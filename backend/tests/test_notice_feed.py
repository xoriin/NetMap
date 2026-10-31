"""Release notice feed: fetched from a JSON file, shown per user, no install data sent."""
import json
from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import get_current_user
from app.api.v1 import notices as notices_api
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.system_setting import SystemSetting
from app.models.user import User, UserRole
from app.services import notices as feed
from tests.app_helpers import add_user, memory_factory

FEED = {
    "notices": [
        {"id": "v2-postgres", "severity": "breaking", "title": "NetMap 2.0 moves to PostgreSQL",
         "message": "Back up before upgrading.", "link": "https://docs.netmap.dev/upgrade", "show_below": "2.0.0"},
        {"id": "tip", "severity": "info", "title": "New docs", "message": "Read the new guide."},
        {"id": "old", "severity": "warning", "title": "Only for 1.6", "message": "Old.", "show_below": "1.7.0"},
        {"id": "future", "severity": "info", "title": "Later", "message": "Not yet.", "starts": "2999-01-01"},
    ]
}


@pytest.fixture
def env(monkeypatch):
    factory = memory_factory()
    monkeypatch.setattr(feed, "installed_app_version", lambda _configured=None: "1.8.0")
    monkeypatch.setattr(feed, "fetch_feed", lambda _url: json.dumps(FEED).encode())
    app = FastAPI()
    app.include_router(notices_api.router, prefix="/api/v1")
    current: dict[str, User] = {}

    def override_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    db = factory()
    admin = add_user(db, "root", UserRole.SUPER_ADMIN)
    viewer = add_user(db, "viewer", UserRole.VIEWER)
    feed.refresh(db)
    client = TestClient(app)

    def as_user(user):
        current["user"] = user
        return client

    yield db, as_user, admin, viewer
    db.close()


def _ids(response):
    assert response.status_code == 200, response.text
    return [n["id"] for n in response.json()]


def test_notices_are_matched_by_version_and_date(env):
    _db, as_user, admin, viewer = env
    assert _ids(as_user(admin).get("/api/v1/notices")) == ["v2-postgres", "tip"]
    assert _ids(as_user(viewer).get("/api/v1/notices")) == ["tip"]


def test_info_notices_are_dismissed_per_user(env):
    _db, as_user, admin, viewer = env
    assert as_user(viewer).post("/api/v1/notices/tip/dismiss").status_code == 204
    assert as_user(viewer).post("/api/v1/notices/tip/dismiss").status_code == 204
    assert _ids(as_user(viewer).get("/api/v1/notices")) == []
    assert "tip" in _ids(as_user(admin).get("/api/v1/notices"))
    assert as_user(viewer).post("/api/v1/notices/v2-postgres/dismiss").status_code == 409
    assert as_user(viewer).post("/api/v1/notices/nope/dismiss").status_code == 404
    assert as_user(viewer).post("/api/v1/notices/BAD%20ID/dismiss").status_code == 422


def test_breaking_notice_stays_until_a_super_admin_acknowledges_it(env):
    db, as_user, admin, viewer = env
    assert as_user(viewer).post("/api/v1/notices/v2-postgres/acknowledge").status_code == 403
    assert as_user(admin).post("/api/v1/notices/tip/acknowledge").status_code == 409
    assert as_user(admin).post("/api/v1/notices/v2-postgres/acknowledge").status_code == 204
    assert _ids(as_user(admin).get("/api/v1/notices")) == ["tip"]
    status = as_user(admin).get("/api/v1/admin/notices").json()
    breaking = next(n for n in status["notices"] if n["id"] == "v2-postgres")
    assert breaking["acknowledged_by"] == "root" and breaking["can_acknowledge"] is False
    db.expire_all()
    assert db.scalar(select(AuditLog.target).where(AuditLog.action == "notice.acknowledged")) == "notice:v2-postgres"


def test_feed_can_be_switched_off_and_admin_sees_its_status(env):
    db, as_user, admin, _viewer = env
    status = as_user(admin).get("/api/v1/admin/notices").json()
    assert status["enabled"] is True and status["error"] is None and status["checked_at"]
    assert status["url"].startswith("https://raw.githubusercontent.com/xoriin/netmap-notices/")
    assert as_user(_viewer).get("/api/v1/admin/notices").status_code == 403
    db.add(SystemSetting(key="notice_feed_enabled", value="false"))
    db.commit()
    assert _ids(as_user(admin).get("/api/v1/notices")) == []
    assert as_user(admin).get("/api/v1/admin/notices").json()["enabled"] is False


def test_a_failed_check_keeps_the_last_good_notices(env, monkeypatch):
    db, as_user, admin, _viewer = env

    def offline(_url):
        raise OSError("network unreachable")

    monkeypatch.setattr(feed, "fetch_feed", offline)
    status = as_user(admin).post("/api/v1/admin/notices/refresh").json()
    assert status["error"] == "network unreachable"
    assert [n["id"] for n in status["notices"]] == ["v2-postgres", "tip"]


def test_invalid_entries_are_skipped_not_the_whole_feed():
    raw = json.dumps({"notices": [
        {"id": "ok", "title": "Fine", "message": "Shown."},
        {"id": "Bad ID", "title": "x", "message": "x"},
        {"id": "http-link", "title": "x", "message": "x", "link": "http://insecure.example"},
        {"id": "js-link", "title": "x", "message": "x", "link": "javascript:alert(1)"},
        {"id": "bad-version", "title": "x", "message": "x", "show_below": "two"},
        {"id": "ok", "title": "Duplicate", "message": "Ignored."},
        {"id": "long", "title": "x", "message": "x" * 1001},
        "not an object",
    ]}).encode()
    notices = feed.parse_feed(raw)
    assert [(n.id, n.title) for n in notices] == [("ok", "Fine")]
    for bad in (b"[]", b'{"notices": {}}', b"not json"):
        with pytest.raises(ValueError):
            feed.parse_feed(bad)


@pytest.mark.parametrize(("version", "expected"), [("1.7.9", True), ("1.8.0", True), ("2.0.0", False), ("dev", True)])
def test_version_window(version, expected):
    notice = feed.Notice(id="n", title="t", message="m", show_from="1.7.0", show_below="2.0.0")
    assert feed.applies(notice, version, date(2026, 11, 1)) is expected
    assert feed.applies(feed.Notice(id="n", title="t", message="m", show_from="1.7.0"), "1.6.9", date(2026, 11, 1)) is False


def test_date_window():
    notice = feed.Notice(id="n", title="t", message="m", starts="2026-11-01", ends="2026-11-30")
    assert [feed.applies(notice, "1.8.0", day) for day in (date(2026, 10, 31), date(2026, 11, 1), date(2026, 11, 30), date(2026, 12, 1))] == [False, True, True, False]


def test_fetch_refuses_plain_http_and_oversized_feeds(monkeypatch):
    with pytest.raises(ValueError):
        feed.fetch_feed("http://example.com/notices.json")

    class Big:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self, limit):
            return b"x" * limit

    seen = {}

    def fake_open(request, timeout):
        seen["headers"] = dict(request.header_items())
        seen["timeout"] = timeout
        return Big()

    monkeypatch.setattr(feed.urllib.request, "urlopen", fake_open)
    with pytest.raises(ValueError):
        feed.fetch_feed("https://example.com/notices.json")
    assert seen["timeout"] == feed.FETCH_TIMEOUT_SECONDS
    assert seen["headers"] == {"User-agent": "netmap-notices", "Accept": "application/json"}


def test_empty_feed_url_disables_the_feed(env, monkeypatch):
    db, *_ = env
    monkeypatch.setattr(feed.settings, "notice_feed_url", "")
    assert feed.feed_enabled(db) is False
    assert feed.active_notices(db) == []

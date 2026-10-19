import json
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user, require_super_admin
from app.api.v1 import exports as exports_api
from app.api.v1 import status_pages as status_pages_api
from app.api.v1 import status_public
from app.db.session import Base, get_db, import_all_models
from app.models.status_page import StatusPage
from app.models.user import User, UserRole
from app.services.status_pages import cache as cache_module
from app.services.status_pages import throttle
from app.services.status_pages.cache import StatusSnapshotCache
from tests.status_page_helpers import seed_page

T_OLD = datetime(2026, 1, 1, tzinfo=timezone.utc)
BACKUP = b"SQLite format 3\x00"
HEADERS = {"Cache-Control": "no-cache, private, must-revalidate", "Vary": "Cookie, Authorization"}


@pytest.fixture
def env(monkeypatch):
    import_all_models()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with Session() as db:
        db.add(User(username="admin", password_hash="x", role=UserRole.NETWORK_ADMIN, is_active=True))
        db.add(User(username="viewer", password_hash="x", role=UserRole.VIEWER, is_active=True))
        db.commit()
    monkeypatch.setattr(cache_module, "SessionLocal", Session)
    cache = StatusSnapshotCache()
    monkeypatch.setattr(cache_module, "status_cache", cache)
    monkeypatch.setattr(status_public, "status_cache", cache)
    monkeypatch.setattr(status_pages_api, "status_cache", cache)
    throttle.throttle.reset()
    current = {"name": "admin"}

    app = FastAPI()
    app.include_router(status_public.router, prefix="/api/v1")
    app.include_router(status_pages_api.router, prefix="/api/v1")
    app.include_router(exports_api.router, prefix="/api/v1")

    def override_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    def override_user():
        with Session() as db:
            return db.scalar(select(User).where(User.username == current["name"]))

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    app.dependency_overrides[require_super_admin] = override_user
    client = TestClient(app)
    client.Session = Session
    client.cache = cache
    client.as_user = lambda name: current.update(name=name)

    def seed(slug, visibility="public"):
        with Session() as db:
            return seed_page(db, slug, visibility).id

    def ready(*pages):
        cache.load_registry()
        for page_id in pages:
            assert cache.build_now(page_id)

    client.seed = seed
    client.ready = ready
    yield client
    cache.stop()
    throttle.throttle.reset()


def assert_headers(response):
    for key, value in HEADERS.items():
        assert response.headers[key] == value


def test_private_and_unknown_slugs_return_identical_404(env):
    private_id = env.seed("secret", "private")
    env.ready(private_id)
    private = env.get("/api/v1/public/status-pages/secret")
    unknown = env.get("/api/v1/public/status-pages/nope")
    assert private.status_code == unknown.status_code == 404
    assert private.json() == unknown.json() == {"detail": "Not found"}
    assert private.content == unknown.content
    assert_headers(private)
    assert_headers(unknown)
    assert "etag" not in private.headers


def test_not_ready_returns_503_with_retry_after(env):
    env.seed("media")
    for slug in ("media", "nope"):
        response = env.get(f"/api/v1/public/status-pages/{slug}")
        assert response.status_code == 503
        assert response.headers["Retry-After"] == "5"
        assert_headers(response)
    env.ready()
    env.cache.stop()
    assert env.get("/api/v1/public/status-pages/media").status_code == 503


def test_missing_and_expired_snapshots_return_503_and_request_a_build(env):
    page_id = env.seed("media")
    env.cache.load_registry()
    env.cache.drain()
    assert env.cache.build_now(page_id, now=T_OLD)
    env.cache.drain()
    response = env.get("/api/v1/public/status-pages/media")
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
    assert env.cache.pending() == [page_id]


def test_success_etag_and_304(env):
    page_id = env.seed("media")
    env.ready(page_id)
    first = env.get("/api/v1/public/status-pages/media")
    assert first.status_code == 200
    assert first.json()["slug"] == "media"
    assert first.headers["content-type"].startswith("application/json")
    assert_headers(first)
    etag = first.headers["ETag"]
    again = env.get("/api/v1/public/status-pages/media", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""
    assert again.headers["ETag"] == etag
    assert_headers(again)
    stale = env.get("/api/v1/public/status-pages/media", headers={"If-None-Match": '"other"'})
    assert stale.status_code == 200


def test_old_etag_after_visibility_change_gets_404_not_304(env):
    page_id = env.seed("media")
    env.ready(page_id)
    etag = env.get("/api/v1/public/status-pages/media").headers["ETag"]
    with env.Session() as db:
        db.get(StatusPage, page_id).visibility = "private"
        db.get(StatusPage, page_id).generation += 1
        db.commit()
    env.cache.load_registry()
    response = env.get("/api/v1/public/status-pages/media", headers={"If-None-Match": etag})
    assert response.status_code == 404
    assert response.json() == {"detail": "Not found"}


def test_public_read_does_no_db_access(env, monkeypatch):
    page_id = env.seed("media")
    env.ready(page_id)

    def explode(*a, **kw):
        raise AssertionError("database touched")

    monkeypatch.setattr(cache_module, "SessionLocal", explode)
    monkeypatch.setattr("app.db.session.SessionLocal", explode)
    app = FastAPI()
    app.include_router(status_public.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = explode
    app.dependency_overrides[get_current_user] = explode
    client = TestClient(app)
    assert client.get("/api/v1/public/status-pages/media").status_code == 200
    assert client.get("/api/v1/public/status-pages/nope").status_code == 404


def test_headers_are_private_no_cache_and_vary(env):
    page_id = env.seed("media")
    env.ready(page_id)
    for path in ("media", "nope"):
        assert_headers(env.get(f"/api/v1/public/status-pages/{path}"))
    env.cache.stop()
    assert_headers(env.get("/api/v1/public/status-pages/media"))


def test_signed_in_user_viewing_public_page_gets_public_audience(env):
    public_id = env.seed("media")
    private_id = env.seed("ops", "private")
    env.ready(public_id, private_id)
    response = env.get("/api/v1/status-pages/media/view")
    assert response.status_code == 200
    assert response.json()["slug"] == "media"
    assert_headers(response)
    assert response.json() == env.get("/api/v1/public/status-pages/media").json()
    assert env.get("/api/v1/status-pages/media/view", headers={"If-None-Match": response.headers["ETag"]}).status_code == 304


def test_private_page_view_uses_private_snapshot_and_public_endpoint_refuses_it(env):
    private_id = env.seed("ops", "private")
    env.ready(private_id)
    view = env.get("/api/v1/status-pages/ops/view")
    assert view.status_code == 200
    assert json.loads(env.cache.get(private_id, "private", datetime.now(timezone.utc)).body) == view.json()
    assert env.get("/api/v1/public/status-pages/ops").status_code == 404
    assert env.get("/api/v1/status-pages/nope/view").status_code == 404


def test_view_without_snapshot_is_503_and_never_falls_back(env):
    private_id = env.seed("ops", "private")
    env.cache.load_registry()
    response = env.get("/api/v1/status-pages/ops/view")
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
    assert_headers(response)
    assert env.cache.pending() == [private_id]


def test_view_requires_sign_in(env):
    env.app.dependency_overrides.pop(get_current_user)
    env.ready(env.seed("media"))
    assert env.get("/api/v1/status-pages/media/view").status_code == 401


def test_preview_builds_on_demand_without_caching(env):
    private_id = env.seed("ops", "private")
    env.cache.load_registry()
    private = env.get(f"/api/v1/status-pages/{private_id}/preview?audience=private")
    public = env.get(f"/api/v1/status-pages/{private_id}/preview")
    assert private.status_code == public.status_code == 200
    assert private.json()["slug"] == "ops"
    assert env.cache.get(private_id, "private", datetime.now(timezone.utc)) is None
    assert env.get(f"/api/v1/status-pages/{private_id}/preview?audience=bogus").status_code == 422
    assert env.get("/api/v1/status-pages/999/preview").status_code == 404
    env.as_user("viewer")
    assert env.get(f"/api/v1/status-pages/{private_id}/preview").status_code == 403


def test_per_ip_throttle_and_key_cap():
    limiter = throttle.RequestThrottle()
    assert all(limiter.allow("1.1.1.1", 0.0) for _ in range(throttle.PER_IP_LIMIT))
    assert not limiter.allow("1.1.1.1", 1.0)
    assert limiter.allow("2.2.2.2", 1.0)
    assert limiter.allow("1.1.1.1", 61.0)
    assert all(limiter.allow(None, 100.0) for _ in range(throttle.PER_IP_LIMIT))
    assert not limiter.allow(None, 101.0)
    for n in range(throttle.MAX_TRACKED_IPS + 500):
        limiter.allow(f"ip-{n}", 200.0)
    assert limiter.tracked() == throttle.MAX_TRACKED_IPS


def test_global_throttle_limit():
    limiter = throttle.RequestThrottle()
    allowed = sum(limiter.allow(f"ip-{n % 50}", 0.0) for n in range(throttle.GLOBAL_LIMIT + 100))
    assert allowed <= throttle.GLOBAL_LIMIT
    assert not limiter.allow("fresh", 1.0)
    assert limiter.allow("fresh", 61.0)


def test_throttled_request_gets_429_with_retry_after(env, monkeypatch):
    env.ready(env.seed("media"))
    monkeypatch.setattr(throttle, "PER_IP_LIMIT", 2)
    assert env.get("/api/v1/public/status-pages/media").status_code == 200
    assert env.get("/api/v1/public/status-pages/media").status_code == 200
    blocked = env.get("/api/v1/public/status-pages/media")
    assert blocked.status_code == 429
    assert int(blocked.headers["Retry-After"]) > 0
    assert_headers(blocked)
    assert blocked.json() == {"detail": "Too many requests"}


def test_restore_reloads_the_status_registry(env, monkeypatch):
    old_id = env.seed("old")
    env.ready(old_id)
    assert env.cache.lookup("old") is not None

    def fake_restore(payload, passphrase):
        with env.Session() as db:
            db.delete(db.get(StatusPage, old_id))
            db.commit()
        env.seed("restored")

    monkeypatch.setattr(exports_api, "restore_database_bytes", fake_restore)
    response = env.post("/api/v1/exports/restore", content=BACKUP)
    assert response.status_code == 204, response.text
    assert env.cache.lookup("old") is None
    assert env.cache.lookup("restored") is not None


def test_restore_succeeds_even_if_registry_reload_fails(env, monkeypatch):
    monkeypatch.setattr(exports_api, "restore_database_bytes", lambda payload, passphrase: None)

    def boom():
        raise RuntimeError("reload failed")

    monkeypatch.setattr(env.cache, "load_registry", boom)
    assert env.post("/api/v1/exports/restore", content=BACKUP).status_code == 204


def test_stopped_cache_answers_every_slug_identically(env):
    env.ready(env.seed("open"), env.seed("secret", "private"))
    env.cache.stop()
    assert env.cache.lookup("secret") is not None
    paths = [f"/api/v1/public/status-pages/{s}" for s in ("open", "secret", "nope")]
    paths += [f"/api/v1/status-pages/{s}/view" for s in ("open", "secret", "nope")]
    responses = [env.get(path) for path in paths]
    for response in responses:
        assert response.status_code == 503
        assert response.headers["Retry-After"] == "5"
        assert_headers(response)
    assert len({r.content for r in responses}) == 1
    assert len({tuple(sorted((k, v) for k, v in r.headers.items() if k != "date")) for r in responses}) == 1


def _backup(env):
    with env.Session() as db:
        return [
            {c.name: getattr(page, c.name) for c in StatusPage.__table__.columns}
            for page in db.scalars(select(StatusPage))
        ]


def _restore_to(env, monkeypatch, rows):
    def fake_restore(payload, passphrase):
        with env.Session() as db:
            for page in db.scalars(select(StatusPage)):
                db.delete(page)
            db.flush()
            for row in rows:
                db.add(StatusPage(**row))
            db.commit()

    monkeypatch.setattr(exports_api, "restore_database_bytes", fake_restore)
    assert env.post("/api/v1/exports/restore", content=BACKUP).status_code == 204


def test_page_deleted_after_backup_is_reachable_and_editable_after_restore(env, monkeypatch):
    page_id = env.seed("media")
    env.ready(page_id)
    backup = _backup(env)
    assert env.delete(f"/api/v1/status-pages/{page_id}").status_code == 204
    assert env.cache.lookup("media") is None

    _restore_to(env, monkeypatch, backup)
    assert env.cache.lookup("media") is not None
    assert env.get("/api/v1/public/status-pages/media").status_code == 503
    env.cache.drain()
    assert env.get("/api/v1/public/status-pages/media").json()["slug"] == "media"

    assert env.patch(f"/api/v1/status-pages/{page_id}", json={"title": "Media status"}).status_code == 200
    env.cache.drain()
    assert env.get("/api/v1/public/status-pages/media").json()["title"] == "Media status"
    assert env.patch(f"/api/v1/status-pages/{page_id}", json={"slug": "renamed"}).status_code == 200
    env.cache.drain()
    assert env.get("/api/v1/public/status-pages/renamed").status_code == 200
    assert env.get("/api/v1/public/status-pages/media").status_code == 404


def test_reslug_and_visibility_change_after_backup_are_undone_by_restore(env, monkeypatch):
    page_id = env.seed("media")
    env.ready(page_id)
    backup = _backup(env)
    assert env.patch(f"/api/v1/status-pages/{page_id}", json={"slug": "news", "visibility": "private"}).status_code == 200
    env.cache.drain()
    assert env.cache.lookup("news").visibility == "private"

    _restore_to(env, monkeypatch, backup)
    assert env.cache.lookup("news") is None
    assert env.cache.lookup("media").visibility == "public"
    assert env.get("/api/v1/public/status-pages/news").status_code == 404
    assert env.get("/api/v1/public/status-pages/media").status_code == 503
    env.cache.drain()
    assert env.get("/api/v1/public/status-pages/media").json()["slug"] == "media"
    assert env.cache.get(page_id, "private", datetime.now(timezone.utc)) is None


def test_restore_never_serves_another_pages_snapshot_under_a_reused_id(env, monkeypatch):
    page_id = env.seed("media")
    env.ready(page_id)
    other = _backup(env)
    other[0].update(slug="other", name="Other")
    old_etag = env.get("/api/v1/public/status-pages/media").headers["etag"]

    _restore_to(env, monkeypatch, other)
    assert env.get("/api/v1/public/status-pages/media").status_code == 404
    stale = env.get("/api/v1/public/status-pages/other", headers={"If-None-Match": old_etag})
    assert stale.status_code == 503
    env.cache.drain()
    fresh = env.get("/api/v1/public/status-pages/other")
    assert fresh.json()["slug"] == "other" and fresh.headers["etag"] != old_etag

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.api.deps import get_current_user
from app.api.v1 import status_pages as status_pages_api
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.status_page import (
    StatusIncidentAlias, StatusIncidentUpdate, StatusIntegrationToken, StatusNotice, StatusPage, StatusPageItem,
)
from app.models.user import User, UserRole
from app.schemas.datetimes import utc_isoformat
from app.services.status_pages import cache as cache_module
from app.services.status_pages import copy, events, incidents, notices, tokens
from app.services.status_pages.cache import StatusSnapshotCache
from app.services.status_pages.incidents import NetmapActor, PersonActor, Ticket, TokenActor
from app.services.status_pages.projection import build_page_payload
from app.services.status_pages.sources import SourceRef
from tests.status_page_helpers import make_session, seed_device, seed_page

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)

INCIDENT_KEYS = {"id", "title", "severity", "status", "opened_at", "resolved_at", "ticket", "updates"}
UPDATE_KEYS = {"id", "at", "status", "message", "author", "internal"}
NOTICE_KEYS = {"id", "level", "title", "body", "link", "expires_at"}
TICKET_KEYS = {"url", "label"}


@pytest.fixture(autouse=True)
def _no_cache(monkeypatch):
    calls: list[list[int]] = []
    monkeypatch.setattr(events, "notify_pages_changed", lambda ids: calls.append(sorted(ids)))
    return calls


def _user(db, name="alice", display_name="Alice Admin"):
    user = User(username=name, password_hash="x", role=UserRole.NETWORK_ADMIN, is_active=True, display_name=display_name)
    db.add(user)
    db.commit()
    return user


def _token(db, name="backup-server"):
    token = StatusIntegrationToken(name=name, prefix="nmst_abc", hash="h")
    db.add(token)
    db.commit()
    return token


def _device(db, **kw):
    kw.setdefault("monitor_status", "online")
    kw.setdefault("last_monitored_at", NOW - timedelta(seconds=10))
    return seed_device(db, **kw)


def _ref(device):
    return SourceRef("device", device_id=device.id)


def _open(db, actor, pages, items=(), **kw):
    kw.setdefault("title", "Mail delays")
    kw.setdefault("severity", "partial")
    kw.setdefault("message", "We are looking into it.")
    kw.setdefault("is_public", True)
    kw.setdefault("ticket", None)
    return incidents.open_manual_incident(
        db, actor, page_ids=[p.id for p in pages], items=list(items), now=kw.pop("now", NOW), **kw,
    )


def _payload(db, page, audience=None):
    return build_page_payload(db, page, audience or page.visibility, NOW)


def _messages(payload):
    return [u["message"] for i in payload["incidents"] + payload["past"] for u in i["updates"]]


def test_internal_update_absent_from_public_payload_and_etag(monkeypatch):
    db = make_session()
    user = _user(db)
    public = seed_page(db, "public", "public")
    incident = _open(db, PersonActor(user), [public])
    monkeypatch.setattr(cache_module, "SessionLocal", sessionmaker(bind=db.get_bind(), expire_on_commit=False))
    cache = StatusSnapshotCache()
    cache.load_registry()
    assert cache.build_now(public.id, NOW)
    before = cache.get(public.id, "public", NOW)

    incidents.add_update(db, PersonActor(user), incident.id, "Root cause: db-07 at 10.9.9.9", False, None, None, None, now=NOW)
    assert cache.build_now(public.id, NOW)
    after = cache.get(public.id, "public", NOW)
    assert after.etag == before.etag and after.body == before.body
    assert b"db-07" not in after.body and b"10.9.9.9" not in after.body

    preview = json.dumps(_payload(db, public, "public"))
    assert "db-07" not in preview
    private = _payload(db, public, "private")
    (update,) = [u for u in private["incidents"][0]["updates"] if u["internal"]]
    assert update["message"] == "Root cause: db-07 at 10.9.9.9"
    cache.stop()


def test_public_human_author_is_status_team():
    db = make_session()
    user = _user(db, "jsmith", "Jane Smith")
    public = seed_page(db, "public", "public")
    private = seed_page(db, "private", "private")
    _open(db, PersonActor(user), [public, private])
    public_body = _payload(db, public)
    assert [u["author"] for u in public_body["incidents"][0]["updates"]] == ["Status team"]
    dumped = json.dumps(public_body)
    assert "Jane Smith" not in dumped and "jsmith" not in dumped
    private_body = _payload(db, private)
    assert [u["author"] for u in private_body["incidents"][0]["updates"]] == ["Status team"]
    assert "Jane Smith" not in json.dumps(private_body) and "jsmith" not in json.dumps(private_body)

    token = _token(db)
    incident = _open(db, TokenActor(token), [public], title="Backups late")
    incidents.add_update(db, NetmapActor(), incident.id, "Checking", True, None, None, None, now=NOW)
    authors = {u["author"] for i in _payload(db, public)["incidents"] for u in i["updates"]}
    assert authors == {"Status team", "backup-server", "NetMap"}


def test_token_author_label_is_public():
    db = make_session()
    public = seed_page(db, "public", "public")
    _open(db, TokenActor(_token(db)), [public])
    assert [u["author"] for u in _payload(db, public)["incidents"][0]["updates"]] == ["backup-server"]


def test_publishing_to_new_page_does_not_expose_earlier_updates():
    db = make_session()
    user = _user(db)
    first = seed_page(db, "first", "private")
    later = seed_page(db, "later", "private")
    incident = _open(db, PersonActor(user), [first], message="Opening note")
    incidents.add_update(db, PersonActor(user), incident.id, "Earlier internal", False, None, None, None, now=NOW)
    incidents.add_update(db, PersonActor(user), incident.id, "Addressed to first", True, first.id, None, None, now=NOW)
    assert _payload(db, later)["incidents"] == []

    incidents.publish_to_pages(db, PersonActor(user), incident.id, [later.id], now=NOW)
    incidents.add_update(db, PersonActor(user), incident.id, "After publishing", True, None, None, None, now=NOW)
    later_body = _payload(db, later)
    (projected,) = later_body["incidents"]
    assert projected["title"] == "Mail delays"
    assert [u["message"] for u in projected["updates"]] == ["After publishing"]
    assert _messages(_payload(db, first)) == [
        "Opening note", "Earlier internal", "Addressed to first", "After publishing",
    ]

    incidents.publish_to_pages(db, PersonActor(user), incident.id, [later.id, first.id], now=NOW)
    assert _messages(_payload(db, later)) == ["After publishing"]
    assert len(_messages(_payload(db, first))) == 4


def test_event_text_uses_page_alias_and_skips_non_local_sources():
    aliases = {"device:1": "Mail", "device:2": "Web"}
    assert copy.render_event("opened", {"sources": ["device:1", "device:9"], "count": 3}, aliases) == (
        "Mail failing (3 consecutive checks)."
    )
    assert copy.render_event("source_added", {"sources": ["device:9"]}, aliases) is None
    assert copy.render_event("source_added", {"sources": ["device:2"]}, aliases) == "Web is also affected."
    assert copy.render_event("rebreached", {"sources": ["device:1"]}, aliases) == "Mail is failing again."
    assert copy.render_event("source_removed", {"sources": ["device:2"]}, aliases) == "Monitoring source removed"
    assert copy.render_event("source_removed", {"sources": ["device:3"]}, aliases) is None
    assert copy.render_event("recovered", {}, aliases) == "All affected systems have recovered. Monitoring."
    assert copy.render_event("resolved_manual", {}, aliases) == "Resolved."
    assert copy.render_event("no-such-code", {}, aliases) is None
    assert copy.names(["A", "B", "C", "D", "E"]) == "A, B, C and 2 more"
    assert copy.auto_title("availability", ["A", "B"]) == "A, B unavailable"
    assert copy.auto_title("latency", ["A"]) == "Slow responses: A"
    assert copy.auto_title("loss", ["A"]) == "Failed checks: A"
    assert copy.auto_title("flapping", ["A"]) == "Unstable: A"
    assert copy.auto_title("certificate", ["A"]) == "Certificate expiring: A"
    assert copy.auto_title("warning", ["A", "B", "C", "D"]) == "Warning: A, B, C and 1 more"

    db = make_session()
    mail, secret = _device(db, hostname="mail-01"), _device(db, hostname="vault-01", ip_address="10.66.0.1")
    public = seed_page(db, "public", "public", [(_ref(mail), "Mail")])
    private = seed_page(db, "private", "private", [(_ref(mail), "mail-01 (prod)"), (_ref(secret), "Vault")])
    incident = _open(db, NetmapActor(), [public, private], items=[_ref(mail), _ref(secret)], title="internal title")
    incident.source, incident.condition_family = "netmap", "availability"
    db.add(StatusIncidentUpdate(
        incident_id=incident.id, author_kind="netmap", event_code="opened",
        event_data={"sources": [_ref(mail).key, _ref(secret).key], "count": 3},
    ))
    db.add(StatusIncidentUpdate(
        incident_id=incident.id, author_kind="netmap", event_code="source_added", event_data={"sources": [_ref(secret).key]},
    ))
    db.commit()
    public_body = _payload(db, public)
    (projected,) = public_body["incidents"]
    assert projected["title"] == "Mail unavailable"
    assert [u["message"] for u in projected["updates"]][1:] == ["Mail failing (3 consecutive checks)."]
    dumped = json.dumps(public_body)
    for leaked in ("Vault", "vault-01", "10.66.0.1", "internal title", "mail-01", "device:"):
        assert leaked not in dumped, leaked
    private_updates = [u["message"] for u in _payload(db, private)["incidents"][0]["updates"]]
    assert private_updates[1:] == ["mail-01 (prod), Vault failing (3 consecutive checks).", "Vault is also affected."]


def test_alias_change_does_not_rewrite_history():
    db = make_session()
    mail = _device(db)
    page = seed_page(db, "public", "public", [(_ref(mail), "Mail")])
    incident = _open(db, PersonActor(_user(db)), [page], items=[_ref(mail)])
    db.add(StatusIncidentUpdate(
        incident_id=incident.id, author_kind="netmap", event_code="rebreached", event_data={"sources": [_ref(mail).key]},
    ))
    db.commit()
    alias = db.scalar(select(StatusIncidentAlias).where(StatusIncidentAlias.page_id == page.id))
    assert (alias.source_key, alias.display_name) == (_ref(mail).key, "Mail")
    item = db.scalar(select(StatusPageItem).where(StatusPageItem.page_id == page.id))
    item.display_name = "Email platform"
    db.commit()
    body = _payload(db, page)
    assert body["incidents"][0]["updates"][-1]["message"] == "Mail is failing again."
    assert body["groups"][0]["items"][0]["name"] == "Email platform"
    assert body["groups"][0]["items"][0]["incident_ids"] == [incident.id]


def test_resolved_within_30_days_listed_in_past():
    db = make_session()
    user = _user(db)
    page = seed_page(db, "public", "public")
    recent = _open(db, PersonActor(user), [page], title="Recent", now=NOW - timedelta(days=3))
    old = _open(db, PersonActor(user), [page], title="Old", now=NOW - timedelta(days=40))
    still_open = _open(db, PersonActor(user), [page], title="Open")
    incidents.resolve(db, PersonActor(user), recent.id, "Fixed upstream", now=NOW - timedelta(days=2))
    incidents.resolve(db, PersonActor(user), old.id, None, now=NOW - timedelta(days=31))
    body = _payload(db, page)
    assert [i["title"] for i in body["incidents"]] == ["Open"]
    assert [i["title"] for i in body["past"]] == ["Recent"]
    (past,) = body["past"]
    assert past["status"] == "resolved" and past["resolved_at"] == utc_isoformat(NOW - timedelta(days=2))
    assert [u["message"] for u in past["updates"]] == ["We are looking into it.", "Resolved."]
    assert "Fixed upstream" not in json.dumps(body)
    private = _payload(db, page, "private")
    assert [u["message"] for u in private["past"][0]["updates"]][-1] == "Fixed upstream"
    assert past["kind"] == "incident"
    for incident in body["incidents"] + [{k: v for k, v in p.items() if k != "kind"} for p in body["past"]]:
        assert set(incident) == INCIDENT_KEYS
        assert all(set(u) == UPDATE_KEYS for u in incident["updates"])
    assert still_open.status == "investigating"
    with pytest.raises(incidents.IncidentError):
        incidents.resolve(db, PersonActor(user), recent.id, None, now=NOW)


def test_critical_notice_raises_summary():
    db = make_session()
    user = _user(db)
    page = seed_page(db, "public", "public", [(_ref(_device(db)), "Mail")])
    assert _payload(db, page)["summary"]["state"] == "operational"
    notices.set_notice(db, PersonActor(user), page.id, "warning", "Heads up", None, None, None, now=NOW)
    assert _payload(db, page)["summary"]["state"] == "operational"
    notices.set_notice(db, PersonActor(user), page.id, "critical", "Datacentre power", "On generators", None, None, now=NOW)
    body = _payload(db, page)
    assert body["summary"]["state"] == "affected"
    assert body["groups"][0]["state"] == "operational"
    (notice,) = body["notices"]
    assert set(notice) == NOTICE_KEYS and notice["level"] == "critical" and notice["body"] == "On generators"


def test_notice_slots_per_owner_and_manager_can_clear_any(_no_cache):
    db = make_session()
    alice, bob, token = _user(db), _user(db, "bob", "Bob"), _token(db)
    page = seed_page(db, "public", "public")
    first = notices.set_notice(db, PersonActor(alice), page.id, "info", "One", None, None, None, now=NOW)
    again = notices.set_notice(db, PersonActor(alice), page.id, "warning", "Two", None, None, None, now=NOW)
    assert first.id == again.id
    notices.set_notice(db, PersonActor(bob), page.id, "info", "Bob's", None, None, None, now=NOW)
    theirs = notices.set_notice(db, TokenActor(token), page.id, "info", "Backups", None, "https://ex.test/b", None, now=NOW)
    assert sorted(n["title"] for n in _payload(db, page)["notices"]) == ["Backups", "Bob's", "Two"]
    assert "Alice" not in json.dumps(_payload(db, page)) and "backup-server" not in json.dumps(_payload(db, page))

    with pytest.raises(incidents.IncidentNotFound):
        notices.clear_notice(db, TokenActor(_token(db, "other")), first.id)
    notices.clear_notice(db, PersonActor(bob), theirs.id)
    notices.clear_notice(db, PersonActor(bob), first.id)
    assert [n.title for n in db.scalars(select(StatusNotice))] == ["Bob's"]
    assert _no_cache[-1] == [page.id]
    with pytest.raises(incidents.IncidentError):
        notices.set_notice(db, PersonActor(alice), page.id, "loud", "x", None, None, None, now=NOW)
    with pytest.raises(incidents.IncidentError):
        notices.set_notice(db, PersonActor(alice), page.id, "info", "x", None, "javascript:alert(1)", None, now=NOW)
    with pytest.raises(incidents.IncidentError):
        notices.set_notice(db, PersonActor(alice), page.id, "info", "x" * 201, None, None, None, now=NOW)


def test_expired_notice_disappears_without_new_probe():
    db = make_session()
    page = seed_page(db, "public", "public")
    expiry = NOW + timedelta(seconds=12)
    notices.set_notice(db, PersonActor(_user(db)), page.id, "critical", "Short", None, None, expiry, now=NOW)
    body = build_page_payload(db, page, "public", NOW)
    assert body["valid_until"] == utc_isoformat(expiry)
    assert body["notices"][0]["expires_at"] == utc_isoformat(expiry)
    later = build_page_payload(db, page, "public", expiry + timedelta(seconds=1))
    assert later["notices"] == [] and later["summary"]["state"] == "empty"
    with pytest.raises(incidents.IncidentError):
        notices.set_notice(db, PersonActor(_user(db, "b")), page.id, "info", "Past", None, None, NOW - timedelta(seconds=1), now=NOW)


def test_ticket_link_must_be_http_or_https():
    db = make_session()
    user = _user(db)
    page = seed_page(db, "public", "public")
    other = seed_page(db, "other", "public")
    for bad in ("javascript:alert(1)", "ftp://x.test/a", "//x.test", "https://", "https://x.test/" + "a" * 2048, "data:text/html,x"):
        with pytest.raises(incidents.IncidentError):
            _open(db, PersonActor(user), [page], ticket=Ticket(bad, "INC-1"))
    with pytest.raises(incidents.IncidentError):
        _open(db, PersonActor(user), [page], ticket=Ticket("https://t.test/1", "x" * 121))
    incident = _open(db, PersonActor(user), [page], ticket=Ticket("https://tickets.test/INC-1042", "Ticket INC-1042"))
    (projected,) = _payload(db, page)["incidents"]
    assert projected["ticket"] == {"url": "https://tickets.test/INC-1042", "label": "Ticket INC-1042"}
    assert set(projected["ticket"]) == TICKET_KEYS
    assert _payload(db, other)["incidents"] == []
    with pytest.raises(incidents.IncidentError):
        incidents.add_update(db, PersonActor(user), incident.id, None, True, None, None, Ticket("javascript:x", None), now=NOW)
    incidents.add_update(db, PersonActor(user), incident.id, None, True, None, None, Ticket("http://t.test/2", None), now=NOW)
    assert _payload(db, page)["incidents"][0]["ticket"] == {"url": "http://t.test/2", "label": None}


def test_text_fields_have_length_limits_and_audience_is_validated():
    db = make_session()
    user = _user(db)
    page = seed_page(db, "public", "public")
    other = seed_page(db, "other", "public")
    with pytest.raises(incidents.IncidentError):
        _open(db, PersonActor(user), [page], title="x" * 201)
    with pytest.raises(incidents.IncidentError):
        _open(db, PersonActor(user), [page], message="x" * 5001)
    with pytest.raises(incidents.IncidentError):
        _open(db, PersonActor(user), [page], title="   ")
    with pytest.raises(incidents.IncidentError):
        _open(db, PersonActor(user), [])
    with pytest.raises(incidents.IncidentError):
        incidents.open_manual_incident(db, PersonActor(user), "T", "partial", "m", True, [9999], [], None, now=NOW)
    stray = _device(db)
    with pytest.raises(incidents.IncidentError):
        _open(db, PersonActor(user), [page], items=[_ref(stray)])
    incident = _open(db, PersonActor(user), [page])
    with pytest.raises(incidents.IncidentError):
        incidents.add_update(db, PersonActor(user), incident.id, "To other", True, other.id, None, None, now=NOW)
    with pytest.raises(incidents.IncidentError):
        incidents.add_update(db, PersonActor(user), incident.id, None, True, None, None, None, now=NOW)
    with pytest.raises(incidents.IncidentNotFound):
        incidents.add_update(db, PersonActor(user), 9999, "x", True, None, None, None, now=NOW)


def test_per_page_severity_and_item_incident_ids():
    db = make_session()
    user = _user(db)
    down = [_device(db, monitor_status="offline") for _ in range(2)]
    up = [_device(db) for _ in range(2)]
    page = seed_page(db, "public", "public", [(_ref(d), f"D{i}") for i, d in enumerate(down + up)])
    manual = _open(db, PersonActor(user), [page], items=[_ref(down[0])], severity="performance")
    auto = _open(db, NetmapActor(), [page], items=[_ref(down[0]), _ref(down[1])], title="auto")
    auto.source, auto.condition_family = "netmap", "availability"
    db.commit()
    body = _payload(db, page)
    severities = {i["id"]: i["severity"] for i in body["incidents"]}
    assert severities == {manual.id: "performance", auto.id: "partial"}
    items = body["groups"][0]["items"]
    assert items[0]["incident_ids"] == sorted([manual.id, auto.id]) and items[2]["incident_ids"] == []

    small = seed_page(db, "small", "public", [(_ref(down[0]), "A"), (_ref(down[1]), "B"), (_ref(up[0]), "C")])
    incidents.publish_to_pages(db, NetmapActor(), auto.id, [small.id], now=NOW)
    assert _payload(db, small)["incidents"][0]["severity"] == "major"
    auto.condition_family = "latency"
    db.commit()
    assert _payload(db, small)["incidents"][0]["severity"] == "performance"


def test_status_changes_and_resolution():
    db = make_session()
    user = _user(db)
    page = seed_page(db, "public", "public")
    incident = _open(db, PersonActor(user), [page])
    incidents.add_update(db, PersonActor(user), incident.id, "Found it", True, None, "identified", None, now=NOW)
    assert incident.status == "identified"
    (projected,) = _payload(db, page)["incidents"]
    assert projected["status"] == "identified" and projected["updates"][-1]["status"] == "identified"
    incidents.add_update(db, PersonActor(user), incident.id, "All clear", True, None, "resolved", None, now=NOW)
    assert incident.status == "resolved" and incident.resolved_at is not None
    assert incident.resolution_reason == "manual"
    with pytest.raises(incidents.IncidentError):
        incidents.add_update(db, PersonActor(user), incident.id, None, True, None, "monitoring", None, now=NOW)
    (past,) = _payload(db, page)["past"]
    assert [(u["message"], u["status"]) for u in past["updates"]][-2:] == [("All clear", None), ("Resolved.", "resolved")]
    events_written = db.scalars(select(StatusIncidentUpdate.event_code).where(
        StatusIncidentUpdate.incident_id == incident.id, StatusIncidentUpdate.event_code == "resolved_manual",
    )).all()
    assert events_written == ["resolved_manual"]
    other = seed_page(db, "other", "public")
    with pytest.raises(incidents.IncidentError):
        incidents.publish_to_pages(db, PersonActor(user), incident.id, [other.id], now=NOW)
    assert _payload(db, other)["past"] == []


def test_public_payload_never_leaks_actor_or_source_metadata():
    db = make_session()
    user = _user(db, "ops-user", "Olivia Ops")
    token = _token(db)
    device = _device(db, hostname="core-sw-01", ip_address="10.42.0.1")
    page = seed_page(db, "public", "public", [(_ref(device), "Core network")])
    incident = _open(db, PersonActor(user), [page], items=[_ref(device)])
    incidents.add_update(db, TokenActor(token), incident.id, "Public note", True, None, None, None, now=NOW)
    incidents.add_update(db, PersonActor(user), incident.id, "rule 'Core RTT' fired", False, None, None, None, now=NOW)
    notices.set_notice(db, PersonActor(user), page.id, "info", "FYI", None, None, None, now=NOW)
    body = json.dumps(_payload(db, page))
    for leaked in ("ops-user", "Olivia Ops", "core-sw-01", "10.42.0.1", "device:", "Core RTT", "user_id",
                   "token_id", "author_kind", "source_key", "event_code", "is_public", "page_id", "nmst_"):
        assert leaked not in body, leaked


def test_notice_slot_race_updates_the_existing_row(monkeypatch):
    db = make_session()
    user = _user(db)
    page = seed_page(db, "public", "public")
    first = notices.set_notice(db, PersonActor(user), page.id, "info", "First", None, None, None, now=NOW)
    real = notices._find_slot
    misses = iter([None])
    monkeypatch.setattr(notices, "_find_slot", lambda *a: next(misses, None) or real(*a))
    again = notices.set_notice(db, PersonActor(user), page.id, "critical", "Second", None, None, None, now=NOW)
    assert again.id == first.id
    assert [(n.title, n.level) for n in db.scalars(select(StatusNotice))] == [("Second", "critical")]


# API


@pytest.fixture
def api(_no_cache):
    db = make_session()
    Session = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
    _user(db, "admin", "Ada Admin")
    db.add(User(username="viewer", password_hash="x", role=UserRole.VIEWER, is_active=True))
    db.commit()
    current = {"name": "admin"}
    app = FastAPI()
    app.include_router(status_pages_api.router, prefix="/api/v1")

    def override_db():
        session = Session()
        try:
            yield session
        finally:
            session.close()

    def override_user():
        with Session() as session:
            return session.scalar(select(User).where(User.username == current["name"]))

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    client = TestClient(app)
    client.as_user = lambda name: current.update(name=name)
    client.Session = Session
    client.calls = _no_cache
    return client


def _api_page(client, slug, visibility="public"):
    with client.Session() as db:
        return seed_page(db, slug, visibility).id


def test_incident_routes_audit_and_notify_audience(api):
    a, b = _api_page(api, "a"), _api_page(api, "b", "private")
    created = api.post("/api/v1/status-pages/incidents", json={
        "title": "Mail delays", "severity": "partial", "message": "Looking", "page_ids": [a],
        "ticket": {"url": "https://t.test/1", "label": "INC-1"},
    })
    assert created.status_code == 201, created.text
    incident_id = created.json()["id"]
    assert api.calls[-1] == [a]
    listed = api.get("/api/v1/status-pages/incidents").json()
    assert [i["id"] for i in listed] == [incident_id] and listed[0]["page_ids"] == [a]
    assert listed[0]["updates"][0]["author"] == "Ada Admin"

    published = api.post(f"/api/v1/status-pages/incidents/{incident_id}/publish", json={"page_ids": [b]})
    assert published.status_code == 200
    assert [u["event_code"] for u in published.json()["updates"]] == [None]
    assert api.calls[-1] == [b]
    update = api.post(f"/api/v1/status-pages/incidents/{incident_id}/updates", json={
        "message": "Internal detail", "is_public": False, "status_change": "identified",
    })
    assert update.status_code == 201, update.text
    assert api.calls[-1] == [a, b]
    assert api.post(f"/api/v1/status-pages/incidents/{incident_id}/resolve", json={"reason": "Fixed"}).status_code == 200
    assert api.calls[-1] == [a, b]
    assert api.post(f"/api/v1/status-pages/incidents/{incident_id}/resolve", json={}).status_code == 409
    assert api.post("/api/v1/status-pages/incidents/999/updates", json={"message": "x"}).status_code == 404
    bad = api.post("/api/v1/status-pages/incidents", json={
        "title": "T", "severity": "partial", "message": "m", "page_ids": [a], "ticket": {"url": "javascript:alert(1)"},
    })
    assert bad.status_code == 422
    assert api.post("/api/v1/status-pages/incidents", json={
        "title": "T", "severity": "minor", "message": "m", "page_ids": [a],
    }).status_code == 422
    with api.Session() as db:
        actions = [row.action for row in db.scalars(select(AuditLog).order_by(AuditLog.id))]
    assert actions == [
        "status_incident.opened", "status_incident.published", "status_incident.updated", "status_incident.resolved",
    ]

    api.as_user("viewer")
    assert api.get("/api/v1/status-pages/incidents").status_code == 403
    assert api.post("/api/v1/status-pages/incidents", json={}).status_code in (403, 422)


def test_notice_routes_own_slot_and_manager_clear(api):
    page_id = _api_page(api, "a")
    put = api.put(f"/api/v1/status-pages/{page_id}/notice", json={"level": "critical", "title": "Power", "body": None})
    assert put.status_code == 200, put.text
    notice_id = put.json()["id"]
    assert api.calls[-1] == [page_id]
    assert api.put(f"/api/v1/status-pages/{page_id}/notice", json={"level": "info", "title": "Calmer"}).json()["id"] == notice_id
    assert api.put(f"/api/v1/status-pages/{page_id}/notice", json={"level": "info", "title": "x", "link": "ftp://x"}).status_code == 422
    assert api.put("/api/v1/status-pages/999/notice", json={"level": "info", "title": "x"}).status_code == 404
    listed = api.get(f"/api/v1/status-pages/{page_id}/notices").json()
    assert [n["id"] for n in listed] == [notice_id] and listed[0]["author"] == "Ada Admin"
    assert api.delete(f"/api/v1/status-pages/{page_id}/notice").status_code == 204
    assert api.delete(f"/api/v1/status-pages/{page_id}/notice").status_code == 404

    with api.Session() as db:
        other = db.scalar(select(User).where(User.username == "viewer"))
        notices.set_notice(db, PersonActor(other), page_id, "info", "Someone else's", None, None, None)
        theirs = db.scalar(select(StatusNotice)).id
    assert api.delete(f"/api/v1/status-pages/notices/{theirs}").status_code == 204
    assert api.delete(f"/api/v1/status-pages/notices/{theirs}").status_code == 404
    with api.Session() as db:
        actions = [row.action for row in db.scalars(select(AuditLog).order_by(AuditLog.id))]
    assert actions == [
        "status_notice.set", "status_notice.set", "status_notice.cleared", "status_notice.set", "status_notice.cleared",
    ]


def test_deleting_page_removes_its_notices_and_incident_audience(api):
    a, b = _api_page(api, "a"), _api_page(api, "b")
    incident_id = api.post("/api/v1/status-pages/incidents", json={
        "title": "T", "severity": "partial", "message": "m", "page_ids": [a, b],
    }).json()["id"]
    api.post(f"/api/v1/status-pages/incidents/{incident_id}/updates", json={"message": "only a", "page_id": a})
    assert api.put(f"/api/v1/status-pages/{a}/notice", json={"level": "info", "title": "FYI"}).status_code == 200
    assert api.delete(f"/api/v1/status-pages/{a}").status_code == 204
    with api.Session() as db:
        assert db.scalar(select(StatusNotice)) is None
        assert incidents.audience_page_ids(db, incident_id) == {b}
        assert db.scalar(select(StatusIncidentUpdate).where(StatusIncidentUpdate.page_id == a)) is None
    assert api.get("/api/v1/status-pages/incidents").json()[0]["page_ids"] == [b]


def test_static_incident_routes_are_not_swallowed_by_page_routes(api):
    assert api.get("/api/v1/status-pages/incidents").status_code == 200
    assert api.delete("/api/v1/status-pages/notices/1").status_code == 404
    with api.Session() as db:
        assert db.scalar(select(StatusPage)) is None


def test_notice_list_flags_owner_and_inactive_tokens(api):
    page_id = _api_page(api, "a")
    assert api.put(f"/api/v1/status-pages/{page_id}/notice", json={"level": "info", "title": "Mine"}).status_code == 200
    with api.Session() as db:
        admin = db.scalar(select(User).where(User.username == "admin"))
        live, _ = tokens.create_token(db, admin, "backup-server", [page_id], None)
        dead, _ = tokens.create_token(db, admin, "old-job", [page_id], None)
        notices.set_notice(db, TokenActor(live), page_id, "warning", "Backups running", None, None, None)
        notices.set_notice(db, TokenActor(dead), page_id, "info", "Stale", None, None, None)
        tokens.revoke_token(db, admin, dead)
        live_id, dead_id, admin_id = live.id, dead.id, admin.id
    by_title = {n["title"]: n for n in api.get(f"/api/v1/status-pages/{page_id}/notices").json()}
    assert (by_title["Mine"]["owner_kind"], by_title["Mine"]["owner_id"], by_title["Mine"]["mine"]) == ("user", admin_id, True)
    assert by_title["Mine"]["token_active"] is None
    assert (by_title["Backups running"]["owner_id"], by_title["Backups running"]["mine"]) == (live_id, False)
    assert by_title["Backups running"]["token_active"] is True
    assert (by_title["Stale"]["owner_id"], by_title["Stale"]["token_active"]) == (dead_id, False)


def test_resolving_an_unrecovered_incident_without_reason_is_422(api):
    from app.models.status_page import StatusIncidentSource

    a = _api_page(api, "a")
    incident_id = api.post("/api/v1/status-pages/incidents", json={
        "title": "Router down", "severity": "major", "message": "m", "page_ids": [a],
    }).json()["id"]
    with api.Session() as db:
        db.add(StatusIncidentSource(
            incident_id=incident_id, source_key="device:1", condition_family="availability", page_id=a, active=True, cleared=False,
        ))
        db.commit()
    assert api.get("/api/v1/status-pages/incidents").json()[0]["breaching"] is True
    expected = "An affected system hasn't recovered yet. Give a reason to resolve this incident anyway."
    resolved = api.post(f"/api/v1/status-pages/incidents/{incident_id}/resolve", json={})
    assert (resolved.status_code, resolved.json()["detail"]) == (422, expected)
    via_update = api.post(f"/api/v1/status-pages/incidents/{incident_id}/updates", json={"status_change": "resolved"})
    assert (via_update.status_code, via_update.json()["detail"]) == (422, expected)
    assert api.get("/api/v1/status-pages/incidents").json()[0]["status"] == "investigating"
    ok = api.post(f"/api/v1/status-pages/incidents/{incident_id}/resolve", json={"reason": "Known ISP outage"})
    assert ok.status_code == 200 and ok.json()["status"] == "resolved"


def test_deleting_a_page_resolves_incidents_it_was_the_only_audience_of():
    from app.models.alert_rule import AlertRule
    from app.models.status_page import StatusBreachStreak

    db = make_session()
    alice = PersonActor(_user(db))
    device = _device(db)
    only = seed_page(db, "only", items=[(_ref(device), "Router")])
    other = seed_page(db, "other", items=[(_ref(device), "Router")])
    lonely = _open(db, alice, [only], [_ref(device)])
    shared = _open(db, alice, [only, other], [_ref(device)])
    rule = AlertRule(name="Down", event_type="device_down", enabled=True)
    db.add(rule)
    db.flush()
    db.add_all([
        StatusBreachStreak(rule_id=rule.id, source_key=_ref(device).key, page_id=only.id, streak=2),
        StatusBreachStreak(rule_id=rule.id, source_key=_ref(device).key, page_id=other.id, streak=2),
    ])
    db.commit()

    incidents.delete_page_records(db, only.id, now=NOW + timedelta(minutes=1))
    db.delete(only)
    db.commit()

    db.refresh(lonely)
    db.refresh(shared)
    assert (lonely.status, lonely.resolution_reason) == ("resolved", "page_deleted")
    assert lonely.resolved_at.replace(tzinfo=timezone.utc) == NOW + timedelta(minutes=1)
    notes = list(db.scalars(select(StatusIncidentUpdate).where(StatusIncidentUpdate.incident_id == lonely.id)))
    assert any(u.message == incidents.PAGE_DELETED_REASON and not u.is_public for u in notes)
    assert shared.status == "investigating"
    assert [s.page_id for s in db.scalars(select(StatusBreachStreak))] == [other.id]


def test_resolved_incident_board_removal_is_page_scoped_reversible_and_preserves_history(api):
    a, b = _api_page(api, "board-a"), _api_page(api, "board-b")
    incident = api.post("/api/v1/status-pages/incidents", json={
        "title": "Closed incident", "severity": "partial", "message": "Investigating", "is_public": True,
        "page_ids": [a, b], "items": [],
    }).json()
    iid = incident["id"]
    url = f"/api/v1/status-pages/incidents/{iid}/pages/{a}/visibility"
    assert api.put(url, json={"visible": False}).status_code == 409
    assert api.post(f"/api/v1/status-pages/incidents/{iid}/resolve", json={}).status_code == 200
    api.calls.clear()
    removed = api.put(url, json={"visible": False})
    assert removed.status_code == 200, removed.text
    assert removed.json()["hidden_page_ids"] == [a]
    assert removed.json()["page_ids"] == [a, b]
    assert api.calls == [[a]]
    for audience in ("public", "private"):
        assert not api.get(f"/api/v1/status-pages/{a}/preview?audience={audience}").json()["past"]
        assert len(api.get(f"/api/v1/status-pages/{b}/preview?audience={audience}").json()["past"]) == 1
    assert len(removed.json()["updates"]) == 2
    assert all(u["event_code"] != "board_visibility" for u in removed.json()["updates"])
    assert api.put(url, json={"visible": False}).status_code == 200  # idempotent
    assert api.put(url.replace(f"pages/{a}", "pages/9999"), json={"visible": False}).status_code == 404
    api.as_user("viewer")
    assert api.put(url, json={"visible": True}).status_code == 403
    api.as_user("admin")
    restored = api.put(url, json={"visible": True})
    assert restored.status_code == 200
    assert restored.json()["hidden_page_ids"] == []
    assert len(api.get(f"/api/v1/status-pages/{a}/preview").json()["past"]) == 1

import base64
import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1 import status_pages as status_pages_api
from app.db.session import Base, get_db, import_all_models
from app.models.audit_log import AuditLog
from app.models.status_page import StatusPage, StatusPageGroup, StatusPageItem
from app.models.system_setting import SystemSetting
from app.models.user import User, UserRole
from app.services.status_pages import events
from tests.status_page_helpers import seed_device, seed_monitor, seed_service_check


@pytest.fixture
def env():
    import_all_models()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with Session() as db:
        db.add(User(username="admin", password_hash="x", role=UserRole.NETWORK_ADMIN, is_active=True))
        db.add(User(username="viewer", password_hash="x", role=UserRole.VIEWER, is_active=True))
        db.commit()
    current = {"name": "admin"}

    app = FastAPI()
    app.include_router(status_pages_api.router, prefix="/api/v1")

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
    client = TestClient(app)
    client.as_user = lambda name: current.update(name=name)
    client.Session = Session
    return client


def _page(client, slug="media", **kw):
    body = {"name": "Media", "slug": slug, **kw}
    response = client.post("/api/v1/status-pages", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _logo() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def test_viewer_without_permission_gets_403(env):
    env.as_user("viewer")
    assert env.get("/api/v1/status-pages").status_code == 403
    assert env.post("/api/v1/status-pages", json={"name": "A", "slug": "a"}).status_code == 403
    assert env.get("/api/v1/status-pages/sources").status_code == 403
    assert env.put("/api/v1/status-pages/1/layout", json={"groups": []}).status_code == 403
    assert env.delete("/api/v1/status-pages/1").status_code == 403


def test_slug_must_be_lowercase_and_unique(env):
    assert env.post("/api/v1/status-pages", json={"name": "A", "slug": "Media Team"}).status_code == 422
    assert env.post("/api/v1/status-pages", json={"name": "A", "slug": "-lead"}).status_code == 422
    assert env.post("/api/v1/status-pages", json={"name": "A", "slug": "x" * 49}).status_code == 422
    _page(env, "media")
    duplicate = env.post("/api/v1/status-pages", json={"name": "B", "slug": "media"})
    assert duplicate.status_code == 409
    other = _page(env, "other")
    clash = env.patch(f"/api/v1/status-pages/{other['id']}", json={"slug": "media"})
    assert clash.status_code == 409


def test_layout_requires_display_name_no_hostname_fallback(env):
    page = _page(env)
    device = seed_device(env.Session(), hostname="router1")
    for name in ("", "   ", None):
        body = {"groups": [{"id": None, "name": "G", "collapsed_by_default": False, "items": [
            {"id": None, "source": {"device": device.id}, "display_name": name, "extras": {}},
        ]}]}
        assert env.put(f"/api/v1/status-pages/{page['id']}/layout", json=body).status_code == 422
    missing = {"groups": [{"id": None, "name": "G", "collapsed_by_default": False, "items": [
        {"id": None, "source": {"device": device.id}, "extras": {}},
    ]}]}
    assert env.put(f"/api/v1/status-pages/{page['id']}/layout", json=missing).status_code == 422


def test_service_check_item_requires_target_applicable_to_device(env):
    db = env.Session()
    page = _page(env)
    d1, d2 = seed_device(db), seed_device(db)
    own = seed_service_check(db, d1.id)
    global_check = seed_service_check(db, None, port=22, label="SSH")

    def put(device, target):
        body = {"groups": [{"id": None, "name": "G", "collapsed_by_default": False, "items": [
            {"id": None, "source": {"device": device, "service_check": target}, "display_name": "Svc", "extras": {}},
        ]}]}
        return env.put(f"/api/v1/status-pages/{page['id']}/layout", json=body)

    assert put(d2.id, own.id).status_code == 422
    assert put(d1.id, 9999).status_code == 422
    assert put(9999, global_check.id).status_code == 422
    assert put(d1.id, own.id).status_code == 200
    assert put(d2.id, global_check.id).status_code == 200
    saved = env.get(f"/api/v1/status-pages/{page['id']}").json()
    item = saved["groups"][0]["items"][0]
    assert item["source"] == {"device": d2.id, "service_check": global_check.id}


def test_layout_rejects_bad_sources_extras_and_duplicates(env):
    db = env.Session()
    page = _page(env)
    device, monitor = seed_device(db), seed_monitor(db)

    def put(items):
        body = {"groups": [{"id": None, "name": "G", "collapsed_by_default": False, "items": items}]}
        return env.put(f"/api/v1/status-pages/{page['id']}/layout", json=body).status_code

    def item(source, extras=None):
        return {"id": None, "source": source, "display_name": "X", "extras": extras or {}}

    assert put([item({"device": device.id, "monitor": monitor.id})]) == 422
    assert put([item({})]) == 422
    assert put([item({"service_check": 1})]) == 422
    assert put([item({"monitor": 9999})]) == 422
    assert put([item({"device": device.id}, {"nonsense": True})]) == 422
    assert put([item({"device": device.id}, {"uptime_period": "1y"})]) == 422
    assert put([item({"device": device.id}), item({"device": device.id})]) == 422
    assert put([item({"device": device.id}, {"rtt_graph": True, "uptime_period": "7d"}), item({"monitor": monitor.id})]) == 200


def test_layout_replace_keeps_ids_and_orders_by_array(env):
    db = env.Session()
    page = _page(env)
    pid = page["id"]
    d1, d2, d3 = seed_device(db), seed_device(db), seed_device(db)

    def it(item_id, device, name):
        return {"id": item_id, "source": {"device": device.id}, "display_name": name, "extras": {}}

    first = env.put(f"/api/v1/status-pages/{pid}/layout", json={"groups": [
        {"id": None, "name": "A", "collapsed_by_default": False, "items": [it(None, d1, "one"), it(None, d2, "two")]},
        {"id": None, "name": "B", "collapsed_by_default": True, "items": [it(None, d3, "three")]},
    ]})
    assert first.status_code == 200, first.text
    groups = first.json()["groups"]
    ga, gb = groups[0], groups[1]
    one, two = ga["items"]
    three = gb["items"][0]
    assert gb["collapsed_by_default"] is True

    second = env.put(f"/api/v1/status-pages/{pid}/layout", json={"groups": [
        {"id": gb["id"], "name": "B2", "collapsed_by_default": False, "items": [it(three["id"], d3, "three!"), it(two["id"], d2, "two")]},
        {"id": ga["id"], "name": "A", "collapsed_by_default": False, "items": []},
    ]})
    assert second.status_code == 200, second.text
    out = second.json()["groups"]
    assert [g["id"] for g in out] == [gb["id"], ga["id"]]
    assert [g["name"] for g in out] == ["B2", "A"]
    assert [i["id"] for i in out[0]["items"]] == [three["id"], two["id"]]
    assert out[0]["items"][0]["display_name"] == "three!"

    with env.Session() as check:
        assert check.get(StatusPageItem, one["id"]) is None
        rows = check.scalars(select(StatusPageItem).order_by(StatusPageItem.sort_order)).all()
        assert [r.id for r in rows] == [three["id"], two["id"]]
        assert {r.page_id for r in rows} == {pid}

    foreign = env.put(f"/api/v1/status-pages/{pid}/layout", json={"groups": [
        {"id": 99999, "name": "X", "collapsed_by_default": False, "items": []},
    ]})
    assert foreign.status_code == 422
    other = _page(env, "other")
    cross = env.put(f"/api/v1/status-pages/{other['id']}/layout", json={"groups": [
        {"id": ga["id"], "name": "X", "collapsed_by_default": False, "items": []},
    ]})
    assert cross.status_code == 422

    swap = env.put(f"/api/v1/status-pages/{pid}/layout", json={"groups": [
        {"id": gb["id"], "name": "B2", "collapsed_by_default": False, "items": [it(three["id"], d2, "x"), it(two["id"], d3, "y")]},
    ]})
    assert swap.status_code == 200, swap.text


def test_new_page_copies_default_css_at_creation(env):
    with env.Session() as db:
        db.add(SystemSetting(key="status_page_default_css", value="body{color:red}"))
        db.commit()
    page = _page(env, "styled")
    assert page["custom_css"] == "body{color:red}"
    with env.Session() as db:
        setting = db.get(SystemSetting, "status_page_default_css")
        setting.value = "body{color:blue}"
        db.commit()
    assert env.get(f"/api/v1/status-pages/{page['id']}").json()["custom_css"] == "body{color:red}"
    later = _page(env, "later")
    assert later["custom_css"] == "body{color:blue}"


def test_page_fields_logo_accent_and_generation(env):
    page = _page(env, accent="#1A2B3C", logo=_logo(), title="Status", visibility="private", heartbeat_window="24h")
    assert page["accent"] == "#1a2b3c" and page["visibility"] == "private" and page["heartbeat_window"] == "24h"
    pid = page["id"]
    assert env.patch(f"/api/v1/status-pages/{pid}", json={"logo": "data:image/png;base64,AAAA"}).status_code == 422
    assert env.patch(f"/api/v1/status-pages/{pid}", json={"accent": "red"}).status_code == 422
    assert env.patch(f"/api/v1/status-pages/{pid}", json={"visibility": "secret"}).status_code == 422
    assert env.patch(f"/api/v1/status-pages/{pid}", json={"name": ""}).status_code == 422

    def generation():
        with env.Session() as db:
            return db.get(StatusPage, pid).generation

    start = generation()
    env.patch(f"/api/v1/status-pages/{pid}", json={"title": "New"})
    assert generation() == start
    env.patch(f"/api/v1/status-pages/{pid}", json={"visibility": "private"})
    assert generation() == start
    env.patch(f"/api/v1/status-pages/{pid}", json={"visibility": "public"})
    assert generation() == start + 1
    env.patch(f"/api/v1/status-pages/{pid}", json={"slug": "renamed", "custom_css": "a{}"})
    assert generation() == start + 2
    cleared = env.patch(f"/api/v1/status-pages/{pid}", json={"logo": None, "accent": None}).json()
    assert cleared["logo"] is None and cleared["accent"] is None and cleared["custom_css"] == "a{}"
    assert env.get("/api/v1/status-pages/9999").status_code == 404
    assert env.patch("/api/v1/status-pages/9999", json={"name": "x"}).status_code == 404
    assert env.delete("/api/v1/status-pages/9999").status_code == 404


def test_sources_route_is_not_swallowed_and_lists_applicable_checks(env):
    db = env.Session()
    d1, d2 = seed_device(db, hostname="alpha"), seed_device(db, hostname="beta")
    own = seed_service_check(db, d1.id, label="HTTPS")
    glob = seed_service_check(db, None, port=22, label="SSH")
    monitor = seed_monitor(db, name="Site")
    response = env.get("/api/v1/status-pages/sources")
    assert response.status_code == 200, response.text
    data = response.json()
    devices = {d["id"]: d for d in data["devices"]}
    assert {c["id"] for c in devices[d1.id]["service_checks"]} == {own.id, glob.id}
    assert {c["id"] for c in devices[d2.id]["service_checks"]} == {glob.id}
    assert [m["id"] for m in data["monitors"]] == [monitor.id]
    assert devices[d1.id]["name"] == "alpha"


def test_every_mutation_is_audited_and_notifies_cache(env, monkeypatch):
    calls = []
    monkeypatch.setattr(events, "notify_pages_changed", lambda ids: calls.append(list(ids)))
    device = seed_device(env.Session())
    page = _page(env)
    pid = page["id"]
    env.patch(f"/api/v1/status-pages/{pid}", json={"title": "T"})
    env.put(f"/api/v1/status-pages/{pid}/layout", json={"groups": [
        {"id": None, "name": "G", "collapsed_by_default": False, "items": [
            {"id": None, "source": {"device": device.id}, "display_name": "D", "extras": {}}]},
    ]})
    env.delete(f"/api/v1/status-pages/{pid}")
    assert calls == [[pid]] * 4
    with env.Session() as db:
        actions = [a.action for a in db.scalars(select(AuditLog).order_by(AuditLog.id))]
        assert actions == ["status_page.created", "status_page.updated", "status_page.layout_updated", "status_page.deleted"]
        assert db.scalar(select(StatusPageGroup).limit(1)) is None
        assert db.scalar(select(StatusPageItem).limit(1)) is None


def test_failed_mutation_does_not_notify(env, monkeypatch):
    calls = []
    monkeypatch.setattr(events, "notify_pages_changed", lambda ids: calls.append(list(ids)))
    env.post("/api/v1/status-pages", json={"name": "A", "slug": "Bad Slug"})
    assert env.put("/api/v1/status-pages/1/layout", json={"groups": []}).status_code == 404
    assert calls == []


def test_draft_preview_uses_unsaved_layout_and_window_without_writing(env):
    page = _page(env, "draft-preview")
    pid = page["id"]
    with env.Session() as db:
        device = seed_device(db)
        did = device.id
    original = env.get(f"/api/v1/status-pages/{pid}").json()
    groups = [{"name": "Unsaved group", "collapsed_by_default": True, "items": [
        {"source": {"device": did}, "display_name": "Draft alias", "extras": {"last_check": True, "rtt_graph": True}},
    ]}]
    result = env.post(f"/api/v1/status-pages/{pid}/preview?audience=public", json={"groups": groups, "heartbeat_window": "24h"})
    assert result.status_code == 200, result.text
    shown = result.json()
    assert shown["heartbeat_window"] == "24h"
    assert shown["groups"][0]["name"] == "Unsaved group"
    assert shown["groups"][0]["collapsed"] is True
    item = shown["groups"][0]["items"][0]
    assert item["name"] == "Draft alias"
    assert len(item["heartbeats"]) == 60
    assert item["response"] is not None
    assert "last_check" in item["metrics"]
    assert env.get(f"/api/v1/status-pages/{pid}").json() == original
    assert env.get(f"/api/v1/status-pages/{pid}/preview").json()["groups"] == []
    # Repeated/empty previews are read-only, never persist negative transient IDs or audits.
    assert env.post(f"/api/v1/status-pages/{pid}/preview", json={"groups": []}).json()["groups"] == []
    with env.Session() as db:
        assert db.query(StatusPageGroup).count() == 0
        assert db.query(StatusPageItem).count() == 0
    for bad in ({"heartbeat_window": "7d"}, {"groups": [{"id": 999, "name": "Foreign", "items": []}]},
                {"groups": [{"name": "Duplicate", "items": groups[0]["items"] * 2}]},
                {"groups": [{"name": "Bad source", "items": [{"source": {"device": 9999}, "display_name": "No"}]}]}):
        assert env.post(f"/api/v1/status-pages/{pid}/preview", json=bad).status_code == 422
    assert env.post("/api/v1/status-pages/99999/preview", json={}).status_code == 404
    env.as_user("viewer")
    assert env.post(f"/api/v1/status-pages/{pid}/preview", json={}).status_code == 403


def test_group_icon_is_saved_cleared_and_shown_in_the_payload(env):
    page = _page(env, "icons")
    pid = page["id"]
    with env.Session() as db:
        did = seed_device(db).id

    def layout(icon):
        group = {"name": "Web", "collapsed_by_default": False, "items": [
            {"source": {"device": did}, "display_name": "Site", "extras": {}},
        ]}
        if icon is not ...:
            group["icon"] = icon
        return {"groups": [group, {"name": "Plain", "items": []}]}

    saved = env.put(f"/api/v1/status-pages/{pid}/layout", json=layout("world"))
    assert saved.status_code == 200, saved.text
    assert [g["icon"] for g in saved.json()["groups"]] == ["world", None]
    assert [g["icon"] for g in env.get(f"/api/v1/status-pages/{pid}").json()["groups"]] == ["world", None]
    shown = env.get(f"/api/v1/status-pages/{pid}/preview").json()
    assert [g["icon"] for g in shown["groups"]] == ["world", None]

    group_id = saved.json()["groups"][0]["id"]
    kept_id = env.put(f"/api/v1/status-pages/{pid}/layout", json={"groups": [
        {**layout("brand-github")["groups"][0], "id": group_id, "items": []},
    ]}).json()["groups"][0]
    assert kept_id["id"] == group_id and kept_id["icon"] == "brand-github"

    for cleared in ("", "   ", None, ...):
        body = layout(cleared)
        body["groups"][0]["id"] = group_id
        body["groups"][0]["items"] = []
        assert env.put(f"/api/v1/status-pages/{pid}/layout", json=body).json()["groups"][0]["icon"] is None


@pytest.mark.parametrize("icon", ["World", "world wide", "-world", "world-", "a--b", "<svg>", "https://x.test/i.png", "x" * 65])
def test_group_icon_rejects_anything_but_an_icon_name(env, icon):
    pid = _page(env, "bad-icons")["id"]
    body = {"groups": [{"name": "Web", "icon": icon, "items": []}]}
    assert env.put(f"/api/v1/status-pages/{pid}/layout", json=body).status_code == 422
    assert env.post(f"/api/v1/status-pages/{pid}/preview", json=body).status_code == 422


def test_draft_preview_shows_an_unsaved_group_icon(env):
    pid = _page(env, "icon-preview")["id"]
    result = env.post(f"/api/v1/status-pages/{pid}/preview", json={"groups": [{"name": "Draft", "icon": "database", "items": []}]})
    assert result.status_code == 200, result.text
    assert result.json()["groups"][0]["icon"] == "database"
    assert env.get(f"/api/v1/status-pages/{pid}").json()["groups"] == []


def test_migration_0091_adds_group_icon_and_keeps_groups():
    from sqlalchemy import text

    from app.db import session as db_session

    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE status_page_groups (id INTEGER PRIMARY KEY, page_id INTEGER, name VARCHAR(120), sort_order INTEGER, collapsed_by_default BOOLEAN)"))
        conn.execute(text("INSERT INTO status_page_groups VALUES (1, 1, 'Core', 0, 0)"))
        db_session._migrate_status_page_group_icon(conn, None)
        db_session._migrate_status_page_group_icon(conn, None)
        assert "icon" in db_session._live_columns(conn, "status_page_groups")
        assert conn.execute(text("SELECT name, icon FROM status_page_groups")).fetchall() == [("Core", None)]
    with create_engine("sqlite://").begin() as conn:
        db_session._migrate_status_page_group_icon(conn, None)

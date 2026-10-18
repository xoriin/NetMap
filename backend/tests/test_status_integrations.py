import itertools
from datetime import datetime, timedelta, timezone
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.api.deps import get_current_user
from app.api.v1 import status_integrations as integrations_api
from app.api.v1 import status_pages as status_pages_api
from app.core.config import settings
from app.core.security import create_access_token
from app.db.session import get_db
from app.middleware.csrf import CsrfProtectionMiddleware
from app.models.audit_log import AuditLog
from app.models.status_page import (
    StatusIdempotencyKey,
    StatusIncident,
    StatusIncidentPage,
    StatusIncidentUpdate,
    StatusIntegrationToken,
    StatusIntegrationTokenPage,
    StatusNotice,
)
from app.models.user import User, UserRole
from app.services.api_keys import service as api_key_service
from app.services.api_keys.service import create_api_key
from app.services.status_pages import events, incidents, tokens
from app.services.status_pages.incidents import NetmapActor, PersonActor
from app.services.status_pages.sources import SourceRef
from tests.status_page_helpers import make_session, seed_device, seed_page

BASE = "/api/v1/status-integrations"
INVALID = {"detail": "Invalid or inactive status integration token"}
NOT_FOUND = {"detail": "Not found"}
OUT_OF_SCOPE = {"detail": "This token may not post to that page"}

_keys = itertools.count(1)


@pytest.fixture()
def env(monkeypatch):
    calls: list[list[int]] = []
    monkeypatch.setattr(events, "notify_pages_changed", lambda ids: calls.append(sorted(ids)))
    tokens.write_limiter.reset()
    seed = make_session()
    Session = sessionmaker(bind=seed.get_bind(), autoflush=False)

    app = FastAPI()
    app.add_middleware(CsrfProtectionMiddleware)
    app.include_router(status_pages_api.router, prefix="/api/v1")
    app.include_router(integrations_api.router, prefix="/api/v1")

    @app.get("/api/v1/whoami")
    def whoami(user: Annotated[User, Depends(get_current_user)]) -> dict:
        return {"id": user.id}

    def override_db():
        session = Session()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_db

    class Env:
        pass

    e = Env()
    e.client = TestClient(app)
    e.Session = Session
    e.calls = calls
    with Session() as db:
        e.admin_id = _user(db, "admin", UserRole.NETWORK_ADMIN).id
        e.viewer_id = _user(db, "viewer", UserRole.VIEWER).id
        _, e.admin_key = create_api_key(db, db.get(User, e.admin_id), "admin key", None)
        _, e.viewer_key = create_api_key(db, db.get(User, e.viewer_id), "viewer key", None)
        db.commit()
    return e


def _user(db, name, role):
    user = User(username=name, password_hash="x", role=role, is_active=True, display_name=name.title())
    db.add(user)
    db.commit()
    return user


def _admin(env, method, path, key=None, **kw):
    return env.client.request(method, f"/api/v1/status-pages{path}", headers={"X-API-Key": key or env.admin_key}, **kw)


def _new_token(env, page_ids, name="backup-server", key=None, **extra):
    response = _admin(env, "POST", "/tokens", key=key, json={"name": name, "page_ids": page_ids, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def _call(env, method, path, secret, json=None, key="auto", headers=None):
    sent = {"Authorization": f"Bearer {secret}"} if secret else {}
    if key == "auto" and method in ("POST", "PUT"):
        key = f"k-{next(_keys)}"
    if key and key != "auto":
        sent["Idempotency-Key"] = key
    sent.update(headers or {})
    return env.client.request(method, f"{BASE}{path}", headers=sent, json=json)


def _pages(env, *slugs, items=None):
    with env.Session() as db:
        return [seed_page(db, slug, "public", (items or {}).get(slug, ())).id for slug in slugs]


def _device(env):
    with env.Session() as db:
        return seed_device(db).id


def _notice(title="Backups delayed"):
    return {"level": "warning", "title": title}


def _incident(**kw):
    body = {"title": "Backups failing", "severity": "partial", "message": "Nightly backup did not finish."}
    body.update(kw)
    return body


def _count(env, model, *where):
    with env.Session() as db:
        return db.scalar(select(func.count()).select_from(model).where(*where))


def test_token_cannot_use_normal_api_and_api_key_cannot_use_integration_routes(env):
    (a,) = _pages(env, "a")
    secret = _new_token(env, [a])["secret"]
    assert secret.startswith("nmsp_")

    assert env.client.get("/api/v1/whoami", headers={"Authorization": f"Bearer {secret}"}).status_code == 401
    assert env.client.get("/api/v1/whoami", headers={"X-API-Key": secret}).status_code == 401
    assert env.client.get("/api/v1/status-pages", headers={"X-API-Key": secret}).status_code == 401
    assert env.client.get("/api/v1/status-pages", headers={"Authorization": f"Bearer {secret}"}).status_code == 401
    assert env.client.get("/api/v1/whoami", headers={"X-API-Key": env.admin_key}).status_code == 200

    access = create_access_token(env.admin_id)
    for headers in (
        {"Authorization": f"Bearer {env.admin_key}"},
        {"X-API-Key": env.admin_key},
        {"Authorization": f"Bearer {access}"},
        {"X-API-Key": env.admin_key, "Authorization": f"Bearer {access}"},
    ):
        response = _call(env, "PUT", "/pages/a/notice", None, _notice(), headers=headers)
        assert response.status_code == 401 and response.json() == INVALID, headers

    env.client.cookies.set("netmap_access", access)
    env.client.cookies.set("netmap_csrf", "c")
    with_csrf = _call(env, "PUT", "/pages/a/notice", None, _notice(), headers={"X-CSRF-Token": "c"})
    assert with_csrf.status_code == 401 and with_csrf.json() == INVALID
    env.client.cookies.delete("netmap_csrf")
    without_csrf = _call(env, "PUT", "/pages/a/notice", None, _notice())
    assert without_csrf.status_code == 403 and without_csrf.json() == {"detail": "CSRF token required"}
    assert _count(env, StatusNotice) == 0

    ok = _call(env, "PUT", "/pages/a/notice", secret, _notice())
    assert ok.status_code == 200, ok.text
    env.client.cookies.clear()
    with env.Session() as db:
        (notice,) = db.scalars(select(StatusNotice)).all()
        assert notice.owner_kind == "token"


def test_slug_outside_scope_is_403_and_nothing_written(env):
    a, _b = _pages(env, "a", "b")
    secret = _new_token(env, [a])["secret"]

    for slug in ("b", "missing"):
        response = _call(env, "PUT", f"/pages/{slug}/notice", secret, _notice())
        assert response.status_code == 403 and response.json() == OUT_OF_SCOPE
        response = _call(env, "DELETE", f"/pages/{slug}/notice", secret)
        assert response.status_code == 403 and response.json() == OUT_OF_SCOPE
    for pages in (["b"], ["a", "b"], ["a", "missing"]):
        response = _call(env, "POST", "/incidents", secret, _incident(pages=pages))
        assert response.status_code == 403 and response.json() == OUT_OF_SCOPE
    assert _count(env, StatusNotice) == 0
    assert _count(env, StatusIncident) == 0
    assert _count(env, StatusIdempotencyKey) == 0
    assert env.calls == []

    response = _call(env, "POST", "/incidents", secret, _incident(pages=["a"]))
    assert response.status_code == 201, response.text
    assert response.json()["pages"] == ["a"]


def test_items_on_no_permitted_page_are_rejected(env):
    shared, hidden = _device(env), _device(env)
    on_both = (SourceRef("device", device_id=shared), "Shared host")
    a, b = _pages(env, "a", "b", items={
        "a": [on_both], "b": [on_both, (SourceRef("device", device_id=hidden), "Hidden host")],
    })
    secret = _new_token(env, [a])["secret"]

    for items in ([{"device": hidden}], [{"device": shared}, {"device": hidden}], [{"device": 9999}], [{"monitor": 9999}]):
        response = _call(env, "POST", "/incidents", secret, _incident(items=items))
        assert response.status_code == 404 and response.json() == NOT_FOUND, items
    assert _count(env, StatusIncident) == 0

    assert _call(env, "POST", "/incidents", secret, _incident()).status_code == 422
    assert _call(env, "POST", "/incidents", secret, _incident(items=[{"device": shared}], pages=["a"])).status_code == 422

    response = _call(env, "POST", "/incidents", secret, _incident(items=[{"device": shared}]))
    assert response.status_code == 201, response.text
    assert response.json()["pages"] == ["a"]
    with env.Session() as db:
        incident = db.get(StatusIncident, response.json()["id"])
        assert incident.source == "token"
        assert incidents.audience_page_ids(db, incident.id) == {a}
    assert env.calls[-1] == [a]
    assert b not in env.calls[-1]


def test_guessed_incident_id_of_other_token_is_404(env):
    (a,) = _pages(env, "a")
    first = _new_token(env, [a], name="first")["secret"]
    second = _new_token(env, [a], name="second")["secret"]
    incident_id = _call(env, "POST", "/incidents", first, _incident(pages=["a"])).json()["id"]

    for target in (incident_id, 9999):
        update = _call(env, "POST", f"/incidents/{target}/updates", second, {"message": "Hijack"})
        assert update.status_code == 404 and update.json() == NOT_FOUND
        resolved = _call(env, "POST", f"/incidents/{target}/resolve", second, {})
        assert resolved.status_code == 404 and resolved.json() == NOT_FOUND
    assert _count(env, StatusIncidentUpdate, StatusIncidentUpdate.incident_id == incident_id) == 1
    with env.Session() as db:
        assert db.get(StatusIncident, incident_id).status == "investigating"

    own = _call(env, "POST", f"/incidents/{incident_id}/updates", first, {"message": "Retrying", "status": "identified"})
    assert own.status_code == 201, own.text
    assert own.json()["status"] == "identified"


def test_scope_narrowing_blocks_update_of_older_incident(env):
    a, b = _pages(env, "a", "b")
    created = _new_token(env, [a, b])
    secret = created["secret"]
    incident_id = _call(env, "POST", "/incidents", secret, _incident(pages=["a", "b"])).json()["id"]

    with env.Session() as db:
        db.delete(db.get(StatusIntegrationTokenPage, (created["id"], b)))
        db.commit()

    update = _call(env, "POST", f"/incidents/{incident_id}/updates", secret, {"message": "Still failing"})
    assert update.status_code == 404 and update.json() == NOT_FOUND
    resolved = _call(env, "POST", f"/incidents/{incident_id}/resolve", secret, {})
    assert resolved.status_code == 404 and resolved.json() == NOT_FOUND
    assert _count(env, StatusIncidentUpdate, StatusIncidentUpdate.incident_id == incident_id) == 1
    with env.Session() as db:
        assert db.get(StatusIncident, incident_id).status == "investigating"

    assert _call(env, "POST", "/incidents", secret, _incident(pages=["b"])).status_code == 403
    newer = _call(env, "POST", "/incidents", secret, _incident(pages=["a"])).json()["id"]
    assert _call(env, "POST", f"/incidents/{newer}/resolve", secret, {}).status_code == 200


def test_revoked_expired_or_creator_disabled_token_is_401_immediately(env):
    (a,) = _pages(env, "a")

    revoked = _new_token(env, [a], name="revoked")
    assert _call(env, "PUT", "/pages/a/notice", revoked["secret"], _notice()).status_code == 200
    assert _admin(env, "DELETE", f"/tokens/{revoked['id']}").status_code == 204
    response = _call(env, "PUT", "/pages/a/notice", revoked["secret"], _notice("Again"))
    assert response.status_code == 401 and response.json() == INVALID

    expired = _new_token(env, [a], name="expired")
    assert _call(env, "PUT", "/pages/a/notice", expired["secret"], _notice()).status_code == 200
    with env.Session() as db:
        db.get(StatusIntegrationToken, expired["id"]).expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.commit()
    response = _call(env, "DELETE", "/pages/a/notice", expired["secret"])
    assert response.status_code == 401 and response.json() == INVALID

    with env.Session() as db:
        creator = _user(db, "temp", UserRole.NETWORK_ADMIN)
        _, temp_key = create_api_key(db, creator, "temp", None)
        db.commit()
        creator_id = creator.id
    disabled = _new_token(env, [a], name="disabled", key=temp_key)
    assert _call(env, "PUT", "/pages/a/notice", disabled["secret"], _notice()).status_code == 200
    with env.Session() as db:
        db.get(User, creator_id).is_active = False
        db.commit()
    response = _call(env, "PUT", "/pages/a/notice", disabled["secret"], _notice("Again"))
    assert response.status_code == 401 and response.json() == INVALID

    good = _new_token(env, [a], name="good")["secret"]
    assert _call(env, "PUT", "/pages/a/notice", good, _notice()).status_code == 200
    wrong = good[:-4] + ("AAAA" if not good.endswith("AAAA") else "BBBB")
    for bad in (wrong, "nmsp_", "nmsp_x_y", "garbage"):
        response = _call(env, "PUT", "/pages/a/notice", bad, _notice())
        assert response.status_code == 401 and response.json() == INVALID
    assert _call(env, "PUT", "/pages/a/notice", None, _notice()).json() == INVALID

    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    assert _admin(env, "POST", "/tokens", json={"name": "late", "page_ids": [a], "expires_at": past}).status_code == 422


def test_creator_losing_permission_disables_token(env):
    (a,) = _pages(env, "a")
    with env.Session() as db:
        creator = _user(db, "lead", UserRole.NETWORK_ADMIN)
        _, key = create_api_key(db, creator, "lead", None)
        db.commit()
        creator_id = creator.id
    secret = _new_token(env, [a], key=key)["secret"]
    assert _call(env, "PUT", "/pages/a/notice", secret, _notice()).status_code == 200

    with env.Session() as db:
        db.get(User, creator_id).role = UserRole.VIEWER
        db.commit()
    response = _call(env, "PUT", "/pages/a/notice", secret, _notice("Again"))
    assert response.status_code == 401 and response.json() == INVALID

    with env.Session() as db:
        db.get(User, creator_id).role = UserRole.SUPER_ADMIN
        db.commit()
    assert _call(env, "PUT", "/pages/a/notice", secret, _notice("Back")).status_code == 200

    assert _admin(env, "POST", "/tokens", key=env.viewer_key, json={"name": "x", "page_ids": [a]}).status_code == 403


def test_retry_with_same_idempotency_key_returns_original(env):
    (a,) = _pages(env, "a")
    secret = _new_token(env, [a])["secret"]
    body = _incident(pages=["a"])

    first = _call(env, "POST", "/incidents", secret, body, key="open-1")
    assert first.status_code == 201
    again = _call(env, "POST", "/incidents", secret, body, key="open-1")
    assert again.status_code == 201 and again.json() == first.json()
    assert again.headers.get("Idempotent-Replayed") == "true"
    assert _count(env, StatusIncident) == 1

    changed = _call(env, "POST", "/incidents", secret, _incident(pages=["a"], title="Other"), key="open-1")
    assert changed.status_code == 422
    assert _count(env, StatusIncident) == 1

    missing = _call(env, "POST", "/incidents", secret, body, key=None)
    assert missing.status_code == 400 and missing.json() == {"detail": "Idempotency-Key header is required"}
    assert _call(env, "POST", "/incidents", secret, body, key="x" * 121).status_code == 400
    assert _count(env, StatusIncident) == 1

    incident_id = first.json()["id"]
    update = {"message": "Retrying now"}
    u1 = _call(env, "POST", f"/incidents/{incident_id}/updates", secret, update, key="open-1")
    u2 = _call(env, "POST", f"/incidents/{incident_id}/updates", secret, update, key="open-1")
    assert u1.status_code == u2.status_code == 201 and u1.json() == u2.json()
    assert _count(env, StatusIncidentUpdate, StatusIncidentUpdate.incident_id == incident_id) == 2

    r1 = _call(env, "POST", f"/incidents/{incident_id}/resolve", secret, {}, key="done")
    r2 = _call(env, "POST", f"/incidents/{incident_id}/resolve", secret, {}, key="done")
    assert r1.status_code == r2.status_code == 200 and r1.json() == r2.json()
    assert _call(env, "POST", f"/incidents/{incident_id}/resolve", secret, {}, key="done-again").status_code == 409

    n1 = _call(env, "PUT", "/pages/a/notice", secret, _notice(), key="n")
    n2 = _call(env, "PUT", "/pages/a/notice", secret, _notice(), key="n")
    assert n1.status_code == n2.status_code == 200 and n1.json() == n2.json()

    other = _new_token(env, [a], name="other")["secret"]
    assert _call(env, "POST", "/incidents", other, body, key="open-1").status_code == 201
    assert _count(env, StatusIncident) == 2


def test_concurrent_duplicate_key_does_not_write_twice(env, monkeypatch):
    (a,) = _pages(env, "a")
    secret = _new_token(env, [a])["secret"]
    body = _incident(pages=["a"])
    first = _call(env, "POST", "/incidents", secret, body, key="race")
    assert first.status_code == 201

    real = integrations_api._find_key
    seen = {"n": 0}

    def blind_first(db, token_id, operation, key):
        seen["n"] += 1
        return None if seen["n"] == 1 else real(db, token_id, operation, key)

    monkeypatch.setattr(integrations_api, "_find_key", blind_first)
    again = _call(env, "POST", "/incidents", secret, body, key="race")
    assert seen["n"] == 2
    assert again.status_code == 201 and again.json() == first.json()
    assert _count(env, StatusIncident) == 1

    with env.Session() as db:
        token_id = db.scalar(select(StatusIntegrationToken.id))
        db.add(StatusIdempotencyKey(token_id=token_id, operation="incident_opened", key="pending", result_json=None))
        db.commit()
    monkeypatch.setattr(integrations_api, "_find_key", real)
    pending = _call(env, "POST", "/incidents", secret, body, key="pending")
    assert pending.status_code == 409
    assert _count(env, StatusIncident) == 1


def test_token_cannot_update_netmap_or_person_incidents(env):
    (a,) = _pages(env, "a")
    secret = _new_token(env, [a])["secret"]
    with env.Session() as db:
        person = incidents.open_manual_incident(
            db, PersonActor(db.get(User, env.admin_id)), "Planned", "partial", "Hello", True, [a], [], None,
        ).id
        netmap = incidents.open_manual_incident(db, NetmapActor(), "Auto", "major", "Down", True, [a], [], None).id

    for incident_id in (person, netmap):
        update = _call(env, "POST", f"/incidents/{incident_id}/updates", secret, {"message": "Mine now"})
        assert update.status_code == 404 and update.json() == NOT_FOUND
        resolved = _call(env, "POST", f"/incidents/{incident_id}/resolve", secret, {})
        assert resolved.status_code == 404 and resolved.json() == NOT_FOUND
    with env.Session() as db:
        assert {i.status for i in db.scalars(select(StatusIncident))} == {"investigating"}
        assert db.scalar(select(func.count()).select_from(StatusIncidentUpdate)) == 2

    with env.Session() as db:
        db.add(StatusNotice(page_id=a, owner_kind="user", owner_id=env.admin_id, level="info", title="Person notice"))
        db.commit()
    assert _call(env, "DELETE", "/pages/a/notice", secret).json() == NOT_FOUND
    assert _count(env, StatusNotice) == 1


def test_every_call_is_audited_with_token_name(env):
    (a,) = _pages(env, "a")
    _pages(env, "b")
    secret = _new_token(env, [a])["secret"]
    env.calls.clear()

    assert _call(env, "PUT", "/pages/a/notice", secret, _notice()).status_code == 200
    assert env.calls == [[a]]
    assert _call(env, "DELETE", "/pages/a/notice", secret).status_code == 204
    incident_id = _call(env, "POST", "/incidents", secret, _incident(pages=["a"])).json()["id"]
    assert _call(env, "POST", f"/incidents/{incident_id}/updates", secret, {"message": "More"}).status_code == 201
    assert _call(env, "POST", f"/incidents/{incident_id}/resolve", secret, {"reason": "Fixed"}).status_code == 200
    assert _call(env, "PUT", "/pages/b/notice", secret, _notice()).status_code == 403
    assert env.calls == [[a]] * 5

    with env.Session() as db:
        rows = db.scalars(select(AuditLog).where(AuditLog.action.like("status_integration.%")).order_by(AuditLog.id)).all()
    assert [r.action for r in rows] == [
        "status_integration.notice_set",
        "status_integration.notice_cleared",
        "status_integration.incident_opened",
        "status_integration.incident_updated",
        "status_integration.incident_resolved",
        "status_integration.notice_set",
    ]
    assert {r.target for r in rows} == {"token:backup-server"}
    with env.Session() as db:
        token_id = db.scalar(select(StatusIntegrationToken.id))
    assert all(r.detail.startswith(f"token_id={token_id} ") for r in rows)
    assert "refused=403" in rows[-1].detail


def test_write_rate_limit_is_per_token(env):
    (a,) = _pages(env, "a")
    secret = _new_token(env, [a])["secret"]
    other = _new_token(env, [a], name="other")["secret"]
    for _ in range(tokens.WRITE_LIMIT):
        assert _call(env, "PUT", "/pages/a/notice", secret, _notice()).status_code == 200
    limited = _call(env, "PUT", "/pages/a/notice", secret, _notice())
    assert limited.status_code == 429
    assert 1 <= int(limited.headers["Retry-After"]) <= 60
    assert _call(env, "PUT", "/pages/a/notice", other, _notice()).status_code == 200

    limiter = tokens.WriteLimiter(limit=2, window=60)
    assert limiter.check(1, now=0) is None and limiter.check(1, now=1) is None
    assert limiter.check(1, now=2) == 58
    assert limiter.check(1, now=60.5) is None


def test_token_admin_routes_show_secret_once_and_sit_before_page_routes(env):
    a, b = _pages(env, "a", "b")
    created = _new_token(env, [b, a, a], name="  backup-server  ")
    assert created["name"] == "backup-server"
    assert created["name_is_public"] is True
    assert created["page_ids"] == [a, b]
    assert created["secret"].startswith(f"nmsp_{created['prefix']}_")

    listed = _admin(env, "GET", "/tokens")
    assert listed.status_code == 200
    (row,) = listed.json()
    assert "secret" not in row and "hash" not in row
    assert row["active"] is True and row["page_ids"] == [a, b] and row["created_by"] == "admin"
    with env.Session() as db:
        stored = db.get(StatusIntegrationToken, created["id"])
        assert stored.hash != created["secret"] and created["secret"] not in stored.hash
        assert stored.created_by_user_id == env.admin_id

    assert _admin(env, "POST", "/tokens", json={"name": "x", "page_ids": [9999]}).status_code == 422
    assert _admin(env, "POST", "/tokens", json={"name": " ", "page_ids": [a]}).status_code == 422
    assert _admin(env, "POST", "/tokens", json={"name": "x", "page_ids": []}).status_code == 422
    assert _admin(env, "GET", "/tokens", key=env.viewer_key).status_code == 403
    assert _admin(env, "DELETE", "/tokens/9999").status_code == 404
    assert _admin(env, "DELETE", f"/tokens/{created['id']}").status_code == 204
    assert _admin(env, "GET", "/tokens").json()[0]["active"] is False

    with env.Session() as db:
        assert db.scalar(select(func.count()).select_from(AuditLog).where(
            AuditLog.action.in_(["status_integration_token.created", "status_integration_token.revoked"])
        )) == 2


def test_notice_slot_is_per_token_and_page(env):
    a, b = _pages(env, "a", "b")
    secret = _new_token(env, [a, b])["secret"]
    with env.Session() as db:
        db.add(StatusNotice(page_id=a, owner_kind="user", owner_id=env.admin_id, level="info", title="Person"))
        db.commit()
    first = _call(env, "PUT", "/pages/a/notice", secret, _notice("One"))
    second = _call(env, "PUT", "/pages/a/notice", secret, {"level": "critical", "title": "Two", "link": "https://x.test/"})
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["title"] == "Two" and second.json()["page"] == "a"
    assert _call(env, "PUT", "/pages/b/notice", secret, _notice("Other page")).status_code == 200
    assert _count(env, StatusNotice) == 3
    bad = _call(env, "PUT", "/pages/a/notice", secret, {"level": "info", "title": "x", "link": "javascript:alert(1)"})
    assert bad.status_code == 422
    assert _call(env, "DELETE", "/pages/a/notice", secret).status_code == 204
    assert _call(env, "DELETE", "/pages/a/notice", secret).json() == NOT_FOUND
    assert _count(env, StatusNotice) == 2


def test_deleting_a_page_removes_it_from_token_scope(env):
    a, b = _pages(env, "a", "b")
    created = _new_token(env, [a, b])
    assert _admin(env, "DELETE", f"/{b}").status_code == 204
    assert _count(env, StatusIntegrationTokenPage) == 1
    assert _admin(env, "GET", "/tokens").json()[0]["page_ids"] == [a]
    assert _call(env, "PUT", "/pages/a/notice", created["secret"], _notice()).status_code == 200
    assert _count(env, StatusIncidentPage) == 0


def _refusals(env):
    with env.Session() as db:
        return [
            (r.action, r.detail) for r in db.scalars(
                select(AuditLog).where(AuditLog.detail.like("%refused=%")).order_by(AuditLog.id)
            )
        ]


def test_refused_idempotency_and_validation_calls_are_audited(env):
    (a,) = _pages(env, "a")
    created = _new_token(env, [a])
    secret = created["secret"]
    body = _incident(pages=["a"])
    assert _call(env, "POST", "/incidents", secret, body, key=None).status_code == 400
    assert _call(env, "POST", "/incidents", secret, body, key="x" * 121).status_code == 400
    assert _call(env, "POST", "/incidents", secret, body, key="same").status_code == 201
    assert _call(env, "POST", "/incidents", secret, _incident(pages=["a"], title="Changed"), key="same").status_code == 422
    with env.Session() as db:
        db.add(StatusIdempotencyKey(token_id=created["id"], operation="notice_set:a", key="busy", result_json=None))
        db.commit()
    assert _call(env, "PUT", "/pages/a/notice", secret, _notice(), key="busy").status_code == 409
    invalid = _call(env, "POST", "/incidents", secret, _incident(pages=["a"], severity="apocalyptic"))
    assert invalid.status_code == 422 and isinstance(invalid.json()["detail"], list)
    assert _call(env, "POST", "/incidents/abc/resolve", secret, {}).status_code == 422

    refusals = _refusals(env)
    assert [(action, detail.rsplit("refused=", 1)[1]) for action, detail in refusals] == [
        ("status_integration.incident_opened", "400"),
        ("status_integration.incident_opened", "400"),
        ("status_integration.incident_opened", "422"),
        ("status_integration.notice_set", "409"),
        ("status_integration.incident_opened", "422"),
        ("status_integration.incident_resolved", "422"),
    ]
    assert all(detail.startswith(f"token_id={created['id']} ") for _, detail in refusals)

    assert _call(env, "PUT", "/pages/a/notice", "nmsp_bad_secret", {"level": "nope"}).status_code == 401
    assert len(_refusals(env)) == len(refusals)


def test_repeated_bad_secrets_lock_out_the_source_ip(env, monkeypatch):
    (a,) = _pages(env, "a")
    secret = _new_token(env, [a])["secret"]
    monkeypatch.setattr(settings, "api_key_max_failed_lookups", 3)
    bad = secret[:-4] + ("AAAA" if not secret.endswith("AAAA") else "BBBB")

    for _ in range(2):
        assert _call(env, "PUT", "/pages/a/notice", bad, _notice()).status_code == 401
    assert _call(env, "PUT", "/pages/a/notice", secret, _notice()).status_code == 200
    for _ in range(2):
        assert _call(env, "PUT", "/pages/a/notice", bad, _notice()).status_code == 401
    assert _call(env, "PUT", "/pages/a/notice", secret, _notice()).status_code == 200

    for _ in range(3):
        assert _call(env, "PUT", "/pages/a/notice", bad, _notice()).status_code == 401
    locked = _call(env, "PUT", "/pages/a/notice", secret, _notice())
    assert locked.status_code == 429
    assert locked.json() == {"detail": "Too many failed status integration token attempts; try again later"}
    assert env.client.get("/api/v1/whoami", headers={"X-API-Key": env.admin_key}).status_code == 429
    with env.Session() as db:
        (row,) = db.scalars(select(AuditLog).where(AuditLog.action == "status_integration.auth_failed")).all()
        assert row.target == "ip:testclient"


def test_token_without_pages_is_listed_inactive(env):
    a, b = _pages(env, "a", "b")
    _new_token(env, [a])
    _new_token(env, [b], name="other")
    assert _admin(env, "DELETE", f"/{a}").status_code == 204
    listed = {row["name"]: row for row in _admin(env, "GET", "/tokens").json()}
    assert listed["backup-server"]["page_ids"] == [] and listed["backup-server"]["active"] is False
    assert listed["other"]["active"] is True


def test_token_validation_raises_token_error_and_api_key_format_is_unchanged(env, monkeypatch):
    with env.Session() as db:
        creator = db.get(User, env.admin_id)
        with pytest.raises(tokens.TokenError):
            tokens.create_token(db, creator, "x", [9999], None)
        with pytest.raises(tokens.TokenError):
            tokens.create_token(db, creator, " ", [], None)

    parts = iter(["P" * 12, "S" * 43])
    monkeypatch.setattr(api_key_service, "_random_token", lambda length: next(parts))
    full, prefix, digest = api_key_service.generate_api_key()
    assert (full, prefix) == (f"nm_{'P' * 12}_{'S' * 43}", "P" * 12)
    assert digest == api_key_service.hash_key(full)

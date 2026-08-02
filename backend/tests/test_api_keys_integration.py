"""Route-level tests proving API-key auth works through the shared dependency chain.

A minimal FastAPI app mounts the real api-keys + dashboard routers (plus one
route using the real ``require_topology_write`` dependency) over an in-memory
database, mirroring the harness in ``test_oidc_flow.py``.
"""

from datetime import datetime, timedelta, timezone
from typing import Annotated

import anyio
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import require_topology_write
from app.api.v1 import api_keys as api_keys_api
from app.api.v1 import dashboard as dashboard_api
from app.core.security import hash_password
from app.db.session import Base, get_db
from app.middleware.csrf import CsrfProtectionMiddleware
from app.models.api_key import ApiKey, ApiKeyThrottleState
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.relationship import DeviceRelationship
from app.models.topology_group import TopologyGroup
from app.models.user import User, UserRole
from app.services.api_keys.service import create_api_key


def _session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    from app.models import alert_rule, api_key, auth_session, audit_log, device, device_type, dhcp_lease, discovery, ip_reservation, monitor_history, notification_delivery, notification_profile, oidc, password_reset_token, port_target, relationship, saved_search, site, snmp_profile, subnet, system_setting, topology_group, topology_layout, user, user_device_favourite  # noqa: F401

    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            AuditLog.__table__,
            ApiKey.__table__,
            ApiKeyThrottleState.__table__,
            Device.__table__,
            TopologyGroup.__table__,
            DeviceRelationship.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


@pytest.fixture()
def client_and_db():
    session_factory = _session_factory()

    app = FastAPI()
    app.include_router(api_keys_api.router, prefix="/api/v1")
    app.include_router(dashboard_api.router, prefix="/api/v1")

    @app.post("/api/v1/test-write")
    def write_gated(_current_user: Annotated[User, Depends(require_topology_write)]) -> dict[str, str]:
        return {"status": "written"}

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app, base_url="http://testserver")
    db = session_factory()
    try:
        yield client, db
    finally:
        db.close()


def _make_user(db, username: str, role: UserRole, is_active: bool = True) -> User:
    account = User(
        username=username,
        password_hash=hash_password("Password123!"),
        role=role,
        is_active=is_active,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def _make_key(db, user: User, name: str = "test", expires_in_days: int | None = None) -> tuple[ApiKey, str]:
    key, plaintext = create_api_key(db, user, name=name, expires_in_days=expires_in_days)
    db.commit()
    return key, plaintext


def test_api_key_authenticates_protected_route(client_and_db):
    client, db = client_and_db
    user = _make_user(db, "viewer", UserRole.VIEWER)
    key, plaintext = _make_key(db, user)
    key.suffix = None
    db.commit()

    response = client.get("/api/v1/dashboard/summary", headers={"X-API-Key": plaintext})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["user_count"] == 1
    assert response.headers["content-type"].startswith("application/json")
    db.expire_all()
    assert db.get(ApiKey, key.id).suffix == plaintext[-4:]


def test_request_without_credentials_is_rejected(client_and_db):
    client, _db = client_and_db
    assert client.get("/api/v1/dashboard/summary").status_code == 401


def test_invalid_key_is_rejected(client_and_db):
    client, db = client_and_db
    user = _make_user(db, "viewer", UserRole.VIEWER)
    key, plaintext = _make_key(db, user)
    tampered = f"nm_{key.prefix}_" + "A" * 43
    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": tampered}).status_code == 401


def test_revoked_key_is_rejected(client_and_db):
    client, db = client_and_db
    user = _make_user(db, "viewer", UserRole.VIEWER)
    key, plaintext = _make_key(db, user)

    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": plaintext}).status_code == 200
    key.revoked_at = datetime.now(timezone.utc)
    db.commit()
    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": plaintext}).status_code == 401


def test_expired_key_is_rejected(client_and_db):
    client, db = client_and_db
    user = _make_user(db, "viewer", UserRole.VIEWER)
    key, plaintext = _make_key(db, user, expires_in_days=30)
    key.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.commit()
    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": plaintext}).status_code == 401


def test_inactive_user_key_is_rejected(client_and_db):
    client, db = client_and_db
    user = _make_user(db, "viewer", UserRole.VIEWER)
    _, plaintext = _make_key(db, user)
    user.is_active = False
    db.commit()
    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": plaintext}).status_code == 401


def test_role_inheritance_gates_write_routes(client_and_db):
    client, db = client_and_db
    viewer = _make_user(db, "viewer", UserRole.VIEWER)
    admin = _make_user(db, "admin", UserRole.SUPER_ADMIN)
    _, viewer_key = _make_key(db, viewer)
    _, admin_key = _make_key(db, admin)

    assert client.post("/api/v1/test-write", headers={"X-API-Key": viewer_key}).status_code == 403
    assert client.post("/api/v1/test-write", headers={"X-API-Key": admin_key}).status_code == 200


def test_key_lifecycle_via_routes(client_and_db):
    client, db = client_and_db
    user = _make_user(db, "owner", UserRole.VIEWER)
    _, session_key = _make_key(db, user, name="bootstrap")

    created = client.post(
        "/api/v1/api-keys",
        headers={"X-API-Key": session_key},
        json={"name": "integration", "expires_in_days": 30},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["key"].startswith("nm_")
    assert body["name"] == "integration"
    assert body["suffix"] == body["key"][-4:]
    assert body["expires_at"] is not None

    listed = client.get("/api/v1/api-keys", headers={"X-API-Key": session_key})
    assert listed.status_code == 200
    names = {row["name"] for row in listed.json()}
    assert names == {"bootstrap", "integration"}
    assert all(len(row["suffix"]) == 4 for row in listed.json())
    assert all("key" not in row and "key_hash" not in row for row in listed.json())

    revoked = client.delete(f"/api/v1/api-keys/{body['id']}", headers={"X-API-Key": session_key})
    assert revoked.status_code == 204
    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": body["key"]}).status_code == 401

    audit_actions = [row.action for row in db.scalars(select(AuditLog)).all()]
    assert "apikey.created" in audit_actions
    assert "apikey.revoked" in audit_actions


def test_cross_user_revoke_returns_404(client_and_db):
    client, db = client_and_db
    owner = _make_user(db, "owner", UserRole.VIEWER)
    intruder = _make_user(db, "intruder", UserRole.VIEWER)
    victim_key, _ = _make_key(db, owner, name="victim")
    _, intruder_session = _make_key(db, intruder)

    response = client.delete(f"/api/v1/api-keys/{victim_key.id}", headers={"X-API-Key": intruder_session})
    assert response.status_code == 404
    db.expire_all()
    assert db.get(ApiKey, victim_key.id).revoked_at is None


def test_admin_can_list_and_revoke_any_key(client_and_db):
    client, db = client_and_db
    owner = _make_user(db, "owner", UserRole.VIEWER)
    admin = _make_user(db, "admin", UserRole.SUPER_ADMIN)
    victim_key, _ = _make_key(db, owner, name="victim")
    _, admin_session = _make_key(db, admin)

    listed = client.get("/api/v1/api-keys/admin/all", headers={"X-API-Key": admin_session})
    assert listed.status_code == 200
    rows = listed.json()
    assert {row["username"] for row in rows} == {"owner", "admin"}

    revoked = client.delete(f"/api/v1/api-keys/admin/{victim_key.id}", headers={"X-API-Key": admin_session})
    assert revoked.status_code == 204
    db.expire_all()
    assert db.get(ApiKey, victim_key.id).revoked_at is not None


def test_non_admin_cannot_use_admin_routes(client_and_db):
    client, db = client_and_db
    viewer = _make_user(db, "viewer", UserRole.VIEWER)
    _, viewer_session = _make_key(db, viewer)
    assert client.get("/api/v1/api-keys/admin/all", headers={"X-API-Key": viewer_session}).status_code == 403


def test_rate_limit_returns_429(client_and_db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "api_key_rate_limit_max_calls", 3)
    client, db = client_and_db
    user = _make_user(db, "busy", UserRole.VIEWER)
    _, plaintext = _make_key(db, user)

    for _ in range(3):
        assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": plaintext}).status_code == 200
    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": plaintext}).status_code == 429


def test_failed_lookup_lockout_returns_429(client_and_db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "api_key_max_failed_lookups", 3)
    client, db = client_and_db
    user = _make_user(db, "viewer", UserRole.VIEWER)
    key, plaintext = _make_key(db, user)
    tampered = f"nm_{key.prefix}_" + "A" * 43

    for _ in range(3):
        assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": tampered}).status_code == 401
    # Locked out now: even the valid key from the same source is refused pre-verification.
    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": plaintext}).status_code == 429
    audit_actions = [row.action for row in db.scalars(select(AuditLog)).all()]
    assert "apikey.auth_failed" in audit_actions


async def _csrf_response_status(headers: dict[str, str]) -> int:
    async def ok_app(scope, receive, send):
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    middleware = CsrfProtectionMiddleware(ok_app)
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/v1/api-keys",
        "headers": [(key.lower().encode("latin1"), value.encode("latin1")) for key, value in headers.items()],
    }
    await middleware(scope, receive, send)
    return next(message["status"] for message in messages if message["type"] == "http.response.start")


def test_csrf_exempts_api_key_requests() -> None:
    status = anyio.run(_csrf_response_status, {"x-api-key": "nm_prefix_secret"})
    assert status == 204


def test_csrf_still_blocks_cookie_requests_without_token() -> None:
    status = anyio.run(_csrf_response_status, {"cookie": "netmap_access=access-token"})
    assert status == 403

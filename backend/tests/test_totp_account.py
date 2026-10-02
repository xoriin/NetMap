import time

import pyotp
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import auth as auth_api
from app.core.security import create_access_token, hash_password
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.system_setting import SystemSetting
from app.models.user import User
from tests.oidc_helpers import memory_session_factory

PASSWORD = "correct horse battery"


@pytest.fixture()
def client_and_db(monkeypatch):
    monkeypatch.setattr(auth_api, "apply_progressive_delay", lambda _attempts: None)
    session_factory = memory_session_factory()
    app = FastAPI()
    app.include_router(auth_api.router, prefix="/api/v1")

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    db = session_factory()
    try:
        yield TestClient(app, base_url="http://testserver"), db
    finally:
        db.close()


def _signed_in(db, role="Viewer"):
    user = User(username="alice", password_hash=hash_password(PASSWORD), role=role, is_active=True)
    db.add(user)
    db.commit()
    return user, {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _enrol(client, headers):
    secret = client.post("/api/v1/auth/me/totp/setup", headers=headers).json()["secret"]
    response = client.post("/api/v1/auth/me/totp/confirm", headers=headers, json={"code": pyotp.TOTP(secret).at(time.time() - 30)})
    assert response.status_code == 200
    return secret, response.json()["recovery_codes"]


def test_me_reports_totp_state(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db)
    body = client.get("/api/v1/auth/me", headers=headers).json()
    assert (body["totp_enabled"], body["totp_required"], body["recovery_codes_remaining"]) == (False, False, 0)
    _enrol(client, headers)
    body = client.get("/api/v1/auth/me", headers=headers).json()
    assert (body["totp_enabled"], body["recovery_codes_remaining"]) == (True, 10)


def test_setup_is_refused_when_already_enabled(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db)
    _enrol(client, headers)
    assert client.post("/api/v1/auth/me/totp/setup", headers=headers).status_code == 409


def test_disable_requires_password_and_code(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db)
    secret, _codes = _enrol(client, headers)
    code = pyotp.TOTP(secret).now()
    assert client.request("DELETE", "/api/v1/auth/me/totp", headers=headers, json={"password": "wrong password!", "code": code}).status_code == 401
    assert client.request("DELETE", "/api/v1/auth/me/totp", headers=headers, json={"password": PASSWORD, "code": "000000"}).status_code == 401
    assert client.request("DELETE", "/api/v1/auth/me/totp", headers=headers, json={"password": PASSWORD, "code": code}).status_code == 204
    assert client.get("/api/v1/auth/me", headers=headers).json()["totp_enabled"] is False


def test_disable_is_refused_when_required_for_the_role(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db, role="SuperAdmin")
    secret, _codes = _enrol(client, headers)
    db.add(SystemSetting(key="totp_required", value="admins"))
    db.commit()
    response = client.request("DELETE", "/api/v1/auth/me/totp", headers=headers, json={"password": PASSWORD, "code": pyotp.TOTP(secret).now()})
    assert response.status_code == 403
    assert client.get("/api/v1/auth/me", headers=headers).json()["totp_required"] is True


def test_regenerate_requires_password_and_code(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db)
    secret, old = _enrol(client, headers)
    assert client.post("/api/v1/auth/me/totp/recovery-codes", headers=headers, json={"password": PASSWORD, "code": "000000"}).status_code == 401
    response = client.post("/api/v1/auth/me/totp/recovery-codes", headers=headers, json={"password": PASSWORD, "code": pyotp.TOTP(secret).now()})
    assert response.status_code == 200
    assert set(response.json()["recovery_codes"]).isdisjoint(old)


def test_password_change_leaves_totp_enabled(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db)
    _enrol(client, headers)
    response = client.post("/api/v1/auth/change-password", headers=headers, json={"current_password": PASSWORD, "new_password": "another long password"})
    assert response.status_code == 204
    db.expire_all()
    assert db.query(User).filter_by(username="alice").one().totp_enabled is True


def test_failed_disable_is_audited(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db)
    _enrol(client, headers)
    client.request("DELETE", "/api/v1/auth/me/totp", headers=headers, json={"password": PASSWORD, "code": "000000"})
    actions = [a.action for a in db.query(AuditLog).all()]
    assert "auth.mfa_verify_failed" in actions


def test_repeated_failures_are_throttled(client_and_db, monkeypatch):
    client, db = client_and_db
    monkeypatch.setattr(auth_api.settings, "auth_max_failed_attempts", 3, raising=False)
    _user, headers = _signed_in(db)
    secret, _codes = _enrol(client, headers)
    body = {"password": PASSWORD, "code": "000000"}
    statuses = [client.post("/api/v1/auth/me/totp/recovery-codes", headers=headers, json=body).status_code for _ in range(4)]
    assert statuses[:3] == [401, 401, 401]
    assert statuses[3] == 429
    good = {"password": PASSWORD, "code": pyotp.TOTP(secret).now()}
    assert client.post("/api/v1/auth/me/totp/recovery-codes", headers=headers, json=good).status_code == 429


def test_wrong_password_does_not_consume_a_code(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db)
    secret, codes = _enrol(client, headers)
    totp_code = pyotp.TOTP(secret).now()
    for code in (codes[0], totp_code):
        response = client.request("DELETE", "/api/v1/auth/me/totp", headers=headers, json={"password": "wrong password!", "code": code})
        assert response.status_code == 401
    assert client.get("/api/v1/auth/me", headers=headers).json()["recovery_codes_remaining"] == 10
    assert client.request("DELETE", "/api/v1/auth/me/totp", headers=headers, json={"password": PASSWORD, "code": totp_code}).status_code == 204


def test_current_user_responses_report_totp_required(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db, role="SuperAdmin")
    db.add(SystemSetting(key="totp_required", value="admins"))
    db.commit()
    patched = client.patch("/api/v1/auth/me", headers=headers, json={"display_name": "Alice"})
    assert patched.json()["totp_required"] is True
    acked = client.post("/api/v1/auth/me/acknowledge-whats-new", headers=headers, json={"version": "1.0.0"})
    assert acked.json()["totp_required"] is True


def test_admin_reset_clears_totp_revokes_sessions_and_audits(client_and_db):
    from app.core.security import create_refresh_token
    from app.models.auth_session import RefreshTokenState
    from app.services.auth import register_refresh_token

    client, db = client_and_db
    _user, user_headers = _signed_in(db)
    _enrol(client, user_headers)
    target = db.query(User).filter_by(username="alice").one()
    register_refresh_token(db, user_id=target.id, refresh_token=create_refresh_token(target.id), client_ip=None)
    admin = User(username="root-admin", password_hash=hash_password(PASSWORD), role="SuperAdmin", is_active=True)
    db.add(admin)
    db.commit()
    admin_headers = {"Authorization": f"Bearer {create_access_token(admin.id)}"}

    assert client.delete(f"/api/v1/auth/users/{target.id}/totp", headers=user_headers).status_code == 403
    assert client.delete(f"/api/v1/auth/users/{target.id}/totp", headers=admin_headers).status_code == 204
    assert client.delete("/api/v1/auth/users/99999/totp", headers=admin_headers).status_code == 404

    db.expire_all()
    assert db.get(User, target.id).totp_enabled is False
    assert all(row.revoked_at is not None for row in db.query(RefreshTokenState).filter_by(user_id=target.id))
    assert "auth.mfa_reset" in [a.action for a in db.query(AuditLog).all()]


def test_requirement_setting_round_trips_and_is_validated(client_and_db):
    from pydantic import ValidationError

    from app.api.v1 import admin as admin_api
    from app.schemas.admin import SystemSettingsUpdate

    assert SystemSettingsUpdate(totp_required="admins").totp_required == "admins"
    with pytest.raises(ValidationError):
        SystemSettingsUpdate(totp_required="sometimes")

    client, db = client_and_db
    app = client.app
    app.include_router(admin_api.router, prefix="/api/v1")
    _user, user_headers = _signed_in(db)
    admin = User(username="root-admin", password_hash=hash_password(PASSWORD), role="SuperAdmin", is_active=True)
    db.add(admin)
    db.commit()
    admin_headers = {"Authorization": f"Bearer {create_access_token(admin.id)}"}

    assert client.get("/api/v1/admin/settings", headers=admin_headers).json()["totp_required"] == "off"
    assert client.put("/api/v1/admin/settings", headers=user_headers, json={"totp_required": "all"}).status_code == 403
    assert client.put("/api/v1/admin/settings", headers=admin_headers, json={"totp_required": "bogus"}).status_code == 422
    put = client.put("/api/v1/admin/settings", headers=admin_headers, json={"totp_required": "admins"})
    assert put.status_code == 200 and put.json()["totp_required"] == "admins"
    assert client.get("/api/v1/admin/settings", headers=admin_headers).json()["totp_required"] == "admins"


def test_changing_the_2fa_requirement_is_audited(client_and_db):
    from app.api.v1 import admin as admin_api

    client, db = client_and_db
    client.app.include_router(admin_api.router, prefix="/api/v1")
    admin = User(username="root-admin", password_hash=hash_password(PASSWORD), role="SuperAdmin", is_active=True)
    db.add(admin)
    db.commit()
    headers = {"Authorization": f"Bearer {create_access_token(admin.id)}"}

    assert client.put("/api/v1/admin/settings", headers=headers, json={"totp_required": "admins"}).status_code == 200
    assert client.put("/api/v1/admin/settings", headers=headers, json={"totp_required": "admins"}).status_code == 200
    assert client.put("/api/v1/admin/settings", headers=headers, json={"totp_required": "all"}).status_code == 200
    assert client.put("/api/v1/admin/settings", headers=headers, json={"idle_timeout_minutes": 30}).status_code == 200

    db.expire_all()
    changes = db.query(AuditLog).filter(AuditLog.action == "admin.totp_required_changed").order_by(AuditLog.id).all()
    assert [(c.actor_user_id, c.detail) for c in changes] == [
        (admin.id, "from=off to=admins"),
        (admin.id, "from=admins to=all"),
    ]

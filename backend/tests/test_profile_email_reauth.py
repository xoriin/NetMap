import time

import pyotp
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import auth as auth_api
from app.core.security import create_access_token, hash_password, verify_password
from app.db.session import get_db
from app.models.audit_log import AuditLog
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


def _signed_in(db):
    user = User(
        username="alice", password_hash=hash_password(PASSWORD), role="Viewer", is_active=True, email="alice@example.com"
    )
    db.add(user)
    db.commit()
    return user, {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _enrol(client, headers):
    secret = client.post("/api/v1/auth/me/totp/setup", headers=headers, json={"password": PASSWORD}).json()["secret"]
    response = client.post(
        "/api/v1/auth/me/totp/confirm", headers=headers, json={"code": pyotp.TOTP(secret).at(time.time() - 30)}
    )
    assert response.status_code == 200
    # Enabling 2FA ends the old session; carry on with the reissued token.
    headers["Authorization"] = f"Bearer {response.json()['access_token']}"
    return secret


def _email(db, user):
    db.expire_all()
    return db.get(User, user.id).email


def test_email_change_requires_current_password(client_and_db):
    client, db = client_and_db
    user, headers = _signed_in(db)

    missing = client.patch("/api/v1/auth/me", headers=headers, json={"email": "evil@example.com"})
    assert missing.status_code == 401
    assert missing.json() == {"detail": "Current password is required to change your email"}

    wrong = client.patch(
        "/api/v1/auth/me", headers=headers, json={"email": "evil@example.com", "current_password": "wrong password!"}
    )
    assert wrong.status_code == 401
    assert wrong.json() == {"detail": "Current password is incorrect"}
    assert _email(db, user) == "alice@example.com"

    ok = client.patch(
        "/api/v1/auth/me", headers=headers, json={"email": "new@example.com", "current_password": PASSWORD}
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["email"] == "new@example.com"
    assert _email(db, user) == "new@example.com"
    assert db.query(AuditLog).filter(
        AuditLog.action == "auth.profile_updated", AuditLog.detail == "email_changed"
    ).count() == 1


def test_clearing_email_requires_current_password(client_and_db):
    client, db = client_and_db
    user, headers = _signed_in(db)
    response = client.patch("/api/v1/auth/me", headers=headers, json={"email": None})
    assert response.status_code == 401
    assert _email(db, user) == "alice@example.com"


def test_unchanged_email_and_other_fields_need_no_password(client_and_db):
    client, db = client_and_db
    user, headers = _signed_in(db)
    response = client.patch(
        "/api/v1/auth/me", headers=headers, json={"display_name": "Alice", "email": "alice@example.com"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["display_name"] == "Alice"


def test_email_change_requires_totp_code_when_enabled(client_and_db):
    client, db = client_and_db
    user, headers = _signed_in(db)
    secret = _enrol(client, headers)

    missing = client.patch(
        "/api/v1/auth/me", headers=headers, json={"email": "new@example.com", "current_password": PASSWORD}
    )
    assert missing.status_code == 401
    assert missing.json() == {"detail": "Authentication code is required to change your email"}

    wrong = client.patch(
        "/api/v1/auth/me",
        headers=headers,
        json={"email": "new@example.com", "current_password": PASSWORD, "totp_code": "000000"},
    )
    assert wrong.status_code == 401
    assert wrong.json() == {"detail": "Password or authentication code is incorrect"}
    assert _email(db, user) == "alice@example.com"

    ok = client.patch(
        "/api/v1/auth/me",
        headers=headers,
        json={"email": "new@example.com", "current_password": PASSWORD, "totp_code": pyotp.TOTP(secret).now()},
    )
    assert ok.status_code == 200, ok.text
    assert _email(db, user) == "new@example.com"


def test_email_change_password_failures_are_throttled(client_and_db, monkeypatch):
    client, db = client_and_db
    monkeypatch.setattr(auth_api.settings, "auth_max_failed_attempts", 2, raising=False)
    from app.services.auth import security

    monkeypatch.setattr(security.settings, "auth_max_failed_attempts", 2)
    user, headers = _signed_in(db)
    body = {"email": "evil@example.com", "current_password": "wrong password!"}
    assert client.patch("/api/v1/auth/me", headers=headers, json=body).status_code == 401
    assert client.patch("/api/v1/auth/me", headers=headers, json=body).status_code == 401
    locked = client.patch("/api/v1/auth/me", headers=headers, json={**body, "current_password": PASSWORD})
    assert locked.status_code == 429
    assert locked.json()["detail"].startswith("Too many attempts. Retry in ")
    assert _email(db, user) == "alice@example.com"


def _admin(db, username="root"):
    admin = User(username=username, password_hash=hash_password(PASSWORD), role="SuperAdmin", is_active=True, email="root@example.com")
    db.add(admin)
    db.commit()
    return admin, {"Authorization": f"Bearer {create_access_token(admin.id)}"}


def test_admin_route_refuses_your_own_email_change(client_and_db):
    client, db = client_and_db
    admin, headers = _admin(db)
    response = client.patch(f"/api/v1/auth/users/{admin.id}", headers=headers, json={"email": "evil@example.com"})
    assert response.status_code == 403
    assert response.json() == {"detail": "Change your own email from your profile, which asks you to confirm it is you"}
    assert _email(db, admin) == "root@example.com"
    unchanged = client.patch(f"/api/v1/auth/users/{admin.id}", headers=headers, json={"email": "root@example.com"})
    assert unchanged.status_code == 200, unchanged.text


def test_admin_email_edit_of_another_user_is_audited(client_and_db):
    client, db = client_and_db
    user, _headers = _signed_in(db)
    _admin_user, headers = _admin(db)
    response = client.patch(f"/api/v1/auth/users/{user.id}", headers=headers, json={"email": "alice@corp.example"})
    assert response.status_code == 200, response.text
    assert _email(db, user) == "alice@corp.example"
    row = db.query(AuditLog).filter(AuditLog.action == "auth.user_updated").one()
    assert row.target == "user:alice"
    assert row.detail.endswith("email_changed=yes")


def test_wrong_password_alone_is_not_audited_as_an_mfa_failure(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db)
    client.patch("/api/v1/auth/me", headers=headers, json={"email": "evil@example.com", "current_password": "wrong password!"})
    db.expire_all()
    actions = [row.action for row in db.query(AuditLog).all()]
    assert actions == ["auth.password_verify_failed"]


def test_a_used_authentication_code_cannot_change_the_email_again(client_and_db):
    client, db = client_and_db
    user, headers = _signed_in(db)
    secret = _enrol(client, headers)
    code = pyotp.TOTP(secret).now()
    first = client.patch(
        "/api/v1/auth/me", headers=headers, json={"email": "new@example.com", "current_password": PASSWORD, "totp_code": code}
    )
    assert first.status_code == 200, first.text
    replay = client.patch(
        "/api/v1/auth/me", headers=headers, json={"email": "evil@example.com", "current_password": PASSWORD, "totp_code": code}
    )
    assert replay.status_code == 401
    assert replay.json() == {"detail": "Password or authentication code is incorrect"}
    assert _email(db, user) == "new@example.com"


def test_a_recovery_code_changes_the_email_once(client_and_db):
    # Recovery codes stand in for the authenticator everywhere else on the
    # profile, so they do here too, and each one is consumed on use.
    client, db = client_and_db
    user, headers = _signed_in(db)
    secret = client.post("/api/v1/auth/me/totp/setup", headers=headers, json={"password": PASSWORD}).json()["secret"]
    confirmed = client.post("/api/v1/auth/me/totp/confirm", headers=headers, json={"code": pyotp.TOTP(secret).now()})
    recovery = confirmed.json()["recovery_codes"][0]
    headers["Authorization"] = f"Bearer {confirmed.json()['access_token']}"
    body = {"email": "new@example.com", "current_password": PASSWORD, "totp_code": recovery}
    assert client.patch("/api/v1/auth/me", headers=headers, json=body).status_code == 200
    again = client.patch("/api/v1/auth/me", headers=headers, json={**body, "email": "evil@example.com"})
    assert again.status_code == 401
    assert _email(db, user) == "new@example.com"
    assert client.get("/api/v1/auth/me", headers=headers).json()["recovery_codes_remaining"] == 9


def test_unknown_fields_on_the_profile_update_are_ignored(client_and_db):
    client, db = client_and_db
    user, headers = _signed_in(db)
    response = client.patch(
        "/api/v1/auth/me",
        headers=headers,
        json={"display_name": "Alice", "role": "SuperAdmin", "is_active": False, "password_hash": "x", "totp_enabled": False},
    )
    assert response.status_code == 200, response.text
    db.expire_all()
    stored = db.get(User, user.id)
    assert (stored.role, stored.is_active, stored.display_name) == ("Viewer", True, "Alice")
    assert verify_password(PASSWORD, stored.password_hash)

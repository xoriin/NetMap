from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import auth as auth_api
from app.core.security import create_access_token, hash_password, verify_password
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.auth_session import LoginThrottleState
from app.models.user import User
from app.services.auth import security
from tests.oidc_helpers import memory_session_factory

PASSWORD = "correct horse battery"
NEW_PASSWORD = "another long password"


@pytest.fixture()
def client_and_db(monkeypatch):
    monkeypatch.setattr(auth_api, "apply_progressive_delay", lambda _attempts: None)
    monkeypatch.setattr(security.settings, "auth_max_failed_attempts", 3)
    monkeypatch.setattr(security.settings, "auth_ip_lockout_enabled", True)
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
    user = User(username="alice", password_hash=hash_password(PASSWORD), role="Viewer", is_active=True)
    db.add(user)
    db.commit()
    return user, {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _change(client, headers, current):
    return client.post(
        "/api/v1/auth/change-password", headers=headers, json={"current_password": current, "new_password": NEW_PASSWORD}
    )


def _password_is(db, user, password):
    db.expire_all()
    return verify_password(password, db.get(User, user.id).password_hash)


def test_wrong_current_passwords_lock_password_change(client_and_db):
    client, db = client_and_db
    user, headers = _signed_in(db)
    for _ in range(3):
        wrong = _change(client, headers, "wrong password!")
        assert wrong.status_code == 401
        assert wrong.json() == {"detail": "Current password is invalid"}
    locked = _change(client, headers, PASSWORD)
    assert locked.status_code == 429
    assert locked.json()["detail"].startswith("Too many attempts. Retry in ")
    assert int(locked.headers["Retry-After"]) >= 1
    assert _password_is(db, user, PASSWORD)
    failures = db.query(AuditLog).filter(AuditLog.action == "auth.password_change_failed").all()
    assert len(failures) == 3
    assert failures[-1].detail.startswith("attempts=3 ") and failures[-1].detail.endswith("source=change_password")


def test_password_change_failures_use_the_sign_in_subjects(client_and_db):
    client, db = client_and_db
    _user, headers = _signed_in(db)
    _change(client, headers, "wrong password!")
    db.expire_all()
    subjects = {row.subject for row in db.query(LoginThrottleState).all()}
    assert subjects == {"user:alice", "ip:testclient"}
    for _ in range(2):
        _change(client, headers, "wrong password!")
    login = client.post("/api/v1/auth/login", json={"username": "alice", "password": PASSWORD})
    assert login.status_code == 429


def test_old_password_change_failures_decay(client_and_db):
    client, db = client_and_db
    user, headers = _signed_in(db)
    old = datetime.now(timezone.utc) - timedelta(days=30)
    db.add(LoginThrottleState(subject="user:alice", failed_attempts=3, last_failed_at=old, locked_until=old + timedelta(minutes=15), updated_at=old))
    db.commit()
    assert _change(client, headers, "wrong password!").status_code == 401
    assert _change(client, headers, PASSWORD).status_code == 204
    assert _password_is(db, user, NEW_PASSWORD)

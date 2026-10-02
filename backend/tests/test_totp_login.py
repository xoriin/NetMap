import time
from datetime import timedelta

import anyio
import pyotp
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import auth as auth_api
from app.core.security import create_token, hash_password
from app.db.session import get_db
from app.middleware.csrf import CsrfProtectionMiddleware
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services import totp
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
    client = TestClient(app, base_url="http://testserver")
    db = session_factory()
    try:
        yield client, db
    finally:
        db.close()


def _make_user(db, username="alice", role="Viewer", enrol=False):
    user = User(username=username, password_hash=hash_password(PASSWORD), role=role, is_active=True)
    db.add(user)
    db.commit()
    secret = None
    if enrol:
        secret, _ = totp.begin_enrolment(db, user)
        totp.confirm_enrolment(db, user, pyotp.TOTP(secret).at(time.time() - 60), now=time.time() - 60)
        db.commit()
    return user, secret


def _login(client, username="alice"):
    return client.post("/api/v1/auth/login", json={"username": username, "password": PASSWORD})


def test_account_without_totp_signs_in_as_before(client_and_db):
    client, db = client_and_db
    _make_user(db)
    response = _login(client)
    assert response.status_code == 200
    assert "access_token" in response.json()
    assert "netmap_access" in response.cookies


def test_enrolled_account_gets_a_challenge_and_no_cookies(client_and_db):
    client, db = client_and_db
    _make_user(db, enrol=True)
    response = _login(client)
    body = response.json()
    assert response.status_code == 200
    assert body["mfa_required"] is True and body["challenge"]
    assert "access_token" not in body
    assert "set-cookie" not in response.headers


def test_correct_code_completes_sign_in_and_is_audited(client_and_db):
    client, db = client_and_db
    _user, secret = _make_user(db, enrol=True)
    challenge = _login(client).json()["challenge"]
    response = client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": pyotp.TOTP(secret).now()})
    assert response.status_code == 200
    assert "netmap_access" in response.cookies
    actions = [(a.action, a.detail) for a in db.query(AuditLog).all()]
    assert any(action == "auth.login_success" and "method=totp" in (detail or "") for action, detail in actions)


def test_recovery_code_signs_in_and_is_audited(client_and_db):
    client, db = client_and_db
    user, _secret = _make_user(db)
    secret, _ = totp.begin_enrolment(db, user)
    codes = totp.confirm_enrolment(db, user, pyotp.TOTP(secret).now())
    db.commit()
    challenge = _login(client).json()["challenge"]
    response = client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": codes[0]})
    assert response.status_code == 200
    assert "auth.mfa_recovery_used" in [a.action for a in db.query(AuditLog).all()]


def test_wrong_codes_count_toward_the_shared_lockout(client_and_db, monkeypatch):
    client, db = client_and_db
    monkeypatch.setattr(auth_api.settings, "auth_max_failed_attempts", 3, raising=False)
    _make_user(db, enrol=True)
    challenge = _login(client).json()["challenge"]
    statuses = [client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": "000000"}).status_code for _ in range(4)]
    assert statuses[:3] == [401, 401, 401]
    assert statuses[3] == 429
    assert "auth.mfa_failed" in [a.action for a in db.query(AuditLog).all()]


@pytest.mark.parametrize("token_type", ["access", "mfa_setup"])
def test_wrong_challenge_types_are_rejected(client_and_db, token_type):
    client, db = client_and_db
    user, secret = _make_user(db, enrol=True)
    challenge = create_token(str(user.id), token_type, timedelta(minutes=5))
    response = client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": pyotp.TOTP(secret).now()})
    assert response.status_code == 401
    assert response.json()["detail"] == "Sign-in expired. Enter your password again."


def test_expired_and_tampered_challenges_are_rejected(client_and_db):
    client, db = client_and_db
    user, secret = _make_user(db, enrol=True)
    expired = create_token(str(user.id), "mfa_challenge", timedelta(seconds=-1))
    good = _login(client).json()["challenge"]
    for challenge in (expired, good[:-2] + "xx"):
        response = client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": pyotp.TOTP(secret).now()})
        assert response.status_code == 401


def test_disabled_account_cannot_use_an_outstanding_challenge(client_and_db):
    client, db = client_and_db
    user, secret = _make_user(db, enrol=True)
    challenge = _login(client).json()["challenge"]
    user.is_active = False
    db.commit()
    response = client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": pyotp.TOTP(secret).now()})
    assert response.status_code == 401


def test_required_but_not_enrolled_gets_a_setup_challenge(client_and_db):
    client, db = client_and_db
    from app.models.system_setting import SystemSetting

    db.add(SystemSetting(key="totp_required", value="all"))
    db.commit()
    _make_user(db)
    body = _login(client).json()
    assert body["mfa_setup_required"] is True and body["challenge"]


def _csrf_status(path: str) -> int:
    async def ok(scope, receive, send):
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    scope = {"type": "http", "method": "POST", "path": path, "headers": [(b"cookie", b"netmap_access=stale")]}
    anyio.run(CsrfProtectionMiddleware(ok), scope, receive, send)
    return next(m["status"] for m in messages if m["type"] == "http.response.start")


@pytest.mark.parametrize("path", ["/api/v1/auth/login/totp", "/api/v1/auth/login/totp/setup", "/api/v1/auth/login/totp/setup/confirm"])
def test_second_step_endpoints_are_not_blocked_by_a_stale_session_cookie(path):
    assert _csrf_status(path) == 204


def _setup_challenge(client, db):
    from app.models.system_setting import SystemSetting

    db.add(SystemSetting(key="totp_required", value="all"))
    db.commit()
    _make_user(db)
    return _login(client).json()["challenge"]


def test_forced_enrolment_signs_in_and_returns_recovery_codes(client_and_db):
    client, db = client_and_db
    challenge = _setup_challenge(client, db)
    setup = client.post("/api/v1/auth/login/totp/setup", json={"challenge": challenge}).json()
    assert setup["otpauth_uri"].startswith("otpauth://totp/")
    response = client.post(
        "/api/v1/auth/login/totp/setup/confirm",
        json={"challenge": challenge, "code": pyotp.TOTP(setup["secret"]).now()},
    )
    assert response.status_code == 200
    assert len(response.json()["recovery_codes"]) == 10
    assert "netmap_access" in response.cookies


def test_restarting_forced_enrolment_replaces_the_pending_secret(client_and_db):
    client, db = client_and_db
    challenge = _setup_challenge(client, db)
    first = client.post("/api/v1/auth/login/totp/setup", json={"challenge": challenge}).json()["secret"]
    second = client.post("/api/v1/auth/login/totp/setup", json={"challenge": challenge}).json()["secret"]
    assert first != second
    bad = client.post("/api/v1/auth/login/totp/setup/confirm", json={"challenge": challenge, "code": pyotp.TOTP(first).now()})
    assert bad.status_code == 401


def test_setup_challenge_cannot_finish_a_normal_sign_in(client_and_db):
    client, db = client_and_db
    challenge = _setup_challenge(client, db)
    response = client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": "123456"})
    assert response.status_code == 401


def test_normal_challenge_cannot_reach_setup(client_and_db):
    client, db = client_and_db
    _make_user(db, enrol=True)
    challenge = _login(client).json()["challenge"]
    assert client.post("/api/v1/auth/login/totp/setup", json={"challenge": challenge}).status_code == 401


def test_setup_challenge_is_not_an_access_token(client_and_db):
    client, db = client_and_db
    challenge = _setup_challenge(client, db)
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {challenge}"}).status_code == 401


def test_setup_challenge_cannot_wipe_an_active_enrolment(client_and_db):
    client, db = client_and_db
    challenge = _setup_challenge(client, db)
    setup = client.post("/api/v1/auth/login/totp/setup", json={"challenge": challenge}).json()
    code = pyotp.TOTP(setup["secret"]).now()
    assert client.post("/api/v1/auth/login/totp/setup/confirm", json={"challenge": challenge, "code": code}).status_code == 200
    for path, body in (
        ("/api/v1/auth/login/totp/setup", {"challenge": challenge}),
        ("/api/v1/auth/login/totp/setup/confirm", {"challenge": challenge, "code": code}),
    ):
        response = client.post(path, json=body)
        assert response.status_code == 401
        assert response.json()["detail"] == "Sign-in expired. Enter your password again."
    db.expire_all()
    assert db.query(User).filter_by(username="alice").one().totp_enabled_at is not None


def test_challenge_is_rejected_once_totp_is_removed_without_counting_a_failure(client_and_db):
    client, db = client_and_db
    user, secret = _make_user(db, enrol=True)
    challenge = _login(client).json()["challenge"]
    totp.disable(db, user)
    db.commit()
    response = client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": "123456"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Sign-in expired. Enter your password again."
    assert "auth.mfa_failed" not in [a.action for a in db.query(AuditLog).all()]


def test_failed_code_audit_names_the_actor(client_and_db):
    client, db = client_and_db
    user, _secret = _make_user(db, enrol=True)
    challenge = _login(client).json()["challenge"]
    client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": "000000"})
    failed = db.query(AuditLog).filter(AuditLog.action == "auth.mfa_failed").one()
    assert failed.actor_user_id == user.id


def test_locked_code_step_is_audited_as_blocked(client_and_db, monkeypatch):
    client, db = client_and_db
    monkeypatch.setattr(auth_api.settings, "auth_max_failed_attempts", 3, raising=False)
    _make_user(db, enrol=True)
    challenge = _login(client).json()["challenge"]
    for _ in range(4):
        client.post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": "000000"})
    db.expire_all()
    blocked = db.query(AuditLog).filter(AuditLog.action == "auth.login_blocked").all()
    assert len(blocked) == 1
    assert "stage=totp" in blocked[0].detail


def test_locked_enrolment_step_is_audited_as_blocked(client_and_db, monkeypatch):
    client, db = client_and_db
    monkeypatch.setattr(auth_api.settings, "auth_max_failed_attempts", 3, raising=False)
    challenge = _setup_challenge(client, db)
    client.post("/api/v1/auth/login/totp/setup", json={"challenge": challenge})
    statuses = [
        client.post("/api/v1/auth/login/totp/setup/confirm", json={"challenge": challenge, "code": "000000"}).status_code
        for _ in range(4)
    ]
    assert statuses[3] == 429
    db.expire_all()
    blocked = db.query(AuditLog).filter(AuditLog.action == "auth.login_blocked").all()
    assert len(blocked) == 1
    assert "stage=totp" in blocked[0].detail

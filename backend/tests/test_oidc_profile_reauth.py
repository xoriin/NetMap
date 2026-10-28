"""Linking SSO from the Profile and confirming an email change by signing in
again at the provider: fresh, bound to the signed-in user, never a sign-in."""
import time
from urllib.parse import parse_qs, urlparse

import pyotp
import pytest
from sqlalchemy import select

from app.core.security import hash_password
from app.models.audit_log import AuditLog
from app.models.oidc import ExternalIdentity, OidcLoginState
from app.models.user import User
from app.services import totp as totp_service
from tests.oidc_helpers import ISSUER, make_id_token
from tests.test_oidc_flow import _callback, _enable_oidc
from tests.test_oidc_flow import client_and_db as client_and_db_fixture
from tests.test_oidc_flow import fake_http as fake_http_fixture

client_and_db = client_and_db_fixture
fake_http = fake_http_fixture

PASSWORD = "correct horse battery staple"
MANAGED = "Your email is managed by your identity provider or an administrator"


def _user(db, *, role="Viewer", totp=False, linked=False):
    user = User(username="alice", email="alice@example.com", password_hash=hash_password(PASSWORD), role=role, is_active=True)
    db.add(user)
    db.flush()
    if linked:
        db.add(ExternalIdentity(issuer=ISSUER, subject="subject-1", user_id=user.id, email="user@example.com", email_verified=True))
    secret = None
    if totp:
        secret, _uri = totp_service.begin_enrolment(db, user)
        assert totp_service.confirm_enrolment(db, user, pyotp.TOTP(secret).at(time.time() - 30)) is not None
    db.commit()
    return user, secret


def _sign_in(client, secret=None):
    response = client.post("/api/v1/auth/login", json={"username": "alice", "password": PASSWORD})
    assert response.status_code == 200, response.text
    body = response.json()
    if body.get("mfa_required"):
        response = client.post(
            "/api/v1/auth/login/totp",
            json={"challenge": body["challenge"], "code": pyotp.TOTP(secret).now()},
        )
        assert response.status_code == 200, response.text
        body = response.json()
    return body["access_token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _state_from(response, db):
    assert response.status_code == 200, response.text
    params = {k: v[0] for k, v in parse_qs(urlparse(response.json()["authorize_url"]).query).items()}
    row = db.scalar(select(OidcLoginState).where(OidcLoginState.state == params["state"]))
    db.refresh(row)
    return params, row


def _provider_returns(client, db, fake_http, response, **claims):
    params, row = _state_from(response, db)
    claims.setdefault("auth_time", int(time.time()) - 5)
    sub = claims.pop("sub", "subject-1")
    fake_http.token_response = {"access_token": "a", "id_token": make_id_token(sub=sub, nonce=row.nonce, extra_claims=claims)}
    return _callback(client, params["state"])


def _query(response):
    assert response.status_code == 302, response.text
    return {k: v[0] for k, v in parse_qs(urlparse(response.headers["location"]).query).items()}


def _email_of(db, user):
    db.expire_all()
    return db.get(User, user.id).email


# --- SSO email change --------------------------------------------------------


def test_sso_email_change_needs_a_fresh_sign_in_and_issues_no_tokens(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    user, _ = _user(db, linked=True)
    token = _sign_in(client)
    client.cookies.clear()
    start = client.post("/api/v1/auth/me/email/sso", json={"email": "new@example.com"}, headers=_auth(token))
    params, row = _state_from(start, db)
    assert params["prompt"] == "login" and params["max_age"] == "300"
    assert row.purpose == "email_change" and row.user_id == user.id and row.pending_value == "new@example.com"
    assert "new@example.com" not in start.json()["authorize_url"]
    assert "netmap_oidc_txn" in start.headers["set-cookie"] and "HttpOnly" in start.headers["set-cookie"]
    assert "Max-Age=300" in start.headers["set-cookie"]
    done = _provider_returns(client, db, fake_http, start)
    assert _query(done) == {"sso_email": "changed"}
    assert "netmap_access" not in done.headers.get("set-cookie", "")
    assert _email_of(db, user) == "new@example.com"
    # Single use: replaying the callback does nothing.
    replay = _callback(client, params["state"])
    assert _query(replay)["sso_error"] == "invalid_state"


@pytest.mark.parametrize(
    "claims,code",
    [
        ({"auth_time": None}, "reauth_required"),
        ({"auth_time": int(time.time()) - 900}, "reauth_required"),
        ({"auth_time": int(time.time()) + 3600}, "reauth_required"),
        ({"sub": "someone-else"}, "reauth_mismatch"),
    ],
)
def test_sso_email_change_fails_closed(client_and_db, fake_http, claims, code):
    client, db = client_and_db
    _enable_oidc(db)
    user, _ = _user(db, linked=True)
    token = _sign_in(client)
    start = client.post("/api/v1/auth/me/email/sso", json={"email": "new@example.com"}, headers=_auth(token))
    claims = dict(claims)
    if claims.get("auth_time", 0) is None:
        params, row = _state_from(start, db)
        fake_http.token_response = {"access_token": "a", "id_token": make_id_token(nonce=row.nonce)}
        done = _callback(client, params["state"])
    else:
        done = _provider_returns(client, db, fake_http, start, **claims)
    assert _query(done)["sso_error"] == code
    assert _email_of(db, user) == "alice@example.com"


def test_sso_email_change_without_a_linked_identity_is_managed(client_and_db):
    client, db = client_and_db
    _enable_oidc(db)
    _user(db)
    token = _sign_in(client)
    response = client.post("/api/v1/auth/me/email/sso", json={"email": "new@example.com"}, headers=_auth(token))
    assert response.status_code == 403
    assert response.json() == {"detail": MANAGED}


def test_sso_email_change_with_sso_off_is_managed(client_and_db):
    client, db = client_and_db
    _user(db, linked=True)
    token = _sign_in(client)
    response = client.post("/api/v1/auth/me/email/sso", json={"email": "new@example.com"}, headers=_auth(token))
    assert response.status_code == 403
    assert response.json() == {"detail": MANAGED}


def test_sso_email_change_still_needs_the_local_code_and_is_throttled(client_and_db, fake_http, monkeypatch):
    from app.api.v1 import auth as auth_api
    from app.services.auth import security

    monkeypatch.setattr(auth_api, "apply_progressive_delay", lambda _attempts: None)
    monkeypatch.setattr(security.settings, "auth_max_failed_attempts", 3)
    client, db = client_and_db
    _enable_oidc(db)
    user, secret = _user(db, linked=True, totp=True)
    token = _sign_in(client, secret)
    missing = client.post("/api/v1/auth/me/email/sso", json={"email": "new@example.com"}, headers=_auth(token))
    assert missing.status_code == 401
    for _ in range(5):
        wrong = client.post(
            "/api/v1/auth/me/email/sso", json={"email": "new@example.com", "totp_code": "000000"}, headers=_auth(token)
        )
        if wrong.status_code == 429:
            break
        assert wrong.status_code == 401
        assert wrong.json() == {"detail": "Authentication code is incorrect"}
    assert wrong.status_code == 429
    assert "Retry-After" in wrong.headers
    assert db.scalar(select(OidcLoginState).where(OidcLoginState.purpose == "email_change")) is None
    actions = [a for a in db.scalars(select(AuditLog.action)).all()]
    assert "auth.mfa_verify_failed" in actions


def test_totp_alone_never_changes_the_email(client_and_db, fake_http):
    """A valid code starts the provider sign-in; the email changes only after it."""
    client, db = client_and_db
    _enable_oidc(db)
    user, secret = _user(db, linked=True, totp=True)
    token = _sign_in(client, secret)
    start = client.post(
        "/api/v1/auth/me/email/sso",
        json={"email": "new@example.com", "totp_code": pyotp.TOTP(secret).at(time.time() + 30)},
        headers=_auth(token),
    )
    assert start.status_code == 200, start.text
    assert _email_of(db, user) == "alice@example.com"


# --- Linking and unlinking from the Profile ----------------------------------


def test_admin_links_sso_from_the_profile_after_a_fresh_sign_in(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    user, _ = _user(db, role="SuperAdmin")
    token = _sign_in(client)
    wrong = client.post("/api/v1/auth/me/identities/link", json={"current_password": "nope-nope-nope"}, headers=_auth(token))
    assert wrong.status_code == 401
    start = client.post("/api/v1/auth/me/identities/link", json={"current_password": PASSWORD}, headers=_auth(token))
    params, row = _state_from(start, db)
    assert row.purpose == "link" and params["prompt"] == "login"
    done = _provider_returns(client, db, fake_http, start)
    assert _query(done) == {"sso_link": "linked"}
    identities = client.get("/api/v1/auth/me/identities", headers=_auth(token)).json()
    assert [(i["issuer"], i["email"]) for i in identities] == [(ISSUER, "user@example.com")]
    assert identities[0]["created_at"].endswith("Z")
    again = client.post("/api/v1/auth/me/identities/link", json={"current_password": PASSWORD}, headers=_auth(token))
    assert again.status_code == 409


def test_linking_an_identity_owned_by_someone_else_is_refused(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    other = User(username="bob", email="bob@example.com", password_hash=hash_password(PASSWORD), role="Viewer", is_active=True)
    db.add(other)
    db.flush()
    db.add(ExternalIdentity(issuer=ISSUER, subject="subject-1", user_id=other.id, email="user@example.com", email_verified=True))
    db.commit()
    user, _ = _user(db)
    token = _sign_in(client)
    start = client.post("/api/v1/auth/me/identities/link", json={"current_password": PASSWORD}, headers=_auth(token))
    done = _provider_returns(client, db, fake_http, start)
    assert _query(done)["sso_error"] == "identity_in_use"
    assert db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id)) is None


def test_linking_needs_a_fresh_sign_in(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    user, _ = _user(db)
    token = _sign_in(client)
    start = client.post("/api/v1/auth/me/identities/link", json={"current_password": PASSWORD}, headers=_auth(token))
    done = _provider_returns(client, db, fake_http, start, auth_time=int(time.time()) - 3600)
    assert _query(done)["sso_error"] == "reauth_required"
    assert db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id)) is None


def test_unlink_needs_the_password_and_ends_other_sessions(client_and_db):
    client, db = client_and_db
    _enable_oidc(db)
    user, _ = _user(db, linked=True)
    old_token = _sign_in(client)
    identity = db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id))
    wrong = client.request(
        "DELETE", f"/api/v1/auth/me/identities/{identity.id}", json={"current_password": "nope-nope-nope"}, headers=_auth(old_token)
    )
    assert wrong.status_code == 401
    ok = client.request(
        "DELETE", f"/api/v1/auth/me/identities/{identity.id}", json={"current_password": PASSWORD}, headers=_auth(old_token)
    )
    assert ok.status_code == 204
    assert "netmap_access" in ok.headers.get("set-cookie", "")
    assert client.get("/api/v1/auth/me", headers=_auth(old_token)).status_code == 401
    db.expire_all()
    assert db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id)) is None


def test_unlink_is_refused_when_sso_is_required_for_non_admins(client_and_db):
    client, db = client_and_db
    _enable_oidc(db)
    user, _ = _user(db, linked=True)
    token = _sign_in(client)
    _enable_oidc(db, require_sso="true")
    identity = db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id))
    response = client.request(
        "DELETE", f"/api/v1/auth/me/identities/{identity.id}", json={"current_password": PASSWORD}, headers=_auth(token)
    )
    assert response.status_code == 409
    assert db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id)) is not None


def test_plain_login_states_never_finish_a_reauthentication(client_and_db, fake_http):
    """A normal SSO sign-in state has no purpose and goes through sign-in."""
    client, db = client_and_db
    _enable_oidc(db)
    response = client.get("/api/v1/auth/oidc/login", follow_redirects=False)
    params = {k: v[0] for k, v in parse_qs(urlparse(response.headers["location"]).query).items()}
    assert "prompt" not in params and "max_age" not in params
    row = db.scalar(select(OidcLoginState).where(OidcLoginState.state == params["state"]))
    assert row.purpose is None and row.user_id is None


# --- 0088 migration ----------------------------------------------------------


def test_0088_adds_the_columns_and_is_idempotent():
    from sqlalchemy import create_engine, text

    from app.db.session import _live_columns, _migrate_oidc_login_state_purpose

    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        _migrate_oidc_login_state_purpose(conn, None)  # fresh install before create_all: no table, no-op
        conn.execute(text("CREATE TABLE oidc_login_states (id INTEGER PRIMARY KEY, state VARCHAR(128))"))
        conn.execute(text("INSERT INTO oidc_login_states (id, state) VALUES (1, 'kept')"))
        _migrate_oidc_login_state_purpose(conn, None)
        _migrate_oidc_login_state_purpose(conn, None)
        assert {"user_id", "purpose", "pending_value"} <= set(_live_columns(conn, "oidc_login_states"))
        assert conn.execute(text("SELECT state, purpose FROM oidc_login_states")).fetchall() == [("kept", None)]


def test_sso_email_change_is_rate_limited_per_user_without_2fa(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    _user(db, linked=True)
    token = _sign_in(client)
    statuses = []
    for _ in range(8):
        response = client.post("/api/v1/auth/me/email/sso", json={"email": "new@example.com"}, headers=_auth(token))
        statuses.append(response.status_code)
        if response.status_code == 429:
            break
    assert statuses[-1] == 429, statuses
    assert all(code == 200 for code in statuses[:-1])
    assert int(response.headers["Retry-After"]) >= 1
    assert response.json()["detail"].startswith("Too many attempts. Retry in ")
    states = db.scalars(select(OidcLoginState).where(OidcLoginState.purpose == "email_change")).all()
    assert len(states) == len(statuses) - 1

"""Route-level tests for the OIDC login flow (Phase 1).

A minimal FastAPI app mounts the real auth + oidc routers over an in-memory
database; the provider HTTP layer is replaced with a fake (see
``oidc_helpers``) so discovery, JWKS, and token exchange run without network.
"""

from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select

from app.api.v1 import auth as auth_api
from app.api.v1 import oidc as oidc_api
from app.core.security import hash_password
from app.db.session import get_db
from app.models.oidc import ExternalIdentity, OidcLoginState
from app.models.user import User, UserRole
from app.services.oidc.provider import clear_provider_caches
from tests.oidc_helpers import (
    CLIENT_ID,
    ISSUER,
    FakeProviderHttp,
    make_id_token,
    memory_session_factory,
    set_oidc_db_settings,
)


@pytest.fixture()
def fake_http(monkeypatch):
    fake = FakeProviderHttp()
    clear_provider_caches()
    monkeypatch.setattr("app.services.oidc.provider._http_get_json", fake.get_json)
    monkeypatch.setattr("app.services.oidc.flow._http_post_form", fake.post_form)
    monkeypatch.setattr("app.services.oidc.provider.fetch_userinfo", lambda *a, **k: fake.userinfo)
    yield fake
    clear_provider_caches()


@pytest.fixture()
def client_and_db():
    session_factory = memory_session_factory()

    app = FastAPI()
    app.include_router(auth_api.router, prefix="/api/v1")
    app.include_router(oidc_api.router, prefix="/api/v1")

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


def _enable_oidc(db, **overrides):
    set_oidc_db_settings(db, **overrides)


def _start_login(client, db):
    """Drive /auth/oidc/login; returns (state, nonce, authorize_params)."""
    response = client.get("/api/v1/auth/oidc/login", follow_redirects=False)
    assert response.status_code == 302, response.text
    location = urlparse(response.headers["location"])
    params = {k: v[0] for k, v in parse_qs(location.query).items()}
    state_row = db.scalar(select(OidcLoginState).where(OidcLoginState.state == params["state"]))
    assert state_row is not None
    return params["state"], state_row.nonce, params


def _callback(client, state, code="test-code"):
    return client.get(
        f"/api/v1/auth/oidc/callback?code={code}&state={state}",
        follow_redirects=False,
    )


def _sso_error(response) -> str:
    assert response.status_code == 302
    query = parse_qs(urlparse(response.headers["location"]).query)
    return query.get("sso_error", [""])[0]


def test_status_disabled_by_default(client_and_db):
    client, _db = client_and_db
    payload = client.get("/api/v1/auth/oidc/status").json()
    assert payload == {"enabled": False, "provider_name": "SSO", "require_sso": False}


def test_login_redirect_includes_pkce_state_and_nonce(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    state, nonce, params = _start_login(client, db)
    assert params["client_id"] == CLIENT_ID
    assert params["response_type"] == "code"
    assert params["code_challenge_method"] == "S256"
    assert params["code_challenge"]
    assert params["nonce"] == nonce
    assert params["redirect_uri"] == "http://testserver/api/v1/auth/oidc/callback"
    assert "openid" in params["scope"]
    assert client.cookies.get("netmap_oidc_txn") == state


def test_callback_success_provisions_user_and_issues_session(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {
        "access_token": "provider-access",
        "id_token": make_id_token(nonce=nonce, email="new.user@example.com"),
    }

    response = _callback(client, state)
    assert response.status_code == 302
    assert response.headers["location"] == "/"
    assert client.cookies.get("netmap_access")
    assert client.cookies.get("netmap_refresh")
    assert client.cookies.get("netmap_csrf")

    user = db.scalar(select(User).where(User.email == "new.user@example.com"))
    assert user is not None
    assert user.role == UserRole.VIEWER
    identity = db.scalar(select(ExternalIdentity).where(ExternalIdentity.subject == "subject-1"))
    assert identity is not None and identity.user_id == user.id

    # PKCE verifier was sent to the token endpoint.
    assert fake_http.token_requests[0]["code_verifier"]

    # The issued session works against the normal auth stack.
    me = client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["username"] == user.username


def test_callback_rejects_unknown_state(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    _start_login(client, db)
    client.cookies.set("netmap_oidc_txn", "forged-state", path="/api/v1/auth/oidc/")
    assert _sso_error(_callback(client, "forged-state")) == "invalid_state"


def test_callback_rejects_reused_state(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {"access_token": "at", "id_token": make_id_token(nonce=nonce)}
    assert _callback(client, state).headers["location"] == "/"
    client.cookies.set("netmap_oidc_txn", state, path="/api/v1/auth/oidc/")
    assert _sso_error(_callback(client, state)) == "invalid_state"


def test_callback_rejects_missing_browser_cookie(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    state, _nonce, _ = _start_login(client, db)
    client.cookies.delete("netmap_oidc_txn", path="/api/v1/auth/oidc/")
    assert _sso_error(_callback(client, state)) == "invalid_state"
    # The state row must survive an attempt without the browser cookie.
    row = db.scalar(select(OidcLoginState).where(OidcLoginState.state == state))
    assert row.used_at is None


def test_callback_rejects_nonce_mismatch(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    state, _nonce, _ = _start_login(client, db)
    fake_http.token_response = {"access_token": "at", "id_token": make_id_token(nonce="wrong-nonce")}
    assert _sso_error(_callback(client, state)) == "nonce_mismatch"


def test_callback_rejects_wrong_issuer(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {
        "access_token": "at",
        "id_token": make_id_token(nonce=nonce, issuer="https://evil.test"),
    }
    assert _sso_error(_callback(client, state)) == "issuer_mismatch"


def test_callback_rejects_wrong_audience(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {
        "access_token": "at",
        "id_token": make_id_token(nonce=nonce, audience="another-client"),
    }
    assert _sso_error(_callback(client, state)) == "audience_mismatch"


def test_callback_rejects_unverified_email(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {
        "access_token": "at",
        "id_token": make_id_token(nonce=nonce, email_verified=False),
    }
    assert _sso_error(_callback(client, state)) == "email_unverified"


def test_callback_rejects_denied_email_domain(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db, allowed_email_domains="corp.example")
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {
        "access_token": "at",
        "id_token": make_id_token(nonce=nonce, email="user@example.com"),
    }
    assert _sso_error(_callback(client, state)) == "email_domain_denied"


def test_login_start_handles_provider_outage(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    fake_http.offline = True
    response = client.get("/api/v1/auth/oidc/login", follow_redirects=False)
    assert _sso_error(response) == "provider_unreachable"


def test_callback_handles_provider_outage_during_exchange(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    state, _nonce, _ = _start_login(client, db)
    fake_http.offline = True
    clear_provider_caches()
    assert _sso_error(_callback(client, state)) == "provider_unreachable"


def test_callback_relays_provider_denial(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    response = client.get(
        "/api/v1/auth/oidc/callback?error=access_denied&state=whatever",
        follow_redirects=False,
    )
    assert _sso_error(response) == "provider_denied"


def test_local_login_still_works_alongside_oidc(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    db.add(User(username="localadmin", password_hash=hash_password("correct horse battery"), role=UserRole.SUPER_ADMIN))
    db.commit()
    response = client.post(
        "/api/v1/auth/login",
        json={"username": "localadmin", "password": "correct horse battery"},
    )
    assert response.status_code == 200
    assert response.json()["access_token"]


def test_login_route_404_when_disabled(client_and_db):
    client, _db = client_and_db
    assert client.get("/api/v1/auth/oidc/login", follow_redirects=False).status_code == 404


def test_require_sso_blocks_non_superadmin_local_login(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db, require_sso="true")
    db.add(User(username="viewer", password_hash=hash_password("correct horse battery"), role=UserRole.VIEWER))
    db.add(User(username="owner", password_hash=hash_password("correct horse battery"), role=UserRole.SUPER_ADMIN))
    db.commit()

    blocked = client.post(
        "/api/v1/auth/login",
        json={"username": "viewer", "password": "correct horse battery"},
    )
    assert blocked.status_code == 403
    assert "single sign-on" in blocked.json()["detail"].lower()

    # Emergency recovery: SuperAdmin local login stays available.
    allowed = client.post(
        "/api/v1/auth/login",
        json={"username": "owner", "password": "correct horse battery"},
    )
    assert allowed.status_code == 200

    status_payload = client.get("/api/v1/auth/oidc/status").json()
    assert status_payload["require_sso"] is True


def test_callback_for_disabled_account_does_not_persist_identity(client_and_db, fake_http):
    client, db = client_and_db
    disabled = User(
        username="gone",
        password_hash=hash_password("Local-password-123!"),
        role=UserRole.VIEWER,
        email="gone@example.com",
        is_active=False,
    )
    db.add(disabled)
    db.commit()
    _enable_oidc(db)
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {
        "id_token": make_id_token(sub="disabled-sub", nonce=nonce, email="gone@example.com", email_verified=True)
    }

    response = _callback(client, state)

    assert _sso_error(response) == "account_disabled"
    db.expire_all()
    assert db.scalars(select(ExternalIdentity).where(ExternalIdentity.user_id == disabled.id)).all() == []
    # The single-use state is still consumed, so the callback cannot be replayed.
    assert db.scalar(select(OidcLoginState).where(OidcLoginState.state == state)).used_at is not None


def test_callback_holds_no_db_transaction_during_token_exchange(client_and_db, fake_http, monkeypatch):
    client, db = client_and_db
    _enable_oidc(db)
    seen = {}
    original = client.app.dependency_overrides[get_db]

    def recording_get_db():
        for session in original():
            seen["session"] = session
            yield session

    client.app.dependency_overrides[get_db] = recording_get_db
    state, nonce, _ = _start_login(client, db)
    real_post = fake_http.post_form

    def post_form(url, data, *, basic_auth=None):
        seen["in_transaction"] = seen["session"].in_transaction()
        return real_post(url, data, basic_auth=basic_auth)

    monkeypatch.setattr("app.services.oidc.flow._http_post_form", post_form)
    fake_http.token_response = {"id_token": make_id_token(sub="s-io", nonce=nonce, email="io@example.com")}

    response = _callback(client, state)

    assert response.status_code == 302
    assert response.headers["location"] == "/"
    assert seen["in_transaction"] is False


def test_refusal_after_provisioning_is_staged_persists_nothing(client_and_db, fake_http, monkeypatch):
    from app.models.audit_log import AuditLog
    from app.services.oidc import accounts
    from app.services.oidc.provider import OidcProviderError

    client, db = client_and_db
    _enable_oidc(db)

    def refuse(*_args, **_kwargs):
        raise OidcProviderError("role_unavailable", "refused after staging")

    monkeypatch.setattr(accounts, "_apply_managed_role", refuse)
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {"id_token": make_id_token(sub="staged-sub", nonce=nonce, email="staged@example.com")}

    response = _callback(client, state)

    assert _sso_error(response) == "role_unavailable"
    db.expire_all()
    assert db.scalar(select(User).where(User.email == "staged@example.com")) is None
    assert db.scalars(select(ExternalIdentity)).all() == []
    assert db.scalars(select(AuditLog).where(AuditLog.action == "auth.oidc_user_provisioned")).all() == []
    assert [row.detail for row in db.scalars(select(AuditLog).where(AuditLog.action == "auth.oidc_login_failed"))] == [
        "code=role_unavailable"
    ]


def test_callback_refuses_an_already_linked_disabled_account(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    user = User(username="linked", password_hash=hash_password("Local-password-123!"), role=UserRole.VIEWER, email="old@example.com", is_active=False)
    db.add(user)
    db.flush()
    db.add(ExternalIdentity(provider_key="oidc", issuer=ISSUER, subject="linked-sub", user_id=user.id, email="old@example.com", email_verified=True))
    db.commit()
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {"id_token": make_id_token(sub="linked-sub", nonce=nonce, email="new@example.com", email_verified=True)}

    response = _callback(client, state)

    assert _sso_error(response) == "account_disabled"
    assert client.cookies.get("netmap_access") is None
    db.expire_all()
    identity = db.scalar(select(ExternalIdentity).where(ExternalIdentity.subject == "linked-sub"))
    assert (identity.email, identity.last_login_at) == ("old@example.com", None)
    assert db.get(User, user.id).is_active is False

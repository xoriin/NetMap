"""SSO sign-in still asks for the local NetMap code unless the policy trusts the
provider and its ID token proves a recent MFA sign-in."""
import time
from urllib.parse import parse_qs, urlparse

import pyotp
import pytest

from app.core.security import hash_password
from app.models.audit_log import AuditLog
from app.models.oidc import ExternalIdentity
from app.models.user import User
from app.services import totp as totp_service
from app.services.oidc.config import OidcRuntimeConfig
from app.services.oidc.mfa import provider_proved_recent_mfa
from tests.oidc_helpers import ISSUER, make_id_token
from tests.test_oidc_flow import _callback, _enable_oidc, _start_login
from tests.test_oidc_flow import client_and_db as client_and_db_fixture
from tests.test_oidc_flow import fake_http as fake_http_fixture

client_and_db = client_and_db_fixture
fake_http = fake_http_fixture


def _linked_user(db, *, role="Viewer", totp=True):
    user = User(username="alice", email="user@example.com", password_hash=hash_password("x" * 20), role=role, is_active=True)
    db.add(user)
    db.flush()
    db.add(ExternalIdentity(issuer=ISSUER, subject="subject-1", user_id=user.id, email="user@example.com", email_verified=True))
    secret = None
    if totp:
        secret, _uri = totp_service.begin_enrolment(db, user)
        assert totp_service.confirm_enrolment(db, user, pyotp.TOTP(secret).at(time.time() - 30)) is not None
    db.commit()
    return user, secret


def _sso(client, db, fake_http, **claims):
    state, nonce, _ = _start_login(client, db)
    fake_http.token_response = {"access_token": "a", "id_token": make_id_token(nonce=nonce, extra_claims=claims)}
    return _callback(client, state)


def _mfa_step(response):
    assert response.status_code == 302
    return parse_qs(urlparse(response.headers["location"]).query).get("sso_mfa", [None])[0]


def test_local_totp_policy_requires_the_code_even_when_the_provider_did_mfa(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    _user, secret = _linked_user(db)
    response = _sso(client, db, fake_http, amr=["mfa"], auth_time=int(time.time()))
    assert _mfa_step(response) == "challenge"
    assert client.cookies.get("netmap_access") is None
    assert client.cookies.get("netmap_refresh") is None
    pending = response.cookies.get("netmap_mfa_pending")
    assert pending
    set_cookie = next(h for h in response.headers.get_list("set-cookie") if h.startswith("netmap_mfa_pending="))
    assert "HttpOnly" in set_cookie and "Path=/api/v1/auth/login/" in set_cookie and "samesite=strict" in set_cookie.lower()
    assert "challenge" not in response.headers["location"].split("?", 1)[1].replace("sso_mfa=challenge", "")

    wrong = client.post("/api/v1/auth/login/totp", json={"code": "000000"}, cookies={"netmap_mfa_pending": pending})
    assert wrong.status_code == 401
    done = client.post(
        "/api/v1/auth/login/totp", json={"code": pyotp.TOTP(secret).now()}, cookies={"netmap_mfa_pending": pending}
    )
    assert done.status_code == 200, done.text
    assert done.json()["access_token"]
    assert any(h.startswith('netmap_mfa_pending=""') or h.startswith("netmap_mfa_pending=;") for h in done.headers.get_list("set-cookie"))
    db.expire_all()
    success = db.query(AuditLog).filter(AuditLog.action == "auth.login_success").one()
    assert "method=oidc+totp" in success.detail


def test_login_totp_without_a_challenge_or_cookie_is_refused(client_and_db):
    client, _db = client_and_db
    assert client.post("/api/v1/auth/login/totp", json={"code": "123456"}).status_code == 401


def test_trust_idp_skips_the_code_for_a_recent_allowlisted_mfa(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db, mfa_policy="trust_idp")
    _linked_user(db)
    response = _sso(client, db, fake_http, amr=["pwd", "mfa"], auth_time=int(time.time()) - 10)
    assert _mfa_step(response) is None
    assert client.cookies.get("netmap_access")


@pytest.mark.parametrize(
    "claims",
    [
        {"amr": ["mfa"]},  # no auth_time: fail closed
        {"amr": ["mfa"], "auth_time": int(time.time()) - 3600},  # too old
        {"amr": ["pwd"], "auth_time": int(time.time())},  # not an allowlisted method
        {"amr": "mfa", "auth_time": int(time.time())},  # malformed amr
        {"amr": ["mfa"], "auth_time": "now"},  # malformed auth_time
        {"amr": ["mfa"], "auth_time": int(time.time()) + 3600},  # from the future
    ],
)
def test_trust_idp_falls_back_to_the_local_code(client_and_db, fake_http, claims):
    client, db = client_and_db
    _enable_oidc(db, mfa_policy="trust_idp")
    _linked_user(db)
    assert _mfa_step(_sso(client, db, fake_http, **claims)) == "challenge"
    assert client.cookies.get("netmap_access") is None


def test_trust_idp_accepts_an_allowlisted_acr(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db, mfa_policy="trust_idp", mfa_trusted_acr="urn:example:loa:2")
    _linked_user(db)
    assert _mfa_step(_sso(client, db, fake_http, acr="urn:example:loa:2", auth_time=int(time.time()))) is None


def test_role_requiring_2fa_without_it_is_sent_to_setup(client_and_db, fake_http):
    client, db = client_and_db
    from datetime import datetime, timezone

    from app.models.system_setting import SystemSetting

    _enable_oidc(db)
    db.add(SystemSetting(key="totp_required", value="all", updated_at=datetime.now(timezone.utc)))
    _linked_user(db, totp=False)
    response = _sso(client, db, fake_http)
    assert _mfa_step(response) == "setup"
    assert client.cookies.get("netmap_access") is None
    pending = response.cookies.get("netmap_mfa_pending")
    setup = client.post("/api/v1/auth/login/totp/setup", json={}, cookies={"netmap_mfa_pending": pending})
    assert setup.status_code == 200, setup.text


def test_users_without_2fa_sign_in_directly(client_and_db, fake_http):
    client, db = client_and_db
    _enable_oidc(db)
    _linked_user(db, totp=False)
    assert _mfa_step(_sso(client, db, fake_http)) is None
    assert client.cookies.get("netmap_access")


def test_unknown_policy_values_fall_back_to_local_totp(client_and_db):
    from app.services.oidc.config import get_oidc_config

    _client, db = client_and_db
    _enable_oidc(db, mfa_policy="off")
    assert get_oidc_config(db).mfa_policy == "local_totp"


def test_policy_helper_never_trusts_under_local_totp():
    config = OidcRuntimeConfig(mfa_policy="local_totp")
    assert not provider_proved_recent_mfa(config, {"amr": ["mfa"], "auth_time": time.time()})
    trusting = OidcRuntimeConfig(mfa_policy="trust_idp", mfa_max_auth_age_seconds=300)
    now = 1_000_000
    assert provider_proved_recent_mfa(trusting, {"amr": ["mfa"], "auth_time": now - 300}, now=now)
    assert not provider_proved_recent_mfa(trusting, {"amr": ["mfa"], "auth_time": now - 301}, now=now)
    assert not provider_proved_recent_mfa(trusting, {"amr": ["mfa"], "auth_time": True}, now=now)


def test_admin_settings_expose_and_validate_the_policy(client_and_db):
    from app.core.security import create_access_token

    client, db = client_and_db
    admin = User(username="root", email="root@example.com", password_hash=hash_password("x" * 20), role="SuperAdmin", is_active=True)
    db.add(admin)
    db.commit()
    headers = {"Authorization": f"Bearer {create_access_token(admin.id)}"}
    body = client.get("/api/v1/admin/oidc-settings", headers=headers).json()
    assert (body["mfa_policy"], body["mfa_trusted_amr"], body["mfa_trusted_acr"], body["mfa_max_auth_age_seconds"]) == ("local_totp", "mfa", "", 300)
    assert client.put("/api/v1/admin/oidc-settings", headers=headers, json={"mfa_policy": "off"}).status_code == 422
    assert client.put("/api/v1/admin/oidc-settings", headers=headers, json={"mfa_max_auth_age_seconds": 5}).status_code == 422
    updated = client.put(
        "/api/v1/admin/oidc-settings", headers=headers, json={"mfa_policy": "trust_idp", "mfa_trusted_amr": "mfa, hwk", "mfa_max_auth_age_seconds": 600}
    )
    assert updated.status_code == 200, updated.text
    assert (updated.json()["mfa_policy"], updated.json()["mfa_trusted_amr"], updated.json()["mfa_max_auth_age_seconds"]) == ("trust_idp", "mfa, hwk", 600)

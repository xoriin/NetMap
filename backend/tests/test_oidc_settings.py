"""Tests for OIDC configuration resolution and the SuperAdmin settings API
(Phases 3 and 5)."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.api.deps import require_super_admin
from app.api.v1 import oidc as oidc_api
from app.core.security import hash_password
from app.db.session import get_db
from app.models.user import User, UserRole
from app.services.oidc.config import get_oidc_config, save_oidc_db_settings, store_client_secret
from app.services.oidc.provider import clear_provider_caches
from tests.oidc_helpers import (
    FakeProviderHttp,
    ISSUER,
    memory_session_factory,
    set_oidc_db_settings,
)


@pytest.fixture()
def fake_http(monkeypatch):
    fake = FakeProviderHttp()
    clear_provider_caches()
    monkeypatch.setattr("app.services.oidc.provider._http_get_json", fake.get_json)
    yield fake
    clear_provider_caches()


@pytest.fixture()
def session_factory():
    return memory_session_factory()


@pytest.fixture()
def db(session_factory):
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def admin_client(session_factory, db):
    app = FastAPI()
    app.include_router(oidc_api.router, prefix="/api/v1")

    admin = User(username="root", password_hash=hash_password("irrelevant-password"), role=UserRole.SUPER_ADMIN)
    db.add(admin)
    db.commit()

    def override_get_db():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_super_admin] = lambda: admin
    return TestClient(app)


# --- Config resolution -------------------------------------------------------


def test_db_settings_override_env_defaults(db):
    config = get_oidc_config(db)
    assert config.enabled is False
    set_oidc_db_settings(db, provider_name="Keycloak", scopes="openid email")
    config = get_oidc_config(db)
    assert config.enabled is True
    assert config.issuer == ISSUER
    assert config.provider_name == "Keycloak"
    assert config.scope_list() == ["openid", "email"]
    assert config.is_usable is True


def test_client_secret_stored_encrypted_and_resolves(db):
    set_oidc_db_settings(db)
    store_client_secret(db, "super-secret-value")
    db.commit()
    from app.models.system_setting import SystemSetting

    row = db.get(SystemSetting, "oidc.client_secret_encrypted")
    assert row is not None
    assert "super-secret-value" not in row.value
    assert get_oidc_config(db).client_secret == "super-secret-value"


def test_invalid_role_mappings_are_ignored(db):
    set_oidc_db_settings(db, role_mappings="{not json")
    assert get_oidc_config(db).role_mappings == {}


def test_require_sso_is_db_only(db):
    set_oidc_db_settings(db)
    assert get_oidc_config(db).require_sso is False
    save_oidc_db_settings(db, {"require_sso": "true"})
    db.commit()
    assert get_oidc_config(db).require_sso is True


# --- Admin settings API ------------------------------------------------------


def test_settings_read_masks_secret(admin_client, db):
    set_oidc_db_settings(db)
    store_client_secret(db, "super-secret-value")
    db.commit()
    payload = admin_client.get("/api/v1/admin/oidc-settings").json()
    assert payload["client_secret_set"] is True
    assert "super-secret-value" not in str(payload)


def test_settings_update_and_secret_rotation(admin_client, db):
    response = admin_client.put(
        "/api/v1/admin/oidc-settings",
        json={
            "enabled": True,
            "issuer": ISSUER,
            "client_id": "netmap-client",
            "client_secret": "first-secret",
            "provider_name": "Authentik",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["client_secret_set"] is True
    db.expire_all()
    assert get_oidc_config(db).client_secret == "first-secret"

    # Omitting client_secret keeps the stored value.
    admin_client.put("/api/v1/admin/oidc-settings", json={"provider_name": "Authentik SSO"})
    db.expire_all()
    assert get_oidc_config(db).client_secret == "first-secret"

    # Sending a new value rotates it; empty string clears it.
    admin_client.put("/api/v1/admin/oidc-settings", json={"client_secret": "second-secret"})
    db.expire_all()
    assert get_oidc_config(db).client_secret == "second-secret"
    admin_client.put("/api/v1/admin/oidc-settings", json={"client_secret": ""})
    db.expire_all()
    assert get_oidc_config(db).client_secret == ""


def test_settings_update_rejects_bad_role_mappings(admin_client):
    response = admin_client.put("/api/v1/admin/oidc-settings", json={"role_mappings": "[1,2]"})
    assert response.status_code == 400


def test_settings_update_rejects_super_admin_default_role(admin_client):
    response = admin_client.put("/api/v1/admin/oidc-settings", json={"default_role": "SuperAdmin"})
    assert response.status_code == 400


def test_provider_test_reports_checks(admin_client, db, fake_http):
    set_oidc_db_settings(db, redirect_url="https://netmap.example/api/v1/auth/oidc/callback")
    response = admin_client.post("/api/v1/admin/oidc-settings/test")
    payload = response.json()
    assert payload["ok"] is True
    names = {c["name"] for c in payload["checks"]}
    assert {"configuration", "redirect_url", "discovery", "jwks", "pkce"} <= names


def test_provider_test_explains_outage_without_secrets(admin_client, db, fake_http):
    set_oidc_db_settings(db)
    store_client_secret(db, "super-secret-value")
    db.commit()
    fake_http.offline = True
    payload = admin_client.post("/api/v1/admin/oidc-settings/test").json()
    assert payload["ok"] is False
    discovery = next(c for c in payload["checks"] if c["name"] == "discovery")
    assert discovery["ok"] is False
    assert "could not be reached" in discovery["message"]
    assert "super-secret-value" not in str(payload)


# --- Require-SSO guard rails (Phase 5) --------------------------------------


def test_require_sso_blocked_when_provider_unreachable(admin_client, db, fake_http):
    set_oidc_db_settings(db)
    fake_http.offline = True
    response = admin_client.put("/api/v1/admin/oidc-settings", json={"require_sso": True})
    assert response.status_code == 400
    assert "provider test failed" in response.json()["detail"]
    db.expire_all()
    assert get_oidc_config(db).require_sso is False


def test_require_sso_blocked_when_not_configured(admin_client, fake_http):
    response = admin_client.put("/api/v1/admin/oidc-settings", json={"require_sso": True})
    assert response.status_code == 400
    assert "not enabled" in response.json()["detail"]


def test_require_sso_enables_with_valid_config_and_super_admin(admin_client, db, fake_http):
    set_oidc_db_settings(db, redirect_url="https://netmap.example/api/v1/auth/oidc/callback")
    response = admin_client.put("/api/v1/admin/oidc-settings", json={"require_sso": True})
    assert response.status_code == 200, response.text
    assert response.json()["require_sso"] is True
    db.expire_all()
    assert get_oidc_config(db).require_sso is True

    # And it can be rolled back.
    response = admin_client.put("/api/v1/admin/oidc-settings", json={"require_sso": False})
    assert response.json()["require_sso"] is False


def test_require_sso_blocked_without_active_super_admin(admin_client, db, fake_http):
    set_oidc_db_settings(db, redirect_url="https://netmap.example/api/v1/auth/oidc/callback")
    db.query(User).update({"is_active": False})
    db.commit()
    response = admin_client.put("/api/v1/admin/oidc-settings", json={"require_sso": True})
    assert response.status_code == 400
    assert "SuperAdmin" in response.json()["detail"]


ACK_URL = "/api/v1/admin/oidc/link-by-email/acknowledge"


def test_link_by_email_acknowledgement_hides_notice_but_keeps_startup_warning(admin_client, db):
    from sqlalchemy import select
    from app.models.audit_log import AuditLog
    from app.services.oidc.config import oidc_security_warnings, link_by_email_fingerprint

    set_oidc_db_settings(db, link_by_email="true")
    assert oidc_security_warnings(db)
    response = admin_client.post(ACK_URL)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["link_by_email_acknowledged"] is True
    assert payload["link_by_email_ack_by"] == "root"
    assert payload["link_by_email_ack_at"].endswith(("Z", "+00:00"))
    db.expire_all()
    assert oidc_security_warnings(db) == []
    assert oidc_security_warnings(db, include_acknowledged=True)
    audit = db.scalar(select(AuditLog).where(AuditLog.action == "oidc_link_by_email_acknowledged"))
    assert audit is not None
    assert audit.actor_user_id == db.scalar(select(User.id).where(User.username == "root"))
    assert audit.detail == f"fingerprint={link_by_email_fingerprint(get_oidc_config(db))}"
    assert admin_client.get("/api/v1/admin/oidc-settings").json()["link_by_email_acknowledged"] is True


def test_link_by_email_off_rejects_acknowledgement(admin_client, db):
    from sqlalchemy import select
    from app.models.audit_log import AuditLog
    from app.services.oidc.config import oidc_security_warnings

    set_oidc_db_settings(db, link_by_email="false")
    assert admin_client.post(ACK_URL).status_code == 409
    assert oidc_security_warnings(db) == []
    assert db.scalar(select(AuditLog).where(AuditLog.action == "oidc_link_by_email_acknowledged")) is None


@pytest.mark.parametrize("changed", [{"issuer": "https://other.test"}, {"client_id": "other-client"}, {"link_by_email": "false"}])
def test_link_by_email_config_change_invalidates_acknowledgement(admin_client, db, changed):
    from app.services.oidc.config import oidc_security_warnings, link_by_email_acknowledgement, link_by_email_fingerprint

    set_oidc_db_settings(db, link_by_email="true")
    original = link_by_email_fingerprint(get_oidc_config(db))
    assert admin_client.post(ACK_URL).status_code == 200
    save_oidc_db_settings(db, changed)
    db.commit()
    assert link_by_email_fingerprint(get_oidc_config(db)) != original
    assert link_by_email_acknowledgement(db)["acknowledged"] is False
    assert admin_client.get("/api/v1/admin/oidc-settings").json()["link_by_email_acknowledged"] is False
    assert bool(oidc_security_warnings(db)) is (changed.get("link_by_email") != "false")


@pytest.mark.parametrize("role", [UserRole.NETWORK_ADMIN, UserRole.VIEWER])
def test_link_by_email_acknowledgement_requires_super_admin(admin_client, db, role):
    from app.api.deps import get_current_user

    set_oidc_db_settings(db, link_by_email="true")
    app = admin_client.app
    del app.dependency_overrides[require_super_admin]
    app.dependency_overrides[get_current_user] = lambda: User(id=999, username="ordinary", role=role)
    response = admin_client.post(ACK_URL)
    assert response.status_code == 403
    assert "SuperAdmin" in response.json()["detail"]


def test_link_by_email_acknowledgement_enforces_cookie_csrf(admin_client, db):
    from app.middleware.csrf import CsrfProtectionMiddleware

    set_oidc_db_settings(db, link_by_email="true")
    admin_client.app.add_middleware(CsrfProtectionMiddleware)
    admin_client.cookies.set("netmap_access", "session-cookie")
    admin_client.cookies.set("netmap_csrf", "csrf-value")
    assert admin_client.post(ACK_URL).status_code == 403
    assert admin_client.post(ACK_URL, headers={"X-CSRF-Token": "wrong"}).status_code == 403
    assert admin_client.post(ACK_URL, headers={"X-CSRF-Token": "csrf-value"}).status_code == 200

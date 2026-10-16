from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.api.deps import get_current_user
from app.api.v1 import admin
from app.core import startup


def test_https_upgrade_keeps_starting_without_security_flags(caplog):
    configured = SimpleNamespace(
        app_env="production", app_url="https://netmap.example.com", app_uses_https=True,
        auth_cookie_secure=False, auth_cookies_secure=False, secure_hsts_enabled=False,
        secure_headers_enabled=True,
        cors_origins=[], trusted_hosts=[], syslog_sender_allowlist=[],
    )
    with patch.object(startup, "settings", configured):
        startup.ensure_production_network_configuration()
    assert "AUTH_COOKIE_SECURE" in caplog.text
    assert "SECURE_HSTS_ENABLED" in caplog.text


@pytest.mark.parametrize("role,expected", [(None, 401), ("Viewer", 403), ("NetworkAdmin", 403), ("SuperAdmin", 200)])
def test_runtime_security_status_requires_superadmin(monkeypatch, role, expected):
    app = FastAPI()
    app.include_router(admin.router, prefix="/api/v1")
    if role:
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1, username="admin", role=role, is_active=True)
    from app.core.config import settings
    monkeypatch.setattr(settings, "app_env", "production")
    monkeypatch.setattr(settings, "app_url", "https://netmap.example.com")
    monkeypatch.setattr(settings, "auth_cookie_secure", False)
    monkeypatch.setattr(settings, "secure_hsts_enabled", False)
    monkeypatch.setattr(settings, "secure_headers_enabled", True)
    with TestClient(app) as client:
        response = client.get("/api/v1/admin/runtime-security")
        assert response.status_code == expected
        if expected == 200:
            warnings = response.json()["warnings"]
            assert len(warnings) == 2
            assert "AUTH_COOKIE_SECURE=true" in warnings[0]
            assert "SECURE_HSTS_ENABLED=true" in warnings[1]
            monkeypatch.setattr(settings, "auth_cookie_secure", True)
            monkeypatch.setattr(settings, "secure_hsts_enabled", True)
            assert client.get("/api/v1/admin/runtime-security").json() == {"warnings": []}


@pytest.mark.parametrize("https,env,cookies,hsts,headers,count", [
    (False, "production", False, False, True, 0),
    (True, "development", False, False, True, 0),
    (True, "production", None, False, True, 1),
    (True, "production", True, True, False, 1),
    (False, "production", False, True, True, 1),
])
def test_runtime_security_uses_effective_configuration(monkeypatch, https, env, cookies, hsts, headers, count):
    from app.core.config import settings
    from app.core.runtime_security import https_security_warnings
    monkeypatch.setattr(settings, "app_env", env)
    monkeypatch.setattr(settings, "app_url", "https://netmap.example.com" if https else "http://netmap.lan")
    monkeypatch.setattr(settings, "auth_cookie_secure", cookies)
    monkeypatch.setattr(settings, "secure_hsts_enabled", hsts)
    monkeypatch.setattr(settings, "secure_headers_enabled", headers)
    assert len(https_security_warnings()) == count


def test_explicit_insecure_cookie_setting_is_told_to_remove_it(monkeypatch):
    from app.core.config import settings
    from app.core.runtime_security import https_security_warnings
    monkeypatch.setattr(settings, "app_env", "production")
    monkeypatch.setattr(settings, "app_url", "https://netmap.example.com")
    monkeypatch.setattr(settings, "auth_cookie_secure", False)
    monkeypatch.setattr(settings, "secure_hsts_enabled", True)
    monkeypatch.setattr(settings, "secure_headers_enabled", True)
    assert len(https_security_warnings()) == 1
    assert "Remove AUTH_COOKIE_SECURE" in https_security_warnings()[0]


def test_unset_cookie_setting_with_hsts_on_plain_http_names_app_url(monkeypatch):
    from app.core.config import settings
    from app.core.runtime_security import https_security_warnings
    monkeypatch.setattr(settings, "app_env", "production")
    monkeypatch.setattr(settings, "app_url", "http://netmap.lan")
    monkeypatch.setattr(settings, "auth_cookie_secure", None)
    monkeypatch.setattr(settings, "secure_hsts_enabled", True)
    monkeypatch.setattr(settings, "secure_headers_enabled", True)
    [warning] = https_security_warnings()
    assert "APP_URL" in warning and "AUTH_COOKIE_SECURE=false" not in warning

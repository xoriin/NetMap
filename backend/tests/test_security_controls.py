from types import SimpleNamespace
from unittest.mock import patch

import pytest
import anyio

from app.middleware.csrf import CsrfProtectionMiddleware
from app.services.tools.service import ensure_active_target_allowed
from app.api.v1.auth import _clear_auth_cookies


async def _ok_app(scope, receive, send):
    await send({"type": "http.response.start", "status": 204, "headers": []})
    await send({"type": "http.response.body", "body": b""})


async def _csrf_response_status(headers: dict[str, str]) -> int:
    middleware = CsrfProtectionMiddleware(_ok_app)
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/v1/auth/logout",
        "headers": [(key.lower().encode("latin1"), value.encode("latin1")) for key, value in headers.items()],
    }
    await middleware(scope, receive, send)
    return next(message["status"] for message in messages if message["type"] == "http.response.start")


def test_csrf_blocks_cookie_authenticated_unsafe_request_without_token() -> None:
    status = anyio.run(_csrf_response_status, {"cookie": "netmap_access=access-token"})

    assert status == 403


def test_csrf_allows_matching_double_submit_token() -> None:
    status = anyio.run(
        _csrf_response_status,
        {"cookie": "netmap_access=access-token; netmap_csrf=csrf-token", "x-csrf-token": "csrf-token"},
    )

    assert status == 204


def test_csrf_allows_bearer_authenticated_request() -> None:
    status = anyio.run(_csrf_response_status, {"authorization": "Bearer access-token"})

    assert status == 204


def test_logout_clears_csrf_cookie_root_path() -> None:
    from starlette.responses import Response

    response = Response()

    _clear_auth_cookies(response)

    set_cookie_headers = response.headers.getlist("set-cookie")
    assert any("netmap_csrf=" in header and "Path=/" in header for header in set_cookie_headers)


def test_active_tool_blocks_public_ip_targets_by_default() -> None:
    with pytest.raises(ValueError, match="Public active network targets are blocked"):
        ensure_active_target_allowed("8.8.8.8")


def test_active_tool_allows_private_ip_targets_by_default() -> None:
    ensure_active_target_allowed("192.168.1.1")


def test_active_tool_resolves_hostnames_before_allowing() -> None:
    fake_info = [(None, None, None, None, ("10.0.0.10", 0))]
    with patch("app.services.tools.service.socket.getaddrinfo", return_value=fake_info):
        ensure_active_target_allowed("router.lan")


def test_startup_rejects_placeholder_secret_values() -> None:
    from app.core import startup

    # Placeholder rejection only applies in production mode.
    fake_settings = SimpleNamespace(
        app_env="production",
        secret_key="replace-with-a-long-random-secret",
        secret_key_file=None,
        master_key=None,
        master_key_file=None,
    )

    with patch.object(startup, "settings", fake_settings):
        with pytest.raises(RuntimeError, match="SECRET_KEY must not use a placeholder"):
            startup.ensure_secret_configuration()


def test_startup_ignores_placeholder_secret_values_in_development() -> None:
    from app.core import startup

    fake_settings = SimpleNamespace(
        app_env="development",
        secret_key="replace-with-a-long-random-secret",
        secret_key_file=None,
        master_key=None,
        master_key_file=None,
    )

    with patch.object(startup, "settings", fake_settings):
        # Should not raise — placeholder checks are skipped outside production.
        startup.ensure_secret_configuration()


def test_startup_rejects_invalid_master_key() -> None:
    from app.core import startup

    fake_settings = SimpleNamespace(
        app_env="development",
        secret_key="real-secret",
        secret_key_file=None,
        master_key="not-a-fernet-key",
        master_key_file=None,
    )

    with patch.object(startup, "settings", fake_settings):
        with pytest.raises(RuntimeError, match="MASTER_KEY is not a valid Fernet key"):
            startup.ensure_secret_configuration()

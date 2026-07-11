from __future__ import annotations

from collections.abc import Awaitable, Callable
from secrets import compare_digest

from starlette.responses import JSONResponse

CSRF_COOKIE_NAME = "netmap_csrf"
CSRF_HEADER_NAME = "x-csrf-token"

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
_EXEMPT_PATHS = frozenset({
    "/api/v1/auth/login",
    "/api/v1/auth/forgot-password",
    "/api/v1/auth/reset-password",
    "/api/v1/setup/admin",
})


class CsrfProtectionMiddleware:
    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "").upper()
        path = scope.get("path", "")
        if method in _SAFE_METHODS or path in _EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return

        headers = {key.decode("latin1").lower(): value.decode("latin1") for key, value in scope["headers"]}
        if headers.get("authorization", "").lower().startswith("bearer ") or headers.get("x-api-key"):
            await self.app(scope, receive, send)
            return

        cookies = _parse_cookie_header(headers.get("cookie", ""))
        if "netmap_access" not in cookies and "netmap_refresh" not in cookies:
            await self.app(scope, receive, send)
            return

        csrf_cookie = cookies.get(CSRF_COOKIE_NAME, "")
        csrf_header = headers.get(CSRF_HEADER_NAME, "")
        if not csrf_cookie or not csrf_header or not compare_digest(csrf_cookie, csrf_header):
            response = JSONResponse(
                {"detail": "CSRF token required"},
                status_code=403,
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)


def _parse_cookie_header(raw_cookie: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for part in raw_cookie.split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        cookies[key.strip()] = value.strip()
    return cookies

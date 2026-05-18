from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import Request
from starlette.datastructures import MutableHeaders

from app.core.config import settings
from app.core.network import request_scheme


class SecurityHeadersMiddleware:
    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive=receive)

        async def send_with_headers(message: dict) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("X-Content-Type-Options", "nosniff")
                headers.setdefault("Referrer-Policy", settings.secure_referrer_policy)
                headers.setdefault("Content-Security-Policy", settings.secure_content_security_policy)
                headers.setdefault("Permissions-Policy", settings.secure_permissions_policy)
                headers.setdefault("X-Frame-Options", "DENY")
                if settings.secure_hsts_enabled and request_scheme(request) == "https":
                    headers.setdefault(
                        "Strict-Transport-Security",
                        f"max-age={settings.secure_hsts_max_age}; includeSubDomains",
                    )
            await send(message)

        await self.app(scope, receive, send_with_headers)

from __future__ import annotations

from datetime import timedelta
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.v1 import syslog
from app.core.security import create_token


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(syslog.router, prefix="/api/v1")
    return TestClient(app)


def test_live_firewall_websocket_acknowledges_auth_and_heartbeats(monkeypatch) -> None:
    monkeypatch.setattr(syslog, "get_websocket_user", lambda _token: SimpleNamespace(role="SecurityAnalyst"))

    with _client().websocket_connect("/api/v1/syslog/events/live") as websocket:
        websocket.send_text("example-token")
        assert websocket.receive_json() == {"type": "ready"}
        websocket.send_text("ping")
        assert websocket.receive_json() == {"type": "heartbeat"}


def test_live_firewall_websocket_accepts_super_admin(monkeypatch) -> None:
    monkeypatch.setattr(syslog, "get_websocket_user", lambda _token: SimpleNamespace(role="SuperAdmin"))

    with _client().websocket_connect("/api/v1/syslog/events/live") as websocket:
        websocket.send_text("example-token")
        assert websocket.receive_json() == {"type": "ready"}


def test_live_firewall_websocket_rejects_role_without_security_view(monkeypatch) -> None:
    monkeypatch.setattr(syslog, "get_websocket_user", lambda _token: SimpleNamespace(role="Viewer"))

    with _client().websocket_connect("/api/v1/syslog/events/live") as websocket:
        websocket.send_text("example-token")
        with pytest.raises(WebSocketDisconnect) as exc_info:
            websocket.receive_json()
    assert exc_info.value.code == 1008


def test_live_firewall_websocket_user_lookup_does_not_block_event_loop(monkeypatch) -> None:
    import asyncio
    import time

    def slow_lookup(_token):
        time.sleep(0.5)  # stands in for a SQLite busy wait
        return None

    monkeypatch.setattr(syslog, "get_websocket_user", slow_lookup)
    closed: list[int] = []

    class FakeWebSocket:
        async def accept(self) -> None:
            return None

        async def receive_text(self) -> str:
            return "example-token"

        async def close(self, code: int) -> None:
            closed.append(code)

    async def main() -> float:
        gaps: list[float] = []
        last = time.monotonic()

        async def ticker() -> None:
            nonlocal last
            for _ in range(20):
                await asyncio.sleep(0.02)
                now = time.monotonic()
                gaps.append(now - last)
                last = now

        await asyncio.gather(ticker(), syslog.live_firewall_events(FakeWebSocket()))
        return max(gaps)

    worst_gap = asyncio.run(main())
    assert worst_gap < 0.2
    assert closed == [1008]


def _token_expiring_in(seconds: float) -> str:
    return create_token("1", "access", timedelta(seconds=seconds))


def test_live_firewall_websocket_closes_when_the_access_token_expires(monkeypatch) -> None:
    monkeypatch.setattr(syslog, "get_websocket_user", lambda _token: SimpleNamespace(role="SecurityAnalyst"))
    monkeypatch.setattr(syslog, "websocket_session_still_valid", lambda _payload: True)
    token = _token_expiring_in(2)
    expires_at = syslog._token_expires_at(syslog.decode_token(token, "access"))

    with _client().websocket_connect("/api/v1/syslog/events/live") as websocket:
        websocket.send_text(token)
        assert websocket.receive_json() == {"type": "ready"}
        # Heartbeats still work while the token is valid.
        websocket.send_text("ping")
        assert websocket.receive_json() == {"type": "heartbeat"}
        # No client message is needed: the server closes at expiry.
        with pytest.raises(WebSocketDisconnect) as exc_info:
            websocket.receive_json()
    assert exc_info.value.code == 1008
    assert exc_info.value.reason == syslog.WS_TOKEN_EXPIRED_REASON
    assert time.time() >= expires_at


def test_live_firewall_websocket_answers_a_ping_after_expiry_by_closing(monkeypatch) -> None:
    monkeypatch.setattr(syslog, "get_websocket_user", lambda _token: SimpleNamespace(role="SecurityAnalyst"))
    monkeypatch.setattr(syslog, "websocket_session_still_valid", lambda _payload: True)
    clock = {"now": time.time()}
    monkeypatch.setattr(syslog, "_wall_clock", lambda: clock["now"])
    token = _token_expiring_in(600)

    with _client().websocket_connect("/api/v1/syslog/events/live") as websocket:
        websocket.send_text(token)
        assert websocket.receive_json() == {"type": "ready"}
        websocket.send_text("ping")
        assert websocket.receive_json() == {"type": "heartbeat"}
        clock["now"] += 601
        websocket.send_text("ping")
        # No heartbeat for an expired token: the stream closes instead.
        with pytest.raises(WebSocketDisconnect) as exc_info:
            websocket.receive_json()
    assert exc_info.value.code == 1008
    assert exc_info.value.reason == syslog.WS_TOKEN_EXPIRED_REASON


def test_token_expiry_is_read_from_the_exp_claim() -> None:
    assert syslog._token_expires_at({"exp": 1700000000}) == 1700000000.0
    assert syslog._token_expires_at({"exp": True}) is None
    assert syslog._token_expires_at({}) is None
    assert syslog._token_expires_at(None) is None


def test_live_firewall_websocket_closes_on_revocation_without_pings(monkeypatch) -> None:
    """Signing out everywhere ends a quiet stream within the re-check interval."""
    import asyncio

    monkeypatch.setattr(syslog, "get_websocket_user", lambda _token: SimpleNamespace(role="SecurityAnalyst"))
    monkeypatch.setattr(syslog, "WS_SESSION_RECHECK_SECONDS", 0.2)
    session = {"valid": True, "checks": 0}

    def still_valid(_payload):
        session["checks"] += 1
        return session["valid"]

    monkeypatch.setattr(syslog, "websocket_session_still_valid", still_valid)
    token = _token_expiring_in(600)
    sent: list[dict] = []
    closed: list[int] = []

    class QuietWebSocket:
        def __init__(self) -> None:
            self.first = True

        async def accept(self) -> None:
            return None

        async def receive_text(self) -> str:
            if self.first:
                self.first = False
                return token
            await asyncio.Event().wait()  # the client never sends anything
            return ""

        async def send_json(self, data) -> None:
            sent.append(data)

        async def close(self, code: int, reason: str | None = None) -> None:
            closed.append(code)

    async def register(_ws) -> None:
        return None

    async def disconnect(_ws) -> None:
        return None

    monkeypatch.setattr(syslog.firewall_event_broadcaster, "register", register)
    monkeypatch.setattr(syslog.firewall_event_broadcaster, "disconnect", disconnect)

    async def main() -> None:
        async def revoke_soon() -> None:
            await asyncio.sleep(0.3)
            session["valid"] = False

        await asyncio.wait_for(
            asyncio.gather(revoke_soon(), syslog.live_firewall_events(QuietWebSocket())), timeout=3
        )

    asyncio.run(main())
    assert sent == [{"type": "ready"}]
    assert closed == [1008]
    assert session["checks"] >= 2

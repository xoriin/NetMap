from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.v1 import syslog


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

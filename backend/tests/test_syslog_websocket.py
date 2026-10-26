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

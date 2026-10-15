from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import syslog


def test_live_firewall_websocket_acknowledges_auth_and_heartbeats(monkeypatch) -> None:
    monkeypatch.setattr(syslog, "get_websocket_user", lambda _token: SimpleNamespace(role="Viewer"))
    monkeypatch.setattr(syslog, "has_permission", lambda _role, _permission: True)
    app = FastAPI()
    app.include_router(syslog.router, prefix="/api/v1")

    with TestClient(app).websocket_connect("/api/v1/syslog/events/live") as websocket:
        websocket.send_text("example-token")
        assert websocket.receive_json() == {"type": "ready"}
        websocket.send_text("ping")
        assert websocket.receive_json() == {"type": "heartbeat"}

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class FirewallEventBroadcaster:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)
            self._loop = asyncio.get_running_loop()

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    def publish(self, event: dict[str, Any]) -> None:
        loop = self._loop
        if loop is None or not self._connections:
            return
        message = json.dumps(event, default=serialize_json_value)
        asyncio.run_coroutine_threadsafe(self._broadcast(message), loop)

    async def _broadcast(self, message: str) -> None:
        async with self._lock:
            connections = list(self._connections)
        stale: list[WebSocket] = []
        for websocket in connections:
            try:
                await websocket.send_text(message)
            except Exception:
                stale.append(websocket)
                logger.debug("Removing stale firewall event websocket", exc_info=True)
        if stale:
            async with self._lock:
                for websocket in stale:
                    self._connections.discard(websocket)


def serialize_json_value(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


firewall_event_broadcaster = FirewallEventBroadcaster()

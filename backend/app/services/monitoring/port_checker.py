from __future__ import annotations

import socket


def check_port(host: str, port: int, timeout: float = 2.0) -> bool:
    """Return True if TCP port is open on host."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False

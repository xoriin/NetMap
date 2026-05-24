import subprocess
from unittest.mock import patch

import pytest

from app.schemas.tools import PingRequest, TracerouteRequest
from app.services.tools.service import (
    MAX_TRACEROUTE_PROCESS_TIMEOUT_SECONDS,
    _default_socket_timeout,
    _resolve_host,
    ping_host,
    traceroute_host,
)


def test_ping_host_converts_subprocess_timeout_to_timeout_error() -> None:
    with (
        patch("app.services.tools.service.ensure_active_target_allowed"),
        patch("app.services.tools.service.subprocess.run") as mock_run,
    ):
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["ping"], timeout=4)

        with pytest.raises(TimeoutError, match="Ping timed out after 4 seconds"):
            ping_host(PingRequest(host="10.0.0.10", count=1, timeout_seconds=1))


def test_traceroute_host_caps_process_timeout() -> None:
    with (
        patch("app.services.tools.service.ensure_active_target_allowed"),
        patch("app.services.tools.service.shutil.which", return_value="/usr/bin/traceroute"),
        patch("app.services.tools.service.subprocess.run") as mock_run,
    ):
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="",
            stderr="",
        )

        traceroute_host(TracerouteRequest(host="10.0.0.10", max_hops=64, timeout_seconds=60))

        assert mock_run.call_args.kwargs["timeout"] == MAX_TRACEROUTE_PROCESS_TIMEOUT_SECONDS


def test_resolve_host_uses_temporary_default_socket_timeout() -> None:
    observed_timeout = None

    def fake_getaddrinfo(*_args, **_kwargs):
        nonlocal observed_timeout
        observed_timeout = __import__("socket").getdefaulttimeout()
        return [(None, None, None, None, ("10.0.0.10", 0))]

    with patch("app.services.tools.service.socket.getaddrinfo", side_effect=fake_getaddrinfo):
        _resolve_host("router.lan")

    assert observed_timeout == 3.0
    assert __import__("socket").getdefaulttimeout() is None


def test_default_socket_timeout_restores_previous_value() -> None:
    import socket

    socket.setdefaulttimeout(9.0)
    try:
        with _default_socket_timeout(1.5):
            assert socket.getdefaulttimeout() == 1.5
        assert socket.getdefaulttimeout() == 9.0
    finally:
        socket.setdefaulttimeout(None)

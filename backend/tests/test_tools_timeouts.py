import subprocess
from unittest.mock import patch

import pytest

from app.schemas.tools import PingRequest, TracerouteRequest
from app.services.tools.service import (
    MAX_TRACEROUTE_PROCESS_TIMEOUT_SECONDS,
    _default_socket_timeout,
    _run_tool_command,
    _resolve_host,
    _safe_tool_target_argument,
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
        assert mock_run.call_args.args[0][-2:] == ["--", "10.0.0.10"]


def test_ping_host_uses_end_of_options_before_target() -> None:
    with (
        patch("app.services.tools.service.ensure_active_target_allowed"),
        patch("app.services.tools.service.subprocess.run") as mock_run,
    ):
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="",
            stderr="",
        )

        ping_host(PingRequest(host="10.0.0.10", count=1, timeout_seconds=1))

        assert mock_run.call_args.args[0][-2:] == ["--", "10.0.0.10"]


def test_ping_host_resolves_hostname_before_subprocess() -> None:
    with (
        patch("app.services.tools.service.ensure_active_target_allowed"),
        patch("app.services.tools.service._resolve_host", return_value=[(None, None, None, None, ("10.0.0.20", 0))]),
        patch("app.services.tools.service.subprocess.run") as mock_run,
    ):
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="",
            stderr="",
        )

        ping_host(PingRequest(host="router.lan", count=1, timeout_seconds=1))

        assert mock_run.call_args.args[0][-2:] == ["--", "10.0.0.20"]


def test_safe_tool_target_argument_rejects_option_like_values() -> None:
    with pytest.raises(ValueError):
        _safe_tool_target_argument("-Ieth0")


def test_run_tool_command_rejects_unsupported_executable() -> None:
    with pytest.raises(ValueError, match="Unsupported tool command"):
        _run_tool_command(["sh", "-c", "id"], timeout_seconds=1, timeout_label="Tool")


def test_run_tool_command_rejects_control_characters() -> None:
    with pytest.raises(ValueError, match="Invalid command argument"):
        _run_tool_command(["ping", "-c", "1", "10.0.0.1\nid"], timeout_seconds=1, timeout_label="Ping")


def test_run_tool_command_rejects_malformed_ping_command() -> None:
    with pytest.raises(ValueError, match="Invalid ping command"):
        _run_tool_command(["ping", "-c", "1", "10.0.0.1"], timeout_seconds=1, timeout_label="Ping")


def test_run_tool_command_rejects_unknown_traceroute_option() -> None:
    with pytest.raises(ValueError, match="Unsupported traceroute command option"):
        _run_tool_command(
            ["traceroute", "-n", "-e", "--", "10.0.0.1"],
            timeout_seconds=1,
            timeout_label="Traceroute",
        )


def test_run_tool_command_rejects_extra_traceroute_target() -> None:
    with pytest.raises(ValueError, match="Invalid traceroute command"):
        _run_tool_command(
            ["traceroute", "-n", "--", "10.0.0.1", "10.0.0.2"],
            timeout_seconds=1,
            timeout_label="Traceroute",
        )


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

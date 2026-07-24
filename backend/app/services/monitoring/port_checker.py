from __future__ import annotations

import socket
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from ipaddress import ip_address
from urllib.parse import urlsplit


@dataclass(frozen=True)
class CheckResult:
    open: bool
    response_time_ms: float | None = None
    status_code: int | None = None


def check_port(
    host: str,
    port: int,
    timeout: float = 2.0,
    *,
    protocol: str = "tcp",
    http_path: str | None = None,
    http_method: str = "GET",
    expected_status_min: int = 200,
    expected_status_max: int = 399,
    verify_tls: bool = False,
    follow_redirects: bool = True,
) -> CheckResult:
    if protocol == "udp":
        return _check_udp(host, port, timeout)
    if protocol in ("http", "https"):
        return _check_http(
            host, port, timeout, protocol, http_path or "/",
            method=http_method,
            expected_status_min=expected_status_min,
            expected_status_max=expected_status_max,
            verify_tls=verify_tls,
            follow_redirects=follow_redirects,
        )
    start = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return CheckResult(open=True, response_time_ms=(time.monotonic() - start) * 1000)
    except OSError:
        return CheckResult(open=False)


def _check_http(
    host: str,
    port: int,
    timeout: float,
    scheme: str,
    path: str,
    *,
    method: str,
    expected_status_min: int,
    expected_status_max: int,
    verify_tls: bool,
    follow_redirects: bool,
) -> CheckResult:
    host_part = f"[{host}]" if ":" in host else host
    url = f"{scheme}://{host_part}:{port}{path}"
    return _request_http(
        url, timeout, scheme,
        method=method,
        expected_status_min=expected_status_min,
        expected_status_max=expected_status_max,
        verify_tls=verify_tls,
        follow_redirects=follow_redirects,
    )


def check_url(
    url: str,
    timeout: float = 10.0,
    *,
    method: str = "GET",
    expected_status_min: int = 200,
    expected_status_max: int = 399,
    verify_tls: bool = True,
    follow_redirects: bool = True,
) -> CheckResult:
    """Standalone-monitor variant of _check_http: takes a full URL rather than host/port/path."""
    scheme = urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        return CheckResult(open=False)
    return _request_http(
        url, timeout, scheme,
        method=method,
        expected_status_min=expected_status_min,
        expected_status_max=expected_status_max,
        verify_tls=verify_tls,
        follow_redirects=follow_redirects,
    )


def _request_http(
    url: str,
    timeout: float,
    scheme: str,
    *,
    method: str,
    expected_status_min: int,
    expected_status_max: int,
    verify_tls: bool,
    follow_redirects: bool,
) -> CheckResult:
    handlers: list[urllib.request.BaseHandler] = []
    if scheme == "https":
        # ponytail: unverified by default — LAN devices commonly use self-signed
        # certs. verify_tls opts a specific check into real certificate validation.
        context = ssl.create_default_context() if verify_tls else ssl._create_unverified_context()
        handlers.append(urllib.request.HTTPSHandler(context=context))
    if not follow_redirects:
        handlers.append(_NoRedirect())
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request(url, method=method, headers={"User-Agent": "NetMap-Monitor"})
    start = time.monotonic()
    try:
        with opener.open(request, timeout=timeout) as response:
            elapsed_ms = (time.monotonic() - start) * 1000
            return CheckResult(
                open=expected_status_min <= response.status <= expected_status_max,
                response_time_ms=elapsed_ms,
                status_code=response.status,
            )
    except urllib.error.HTTPError as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        return CheckResult(
            open=expected_status_min <= exc.code <= expected_status_max,
            response_time_ms=elapsed_ms,
            status_code=exc.code,
        )
    except (urllib.error.URLError, OSError, ValueError):
        return CheckResult(open=False)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _check_udp(host: str, port: int, timeout: float) -> CheckResult:
    try:
        family = socket.AF_INET6 if ip_address(host).version == 6 else socket.AF_INET
    except ValueError:
        family = socket.AF_INET
    sock = socket.socket(family, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    start = time.monotonic()
    try:
        sock.sendto(b"\x00", (host, port))
        sock.recvfrom(1024)
        return CheckResult(open=True, response_time_ms=(time.monotonic() - start) * 1000)
    except socket.timeout:
        return CheckResult(open=False)
    except ConnectionRefusedError:
        return CheckResult(open=False)
    except OSError:
        return CheckResult(open=False)
    finally:
        sock.close()

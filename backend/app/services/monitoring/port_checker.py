from __future__ import annotations

import json
import errno
import re
import secrets
import socket
import ssl
import struct
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def _network_error_message(exc: OSError) -> str:
    if isinstance(exc, TimeoutError):
        return "Timed Out"
    friendly = {
        errno.ECONNREFUSED: "Connection refused",
        errno.ETIMEDOUT: "Timed Out",
        errno.EHOSTUNREACH: "Host unreachable",
        errno.ENETUNREACH: "Network unreachable",
        errno.ECONNRESET: "Connection reset",
    }.get(exc.errno)
    if friendly:
        return friendly
    return re.sub(r"^\[Errno \d+\]\s*", "", str(exc))[:255] or "Connection failed"


@dataclass(frozen=True)
class CheckResult:
    open: bool
    response_time_ms: float | None = None
    status_code: int | None = None
    error: str | None = None
    assertion_detail: str | None = None
    response_size_bytes: int | None = None
    cert_expires_at: datetime | None = None
    cert_issuer: str | None = None


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
    if protocol == "dhcp":
        return _check_dhcp(host, port, timeout)
    if protocol in ("http", "https"):
        host_part = f"[{host}]" if ":" in host else host
        return check_url(
            f"{protocol}://{host_part}:{port}{http_path or '/'}",
            timeout,
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
    except OSError as exc:
        return CheckResult(open=False, error=_network_error_message(exc))


def check_url(
    url: str,
    timeout: float = 10.0,
    *,
    method: str = "GET",
    expected_status_min: int = 200,
    expected_status_max: int = 399,
    accepted_status_codes: str | None = None,
    verify_tls: bool = True,
    follow_redirects: bool = True,
    max_redirects: int = 10,
    headers: dict[str, str] | None = None,
    body: str | None = None,
    body_encoding: str = "json",
    auth_type: str = "none",
    auth_username: str | None = None,
    auth_password: str | None = None,
    bearer_token: str | None = None,
    oauth_token_url: str | None = None,
    oauth_client_id: str | None = None,
    oauth_client_secret: str | None = None,
    oauth_scopes: str | None = None,
    oauth_audience: str | None = None,
    oauth_auth_method: str = "client_secret_basic",
    proxy_url: str | None = None,
    tls_ca: str | None = None,
    tls_cert: str | None = None,
    tls_key: str | None = None,
    keyword: str | None = None,
    keyword_inverted: bool = False,
    json_path: str | None = None,
    json_operator: str = "equals",
    expected_value: str | None = None,
    cache_bust: bool = False,
    upside_down: bool = False,
) -> CheckResult:
    """Run a bounded HTTP check and apply status/body assertions.

    Response reads are capped so a monitoring target cannot consume unbounded
    memory. Callers are expected to decrypt stored secrets before invoking this
    function; no credentials or response bodies are returned or logged.
    """
    scheme = urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        return CheckResult(open=False, error="URL must use HTTP or HTTPS")
    if cache_bust:
        url = _add_cache_buster(url)

    request_headers = {"User-Agent": "NetMap-Monitor/1.0", **(headers or {})}
    content, content_type, body_error = _encode_body(body, body_encoding)
    if body_error:
        return CheckResult(open=False, error=body_error)
    if content_type and not any(name.lower() == "content-type" for name in request_headers):
        request_headers["Content-Type"] = content_type

    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        verify: bool | ssl.SSLContext = verify_tls
        cert: tuple[str, str] | None = None
        if tls_ca or (auth_type == "mtls" and tls_cert and tls_key):
            temp_dir = tempfile.TemporaryDirectory(prefix="netmap-monitor-")
            verify = _build_ssl_context(temp_dir.name, verify_tls, tls_ca, tls_cert, tls_key)

        if auth_type == "basic":
            auth: httpx.Auth | tuple[str, str] | None = (auth_username or "", auth_password or "")
        else:
            auth = None
        if auth_type == "bearer" and bearer_token:
            request_headers["Authorization"] = f"Bearer {bearer_token}"
        if auth_type == "oauth2":
            token, token_error = _oauth_token(
                oauth_token_url, oauth_client_id, oauth_client_secret, oauth_scopes,
                oauth_audience, oauth_auth_method, timeout, verify, proxy_url,
            )
            if token_error:
                return CheckResult(open=False, error=token_error)
            request_headers["Authorization"] = f"Bearer {token}"

        started = time.monotonic()
        with httpx.Client(
            verify=verify,
            cert=cert,
            proxy=proxy_url,
            follow_redirects=follow_redirects,
            max_redirects=max_redirects,
            timeout=httpx.Timeout(timeout),
        ) as client:
            with client.stream(method, url, headers=request_headers, content=content, auth=auth) as response:
                payload = bytearray()
                for chunk in response.iter_bytes():
                    if len(payload) + len(chunk) > MAX_RESPONSE_BYTES:
                        return CheckResult(
                            open=False,
                            response_time_ms=(time.monotonic() - started) * 1000,
                            status_code=response.status_code,
                            error=f"Response exceeds {MAX_RESPONSE_BYTES // 1024 // 1024} MiB limit",
                        )
                    payload.extend(chunk)
                elapsed_ms = (time.monotonic() - started) * 1000
                cert_expires_at, cert_issuer = _certificate_info(response)
                status_ok = _status_allowed(
                    response.status_code,
                    accepted_status_codes or f"{expected_status_min}-{expected_status_max}",
                )
                assertion_ok, assertion_detail = _assert_response(
                    bytes(payload), response.encoding, keyword, keyword_inverted,
                    json_path, json_operator, expected_value,
                )
                success = status_ok and assertion_ok
                failure = None
                if not status_ok:
                    failure = f"HTTP {response.status_code} is outside accepted status codes"
                elif not assertion_ok:
                    failure = assertion_detail
                if upside_down:
                    success = not success
                    assertion_detail = f"Inverted result: {assertion_detail or ('request succeeded' if status_ok else failure)}"
                    failure = None if success else "Inverted monitor expected the request to fail"
                return CheckResult(
                    open=success,
                    response_time_ms=elapsed_ms,
                    status_code=response.status_code,
                    error=failure,
                    assertion_detail=assertion_detail,
                    response_size_bytes=len(payload),
                    cert_expires_at=cert_expires_at,
                    cert_issuer=cert_issuer,
                )
    except httpx.TooManyRedirects:
        return CheckResult(open=upside_down, error=None if upside_down else f"Exceeded {max_redirects} redirects")
    except (httpx.HTTPError, OSError, ValueError, ssl.SSLError) as exc:
        message = re.sub(r"\btimed out\b", "Timed Out", f"{type(exc).__name__}: {exc}", flags=re.IGNORECASE)[:255]
        return CheckResult(open=upside_down, error=None if upside_down else message, assertion_detail="Inverted transport failure" if upside_down else None)
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()


def _build_ssl_context(
    directory: str,
    verify_tls: bool,
    ca_pem: str | None,
    cert_pem: str | None,
    key_pem: str | None,
) -> ssl.SSLContext:
    context = ssl.create_default_context() if verify_tls else ssl._create_unverified_context()
    if ca_pem:
        context.load_verify_locations(cadata=ca_pem)
    if cert_pem and key_pem:
        cert_path = Path(directory) / "client.crt"
        key_path = Path(directory) / "client.key"
        cert_path.write_text(cert_pem, encoding="utf-8")
        key_path.write_text(key_pem, encoding="utf-8")
        cert_path.chmod(0o600)
        key_path.chmod(0o600)
        context.load_cert_chain(str(cert_path), str(key_path))
    return context


def _oauth_token(
    token_url: str | None,
    client_id: str | None,
    client_secret: str | None,
    scopes: str | None,
    audience: str | None,
    auth_method: str,
    timeout: float,
    verify: bool | ssl.SSLContext,
    proxy_url: str | None,
) -> tuple[str | None, str | None]:
    if not token_url or not client_id or not client_secret:
        return None, "OAuth2 configuration is incomplete"
    data = {"grant_type": "client_credentials"}
    if scopes:
        data["scope"] = scopes
    if audience:
        data["audience"] = audience
    auth = None
    if auth_method == "client_secret_post":
        data.update({"client_id": client_id, "client_secret": client_secret})
    else:
        auth = (client_id, client_secret)
    try:
        response = httpx.post(token_url, data=data, auth=auth, timeout=timeout, verify=verify, proxy=proxy_url)
        response.raise_for_status()
        token = response.json().get("access_token")
        return (str(token), None) if token else (None, "OAuth2 response did not contain an access token")
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        return None, f"OAuth2 token request failed: {exc}"[:255]


def _encode_body(body: str | None, encoding: str) -> tuple[bytes | None, str | None, str | None]:
    if body is None or body == "":
        return None, None, None
    if encoding == "json":
        try:
            return json.dumps(json.loads(body), separators=(",", ":")).encode(), "application/json", None
        except ValueError:
            return None, None, "Request body is not valid JSON"
    if encoding == "form":
        try:
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                raise ValueError
            return urlencode({str(k): str(v) for k, v in parsed.items()}).encode(), "application/x-www-form-urlencoded", None
        except ValueError:
            return None, None, "Form body must be a JSON object"
    if encoding == "xml":
        return body.encode(), "application/xml", None
    return body.encode(), "text/plain; charset=utf-8", None


def _status_allowed(code: int, specification: str) -> bool:
    for part in specification.split(","):
        bounds = part.strip().split("-", 1)
        try:
            low = int(bounds[0])
            high = int(bounds[-1])
        except ValueError:
            continue
        if low <= code <= high:
            return True
    return False


def _assert_response(
    payload: bytes,
    encoding: str | None,
    keyword: str | None,
    keyword_inverted: bool,
    json_path: str | None,
    operator: str,
    expected: str | None,
) -> tuple[bool, str | None]:
    text = payload.decode(encoding or "utf-8", errors="replace")
    if keyword:
        found = keyword in text
        if found == keyword_inverted:
            return False, "Forbidden keyword found" if keyword_inverted else "Required keyword not found"
    if json_path:
        try:
            actual = _json_path_get(json.loads(text), json_path)
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            return False, f"JSON assertion failed: {exc}"[:255]
        if not _compare_json(actual, operator, expected):
            return False, f"JSON assertion failed at {json_path}"[:255]
    if keyword or json_path:
        return True, "Response assertions passed"
    return True, None


def _json_path_get(value: Any, path: str) -> Any:
    if path == "$":
        return value
    if not path.startswith("$."):
        raise ValueError("JSON path must start with $.")
    current = value
    for key, index in re.findall(r"(?:^|\.)([^.\[\]]+)|\[(\d+)\]", path[2:]):
        if key:
            current = current[key]
        else:
            current = current[int(index)]
    return current


def _compare_json(actual: Any, operator: str, expected: str | None) -> bool:
    if operator == "exists":
        return actual is not None
    if operator == "not_exists":
        return actual is None
    actual_text = str(actual).lower() if isinstance(actual, bool) else str(actual)
    expected_text = expected or ""
    if operator == "equals":
        return actual_text == expected_text
    if operator == "not_equals":
        return actual_text != expected_text
    if operator == "contains":
        return expected_text in actual_text
    if operator == "not_contains":
        return expected_text not in actual_text
    try:
        left, right = float(actual), float(expected_text)
    except (TypeError, ValueError):
        return False
    return {"gt": left > right, "gte": left >= right, "lt": left < right, "lte": left <= right}.get(operator, False)


def _add_cache_buster(url: str) -> str:
    parsed = urlsplit(url)
    query = parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("_netmap_ts", str(time.time_ns())))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


def _certificate_info(response: httpx.Response) -> tuple[datetime | None, str | None]:
    try:
        stream = response.extensions.get("network_stream")
        ssl_object = stream.get_extra_info("ssl_object") if stream else None
        cert = ssl_object.getpeercert() if ssl_object else None
        if not cert:
            return None, None
        expires = cert.get("notAfter")
        expires_at = datetime.fromtimestamp(ssl.cert_time_to_seconds(expires), timezone.utc) if expires else None
        issuer_parts = [f"{name}={value}" for group in cert.get("issuer", ()) for name, value in group]
        return expires_at, ", ".join(issuer_parts)[:255] or None
    except (ValueError, OSError, AttributeError):
        return None, None


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
    except (socket.timeout, ConnectionRefusedError, OSError) as exc:
        return CheckResult(open=False, error=_network_error_message(exc))
    finally:
        sock.close()


def _dhcp_options(payload: bytes) -> dict[int, bytes]:
    """Parse bounded DHCP TLV options, ignoring padding and malformed tails."""
    options: dict[int, bytes] = {}
    offset = 240
    while offset < len(payload):
        code = payload[offset]
        offset += 1
        if code == 0:
            continue
        if code == 255:
            break
        if offset >= len(payload):
            break
        length = payload[offset]
        offset += 1
        if offset + length > len(payload):
            break
        options[code] = payload[offset:offset + length]
        offset += length
    return options


def _build_dhcp_inform(transaction_id: int, client_ip: str, client_mac: bytes) -> bytes:
    """Build a DHCPINFORM packet, which requests configuration but never a lease."""
    chaddr = client_mac[:6].ljust(16, b"\x00")
    header = struct.pack(
        "!BBBBIHH4s4s4s4s16s64s128s",
        1, 1, 6, 0, transaction_id, 0, 0,
        socket.inet_aton(client_ip), b"\x00" * 4, b"\x00" * 4, b"\x00" * 4,
        chaddr, b"\x00" * 64, b"\x00" * 128,
    )
    options = (
        b"\x63\x82\x53\x63"  # DHCP magic cookie
        b"\x35\x01\x08"      # option 53: DHCPINFORM
        + bytes((61, 7, 1)) + client_mac[:6]  # client identifier
        + b"\x37\x03\x36\x01\x03"  # request server-id, mask and router
        + b"\xff"
    )
    return header + options


def _check_dhcp(host: str, port: int, timeout: float) -> CheckResult:
    """Safely validate an IPv4 DHCP server using DHCPINFORM/DHCPACK.

    DHCPINFORM does not request, renew, or reserve an address. The probe binds
    UDP/68 because compliant servers deliver the ACK to the DHCP client port.
    """
    try:
        if ip_address(host).version != 4:
            return CheckResult(open=False, error="DHCP checks support IPv4 servers only")
    except ValueError:
        return CheckResult(open=False, error="DHCP server must be an IPv4 address")

    route_probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        route_probe.connect((host, port))
        client_ip = route_probe.getsockname()[0]
    except OSError as exc:
        return CheckResult(open=False, error=f"Unable to determine DHCP client address: {exc}"[:255])
    finally:
        route_probe.close()

    transaction_id = secrets.randbits(32)
    client_mac = b"\x02" + secrets.token_bytes(5)
    request = _build_dhcp_inform(transaction_id, client_ip, client_mac)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(timeout)
    started = time.monotonic()
    try:
        try:
            sock.bind((client_ip, 68))
        except OSError as exc:
            return CheckResult(open=False, error=f"Cannot bind DHCP client UDP/68: {exc}"[:255])
        sock.sendto(request, (host, port))
        deadline = started + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return CheckResult(open=False, error="Timed out waiting for DHCPACK")
            sock.settimeout(remaining)
            response, _sender = sock.recvfrom(4096)
            if len(response) < 240 or response[0] != 2:
                continue
            if struct.unpack("!I", response[4:8])[0] != transaction_id:
                continue
            if response[236:240] != b"\x63\x82\x53\x63":
                continue
            message_type = _dhcp_options(response).get(53)
            if message_type == b"\x05":
                return CheckResult(open=True, response_time_ms=(time.monotonic() - started) * 1000)
            if message_type == b"\x06":
                return CheckResult(open=False, error="DHCP server returned DHCPNAK")
    except socket.timeout:
        return CheckResult(open=False, error="Timed out waiting for DHCPACK")
    except OSError as exc:
        return CheckResult(open=False, error=f"DHCP probe failed: {exc}"[:255])
    finally:
        sock.close()

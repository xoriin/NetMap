from __future__ import annotations

import re
import socket
import subprocess
import shutil
import time
from contextlib import contextmanager
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from ipaddress import ip_address, ip_network

import dns.resolver
import dns.reversename

from app.core.capabilities import ActiveNetworkToolUnavailable, RAW_NETWORKING_UNAVAILABLE, raw_networking_error
from app.core.config import settings
from app.schemas.tools import (
    DnsLookupRequest,
    DnsLookupResult,
    DnsRecord,
    PingRequest,
    PingResult,
    ReverseDnsRequest,
    ReverseDnsResult,
    SubnetCalculatorRequest,
    SubnetCalculatorResult,
    TcpPortCheckRequest,
    TcpPortCheckResult,
    TracerouteHop,
    TracerouteRequest,
    TracerouteResult,
)

TOOL_WINDOW = max(1, settings.tool_rate_limit_window_seconds)
TOOL_LIMIT = max(1, settings.tool_rate_limit_max_calls)
TOOL_RATE_LOG: dict[int, deque[float]] = defaultdict(deque)
DNS_LOOKUP_TIMEOUT_SECONDS = 4.0
DNS_RESOLVER_TIMEOUT_SECONDS = 2.0
HOST_RESOLUTION_TIMEOUT_SECONDS = 3.0
MAX_PING_PROCESS_TIMEOUT_SECONDS = 45
MAX_TRACEROUTE_PROCESS_TIMEOUT_SECONDS = 180
TOOL_TARGET_ARGUMENT_RE = re.compile(r"^[A-Za-z0-9:._-]+$")
PRIVATE_ACTIVE_TARGET_NETWORKS = [
    ip_network("10.0.0.0/8"),
    ip_network("172.16.0.0/12"),
    ip_network("192.168.0.0/16"),
    ip_network("127.0.0.0/8"),
    ip_network("169.254.0.0/16"),
    ip_network("fc00::/7"),
    ip_network("fe80::/10"),
    ip_network("::1/128"),
]


@dataclass(frozen=True)
class ToolAction:
    audit_action: str
    active: bool


def enforce_rate_limit(user_id: int) -> None:
    now = time.time()
    window_start = now - TOOL_WINDOW
    bucket = TOOL_RATE_LOG[user_id]
    while bucket and bucket[0] < window_start:
        bucket.popleft()
    if len(bucket) >= TOOL_LIMIT:
        raise RuntimeError(f"Tool rate limit exceeded; retry in {TOOL_WINDOW} seconds")
    bucket.append(now)


def dns_lookup(payload: DnsLookupRequest) -> DnsLookupResult:
    resolver = dns.resolver.Resolver()
    resolver.lifetime = DNS_LOOKUP_TIMEOUT_SECONDS
    resolver.timeout = DNS_RESOLVER_TIMEOUT_SECONDS
    started = time.perf_counter()
    try:
        answers = resolver.resolve(payload.name, payload.record_type, raise_on_no_answer=False)
    except dns.resolver.NXDOMAIN:
        answers = []
    except dns.exception.Timeout as exc:
        raise TimeoutError("DNS lookup timed out") from exc
    records: list[DnsRecord] = []
    if getattr(answers, "rrset", None) is not None:
        for item in answers:
            records.append(DnsRecord(value=normalize_record_value(payload.record_type, item)))
    duration_ms = int((time.perf_counter() - started) * 1000)
    return DnsLookupResult(
        queried_name=payload.name,
        record_type=payload.record_type,
        records=records,
        source="system-resolver",
        duration_ms=duration_ms,
    )


def reverse_dns(payload: ReverseDnsRequest) -> ReverseDnsResult:
    resolver = dns.resolver.Resolver()
    resolver.lifetime = DNS_LOOKUP_TIMEOUT_SECONDS
    resolver.timeout = DNS_RESOLVER_TIMEOUT_SECONDS
    started = time.perf_counter()
    reverse_name = dns.reversename.from_address(payload.ip_address)
    try:
        answers = resolver.resolve(reverse_name, "PTR", raise_on_no_answer=False)
    except dns.resolver.NXDOMAIN:
        answers = []
    except dns.exception.Timeout as exc:
        raise TimeoutError("Reverse DNS lookup timed out") from exc
    ptr_records = [str(item).rstrip(".") for item in answers] if getattr(answers, "rrset", None) is not None else []
    duration_ms = int((time.perf_counter() - started) * 1000)
    return ReverseDnsResult(
        ip_address=payload.ip_address,
        ptr_records=ptr_records,
        source="system-resolver",
        duration_ms=duration_ms,
    )


def ping_host(payload: PingRequest, *, allow_public_targets: bool | None = None) -> PingResult:
    host_arg = _active_tool_target_ip_argument(payload.host)
    _ensure_resolved_ip_allowed(host_arg, allow_public_targets=allow_public_targets)
    command = [
        "ping",
        "-c",
        str(payload.count),
        "-W",
        str(payload.timeout_seconds),
        "--",
        host_arg,
    ]
    started = time.perf_counter()
    process_timeout = min(MAX_PING_PROCESS_TIMEOUT_SECONDS, payload.timeout_seconds + 3)
    completed = _run_tool_command(command, timeout_seconds=process_timeout, timeout_label="Ping")
    duration_ms = int((time.perf_counter() - started) * 1000)
    output = completed.stdout + "\n" + completed.stderr
    if completed.returncode not in {0, 1} and raw_networking_error(output):
        raise ActiveNetworkToolUnavailable(RAW_NETWORKING_UNAVAILABLE)
    transmitted, received, packet_loss = parse_ping_summary(output)
    avg_ms, min_ms, max_ms = parse_ping_rtt(output)
    return PingResult(
        host=payload.host,
        transmitted=transmitted,
        received=received,
        packet_loss=packet_loss,
        average_ms=avg_ms,
        min_ms=min_ms,
        max_ms=max_ms,
        raw_output=(completed.stdout or completed.stderr).strip(),
        duration_ms=duration_ms,
    )


def traceroute_host(payload: TracerouteRequest, *, allow_public_targets: bool | None = None) -> TracerouteResult:
    host_arg = _active_tool_target_ip_argument(payload.host)
    _ensure_resolved_ip_allowed(host_arg, allow_public_targets=allow_public_targets)
    if shutil.which("traceroute") is None:
        raise FileNotFoundError("traceroute")
    command = [
        "traceroute",
        "-n",
        "-m",
        str(payload.max_hops),
        "-w",
        str(payload.timeout_seconds),
        "--",
        host_arg,
    ]
    started = time.perf_counter()
    process_timeout = min(
        MAX_TRACEROUTE_PROCESS_TIMEOUT_SECONDS,
        payload.max_hops * payload.timeout_seconds + 10,
    )
    completed = _run_tool_command(command, timeout_seconds=process_timeout, timeout_label="Traceroute")
    duration_ms = int((time.perf_counter() - started) * 1000)
    hops = parse_traceroute_output(completed.stdout)
    return TracerouteResult(
        host=payload.host,
        hops=hops,
        raw_output=(completed.stdout or completed.stderr).strip(),
        duration_ms=duration_ms,
    )


def port_check(payload: TcpPortCheckRequest, *, allow_public_targets: bool | None = None) -> TcpPortCheckResult:
    resolved_host = _active_tool_target_ip_argument(payload.host)
    _ensure_resolved_ip_allowed(resolved_host, allow_public_targets=allow_public_targets)
    started = time.perf_counter()
    if payload.protocol == "udp":
        reachable, detail = _udp_port_check(resolved_host, payload.port, payload.timeout_seconds)
    else:
        reachable, detail = _tcp_port_check(resolved_host, payload.port, payload.timeout_seconds)
    duration_ms = int((time.perf_counter() - started) * 1000)
    return TcpPortCheckResult(
        host=payload.host,
        port=payload.port,
        protocol=payload.protocol,
        reachable=reachable,
        duration_ms=duration_ms,
        detail=detail,
    )


def _tcp_port_check(host: str, port: int, timeout_seconds: int) -> tuple[bool, str]:
    try:
        with socket.create_connection((host, port), timeout=timeout_seconds):
            return True, "Connection succeeded"
    except OSError as exc:
        return False, str(exc)


def _udp_port_check(host: str, port: int, timeout_seconds: int) -> tuple[bool, str]:
    family = socket.AF_INET6 if ip_address(host).version == 6 else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_DGRAM)
    sock.settimeout(timeout_seconds)
    try:
        sock.sendto(b"\x00", (host, port))
        sock.recvfrom(1024)
        return True, "UDP response received"
    except socket.timeout:
        return False, "No response received (port may be open or filtered)"
    except ConnectionRefusedError:
        return False, "Port unreachable (ICMP)"
    except OSError as exc:
        return False, str(exc)
    finally:
        sock.close()


def subnet_calculate(payload: SubnetCalculatorRequest) -> SubnetCalculatorResult:
    network = ip_network(payload.cidr, strict=False)
    if network.num_addresses <= 2:
        first_host = None
        last_host = None
    else:
        first_host = str(network[1])
        last_host = str(network[-2])
    broadcast = str(network.broadcast_address) if network.version == 4 else None
    usable_hosts = max(0, network.num_addresses - (2 if network.version == 4 and network.num_addresses > 2 else 0))
    return SubnetCalculatorResult(
        cidr=payload.cidr,
        network=str(network.network_address),
        netmask=str(network.netmask),
        broadcast=broadcast,
        first_host=first_host,
        last_host=last_host,
        total_addresses=network.num_addresses,
        usable_hosts=usable_hosts,
        version=network.version,
        prefix_length=network.prefixlen,
        calculated_at=datetime.now(timezone.utc),
    )


def normalize_record_value(record_type: str, item: object) -> str:
    if record_type in {"MX", "NS", "CNAME"}:
        return str(item).rstrip(".")
    return str(item)


def ensure_active_target_allowed(host: str, *, allow_public_targets: bool | None = None) -> None:
    public_targets_enabled = (
        settings.active_network_public_targets_enabled
        if allow_public_targets is None
        else allow_public_targets
    )
    if public_targets_enabled:
        return
    if not _all_resolved_addresses_private(host):
        raise ValueError(
            "Public active network targets are blocked. "
            "Set ACTIVE_NETWORK_PUBLIC_TARGETS_ENABLED=true to allow them."
        )


def _ensure_resolved_ip_allowed(resolved_ip: str, *, allow_public_targets: bool | None = None) -> None:
    public_targets_enabled = (
        settings.active_network_public_targets_enabled
        if allow_public_targets is None
        else allow_public_targets
    )
    if public_targets_enabled:
        return
    try:
        addr = ip_address(resolved_ip)
    except ValueError:
        raise ValueError(f"Invalid resolved IP: {resolved_ip}")
    if not any(addr in net for net in PRIVATE_ACTIVE_TARGET_NETWORKS):
        raise ValueError(
            "Public active network targets are blocked. "
            "Set ACTIVE_NETWORK_PUBLIC_TARGETS_ENABLED=true to allow them."
        )


def _all_resolved_addresses_private(host: str) -> bool:
    try:
        addresses = [ip_address(host)]
    except ValueError:
        try:
            infos = _resolve_host(host)
        except socket.gaierror as exc:
            raise ValueError(f"Unable to resolve target host: {host}") from exc
        except TimeoutError as exc:
            raise ValueError(f"Timed out resolving target host: {host}") from exc
        addresses = []
        for info in infos:
            try:
                addresses.append(ip_address(info[4][0]))
            except (IndexError, ValueError):
                continue
        if not addresses:
            raise ValueError(f"Unable to resolve target host: {host}")
    return all(any(address in network for network in PRIVATE_ACTIVE_TARGET_NETWORKS) for address in addresses)


def _run_tool_command(
    command: list[str],
    *,
    timeout_seconds: int | float,
    timeout_label: str,
) -> subprocess.CompletedProcess[str]:
    if not command:
        raise ValueError("Invalid command")
    executable = command[0].rsplit("/", 1)[-1]
    if executable not in {"ping", "traceroute", "traceroute6"}:
        raise ValueError("Unsupported tool command")
    for arg in command[1:]:
        if not isinstance(arg, str) or any(ch in arg for ch in ("\x00", "\n", "\r")):
            raise ValueError("Invalid command argument")
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"{timeout_label} timed out after {timeout_seconds:g} seconds") from exc


def _safe_tool_target_argument(host: str) -> str:
    if host.startswith("-") or not TOOL_TARGET_ARGUMENT_RE.fullmatch(host):
        raise ValueError("Invalid active tool target")
    return host


def _active_tool_target_ip_argument(host: str) -> str:
    try:
        return _safe_tool_target_argument(str(ip_address(host)))
    except ValueError:
        pass

    try:
        infos = _resolve_host(host)
    except socket.gaierror as exc:
        raise ValueError(f"Unable to resolve target host: {host}") from exc
    except TimeoutError as exc:
        raise ValueError(f"Timed out resolving target host: {host}") from exc

    for info in infos:
        try:
            return _safe_tool_target_argument(str(ip_address(info[4][0])))
        except (IndexError, ValueError):
            continue
    raise ValueError(f"Unable to resolve target host: {host}")


def _resolve_host(host: str):
    with _default_socket_timeout(HOST_RESOLUTION_TIMEOUT_SECONDS):
        return socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)


@contextmanager
def _default_socket_timeout(timeout_seconds: float):
    previous = socket.getdefaulttimeout()
    socket.setdefaulttimeout(timeout_seconds)
    try:
        yield
    finally:
        socket.setdefaulttimeout(previous)


def parse_ping_summary(output: str) -> tuple[int | None, int | None, float | None]:
    match = re.search(r"(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets )?received,\s+([0-9.]+)% packet loss", output)
    if not match:
        return None, None, None
    return int(match.group(1)), int(match.group(2)), float(match.group(3))


def parse_ping_rtt(output: str) -> tuple[float | None, float | None, float | None]:
    match = re.search(r"(?:rtt|round-trip) min/avg/max/(?:mdev|stddev) = ([0-9.]+)/([0-9.]+)/([0-9.]+)/", output)
    if not match:
        return None, None, None
    return float(match.group(2)), float(match.group(1)), float(match.group(3))


def parse_traceroute_output(output: str) -> list[TracerouteHop]:
    hops: list[TracerouteHop] = []
    for line in output.splitlines():
        parts = line.strip().split()
        if not parts or not parts[0].isdigit():
            continue
        hop_number = int(parts[0])
        address = None
        rtt_ms = None
        if len(parts) >= 2 and parts[1] != "*":
            address = parts[1]
        if len(parts) >= 3:
            maybe_rtt = parts[2].replace("ms", "")
            try:
                rtt_ms = float(maybe_rtt)
            except ValueError:
                rtt_ms = None
        hops.append(TracerouteHop(hop=hop_number, address=address, rtt_ms=rtt_ms))
    return hops

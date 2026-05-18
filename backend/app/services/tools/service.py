from __future__ import annotations

import math
import re
import socket
import subprocess
import shutil
import time
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
    resolver.lifetime = 4.0
    resolver.timeout = 2.0
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
    resolver.lifetime = 4.0
    resolver.timeout = 2.0
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


def ping_host(payload: PingRequest) -> PingResult:
    command = [
        "ping",
        "-c",
        str(payload.count),
        "-W",
        str(payload.timeout_seconds),
        payload.host,
    ]
    started = time.perf_counter()
    completed = subprocess.run(command, capture_output=True, text=True, timeout=payload.timeout_seconds + 3)
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


def traceroute_host(payload: TracerouteRequest) -> TracerouteResult:
    if shutil.which("traceroute") is None:
        raise FileNotFoundError("traceroute")
    command = [
        "traceroute",
        "-n",
        "-m",
        str(payload.max_hops),
        "-w",
        str(payload.timeout_seconds),
        payload.host,
    ]
    started = time.perf_counter()
    completed = subprocess.run(command, capture_output=True, text=True, timeout=payload.max_hops * payload.timeout_seconds + 10)
    duration_ms = int((time.perf_counter() - started) * 1000)
    hops = parse_traceroute_output(completed.stdout)
    return TracerouteResult(
        host=payload.host,
        hops=hops,
        raw_output=(completed.stdout or completed.stderr).strip(),
        duration_ms=duration_ms,
    )


def tcp_port_check(payload: TcpPortCheckRequest) -> TcpPortCheckResult:
    started = time.perf_counter()
    try:
        with socket.create_connection((payload.host, payload.port), timeout=payload.timeout_seconds):
            reachable = True
            detail = "Connection succeeded"
    except OSError as exc:
        reachable = False
        detail = str(exc)
    duration_ms = int((time.perf_counter() - started) * 1000)
    return TcpPortCheckResult(
        host=payload.host,
        port=payload.port,
        reachable=reachable,
        duration_ms=duration_ms,
        detail=detail,
    )


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

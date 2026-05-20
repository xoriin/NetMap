import json
import math
import subprocess
from dataclasses import dataclass
from ipaddress import ip_address, ip_network
from xml.etree.ElementTree import Element

from defusedxml import ElementTree

from app.core.capabilities import (
    ActiveNetworkToolUnavailable,
    RAW_NETWORKING_UNAVAILABLE,
    raw_networking_error,
    require_command,
)
from app.core.config import settings
from app.schemas.discovery import DiscoveryHost


@dataclass(frozen=True)
class DiscoveryTarget:
    nmap_target: str
    host_count: int


PRIVATE_SCAN_NETWORKS = [
    ip_network("10.0.0.0/8"),
    ip_network("172.16.0.0/12"),
    ip_network("192.168.0.0/16"),
    ip_network("127.0.0.0/8"),
    ip_network("169.254.0.0/16"),
    ip_network("fc00::/7"),
    ip_network("fe80::/10"),
    ip_network("::1/128"),
]


def validate_target(raw_target: str, confirm_large_scan: bool) -> DiscoveryTarget:
    target = raw_target.strip()
    if not target:
        raise ValueError("Scan target is required")

    if "-" in target and "/" not in target:
        return validate_range(target, confirm_large_scan)

    if "/" in target:
        try:
            network = ip_network(target, strict=False)
        except ValueError as exc:
            raise ValueError("Use a private single IP, IP range, or CIDR target") from exc
        host_count = network.num_addresses
        ensure_private_network(network)
        ensure_scan_size(host_count, confirm_large_scan)
        return DiscoveryTarget(str(network), host_count)

    try:
        address = ip_address(target)
    except ValueError as exc:
        raise ValueError("Use a private single IP, IP range, or CIDR target") from exc
    ensure_private_address(address)
    return DiscoveryTarget(str(address), 1)


def validate_range(target: str, confirm_large_scan: bool) -> DiscoveryTarget:
    start_raw, end_raw = [part.strip() for part in target.split("-", 1)]
    start = ip_address(start_raw)
    end = ip_address(end_raw)
    if start.version != end.version:
        raise ValueError("IP range must use one address family")
    if int(end) < int(start):
        raise ValueError("IP range end must be greater than start")
    host_count = int(end) - int(start) + 1
    ensure_private_address(start)
    ensure_private_address(end)
    ensure_scan_size(host_count, confirm_large_scan)
    return DiscoveryTarget(f"{start}-{end}", host_count)


def ensure_private_network(network) -> None:
    if not any(network.subnet_of(private) or network.overlaps(private) for private in PRIVATE_SCAN_NETWORKS):
        raise ValueError("Public IP scanning is blocked by default")


def ensure_private_address(address) -> None:
    if not any(address in private for private in PRIVATE_SCAN_NETWORKS):
        raise ValueError("Public IP scanning is blocked by default")


def ensure_scan_size(host_count: int, confirm_large_scan: bool) -> None:
    if host_count > settings.discovery_max_hosts:
        raise ValueError(f"Scan target is too large; maximum is {settings.discovery_max_hosts} addresses")
    if host_count > settings.discovery_max_hosts_without_confirmation and not confirm_large_scan:
        raise ValueError("Large scan requires explicit confirmation")


def run_nmap_scan(target: DiscoveryTarget, scan_type: str) -> list[DiscoveryHost]:
    nmap_path = require_command("nmap", "Nmap discovery")

    command = [
        "sudo",
        nmap_path,
        "-n",
        "-oX",
        "-",
        "--max-retries",
        "1",
    ]

    if scan_type == "ping":
        command.extend(
            [
                "-sn",
                "-PR",
                "-PE",
                "-T3",
                "--host-timeout",
                f"{ping_host_timeout_seconds(target)}s",
            ]
        )
    elif scan_type == "basic_ports":
        command.extend(
            [
                "-T2",
                "--host-timeout",
                f"{port_scan_host_timeout_seconds(target)}s",
                "-sT",
                "--top-ports",
                "20",
            ]
        )
    else:
        raise ValueError("Unsupported scan type")

    command.append(target.nmap_target)
    timeout_seconds = discovery_process_timeout_seconds(target, scan_type)

    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            "Discovery scan timed out after "
            f"{timeout_seconds} seconds for {target.host_count} hosts. "
            "Reduce the target size or increase DISCOVERY_SCAN_TIMEOUT_SECONDS."
        ) from exc
    if completed.returncode not in {0, 1}:
        output = f"{completed.stdout}\n{completed.stderr}"
        if raw_networking_error(output):
            raise ActiveNetworkToolUnavailable(RAW_NETWORKING_UNAVAILABLE)
        raise RuntimeError(completed.stderr.strip() or "Nmap scan failed")
    return parse_nmap_xml(completed.stdout)


def ping_host_timeout_seconds(target: DiscoveryTarget) -> int:
    base_timeout = max(5, settings.discovery_scan_timeout_seconds)
    if target.host_count <= 1:
        return base_timeout
    return min(base_timeout, 12)


def port_scan_host_timeout_seconds(target: DiscoveryTarget) -> int:
    base_timeout = max(10, settings.discovery_scan_timeout_seconds)
    if target.host_count <= 1:
        return base_timeout
    return min(base_timeout, 20)


def discovery_process_timeout_seconds(target: DiscoveryTarget, scan_type: str) -> int:
    base_timeout = max(15, settings.discovery_scan_timeout_seconds)
    if target.host_count <= 1:
        return base_timeout + 10

    if scan_type == "ping":
        parallel_groups = max(1, math.ceil(target.host_count / 32))
        return min(900, max(base_timeout + 10, 30 + (parallel_groups * 20)))

    parallel_groups = max(1, math.ceil(target.host_count / 16))
    return min(1800, max(base_timeout + 15, 45 + (parallel_groups * 25)))


def parse_nmap_xml(xml_output: str) -> list[DiscoveryHost]:
    root = ElementTree.fromstring(xml_output)
    hosts: list[DiscoveryHost] = []
    for host in root.findall("host"):
        status_node = host.find("status")
        if status_node is not None and status_node.attrib.get("state") != "up":
            continue

        ip_value = find_address(host, "ipv4") or find_address(host, "ipv6")
        if not ip_value:
            continue

        hostname = None
        hostname_node = host.find("hostnames/hostname")
        if hostname_node is not None:
            hostname = hostname_node.attrib.get("name")

        mac_node = find_address_node(host, "mac")
        open_ports = [
            int(port.attrib["portid"])
            for port in host.findall("ports/port")
            if port.find("state") is not None and port.find("state").attrib.get("state") == "open"
        ]
        hosts.append(
            DiscoveryHost(
                ip_address=ip_value,
                hostname=hostname,
                mac_address=mac_node.attrib.get("addr") if mac_node is not None else None,
                vendor=mac_node.attrib.get("vendor") if mac_node is not None else None,
                status="online",
                open_ports=open_ports,
            )
        )
    return hosts


def find_address(host: Element, address_type: str) -> str | None:
    node = find_address_node(host, address_type)
    return node.attrib.get("addr") if node is not None else None


def find_address_node(host: Element, address_type: str) -> Element | None:
    for address in host.findall("address"):
        if address.attrib.get("addrtype") == address_type:
            return address
    return None


def serialize_results(results: list[DiscoveryHost]) -> str:
    return json.dumps([result.model_dump() for result in results])


def deserialize_results(raw_results: str | None) -> list[DiscoveryHost]:
    if not raw_results:
        return []
    try:
        values = json.loads(raw_results)
    except json.JSONDecodeError:
        return []
    return [DiscoveryHost(**value) for value in values if isinstance(value, dict)]

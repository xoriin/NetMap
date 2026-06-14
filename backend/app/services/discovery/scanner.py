import json
import math
import re
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from ipaddress import ip_address, ip_network, summarize_address_range
from pathlib import Path
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
    nmap_args: tuple[str, ...] | None = None

    def command_targets(self) -> tuple[str, ...]:
        return self.nmap_args or (self.nmap_target,)


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

MAC_PREFIX_FILES = (
    Path("/usr/share/nmap/nmap-mac-prefixes"),
    Path("/usr/local/share/nmap/nmap-mac-prefixes"),
)
MAC_NORMALIZE_RE = re.compile(r"[^0-9A-Fa-f]")


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
    try:
        start = ip_address(start_raw)
        end = ip_address(end_raw)
    except ValueError as exc:
        raise ValueError("Use a private single IP, IP range, or CIDR target") from exc
    if start.version != end.version:
        raise ValueError("IP range must use one address family")
    if int(end) < int(start):
        raise ValueError("IP range end must be greater than start")
    host_count = int(end) - int(start) + 1
    range_networks = tuple(summarize_address_range(start, end))
    ensure_private_range(range_networks)
    ensure_scan_size(host_count, confirm_large_scan)
    return DiscoveryTarget(f"{start}-{end}", host_count, tuple(str(network) for network in range_networks))


def ensure_private_network(network) -> None:
    if not any(
        network.version == private.version and (network.subnet_of(private) or network.overlaps(private))
        for private in PRIVATE_SCAN_NETWORKS
    ):
        raise ValueError("Public IP scanning is blocked by default")


def ensure_private_range(networks) -> None:
    if not all(
        any(network.version == private.version and network.subnet_of(private) for private in PRIVATE_SCAN_NETWORKS)
        for network in networks
    ):
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

    command.extend(target.command_targets())
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
    return enrich_hosts_from_neighbor_table(parse_nmap_xml(completed.stdout))


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


def enrich_hosts_from_neighbor_table(hosts: list[DiscoveryHost]) -> list[DiscoveryHost]:
    if not any(host.mac_address is None for host in hosts):
        return [host_with_vendor(host) for host in hosts]

    neighbors = read_neighbor_table()
    if not neighbors:
        return [host_with_vendor(host) for host in hosts]

    enriched: list[DiscoveryHost] = []
    for host in hosts:
        mac_address = host.mac_address or neighbors.get(host.ip_address)
        enriched.append(
            host.model_copy(
                update={
                    "mac_address": mac_address,
                    "vendor": host.vendor or vendor_for_mac(mac_address),
                }
            )
        )
    return enriched


def enrich_hosts_from_snmp_arp(
    hosts: list[DiscoveryHost],
    snmp_targets: list[str],
    community: str,
    *,
    port: int = 161,
    timeout_seconds: int = 3,
    retries: int = 1,
) -> list[DiscoveryHost]:
    if not hosts or not snmp_targets:
        return hosts

    from concurrent.futures import ThreadPoolExecutor
    from app.services.snmp import snmp_arp_map, SnmpClient, OID_SYS_DESCR, value_to_text

    arp_entries = snmp_arp_map(
        snmp_targets,
        community,
        port=port,
        timeout_seconds=timeout_seconds,
        retries=retries,
    )
    if not arp_entries:
        return hosts

    enriched: list[DiscoveryHost] = []
    for host in hosts:
        entry = arp_entries.get(host.ip_address)
        if entry is None or host.mac_address:
            enriched.append(host_with_vendor(host))
            continue
        enriched.append(
            host.model_copy(
                update={
                    "mac_address": entry.mac_address,
                    "vendor": host.vendor or entry.vendor or vendor_for_mac(entry.mac_address),
                }
            )
        )

    # Probe each discovered host for sysDescr (OS string) using the same community.
    # Best-effort: 1-second timeout, no retries, parallel across all hosts.
    def _probe_host_os(host: DiscoveryHost) -> tuple[str, str | None]:
        try:
            client = SnmpClient(host.ip_address, community, port=port, timeout_seconds=1, retries=0)
            return host.ip_address, value_to_text(client.get(OID_SYS_DESCR))
        except Exception:
            return host.ip_address, None

    os_map: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=min(20, len(enriched))) as executor:
        for ip, sys_descr in executor.map(_probe_host_os, enriched):
            if sys_descr:
                os_map[ip] = sys_descr

    if os_map:
        enriched = [
            host.model_copy(update={"os": os_map[host.ip_address]})
            if host.ip_address in os_map
            else host
            for host in enriched
        ]

    return enriched


def read_neighbor_table() -> dict[str, str]:
    ip_path = shutil.which("ip")
    if ip_path is None:
        return {}

    try:
        completed = subprocess.run(
            [ip_path, "-j", "neigh", "show"],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    if completed.returncode != 0:
        return {}

    try:
        rows = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {}
    if not isinstance(rows, list):
        return {}

    neighbors: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        destination = row.get("dst")
        mac_address = row.get("lladdr")
        state = row.get("state")
        if not isinstance(destination, str) or not isinstance(mac_address, str):
            continue
        if neighbor_state_is_unusable(state):
            continue
        neighbors[destination] = mac_address.upper()
    return neighbors


def neighbor_state_is_unusable(state) -> bool:
    if isinstance(state, str):
        return state in {"FAILED", "INCOMPLETE"}
    if isinstance(state, list):
        return any(item in {"FAILED", "INCOMPLETE"} for item in state if isinstance(item, str))
    return False


def host_with_vendor(host: DiscoveryHost) -> DiscoveryHost:
    if host.vendor or not host.mac_address:
        return host
    return host.model_copy(update={"vendor": vendor_for_mac(host.mac_address)})


def vendor_for_mac(mac_address: str | None) -> str | None:
    if not mac_address:
        return None
    prefix = MAC_NORMALIZE_RE.sub("", mac_address).upper()[:6]
    if len(prefix) != 6:
        return None
    return mac_prefixes().get(prefix)


@lru_cache(maxsize=1)
def mac_prefixes() -> dict[str, str]:
    for path in MAC_PREFIX_FILES:
        try:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        prefixes: dict[str, str] = {}
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(maxsplit=1)
            if len(parts) != 2:
                continue
            prefix, vendor = parts
            normalized = MAC_NORMALIZE_RE.sub("", prefix).upper()
            if len(normalized) == 6 and vendor:
                prefixes[normalized] = vendor.strip()
        return prefixes
    return {}


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

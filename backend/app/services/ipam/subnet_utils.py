from __future__ import annotations

import ipaddress
from dataclasses import dataclass


@dataclass
class IpStatus:
    ip: str
    kind: str  # "network" | "broadcast" | "gateway" | "device" | "dhcp" | "free"
    label: str | None = None  # device name or DHCP hostname


def parse_network(cidr: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network:
    return ipaddress.ip_network(cidr, strict=False)


def subnet_utilization(
    cidr: str,
    device_ips: set[str],
    dhcp_ips: set[str],
    gateway: str | None = None,
) -> dict:
    try:
        net = parse_network(cidr)
    except ValueError:
        return {"total_hosts": 0, "used": 0, "free": 0, "utilization": 0.0, "valid": False}

    host_ips = {str(ip) for ip in net.hosts()}
    used = host_ips & (device_ips | dhcp_ips)
    if gateway and gateway in host_ips:
        used.add(gateway)

    total = len(host_ips)
    used_count = len(used)
    return {
        "total_hosts": total,
        "used": used_count,
        "free": total - used_count,
        "utilization": used_count / total if total > 0 else 0.0,
        "valid": True,
    }


def enumerate_addresses(
    cidr: str,
    device_map: dict[str, str],   # ip -> device label
    dhcp_map: dict[str, str],     # ip -> hostname
    gateway: str | None = None,
    max_hosts: int = 1024,
) -> list[IpStatus]:
    """Return per-IP status for subnets up to max_hosts in size."""
    try:
        net = parse_network(cidr)
    except ValueError:
        return []

    if net.num_addresses > max_hosts + 2:
        return []  # too large — caller should fall back to summary

    result: list[IpStatus] = []
    for ip_obj in net:
        ip = str(ip_obj)
        if ip_obj == net.network_address:
            result.append(IpStatus(ip=ip, kind="network"))
        elif ip_obj == net.broadcast_address:
            result.append(IpStatus(ip=ip, kind="broadcast"))
        elif gateway and ip == gateway:
            result.append(IpStatus(ip=ip, kind="gateway", label="Gateway"))
        elif ip in device_map:
            result.append(IpStatus(ip=ip, kind="device", label=device_map[ip]))
        elif ip in dhcp_map:
            result.append(IpStatus(ip=ip, kind="dhcp", label=dhcp_map[ip] or None))
        else:
            result.append(IpStatus(ip=ip, kind="free"))
    return result


def detect_conflicts(
    subnets: list[tuple[int, str, str | None]],  # (id, cidr, name)
    devices: list[tuple[int, str, str | None]],  # (id, ip, label)
) -> list[dict]:
    conflicts: list[dict] = []

    # Duplicate device IPs
    ip_to_devices: dict[str, list[tuple[int, str | None]]] = {}
    for dev_id, ip, label in devices:
        ip_to_devices.setdefault(ip, []).append((dev_id, label))
    for ip, devs in ip_to_devices.items():
        if len(devs) > 1:
            conflicts.append({
                "type": "duplicate_ip",
                "severity": "error",
                "description": f"IP {ip} is assigned to {len(devs)} devices: {', '.join(l or str(i) for i, l in devs)}",
                "ip": ip,
            })

    # Overlapping subnets
    parsed: list[tuple[int, str, ipaddress.IPv4Network | ipaddress.IPv6Network]] = []
    for sub_id, cidr, name in subnets:
        try:
            parsed.append((sub_id, name or cidr, ipaddress.ip_network(cidr, strict=False)))
        except ValueError:
            conflicts.append({
                "type": "invalid_cidr",
                "severity": "error",
                "description": f"Subnet '{name or cidr}' has an invalid CIDR: {cidr}",
            })

    for i in range(len(parsed)):
        for j in range(i + 1, len(parsed)):
            a_id, a_name, a_net = parsed[i]
            b_id, b_name, b_net = parsed[j]
            if a_net.overlaps(b_net):
                conflicts.append({
                    "type": "subnet_overlap",
                    "severity": "warning",
                    "description": f"Subnets '{a_name}' ({a_net}) and '{b_name}' ({b_net}) overlap",
                })

    # IPs not in any defined subnet
    all_nets = [n for _, _, n in parsed]
    for dev_id, ip, label in devices:
        try:
            ip_obj = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if all_nets and not any(ip_obj in net for net in all_nets):
            conflicts.append({
                "type": "ip_outside_subnet",
                "severity": "warning",
                "description": f"Device '{label or ip}' ({ip}) is not within any defined subnet",
                "ip": ip,
                "device_id": dev_id,
            })

    return conflicts

from __future__ import annotations

import ipaddress
from dataclasses import dataclass


@dataclass
class IpStatus:
    ip: str
    kind: str  # "network" | "broadcast" | "gateway" | "device" | "dhcp" | "reserved" | "free"
    label: str | None = None  # device name, DHCP hostname, or reservation label


def parse_network(cidr: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network:
    return ipaddress.ip_network(cidr, strict=False)


def subnet_utilization(
    cidr: str,
    device_ips: set[str],
    dhcp_ips: set[str],
    gateway: str | None = None,
    reserved_ips: set[str] | None = None,
) -> dict:
    try:
        net = parse_network(cidr)
    except ValueError:
        return {"total_hosts": 0, "used": 0, "free": 0, "utilization": 0.0, "valid": False}

    used: set[str] = set()
    for ip in device_ips | dhcp_ips | (reserved_ips or set()):
        try:
            ip_obj = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if ip_obj in net and ip_obj not in (net.network_address, net.broadcast_address):
            used.add(str(ip_obj))

    if gateway:
        try:
            gateway_obj = ipaddress.ip_address(gateway)
        except ValueError:
            gateway_obj = None
        if gateway_obj and gateway_obj in net and gateway_obj not in (net.network_address, net.broadcast_address):
            used.add(str(gateway_obj))

    total = max(net.num_addresses - 2, 0) if net.version == 4 else max(net.num_addresses - 2, 0)
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
    device_map: dict[str, str],        # ip -> device label
    dhcp_map: dict[str, str],          # ip -> hostname
    gateway: str | None = None,
    max_hosts: int = 1024,
    reservation_map: dict[str, str] | None = None,  # ip -> reservation label
) -> list[IpStatus]:
    """Return per-IP status for subnets up to max_hosts in size."""
    try:
        net = parse_network(cidr)
    except ValueError:
        return []

    if net.num_addresses > max_hosts + 2:
        return []  # too large — caller should fall back to summary

    res_map = reservation_map or {}
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
        elif ip in res_map:
            result.append(IpStatus(ip=ip, kind="reserved", label=res_map[ip]))
        else:
            result.append(IpStatus(ip=ip, kind="free"))
    return result


def detect_conflicts(
    subnets: list[tuple[int, str, str | None]],         # (id, cidr, name)
    devices: list[tuple[int, str, str | None]],         # (id, ip, label)
    dhcp_ips: set[str] | None = None,
    reservations: list[tuple[str, str]] | None = None,  # (ip, label)
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
                "description": f"IP {ip} is assigned to {len(devs)} devices: {', '.join(label or str(device_id) for device_id, label in devs)}",
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

    # Reserved IPs in use by a device or DHCP lease
    if reservations:
        device_ip_set = {ip for _, ip, _ in devices}
        active_dhcp = dhcp_ips or set()
        for res_ip, res_label in reservations:
            if res_ip in device_ip_set:
                dev = next((label or ip for _, ip, label in devices if ip == res_ip), res_ip)
                conflicts.append({
                    "type": "reserved_ip_in_use",
                    "severity": "error",
                    "description": f"Reserved IP {res_ip} ('{res_label}') is assigned to device '{dev}'",
                    "ip": res_ip,
                })
            elif res_ip in active_dhcp:
                conflicts.append({
                    "type": "reserved_ip_in_use",
                    "severity": "warning",
                    "description": f"Reserved IP {res_ip} ('{res_label}') has an active DHCP lease",
                    "ip": res_ip,
                })

    return conflicts

import json
from ipaddress import ip_address, ip_network

from app.models.device import Device


def serialize_tags(tags: list[str]) -> str:
    return json.dumps(tags)


def deserialize_tags(raw_tags: str | None) -> list[str]:
    if not raw_tags:
        return []
    try:
        value = json.loads(raw_tags)
    except json.JSONDecodeError:
        return []
    if not isinstance(value, list):
        return []
    return [str(tag) for tag in value]


def device_to_dict(device: Device) -> dict:
    return {
        "id": device.id,
        "display_name": device.display_name,
        "hostname": device.hostname,
        "ip_address": device.ip_address,
        "mac_address": device.mac_address,
        "vendor": device.vendor,
        "device_type": device.device_type,
        "status": device.status,
        "icon": device.icon,
        "color": device.color,
        "vlan_id": device.vlan_id,
        "subnet": device.subnet,
        "topology_group_id": device.topology_group_id,
        "topology_group": topology_group(device),
        "site_id": device.site_id,
        "snmp_profile_id": device.snmp_profile_id,
        "tags": deserialize_tags(device.tags),
        "notes": device.notes,
        "monitor_status": device.monitor_status,
        "last_monitored_at": device.last_monitored_at,
        "is_favourite": bool(device.is_favourite),
        "created_at": device.created_at,
        "updated_at": device.updated_at,
    }


def infer_subnet(ip_value: str) -> str | None:
    try:
        address = ip_address(ip_value)
    except ValueError:
        return None

    prefix = 24 if address.version == 4 else 64
    return str(ip_network(f"{address}/{prefix}", strict=False))


def topology_group(device: Device) -> str:
    if getattr(device, "group", None) is not None:
        return device.group.display_name or device.group.name
    if device.topology_group:
        return device.topology_group
    if device.vlan_id:
        subnet = device.subnet or infer_subnet(device.ip_address)
        return f"VLAN {device.vlan_id}" + (f" · {subnet}" if subnet else "")
    if device.subnet:
        return device.subnet
    inferred = infer_subnet(device.ip_address)
    return inferred or "Ungrouped"

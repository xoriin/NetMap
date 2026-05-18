"""Parse DHCP lease files into a list of lease dicts.

Supports:
  - ISC dhcpd  (/var/lib/dhcpd/dhcpd.leases)
  - dnsmasq    (/var/lib/misc/dnsmasq.leases)
"""
from __future__ import annotations

import re
from datetime import datetime, timezone


def _parse_isc_timestamp(s: str) -> datetime | None:
    """Parse 'YYYY/MM/DD HH:MM:SS' from ISC lease file."""
    try:
        return datetime.strptime(s.strip(), "%Y/%m/%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_isc_leases(text: str) -> list[dict]:
    leases: dict[str, dict] = {}
    current: dict | None = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("lease "):
            ip = line.split()[1]
            current = {"ip_address": ip, "mac_address": None, "hostname": None, "expires_at": None, "is_active": False}
        elif current is None:
            continue
        elif line.startswith("ends "):
            parts = line.split(None, 2)
            if len(parts) >= 3 and parts[2] != "never;":
                ts = parts[2].rstrip(";")
                current["expires_at"] = _parse_isc_timestamp(ts)
        elif line.startswith("hardware ethernet"):
            mac = line.replace("hardware ethernet", "").strip().rstrip(";")
            current["mac_address"] = mac
        elif line.startswith("client-hostname"):
            h = re.sub(r'[";]', "", line.replace("client-hostname", "")).strip()
            current["hostname"] = h or None
        elif line.startswith("binding state active"):
            current["is_active"] = True
        elif line == "}":
            if current:
                ip = current["ip_address"]
                # Last seen binding wins
                existing = leases.get(ip)
                if existing is None or current["is_active"]:
                    leases[ip] = current
            current = None

    return list(leases.values())


def parse_dnsmasq_leases(text: str) -> list[dict]:
    """dnsmasq format: <epoch> <mac> <ip> <hostname> <client-id>"""
    leases: dict[str, dict] = {}
    now = datetime.now(timezone.utc).timestamp()

    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) < 4:
            continue
        try:
            expires_epoch = int(parts[0])
        except ValueError:
            continue
        mac = parts[1] if parts[1] != "*" else None
        ip = parts[2]
        hostname = parts[3] if parts[3] not in ("*", "") else None
        expires_at = datetime.fromtimestamp(expires_epoch, tz=timezone.utc) if expires_epoch else None
        is_active = expires_epoch == 0 or expires_epoch > now
        leases[ip] = {
            "ip_address": ip,
            "mac_address": mac,
            "hostname": hostname,
            "expires_at": expires_at,
            "is_active": is_active,
        }

    return list(leases.values())


def auto_parse(text: str) -> list[dict]:
    """Detect format and parse."""
    stripped = text.strip()
    if stripped.startswith("lease ") or "binding state" in stripped:
        return parse_isc_leases(text)
    # dnsmasq lines start with epoch integer
    first = stripped.split("\n")[0].split()
    if first and first[0].isdigit() and len(first) >= 4:
        return parse_dnsmasq_leases(text)
    return []

from __future__ import annotations

import re
from ipaddress import ip_address, ip_network
from pathlib import Path

MAC_RE = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")
HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$")
DNS_NAME_RE = HOSTNAME_RE


def normalize_ip(value: str) -> str:
    return str(ip_address(value.strip()))


def normalize_cidr(value: str) -> str:
    return str(ip_network(value.strip(), strict=False))


def validate_hostname(value: str) -> str:
    normalized = value.strip()
    if not HOSTNAME_RE.fullmatch(normalized):
        raise ValueError("Invalid hostname")
    return normalized


def validate_dns_name(value: str) -> str:
    normalized = value.strip().lower()
    if not DNS_NAME_RE.fullmatch(normalized):
        raise ValueError("Invalid DNS name")
    return normalized


def validate_mac(value: str) -> str:
    normalized = value.strip()
    if not MAC_RE.fullmatch(normalized):
        raise ValueError("Invalid MAC address")
    return normalized.lower().replace("-", ":")


def validate_port(value: int) -> int:
    if value < 0 or value > 65535:
        raise ValueError("Port must be between 0 and 65535")
    return value


def validate_snmp_string(value: str) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > 128:
        raise ValueError("SNMP string must be between 1 and 128 characters")
    if any(ord(ch) < 32 for ch in normalized):
        raise ValueError("SNMP string contains invalid control characters")
    return normalized


def validate_uploaded_filename(filename: str) -> str:
    normalized = Path(filename).name.strip()
    if not normalized:
        raise ValueError("Filename is required")
    if len(normalized) > 255:
        raise ValueError("Filename is too long")
    if normalized.startswith("."):
        raise ValueError("Hidden files are not allowed")
    return normalized


def validate_syslog_field(value: str, *, max_length: int) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("Field value is required")
    if len(normalized) > max_length:
        raise ValueError(f"Field value exceeds {max_length} characters")
    if any(ord(ch) < 32 for ch in normalized):
        raise ValueError("Field contains invalid control characters")
    return normalized

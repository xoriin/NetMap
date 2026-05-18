"""
Role-based permission cache.

Permissions are stored in system_settings (key: role_permissions) as JSON
and loaded into an in-memory dict at startup. The cache is refreshed
immediately whenever an admin saves changes, so there is no per-request DB
overhead.

SuperAdmin always has every permission regardless of this table.
"""
from __future__ import annotations

import json

BUILT_IN_ROLES: frozenset[str] = frozenset({"SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"})

PERMISSION_KEYS: list[str] = [
    "topology_write",
    "security_view",
    "tools_passive",
    "tools_active",
    "inventory_export",
    "firewall_export",
    "report_export",
    "ipam_write",
    "monitoring_write",
    "alert_write",
]

PERMISSION_META: dict[str, dict[str, str]] = {
    "topology_write":   {"label": "Edit inventory & topology",     "description": "Create, edit and delete devices, VLANs, sites and relationships"},
    "security_view":    {"label": "View security events",          "description": "Access syslog feed, firewall events and the security dashboard"},
    "tools_passive":    {"label": "Use passive network tools",     "description": "Run DNS lookups, ping and traceroute from the Network Tools panel"},
    "tools_active":     {"label": "Use active scanning",           "description": "Run Nmap discovery and active port scans"},
    "inventory_export": {"label": "Export device inventory",       "description": "Download device list as CSV, JSON or PDF"},
    "firewall_export":  {"label": "Export firewall logs",          "description": "Download syslog and firewall event logs as CSV"},
    "report_export":    {"label": "Generate PDF reports",          "description": "Generate and download full network PDF reports"},
    "ipam_write":       {"label": "Edit IPAM",                     "description": "Create and modify subnets, import DHCP lease files"},
    "monitoring_write": {"label": "Configure monitoring",          "description": "Add and remove port monitoring targets"},
    "alert_write":      {"label": "Manage alert rules",            "description": "Create, edit and delete alert notification rules"},
}

# Default permissions per role — mirrors the hardcoded behaviour that existed before
ROLE_DEFAULTS: dict[str, list[str]] = {
    "NetworkAdmin": [
        "topology_write", "security_view", "tools_passive", "tools_active",
        "inventory_export", "firewall_export", "report_export",
        "ipam_write", "monitoring_write", "alert_write",
    ],
    "SecurityAnalyst": [
        "security_view", "tools_passive", "firewall_export",
    ],
    "Viewer": [
        "tools_passive",
    ],
}

# In-memory cache — populated at startup, refreshed on admin save
_cache: dict[str, set[str]] = {
    role: set(perms) for role, perms in ROLE_DEFAULTS.items()
}


def has_permission(role: str, permission: str) -> bool:
    return permission in _cache.get(role, set())


def get_all_permissions() -> dict[str, list[str]]:
    return {role: sorted(perms) for role, perms in _cache.items()}


def set_role_permissions(role: str, permissions: list[str]) -> None:
    _cache[role] = {p for p in permissions if p in PERMISSION_KEYS}


def load_from_db(json_value: str | None) -> None:
    if not json_value:
        return
    try:
        data = json.loads(json_value)
        _cache.clear()
        for role, perms in data.items():
            if isinstance(perms, list):
                _cache[role] = {p for p in perms if p in PERMISSION_KEYS}
    except (json.JSONDecodeError, TypeError, AttributeError):
        pass


def dump_to_json() -> str:
    return json.dumps({role: sorted(perms) for role, perms in _cache.items()})


def get_custom_roles() -> list[str]:
    return sorted(r for r in _cache if r not in BUILT_IN_ROLES)


def add_role(name: str) -> None:
    if name not in _cache:
        _cache[name] = set()


def delete_role(name: str) -> None:
    _cache.pop(name, None)

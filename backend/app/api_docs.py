from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.responses import HTMLResponse

from app.core.config import installed_app_version, settings


OPENAPI_TAGS = [
    {"name": "health", "description": "Container and API health checks."},
    {
        "name": "auth",
        "description": "Local authentication, sessions, profiles, and user administration.",
    },
    {"name": "oidc", "description": "OpenID Connect sign-in and SuperAdmin SSO configuration."},
    {"name": "api-keys", "description": "Create, inspect, and revoke API keys."},
    {"name": "dashboard", "description": "Summary data used by the NetMap overview."},
    {
        "name": "topology",
        "description": "Devices, groups, sites, relationships, and saved topology layouts.",
    },
    {
        "name": "discovery",
        "description": "Network discovery scans, schedules, and reviewable observations.",
    },
    {
        "name": "monitoring",
        "description": "Device status, uptime history, and service-check results.",
    },
    {"name": "monitors", "description": "Standalone HTTP, TCP, ping, and DNS monitors."},
    {
        "name": "alerts",
        "description": "Alert rules, events, delivery history, and test notifications.",
    },
    {
        "name": "ipam",
        "description": "Subnets, reservations, address usage, DHCP leases, and external allocations.",
    },
    {"name": "syslog", "description": "Firewall/syslog event search, status, and saved searches."},
    {"name": "tools", "description": "DNS, ping, traceroute, port, subnet, and SNMP tools."},
    {"name": "lldp", "description": "LLDP discovery, neighbours, and topology link creation."},
    {"name": "exports", "description": "Reports, data exports, backups, and restore operations."},
    {"name": "audit", "description": "Administrative audit-log search and export."},
    {
        "name": "admin",
        "description": "SuperAdmin settings, roles, notifications, and device-type configuration.",
    },
    {"name": "system", "description": "Installed-version information and SuperAdmin diagnostics."},
]

API_DESCRIPTION = """
NetMap's REST API for network inventory, topology, monitoring, IPAM, discovery,
security events, administration, and automation.

### Authentication

For scripts and integrations, select **Authorize** and enter a NetMap API key in
the `X-API-Key` field. API keys inherit their owner's current role and permissions.
The web application can also use a bearer access token or its existing secure
session cookies.

All API routes are relative to the NetMap instance. Destructive and administrative
operations remain subject to the same permission checks as the web interface.
""".strip()


def swagger_ui_html() -> HTMLResponse:
    """Return a CSP-compatible Swagger page backed by locally built assets."""
    return HTMLResponse(
        """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NetMap API - Swagger UI</title>
    <link rel="icon" href="/favicon.svg">
    <link rel="stylesheet" href="/swagger-ui/swagger-ui.css">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/swagger-ui/swagger-ui-bundle.js"></script>
    <script src="/swagger-ui/swagger-ui-standalone-preset.js"></script>
    <script src="/swagger-ui/swagger-initializer.js"></script>
  </body>
</html>
"""
    )


def configure_openapi(app: FastAPI) -> None:
    def custom_openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema

        schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
            tags=app.openapi_tags,
        )
        security_schemes = schema.setdefault("components", {}).setdefault("securitySchemes", {})
        security_schemes["ApiKeyAuth"] = {
            "type": "apiKey",
            "in": "header",
            "name": "X-API-Key",
            "description": "A registered NetMap API key (`nm_<prefix>_<secret>`).",
        }

        # FastAPI discovers bearer authentication from the dependency tree. API
        # keys use that same dependency but are read from Request, so add the key
        # as an alternative only where FastAPI already marked a route as secured.
        # Public endpoints intentionally remain without a security declaration.
        for path_item in schema.get("paths", {}).values():
            for operation in path_item.values():
                if not isinstance(operation, dict):
                    continue
                security = operation.get("security")
                if security and any("BearerAuth" in requirement for requirement in security):
                    operation["security"] = [{"ApiKeyAuth": []}, *security]
                    operation.setdefault("responses", {}).setdefault(
                        "401",
                        {"description": "Authentication is missing, invalid, expired, or revoked."},
                    )

        app.openapi_schema = schema
        return app.openapi_schema

    app.openapi = custom_openapi  # type: ignore[method-assign]


def app_version() -> str:
    return installed_app_version(settings.app_version).lstrip("v")

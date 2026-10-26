from __future__ import annotations

import pytest

from app.models.user import UserRole
from app.services.rbac import permissions as rbac
from tests.app_helpers import add_user, memory_factory, real_app_client


def test_tools_passive_description_lists_only_passive_tools() -> None:
    description = rbac.PERMISSION_META["tools_passive"]["description"].lower()
    assert "ping" not in description
    assert "traceroute" not in description
    assert "dns" in description


def test_tools_active_description_lists_ping_and_traceroute() -> None:
    description = rbac.PERMISSION_META["tools_active"]["description"].lower()
    assert "ping" in description
    assert "traceroute" in description
    # Nmap discovery is gated by discovery_manage, not tools_active.
    assert "nmap" not in description


@pytest.mark.parametrize("path", ["/api/v1/tools/ping", "/api/v1/tools/traceroute"])
def test_tools_passive_only_role_cannot_run_ping_or_traceroute(path: str) -> None:
    assert rbac.has_permission("Viewer", "tools_passive")
    assert not rbac.has_permission("Viewer", "tools_active")
    factory = memory_factory()
    with factory() as db:
        viewer = add_user(db, "viewer", UserRole.VIEWER)
    with real_app_client(factory, viewer) as client:
        response = client.post(path, json={"host": "192.168.1.1"})
    assert response.status_code == 403
    assert response.json() == {"detail": "Active scanning is not permitted for your role"}

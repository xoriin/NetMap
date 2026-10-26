from __future__ import annotations

import inspect

import pytest

from app.api.deps import require_monitoring_write
from app.api.v1 import monitors as monitors_api
from app.models.monitor import Monitor
from app.models.user import UserRole
from app.services.rbac import permissions as rbac
from tests.app_helpers import add_user, memory_factory, real_app_client


@pytest.fixture()
def restore_rbac():
    saved = {role: set(perms) for role, perms in rbac._cache.items()}
    yield
    rbac._cache.clear()
    rbac._cache.update(saved)


def test_monitor_write_routes_depend_on_monitoring_write() -> None:
    for handler in (monitors_api.create_monitor, monitors_api.update_monitor, monitors_api.delete_monitor):
        annotation = inspect.signature(handler).parameters["current_user"].annotation
        assert annotation.__metadata__[0].dependency is require_monitoring_write, handler.__name__


def test_network_admin_without_monitoring_write_cannot_create_monitor(restore_rbac) -> None:
    rbac.set_role_permissions(
        "NetworkAdmin", [perm for perm in rbac.ROLE_DEFAULTS["NetworkAdmin"] if perm != "monitoring_write"]
    )
    factory = memory_factory()
    with factory() as db:
        network_admin = add_user(db, "na", UserRole.NETWORK_ADMIN)
    with real_app_client(factory, network_admin) as client:
        response = client.post("/api/v1/monitors", json={"name": "blocked", "url": "https://example.com"})
    assert response.status_code == 403
    assert response.json() == {"detail": "Monitoring configuration is not permitted for your role"}
    with factory() as db:
        assert db.query(Monitor).count() == 0


def test_role_granted_monitoring_write_can_create_monitor(restore_rbac) -> None:
    rbac.set_role_permissions("Viewer", ["tools_passive", "monitoring_write"])
    factory = memory_factory()
    with factory() as db:
        viewer = add_user(db, "viewer", UserRole.VIEWER)
    with real_app_client(factory, viewer) as client:
        response = client.post("/api/v1/monitors", json={"name": "allowed", "url": "https://example.com"})
    assert response.status_code == 201, response.text


def test_super_admin_can_create_monitor() -> None:
    factory = memory_factory()
    with factory() as db:
        admin = add_user(db, "sa", UserRole.SUPER_ADMIN)
    with real_app_client(factory, admin) as client:
        response = client.post("/api/v1/monitors", json={"name": "admin", "url": "https://example.com"})
    assert response.status_code == 201, response.text

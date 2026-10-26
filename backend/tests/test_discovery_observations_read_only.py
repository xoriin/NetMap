from __future__ import annotations

from datetime import datetime, timezone

from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.discovery import DiscoveryObservation, DiscoveryScan, DiscoverySchedule
from app.models.user import UserRole
from app.schemas.discovery import DiscoveryHost
from app.services.discovery.scanner import serialize_results
from app.services.discovery.scheduled import create_observations_for_scan
from tests.app_helpers import add_user, memory_factory, real_app_client


def _seed(db) -> None:
    db.add(Device(id=1, display_name="nas", ip_address="192.168.1.50", status="online", lifecycle="active"))
    db.add(DiscoveryObservation(
        id=1, schedule_id=1, observation_type="new_device", status="open", ip_address="192.168.1.50", summary="new host",
    ))
    db.add(DiscoveryObservation(
        id=2, schedule_id=1, observation_type="new_device", status="open", ip_address="192.168.1.60", summary="new host",
    ))
    db.commit()


def test_get_observations_does_not_write() -> None:
    factory = memory_factory()
    with factory() as db:
        admin = add_user(db, "admin", UserRole.SUPER_ADMIN)
        _seed(db)
    with real_app_client(factory, admin) as client:
        all_rows = client.get("/api/v1/discovery/observations?status_filter=all")
        open_rows = client.get("/api/v1/discovery/observations?status_filter=open")
    assert all_rows.status_code == 200 and open_rows.status_code == 200
    with factory() as db:
        obs = db.get(DiscoveryObservation, 1)
        assert obs.status == "open"
        assert obs.resolved_at is None
    assert sorted(row["id"] for row in all_rows.json()) == [1, 2]
    # Already in inventory, so no longer actionable in the open list.
    assert [row["id"] for row in open_rows.json()] == [2]


def test_scan_pipeline_resolves_new_device_observations_already_in_inventory() -> None:
    factory = memory_factory()
    now = datetime.now(timezone.utc)
    with factory() as db:
        owner = add_user(db, "owner", UserRole.SUPER_ADMIN)
        schedule = DiscoverySchedule(
            id=1, owner_user_id=owner.id, name="LAN", target="192.168.1.0/24", scan_type="ping",
            interval_minutes=60, confirm_large_scan=True, enabled=True, created_at=now, updated_at=now,
        )
        db.add(schedule)
        db.commit()
        _seed(db)
        scan = DiscoveryScan(
            actor_user_id=owner.id, schedule_id=1, target="192.168.1.0/24", scan_type="ping", status="completed",
            host_count=254, result_count=1, results_json=serialize_results([DiscoveryHost(ip_address="192.168.1.50")]),
        )
        db.add(scan)
        db.commit()
        create_observations_for_scan(db, schedule, scan, None)
        db.commit()
        assert db.get(DiscoveryObservation, 1).status == "resolved"
        assert db.get(DiscoveryObservation, 1).resolved_at is not None
        assert db.get(DiscoveryObservation, 2).status == "open"


def test_discovery_import_resolves_matching_new_device_observation() -> None:
    factory = memory_factory()
    with factory() as db:
        admin = add_user(db, "admin", UserRole.SUPER_ADMIN)
        db.add(DiscoveryObservation(
            id=1, schedule_id=1, observation_type="new_device", status="open", ip_address="192.168.1.70", summary="new",
        ))
        scan = DiscoveryScan(
            actor_user_id=admin.id, target="192.168.1.70", scan_type="ping", status="completed", host_count=1,
            result_count=1, results_json=serialize_results([DiscoveryHost(ip_address="192.168.1.70")]),
        )
        db.add(scan)
        db.commit()
        scan_id = scan.id
    with real_app_client(factory, admin) as client:
        response = client.post("/api/v1/discovery/import", json={"scan_id": scan_id})
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 1
    with factory() as db:
        assert db.get(DiscoveryObservation, 1).status == "resolved"
        assert db.query(AuditLog).filter(AuditLog.action == "discovery.results_imported").count() == 1

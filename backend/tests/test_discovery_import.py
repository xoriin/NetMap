from datetime import datetime, timezone
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.discovery import import_scan_results, scan_to_read_with_inventory
from app.db.session import Base
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.discovery import DiscoveryScan
from app.models.site import Site
from app.models.topology_group import TopologyGroup
from app.schemas.discovery import DiscoveryHost, DiscoveryImportRequest
from app.services.discovery.scanner import serialize_results


def _session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            Site.__table__,
            TopologyGroup.__table__,
            Device.__table__,
            DiscoveryScan.__table__,
            AuditLog.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def _scan(*hosts: DiscoveryHost) -> DiscoveryScan:
    return DiscoveryScan(
        actor_user_id=1,
        target="192.168.1.0/24",
        scan_type="ping",
        status="completed",
        host_count=254,
        result_count=len(hosts),
        results_json=serialize_results(list(hosts)),
        completed_at=datetime.now(timezone.utc),
    )


def test_scan_read_marks_existing_changed_hosts():
    db = _session()
    existing = Device(
        hostname="old-host",
        ip_address="192.168.1.10",
        mac_address=None,
        vendor="OldVendor",
        status="online",
    )
    scan = _scan(DiscoveryHost(
        ip_address="192.168.1.10",
        hostname="new-host",
        mac_address="aa:bb:cc:dd:ee:ff",
        vendor="NewVendor",
    ))
    db.add_all([existing, scan])
    db.commit()
    db.refresh(scan)

    read = scan_to_read_with_inventory(scan, db)

    host = read.results[0]
    assert host.existing_device_id == existing.id
    assert host.import_status == "changed"
    assert host.proposed_updates == ["hostname", "mac_address", "vendor"]


def test_scan_read_marks_mac_matched_host_ip_change():
    db = _session()
    existing = Device(
        hostname="wifi-phone",
        ip_address="192.168.1.10",
        mac_address="aa:bb:cc:dd:ee:ff",
        vendor="PhoneVendor",
        status="online",
    )
    scan = _scan(DiscoveryHost(
        ip_address="192.168.1.84",
        hostname="wifi-phone",
        mac_address="AA-BB-CC-DD-EE-FF",
        vendor="PhoneVendor",
    ))
    db.add_all([existing, scan])
    db.commit()
    db.refresh(scan)

    read = scan_to_read_with_inventory(scan, db)

    host = read.results[0]
    assert host.existing_device_id == existing.id
    assert host.import_status == "changed"
    assert host.proposed_updates == ["ip_address"]


def test_discovery_import_fill_missing_does_not_override_existing_values():
    db = _session()
    existing = Device(
        hostname="old-host",
        ip_address="192.168.1.10",
        mac_address=None,
        vendor="OldVendor",
        status="online",
    )
    scan = _scan(DiscoveryHost(
        ip_address="192.168.1.10",
        hostname="new-host",
        mac_address="aa:bb:cc:dd:ee:ff",
        vendor="NewVendor",
    ))
    db.add_all([existing, scan])
    db.commit()
    db.refresh(scan)

    result = import_scan_results(
        DiscoveryImportRequest(scan_id=scan.id, mode="fill_missing"),
        SimpleNamespace(id=1),  # type: ignore[arg-type]
        db,
    )
    db.refresh(existing)

    assert result.created == 0
    assert result.updated == 1
    assert existing.hostname == "old-host"
    assert existing.mac_address == "aa:bb:cc:dd:ee:ff"
    assert existing.vendor == "OldVendor"


def test_discovery_import_mac_match_updates_ip_only_when_enabled():
    db = _session()
    existing = Device(
        hostname="wifi-phone",
        ip_address="192.168.1.10",
        mac_address="aa:bb:cc:dd:ee:ff",
        vendor="PhoneVendor",
        status="online",
    )
    scan = _scan(DiscoveryHost(
        ip_address="192.168.1.84",
        hostname="wifi-phone",
        mac_address="aa:bb:cc:dd:ee:ff",
        vendor="PhoneVendor",
    ))
    db.add_all([existing, scan])
    db.commit()
    db.refresh(scan)

    disabled = import_scan_results(
        DiscoveryImportRequest(scan_id=scan.id, mode="fill_missing", update_ip_on_mac_match=False),
        SimpleNamespace(id=1),  # type: ignore[arg-type]
        db,
    )
    db.refresh(existing)

    assert disabled.created == 0
    assert disabled.updated == 0
    assert existing.ip_address == "192.168.1.10"

    enabled = import_scan_results(
        DiscoveryImportRequest(scan_id=scan.id, mode="fill_missing", update_ip_on_mac_match=True),
        SimpleNamespace(id=1),  # type: ignore[arg-type]
        db,
    )
    db.refresh(existing)

    assert enabled.created == 0
    assert enabled.updated == 1
    assert existing.ip_address == "192.168.1.84"


def test_discovery_import_override_existing_replaces_selected_fields():
    db = _session()
    existing = Device(
        hostname="old-host",
        ip_address="192.168.1.10",
        mac_address="11:22:33:44:55:66",
        vendor="OldVendor",
        status="online",
    )
    scan = _scan(DiscoveryHost(
        ip_address="192.168.1.10",
        hostname="new-host",
        mac_address="aa:bb:cc:dd:ee:ff",
        vendor="NewVendor",
    ))
    db.add_all([existing, scan])
    db.commit()
    db.refresh(scan)

    result = import_scan_results(
        DiscoveryImportRequest(
            scan_id=scan.id,
            mode="override_existing",
            update_fields=["hostname", "vendor"],
        ),
        SimpleNamespace(id=1),  # type: ignore[arg-type]
        db,
    )
    db.refresh(existing)

    assert result.created == 0
    assert result.updated == 1
    assert existing.hostname == "new-host"
    assert existing.mac_address == "11:22:33:44:55:66"
    assert existing.vendor == "NewVendor"


def test_discovery_import_new_only_skips_existing_devices():
    db = _session()
    existing = Device(hostname="old-host", ip_address="192.168.1.10", status="online")
    scan = _scan(
        DiscoveryHost(ip_address="192.168.1.10", hostname="new-host"),
        DiscoveryHost(ip_address="192.168.1.11", hostname="brand-new"),
    )
    db.add_all([existing, scan])
    db.commit()
    db.refresh(scan)

    result = import_scan_results(
        DiscoveryImportRequest(scan_id=scan.id, mode="new_only"),
        SimpleNamespace(id=1),  # type: ignore[arg-type]
        db,
    )

    assert result.created == 1
    assert result.updated == 0
    assert result.skipped_existing == 1
    assert db.query(Device).count() == 2

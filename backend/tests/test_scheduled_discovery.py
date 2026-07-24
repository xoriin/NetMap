import json
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.discovery import resolve_all_observations
from app.db.session import Base
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.discovery import DiscoveryObservation, DiscoveryScan, DiscoverySchedule
from app.models.site import Site
from app.models.topology_group import TopologyGroup
from app.schemas.discovery import DiscoveryHost
from app.services.discovery.scheduled import create_observations_for_scan
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
            DiscoverySchedule.__table__,
            DiscoveryScan.__table__,
            DiscoveryObservation.__table__,
            AuditLog.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def _scan(*hosts: DiscoveryHost, schedule_id: int | None = None) -> DiscoveryScan:
    return DiscoveryScan(
        actor_user_id=1,
        schedule_id=schedule_id,
        target="192.168.1.0/24",
        scan_type="ping",
        status="completed",
        host_count=254,
        result_count=len(hosts),
        results_json=serialize_results(list(hosts)),
        completed_at=datetime.now(timezone.utc),
    )


def _schedule() -> DiscoverySchedule:
    now = datetime.now(timezone.utc)
    return DiscoverySchedule(
        owner_user_id=1,
        name="Daily LAN",
        target="192.168.1.0/24",
        scan_type="ping",
        interval_minutes=1440,
        confirm_large_scan=True,
        enabled=True,
        created_at=now,
        updated_at=now,
    )


def test_scheduled_discovery_auto_applies_mac_matched_ip_change():
    db = _session()
    existing = Device(
        hostname="wifi-phone",
        ip_address="192.168.1.10",
        mac_address="aa:bb:cc:dd:ee:ff",
        vendor="PhoneVendor",
        status="online",
    )
    schedule = _schedule()
    scan = _scan(
        DiscoveryHost(ip_address="192.168.1.84", hostname="wifi-phone", mac_address="AA-BB-CC-DD-EE-FF"),
        DiscoveryHost(ip_address="192.168.1.50", hostname="new-host", mac_address="11:22:33:44:55:66"),
    )
    db.add_all([existing, schedule, scan])
    db.commit()
    db.refresh(schedule)
    db.refresh(scan)
    device_id = existing.id

    observations = create_observations_for_scan(db, schedule, scan, None)

    # MAC-matched IP move is auto-applied — no ip_change observation created
    types = {observation.observation_type for observation in observations}
    assert "ip_change" not in types
    assert "new_device" in types
    # Device IP is updated in the database
    db.expire_all()
    updated = db.get(Device, device_id)
    assert updated.ip_address == "192.168.1.84"


def test_scheduled_discovery_ip_conflict_creates_observation():
    db = _session()
    existing = Device(
        hostname="wifi-phone",
        ip_address="192.168.1.10",
        mac_address="aa:bb:cc:dd:ee:ff",
        status="online",
    )
    # Another device already holds the IP the scan found
    blocker = Device(
        hostname="other-device",
        ip_address="192.168.1.84",
        status="online",
    )
    schedule = _schedule()
    scan = _scan(
        DiscoveryHost(ip_address="192.168.1.84", hostname="wifi-phone", mac_address="AA-BB-CC-DD-EE-FF"),
    )
    db.add_all([existing, blocker, schedule, scan])
    db.commit()
    db.refresh(schedule)
    db.refresh(scan)

    observations = create_observations_for_scan(db, schedule, scan, None)

    types = {observation.observation_type for observation in observations}
    assert "ip_change" in types
    ip_change = next(o for o in observations if o.observation_type == "ip_change")
    assert ip_change.device_id == existing.id
    assert ip_change.ip_address == "192.168.1.84"


def test_scheduled_discovery_waits_before_recording_disappeared_host():
    db = _session()
    schedule = _schedule()
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    previous = _scan(
        DiscoveryHost(ip_address="192.168.1.10", hostname="old-host", mac_address="aa:bb:cc:dd:ee:ff"),
        DiscoveryHost(ip_address="192.168.1.20", hostname="stable-host", mac_address="11:22:33:44:55:66"),
        schedule_id=schedule.id,
    )
    current = _scan(
        DiscoveryHost(ip_address="192.168.1.20", hostname="stable-host", mac_address="11:22:33:44:55:66"),
        schedule_id=schedule.id,
    )
    db.add_all([previous, current])
    db.commit()
    db.refresh(previous)
    db.refresh(current)

    observations = create_observations_for_scan(db, schedule, current, previous)

    disappeared = [observation for observation in observations if observation.observation_type == "disappeared"]
    assert disappeared == []


def test_scheduled_discovery_records_disappeared_after_three_missed_scans():
    db = _session()
    schedule = _schedule()
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    baseline = _scan(
        DiscoveryHost(ip_address="192.168.1.10", hostname="old-host", mac_address="aa:bb:cc:dd:ee:ff"),
        DiscoveryHost(ip_address="192.168.1.20", hostname="stable-host", mac_address="11:22:33:44:55:66"),
        schedule_id=schedule.id,
    )
    miss_one = _scan(
        DiscoveryHost(ip_address="192.168.1.20", hostname="stable-host", mac_address="11:22:33:44:55:66"),
        schedule_id=schedule.id,
    )
    miss_two = _scan(
        DiscoveryHost(ip_address="192.168.1.20", hostname="stable-host", mac_address="11:22:33:44:55:66"),
        schedule_id=schedule.id,
    )
    miss_three = _scan(
        DiscoveryHost(ip_address="192.168.1.20", hostname="stable-host", mac_address="11:22:33:44:55:66"),
        schedule_id=schedule.id,
    )
    db.add_all([baseline, miss_one, miss_two, miss_three])
    db.commit()
    db.refresh(miss_two)
    db.refresh(miss_three)

    observations = create_observations_for_scan(db, schedule, miss_three, miss_two)

    disappeared = [observation for observation in observations if observation.observation_type == "disappeared"]
    assert len(disappeared) == 1
    assert disappeared[0].ip_address == "192.168.1.10"
    details = json.loads(disappeared[0].details_json)
    assert details["previous_scan_id"] == baseline.id
    assert details["missed_scans"] == 3


def _observation(schedule_id: int, obs_type: str, *, status: str = "open", ip: str = "192.168.1.10", mac: str | None = "aa:bb:cc:dd:ee:ff", details: dict | None = None, resolved_at: datetime | None = None) -> DiscoveryObservation:
    now = datetime.now(timezone.utc)
    return DiscoveryObservation(
        schedule_id=schedule_id,
        scan_id=None,
        device_id=None,
        observation_type=obs_type,
        status=status,
        ip_address=ip,
        mac_address=mac,
        hostname="wifi-client",
        summary="test",
        details_json=json.dumps(details or {}),
        first_seen_at=now,
        last_seen_at=now,
        resolved_at=resolved_at,
    )


def test_reappearing_host_auto_resolves_open_disappeared_observation():
    db = _session()
    schedule = _schedule()
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    stale = _observation(schedule.id, "disappeared", status="open")
    db.add(stale)
    current = _scan(
        DiscoveryHost(ip_address="192.168.1.10", hostname="wifi-client", mac_address="AA-BB-CC-DD-EE-FF", import_status="existing"),
        schedule_id=schedule.id,
    )
    db.add(current)
    db.commit()
    db.refresh(current)
    db.refresh(stale)

    create_observations_for_scan(db, schedule, current, None)

    db.refresh(stale)
    assert stale.status == "resolved"
    assert stale.resolved_at is not None
    assert json.loads(stale.details_json)["auto_resolved"] == "reappeared"


def test_resolved_new_device_with_mac_is_not_re_raised():
    db = _session()
    schedule = _schedule()
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    dismissed = _observation(
        schedule.id,
        "new_device",
        status="resolved",
        ip="192.168.1.50",
        mac="11:22:33:44:55:66",
        resolved_at=datetime.now(timezone.utc) - timedelta(days=90),
    )
    db.add(dismissed)
    current = _scan(
        DiscoveryHost(ip_address="192.168.1.77", hostname="guest-phone", mac_address="11-22-33-44-55-66"),
        schedule_id=schedule.id,
    )
    db.add(current)
    db.commit()
    db.refresh(current)

    observations = create_observations_for_scan(db, schedule, current, None)

    # MAC-identified dismissal is permanent, even at a new IP and much later
    assert [o for o in observations if o.observation_type == "new_device"] == []


def test_resolved_new_device_without_mac_suppressed_only_within_window():
    db = _session()
    schedule = _schedule()
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    recently = _observation(
        schedule.id, "new_device", status="resolved", ip="192.168.1.50", mac=None,
        resolved_at=datetime.now(timezone.utc) - timedelta(days=2),
    )
    long_ago = _observation(
        schedule.id, "new_device", status="resolved", ip="192.168.1.60", mac=None,
        resolved_at=datetime.now(timezone.utc) - timedelta(days=60),
    )
    db.add_all([recently, long_ago])
    current = _scan(
        DiscoveryHost(ip_address="192.168.1.50", hostname="suppressed"),
        DiscoveryHost(ip_address="192.168.1.60", hostname="re-raised"),
        schedule_id=schedule.id,
    )
    db.add(current)
    db.commit()
    db.refresh(current)

    observations = create_observations_for_scan(db, schedule, current, None)

    new_ips = {o.ip_address for o in observations if o.observation_type == "new_device"}
    assert new_ips == {"192.168.1.60"}


def test_intermittent_host_does_not_re_raise_disappeared():
    db = _session()
    schedule = _schedule()
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    # This host already went through a disappear→reappear cycle two days ago.
    flapper_history = _observation(
        schedule.id,
        "disappeared",
        status="resolved",
        details={"auto_resolved": "reappeared"},
        resolved_at=datetime.now(timezone.utc) - timedelta(days=2),
    )
    db.add(flapper_history)
    baseline = _scan(
        DiscoveryHost(ip_address="192.168.1.10", hostname="wifi-client", mac_address="aa:bb:cc:dd:ee:ff"),
        DiscoveryHost(ip_address="192.168.1.20", hostname="stable-host", mac_address="11:22:33:44:55:66"),
        schedule_id=schedule.id,
    )
    misses = [
        _scan(
            DiscoveryHost(ip_address="192.168.1.20", hostname="stable-host", mac_address="11:22:33:44:55:66"),
            schedule_id=schedule.id,
        )
        for _ in range(3)
    ]
    db.add_all([baseline, *misses])
    db.commit()
    for scan in misses:
        db.refresh(scan)

    observations = create_observations_for_scan(db, schedule, misses[-1], misses[-2])

    assert [o for o in observations if o.observation_type == "disappeared"] == []


def test_resolve_all_observations_resolves_open_and_acknowledged_only():
    db = _session()
    schedule = _schedule()
    db.add(schedule)
    db.commit()
    db.refresh(schedule)

    already_resolved = _observation(schedule.id, "new_device", status="resolved", ip="10.0.0.1", resolved_at=datetime.now(timezone.utc))
    open_obs = _observation(schedule.id, "new_device", status="open", ip="10.0.0.2")
    acked_obs = _observation(schedule.id, "disappeared", status="acknowledged", ip="10.0.0.3")
    db.add_all([already_resolved, open_obs, acked_obs])
    db.commit()

    actor = Mock(id=1)
    result = resolve_all_observations(actor, db)

    assert result == {"resolved": 2}
    db.refresh(open_obs)
    db.refresh(acked_obs)
    db.refresh(already_resolved)
    assert open_obs.status == "resolved"
    assert open_obs.resolved_at is not None
    assert acked_obs.status == "resolved"
    assert acked_obs.resolved_at is not None
    # already-resolved observation's resolved_at is untouched by the bulk call
    assert already_resolved.status == "resolved"

    audit_events = db.query(AuditLog).filter(AuditLog.action == "discovery.observations_resolved_all").all()
    assert len(audit_events) == 1
    assert audit_events[0].detail == "count=2"


def test_resolve_all_observations_is_a_noop_when_nothing_open():
    db = _session()
    schedule = _schedule()
    db.add(schedule)
    db.commit()
    db.refresh(schedule)

    actor = Mock(id=1)
    result = resolve_all_observations(actor, db)
    assert result == {"resolved": 0}

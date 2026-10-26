"""Discovery must not hold a database session across nmap, SNMP or notification I/O."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base, import_all_models
from app.models.discovery import DiscoveryScan, DiscoverySchedule
from app.models.user import UserRole
from app.schemas.discovery import DiscoveryHost, DiscoveryStart
from app.services.discovery import scheduled
from tests.app_helpers import add_user


def _factory():
    # Production SessionLocal settings (expire_on_commit left at its default).
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    import_all_models()
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def test_execute_discovery_scan_releases_session_during_nmap_and_snmp(monkeypatch) -> None:
    factory = _factory()
    seen: dict[str, bool] = {}
    with factory() as db:
        user_id = add_user(db, "scanner", UserRole.SUPER_ADMIN).id

        def fake_nmap(target, scan_type):
            seen["nmap"] = db.in_transaction()
            return [DiscoveryHost(ip_address="192.168.1.10")]

        def fake_snmp(hosts, *args, **kwargs):
            seen["snmp"] = db.in_transaction()
            return hosts

        monkeypatch.setattr(scheduled, "run_nmap_scan", fake_nmap)
        monkeypatch.setattr(scheduled, "enrich_hosts_from_snmp_arp", fake_snmp)
        payload = DiscoveryStart(
            target="192.168.1.10", scan_type="ping", snmp_community="public", snmp_targets=["192.168.1.1"]
        )
        scan = scheduled.execute_discovery_scan(db, payload, user_id)
        assert scan.status == "completed"
        assert scan.result_count == 1
    assert seen == {"nmap": False, "snmp": False}


def test_execute_discovery_scan_records_failure_after_network_phase(monkeypatch) -> None:
    factory = _factory()
    with factory() as db:
        user_id = add_user(db, "scanner", UserRole.SUPER_ADMIN).id

        def failing_nmap(target, scan_type):
            assert not db.in_transaction()
            raise RuntimeError("Nmap scan failed")

        monkeypatch.setattr(scheduled, "run_nmap_scan", failing_nmap)
        scan = scheduled.execute_discovery_scan(db, DiscoveryStart(target="192.168.1.10"), user_id)
        assert scan.status == "failed"
        assert scan.error == "Nmap scan failed"
        assert scan.completed_at is not None


def test_execute_discovery_scan_missing_snmp_profile_fails_without_running_nmap(monkeypatch) -> None:
    factory = _factory()
    calls: list[str] = []
    monkeypatch.setattr(scheduled, "run_nmap_scan", lambda target, scan_type: calls.append("nmap") or [])
    with factory() as db:
        user_id = add_user(db, "scanner", UserRole.SUPER_ADMIN).id
        payload = DiscoveryStart(target="192.168.1.10", snmp_profile_id=999, snmp_targets=["192.168.1.1"])
        scan = scheduled.execute_discovery_scan(db, payload, user_id)
    assert scan.status == "failed"
    assert scan.error == "SNMP profile not found"
    assert calls == []


def test_run_schedule_sends_notifications_after_closing_session(monkeypatch) -> None:
    factory = _factory()
    sessions = []

    def tracking_factory():
        session = factory()
        sessions.append(session)
        return session

    now = datetime.now(timezone.utc)
    with factory() as db:
        owner_id = add_user(db, "owner", UserRole.SUPER_ADMIN).id
        schedule = DiscoverySchedule(
            owner_user_id=owner_id,
            name="Daily LAN",
            target="192.168.1.0/24",
            scan_type="ping",
            interval_minutes=1440,
            confirm_large_scan=True,
            enabled=True,
            notification_targets_json=json.dumps(["email"]),
            created_at=now,
            updated_at=now,
        )
        db.add(schedule)
        db.commit()
        schedule_id = schedule.id

    delivered: list[tuple[str, bool]] = []

    def fake_send(target, message, settings, profiles):
        delivered.append((target, any(session.in_transaction() for session in sessions)))
        return "sent"

    monkeypatch.setattr(scheduled, "SessionLocal", tracking_factory)
    monkeypatch.setattr(scheduled, "run_nmap_scan", lambda target, scan_type: [DiscoveryHost(ip_address="192.168.1.50")])
    monkeypatch.setattr(scheduled, "send_notification_target", fake_send)

    scan = scheduled.ScheduledDiscoveryService().run_schedule(schedule_id)

    assert scan is not None and scan.status == "completed"
    assert delivered == [("email", False)]
    with factory() as db:
        stored = db.get(DiscoverySchedule, schedule_id)
        assert stored.last_scan_id == scan.id
        assert stored.last_status == "completed"
        assert db.get(DiscoveryScan, scan.id).result_count == 1

from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.admin import get_public_settings, update_settings
from app.api.v1.monitoring import _build_device_summaries, device_analysis, list_device_summaries
from app.db.session import Base
from app.models.device import Device
from app.models.monitor_history import DeviceMonitorHistory
from app.models.site import Site
from app.models.system_setting import SystemSetting
from app.models.topology_group import TopologyGroup
from app.schemas.admin import SystemSettingsUpdate
from app.services.alerting import service as alerting_service


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
            DeviceMonitorHistory.__table__,
            SystemSetting.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_monitoring_delta_includes_monitor_and_metadata_changes():
    db = _session()
    now = datetime.now(timezone.utc)
    cursor = now - timedelta(minutes=10)
    old = now - timedelta(hours=1)

    monitored = Device(
        display_name="Monitored",
        ip_address="10.0.0.10",
        status="online",
        monitor_status="online",
        last_monitored_at=now,
        updated_at=old,
    )
    edited = Device(
        display_name="Edited",
        ip_address="10.0.0.11",
        status="online",
        monitor_status="unknown",
        last_monitored_at=old,
        updated_at=now,
    )
    unchanged = Device(
        display_name="Unchanged",
        ip_address="10.0.0.12",
        status="online",
        monitor_status="unknown",
        last_monitored_at=old,
        updated_at=old,
    )
    db.add_all([monitored, edited, unchanged])
    db.commit()

    rows = list_device_summaries(None, db, changed_since=cursor)  # type: ignore[arg-type]

    assert {row.display_name for row in rows} == {"Monitored", "Edited"}


def test_monitoring_heartbeat_is_capped_but_uptime_uses_full_24h_window():
    db = _session()
    now = datetime.now(timezone.utc)
    device = Device(
        display_name="Switch",
        ip_address="10.0.0.20",
        status="online",
        monitor_status="online",
        last_monitored_at=now,
        updated_at=now,
    )
    db.add(device)
    db.commit()
    db.refresh(device)

    rows = []
    for idx in range(60):
        rows.append(
            DeviceMonitorHistory(
                device_id=device.id,
                checked_at=now - timedelta(minutes=idx),
                status="online" if idx < 30 else "offline",
                rtt_ms=float(idx),
                port_results="[]",
            )
        )
    db.add_all(rows)
    db.commit()

    summary = _build_device_summaries(db, [device])[0]

    assert len(summary.heartbeat) == 50
    assert summary.uptime_24h == 0.5
    assert summary.avg_rtt_24h == 29.5


def test_monitoring_service_results_parse_legacy_and_rich_history_rows():
    db = _session()
    now = datetime.now(timezone.utc)
    legacy = Device(
        display_name="Legacy",
        ip_address="10.0.0.30",
        status="online",
        monitor_status="online",
        last_monitored_at=now,
        updated_at=now,
    )
    rich = Device(
        display_name="Rich",
        ip_address="10.0.0.31",
        status="online",
        monitor_status="online",
        last_monitored_at=now,
        updated_at=now,
    )
    db.add_all([legacy, rich])
    db.commit()
    db.refresh(legacy)
    db.refresh(rich)

    db.add_all([
        DeviceMonitorHistory(
            device_id=legacy.id,
            checked_at=now,
            status="online",
            rtt_ms=1.0,
            port_results='[{"port": 443, "label": "HTTPS", "open": true}]',
        ),
        DeviceMonitorHistory(
            device_id=rich.id,
            checked_at=now,
            status="online",
            rtt_ms=1.0,
            port_results='[{"target_id": 7, "port": 8443, "label": "Admin UI", "check_type": "tcp", "open": false, "status": "closed"}]',
        ),
    ])
    db.commit()

    summaries = {row.display_name: row for row in _build_device_summaries(db, [legacy, rich])}

    legacy_result = summaries["Legacy"].latest_port_results[0]
    assert legacy_result.target_id is None
    assert legacy_result.check_type == "tcp"
    assert legacy_result.status is None

    rich_result = summaries["Rich"].latest_port_results[0]
    assert rich_result.target_id == 7
    assert rich_result.label == "Admin UI"
    assert rich_result.status == "closed"


def test_device_analysis_handles_sqlite_naive_checked_at_values():
    db = _session()
    now = datetime.now(timezone.utc)
    device = Device(
        display_name="Router",
        ip_address="10.0.0.40",
        status="online",
        monitor_status="online",
        last_monitored_at=now,
        updated_at=now,
    )
    db.add(device)
    db.commit()
    db.refresh(device)

    rows = []
    for idx in range(12):
        rows.append(
            DeviceMonitorHistory(
                device_id=device.id,
                checked_at=(now - timedelta(hours=idx)).replace(tzinfo=None),
                status="offline" if 3 <= idx <= 4 else "online",
                rtt_ms=float(10 + idx),
                port_results="[]",
            )
        )
    db.add_all(rows)
    db.commit()

    analysis = device_analysis(device.id, None, db)  # type: ignore[arg-type]

    assert analysis.device_id == device.id
    assert analysis.anomaly_level in {"normal", "elevated", "anomalous"}
    assert analysis.flap_count_24h == 2
    assert analysis.longest_outage_minutes == 120


def test_alert_monitor_reads_interval_and_live_ping_settings(monkeypatch):
    db = _session()
    db.add_all([
        SystemSetting(key="monitor_interval_seconds", value="10"),
        SystemSetting(key="live_ping_enabled", value="false"),
    ])
    db.commit()

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(alerting_service, "SessionLocal", factory)

    monitor = alerting_service.AlertMonitorService()

    assert monitor._get_interval() == 30
    assert monitor._live_ping_enabled() is False

    db.get(SystemSetting, "monitor_interval_seconds").value = "7200"  # type: ignore[union-attr]
    db.get(SystemSetting, "live_ping_enabled").value = "true"  # type: ignore[union-attr]
    db.commit()

    assert monitor._get_interval() == 3600
    assert monitor._live_ping_enabled() is True


def test_admin_settings_persist_monitor_interval_seconds():
    db = _session()

    updated = update_settings(
        SystemSettingsUpdate(monitor_interval_seconds=45),
        None,  # type: ignore[arg-type]
        db,
    )

    assert updated.monitor_interval_seconds == 45
    assert get_public_settings(db).monitor_interval_seconds == 45

from datetime import datetime, timedelta, timezone
from contextlib import contextmanager

from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.admin import get_public_settings, update_settings
from app.api.v1.monitoring import _build_device_summaries, device_analysis, list_device_summaries
from app.db.session import Base, _migrate_monitor_history_uptime_index
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
        device_type="switch",
        icon="switch",
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
    assert summary.device_type == "switch"
    assert summary.icon == "switch"
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


def test_alert_monitor_tcp_fallback_marks_device_online_when_icmp_unavailable(monkeypatch):
    device = Device(
        id=1,
        display_name="Router",
        ip_address="10.0.0.1",
        status="online",
    )
    monitor = alerting_service.AlertMonitorService()

    def fail_ping(*_args, **_kwargs):
        raise RuntimeError("icmp unavailable")

    @contextmanager
    def fake_connection(*_args, **_kwargs):
        yield object()

    monkeypatch.setattr(alerting_service, "ping_host", fail_ping)
    monkeypatch.setattr(alerting_service.socket, "create_connection", fake_connection)

    status, rtt_ms = monitor._probe_device_status(device)

    assert status == "online"
    assert rtt_ms is not None


def test_alert_monitor_tcp_fallback_marks_device_offline_when_all_probes_fail(monkeypatch):
    device = Device(
        id=1,
        display_name="Router",
        ip_address="10.0.0.1",
        status="online",
    )
    monitor = alerting_service.AlertMonitorService()

    def fail_ping(*_args, **_kwargs):
        raise RuntimeError("icmp unavailable")

    def fail_connection(*_args, **_kwargs):
        raise OSError("closed")

    monkeypatch.setattr(alerting_service, "ping_host", fail_ping)
    monkeypatch.setattr(alerting_service.socket, "create_connection", fail_connection)

    status, rtt_ms = monitor._probe_device_status(device)

    assert status == "offline"
    assert rtt_ms is None


def test_admin_settings_persist_monitor_interval_seconds():
    db = _session()

    updated = update_settings(
        SystemSettingsUpdate(monitor_interval_seconds=45),
        None,  # type: ignore[arg-type]
        db,
    )

    assert updated.monitor_interval_seconds == 45
    assert get_public_settings(db).monitor_interval_seconds == 45


def _uptime_aggregate_plans(db):
    """Explain every per-device uptime rollup /monitoring/devices actually runs.

    The statements are captured from a real _build_device_summaries call rather
    than restated here, so the assertion can't drift away from the query the
    endpoint issues.
    """
    from sqlalchemy import event

    captured: list[tuple[str, tuple]] = []

    def record(_conn, _cursor, statement, parameters, _context, _executemany):
        captured.append((statement, parameters))

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        _build_device_summaries(db, list(db.scalars(select(Device)).all()))
    finally:
        event.remove(engine, "before_cursor_execute", record)

    plans = []
    for statement, parameters in captured:
        # The two GROUP BY device_id rollups (24 h and 7 d), not the heartbeat
        # window query or the site/group lookups.
        if "GROUP BY device_monitor_history.device_id" not in statement:
            continue
        # exec_driver_sql, not execute(text(...)): these are the driver's own
        # positional parameters, not named bindparams.
        rows = db.connection().exec_driver_sql("EXPLAIN QUERY PLAN " + statement, parameters).all()
        plans.append(" ".join(str(row[-1]) for row in rows))
    return plans


def test_uptime_rollups_are_covered_by_an_index():
    """The 24 h/7 d rollups must not fall back to a table lookup per row.

    ix_monitor_history_device_checked_at narrows to the right rows but omits
    status/rtt_ms, so without the wider index every matching row costs a
    scattered page read — hundreds of thousands of them across a week of fleet
    history on each uncached load.
    """
    db = _session()
    now = datetime.now(timezone.utc)
    device = Device(
        display_name="Indexed",
        ip_address="10.0.0.40",
        status="online",
        monitor_status="online",
        last_monitored_at=now,
        updated_at=now,
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    db.add_all([
        DeviceMonitorHistory(
            device_id=device.id,
            checked_at=now - timedelta(minutes=idx),
            status="online",
            rtt_ms=float(idx),
            port_results="[]",
        )
        for idx in range(20)
    ])
    db.commit()

    before = _uptime_aggregate_plans(db)
    assert len(before) == 2, f"expected the 24h and 7d rollups, got {before}"

    _migrate_monitor_history_uptime_index(db.connection(), inspect(db.get_bind()))
    db.commit()

    after = _uptime_aggregate_plans(db)
    assert len(after) == 2
    for plan in after:
        assert "COVERING INDEX" in plan, plan

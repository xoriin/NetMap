from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.monitoring import _build_device_summaries, list_device_summaries
from app.db.session import Base
from app.models.device import Device
from app.models.monitor_history import DeviceMonitorHistory
from app.models.site import Site
from app.models.topology_group import TopologyGroup


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

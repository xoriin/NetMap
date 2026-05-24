from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.firewall_session import FirewallBase
from app.models.device import Device
from app.models.firewall_event import FirewallEvent
from app.services.search.correlation import build_device_event_counts


def _firewall_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    FirewallBase.metadata.create_all(engine, tables=[FirewallEvent.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_device_event_counts_do_not_double_count_same_source_and_destination_ip():
    db = _firewall_session()
    now = datetime.now(timezone.utc)
    device = Device(id=1, ip_address="10.0.0.10", hostname="router")
    db.add(
        FirewallEvent(
            received_at=now,
            src_ip="10.0.0.10",
            dst_ip="10.0.0.10",
            action="block",
            raw_log="loopback block",
        )
    )
    db.commit()

    counts = build_device_event_counts(
        db,
        [device],
        window_start=now - timedelta(minutes=5),
    )

    assert counts[device.id].event_count == 1
    assert counts[device.id].blocked_count == 1

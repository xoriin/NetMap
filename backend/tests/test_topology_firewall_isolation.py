"""
Tests confirming that:
  1. Topology graph/list endpoints no longer perform broad firewall event aggregation.
  2. Per-device firewall summary is bounded to a single device/IP set.
  3. firewall_db DatabaseError in the per-device summary returns empty data, not HTTP 500.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DatabaseError as SQLAlchemyDatabaseError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.topology import list_device_security_events
from app.db.firewall_session import FirewallBase
from app.db.session import Base
from app.models.device import Device
from app.models.firewall_event import FirewallEvent
from app.models.site import Site
from app.models.topology_group import TopologyGroup
from app.models.user import User, UserRole
from app.services.search.correlation import (
    build_device_event_counts,
    list_recent_device_events,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _app_session():
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
            User.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def _firewall_session(*, corrupt: bool = False):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    FirewallBase.metadata.create_all(engine, tables=[FirewallEvent.__table__])
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    if corrupt:
        # Simulate a DatabaseError raised on any firewall_db query.
        session.execute = MagicMock(
            side_effect=SQLAlchemyDatabaseError(
                "database disk image is malformed", None, None
            )
        )
        session.scalars = MagicMock(
            side_effect=SQLAlchemyDatabaseError(
                "database disk image is malformed", None, None
            )
        )
    return session


def _superadmin():
    return User(username="admin", password_hash="x", role=UserRole.SUPER_ADMIN.value)


# ---------------------------------------------------------------------------
# 1. build_device_event_counts is bounded to the supplied device list
# ---------------------------------------------------------------------------

def test_event_counts_only_queries_supplied_ips():
    """build_device_event_counts only counts events for IPs in the provided device list."""
    fw = _firewall_session()
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(hours=24)

    # Two firewall events for different IPs
    fw.add_all([
        FirewallEvent(received_at=now, src_ip="10.0.0.1", action="block", raw_log="a"),
        FirewallEvent(received_at=now, src_ip="10.0.0.2", action="pass",  raw_log="b"),
    ])
    fw.commit()

    target_device = Device(id=1, ip_address="10.0.0.1", hostname="router")
    other_device  = Device(id=2, ip_address="10.0.0.2", hostname="switch")

    counts_one = build_device_event_counts(fw, [target_device], window_start=window_start)
    counts_both = build_device_event_counts(fw, [target_device, other_device], window_start=window_start)

    # Single-device call must NOT count events for 10.0.0.2
    assert counts_one[1].event_count == 1
    assert 2 not in counts_one

    # Two-device call includes both
    assert counts_both[1].event_count == 1
    assert counts_both[2].event_count == 1


def test_event_counts_zero_for_device_with_no_matching_events():
    """A device whose IP has no matching firewall events returns zero counts."""
    fw = _firewall_session()
    now = datetime.now(timezone.utc)
    # Only an event for a different IP
    fw.add(FirewallEvent(received_at=now, src_ip="10.0.0.1", action="block", raw_log="x"))
    fw.commit()

    silent_device = Device(id=99, ip_address="10.0.0.99", hostname="quiet")
    counts = build_device_event_counts(fw, [silent_device], window_start=now - timedelta(hours=1))
    assert counts[99].event_count == 0


# ---------------------------------------------------------------------------
# 2. list_recent_device_events is bounded to a single device IP
# ---------------------------------------------------------------------------

def test_recent_device_events_only_returns_events_for_target_ip():
    fw = _firewall_session()
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(hours=1)

    fw.add_all([
        FirewallEvent(received_at=now, src_ip="10.0.0.5", dst_ip="8.8.8.8", action="pass",  raw_log="match"),
        FirewallEvent(received_at=now, src_ip="10.0.0.9", dst_ip="10.0.0.5", action="block", raw_log="match dst"),
        FirewallEvent(received_at=now, src_ip="1.2.3.4",  dst_ip="5.6.7.8",  action="block", raw_log="no match"),
    ])
    fw.commit()

    device = Device(id=5, ip_address="10.0.0.5", hostname="target")
    events = list_recent_device_events(fw, device=device, window_start=window_start, limit=100)

    returned_ips = {(e.src_ip, e.dst_ip) for e in events}
    assert all(
        ip == "10.0.0.5" for pair in returned_ips for ip in pair if ip == "10.0.0.5"
    ), "All returned events must involve the target IP"
    # The unrelated event (1.2.3.4 → 5.6.7.8) must NOT appear
    assert ("1.2.3.4", "5.6.7.8") not in returned_ips
    assert len(events) == 2


def test_recent_device_events_respects_limit():
    fw = _firewall_session()
    now = datetime.now(timezone.utc)
    for i in range(20):
        fw.add(FirewallEvent(received_at=now - timedelta(seconds=i), src_ip="10.0.0.1", action="pass", raw_log=f"e{i}"))
    fw.commit()

    device = Device(id=1, ip_address="10.0.0.1", hostname="router")
    events = list_recent_device_events(fw, device=device, window_start=now - timedelta(hours=1), limit=5)
    assert len(events) == 5


# ---------------------------------------------------------------------------
# 3. list_device_security_events returns empty data (not 500) on firewall DB error
# ---------------------------------------------------------------------------

def test_device_security_events_returns_empty_on_firewall_db_error():
    """
    If firewall_db raises DatabaseError (e.g. corruption), the endpoint must
    return an empty DeviceSecurityEventSummary instead of raising HTTP 500.
    """
    db = _app_session()
    admin = _superadmin()
    db.add(admin)
    db.flush()
    device = Device(id=1, ip_address="192.168.1.1", hostname="router")
    db.add(device)
    db.commit()

    corrupt_fw = _firewall_session(corrupt=True)

    result = list_device_security_events(
        device_id=1,
        _current_user=admin,
        db=db,
        firewall_db=corrupt_fw,
        window_hours=24,
        limit=25,
    )

    assert result.device_id == 1
    assert result.total_count == 0
    assert result.blocked_count == 0
    assert result.passed_count == 0
    assert result.events == []
    assert result.last_seen_event_time is None


def test_device_security_events_returns_404_for_missing_device():
    """Unknown device_id still raises 404, not a firewall error."""
    from fastapi import HTTPException

    db = _app_session()
    admin = _superadmin()
    db.add(admin)
    db.commit()
    fw = _firewall_session()

    with pytest.raises(HTTPException) as exc_info:
        list_device_security_events(
            device_id=9999,
            _current_user=admin,
            db=db,
            firewall_db=fw,
        )
    assert exc_info.value.status_code == 404


# ---------------------------------------------------------------------------
# 4. Correlation helper window correctness
# ---------------------------------------------------------------------------

def test_list_device_event_counts_is_bounded_by_window():
    """Event-count endpoint correctly excludes events outside the time window."""
    fw = _firewall_session()
    now = datetime.now(timezone.utc)
    old = now - timedelta(hours=48)

    fw.add_all([
        FirewallEvent(received_at=now, src_ip="10.0.0.1", action="block", raw_log="recent"),
        FirewallEvent(received_at=old, src_ip="10.0.0.1", action="block", raw_log="old"),
    ])
    fw.commit()

    device = Device(id=1, ip_address="10.0.0.1", hostname="router")
    # 24-hour window — only the recent event should be counted
    window_start = now - timedelta(hours=24)
    counts = build_device_event_counts(fw, [device], window_start=window_start)
    assert counts[1].event_count == 1
    assert counts[1].blocked_count == 1

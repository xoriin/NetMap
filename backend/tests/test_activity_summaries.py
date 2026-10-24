from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.audit import audit_summary
from app.api.v1.discovery import observation_summary
from app.db.session import Base
from app.models import device, site, snmp_profile, topology_group  # noqa: F401  (mapper config)
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.discovery import DiscoveryObservation, DiscoveryScan, DiscoverySchedule
from app.models.site import Site
from app.models.topology_group import TopologyGroup
from app.models.user import User


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[
        AuditLog.__table__, User.__table__, Site.__table__, TopologyGroup.__table__, Device.__table__,
        DiscoverySchedule.__table__, DiscoveryScan.__table__, DiscoveryObservation.__table__,
    ])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_audit_summary_counts_sign_ins_per_day_and_ranks_actions_and_users():
    db = _session()
    db.add_all([User(id=1, username="alice", password_hash="x", role="SuperAdmin"), User(id=2, username="bob", password_hash="x", role="Viewer")])
    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)
    db.add_all([
        AuditLog(action="auth.login_success", actor_user_id=1, created_at=now),
        AuditLog(action="auth.login_success", actor_user_id=2, created_at=now),
        AuditLog(action="auth.login_failed", created_at=now),
        AuditLog(action="auth.mfa_failed", actor_user_id=2, created_at=yesterday),
        AuditLog(action="auth.login_blocked", created_at=yesterday),
        AuditLog(action="admin.settings_updated", actor_user_id=1, created_at=yesterday),
        AuditLog(action="auth.login_success", actor_user_id=1, created_at=now - timedelta(days=20)),
    ])
    db.commit()

    result = audit_summary(None, db, days=14)  # type: ignore[arg-type]

    assert len(result.days) == 14
    today, previous = result.days[-1], result.days[-2]
    assert today.date == now.date().isoformat()
    assert (today.signed_in, today.failed) == (2, 1)
    assert (previous.signed_in, previous.failed) == (0, 2)
    assert result.failed_total == 3
    assert result.total == 6
    assert [(a.action, a.count) for a in result.by_action][:1] == [("auth.login_success", 2)]
    assert [(u.username, u.count) for u in result.by_actor] == [("alice", 2), ("bob", 2)]


def test_observation_summary_counts_changes_per_day_by_type():
    db = _session()
    now = datetime.now(timezone.utc)
    schedule = DiscoverySchedule(owner_user_id=1, name="LAN", target="10.0.0.0/24", scan_type="ping", interval_minutes=60,
                                 confirm_large_scan=True, enabled=True, created_at=now, updated_at=now)
    db.add(schedule)
    db.flush()

    def obs(kind: str, when: datetime, status: str = "open") -> DiscoveryObservation:
        return DiscoveryObservation(schedule_id=schedule.id, observation_type=kind, status=status, summary=kind,
                                    details_json="{}", first_seen_at=when, last_seen_at=when)

    db.add_all([
        obs("new_device", now), obs("new_device", now), obs("ip_change", now, "resolved"),
        obs("disappeared", now - timedelta(days=2)), obs("field_change", now - timedelta(days=2)),
        obs("new_device", now - timedelta(days=30)),
    ])
    db.commit()

    result = observation_summary(None, db, days=14)  # type: ignore[arg-type]

    assert len(result.days) == 14
    today, two_ago = result.days[-1], result.days[-3]
    assert (today.new_device, today.ip_change, today.disappeared, today.other) == (2, 1, 0, 0)
    assert (two_ago.disappeared, two_ago.other) == (1, 1)
    assert (result.open, result.resolved) == (5, 1)

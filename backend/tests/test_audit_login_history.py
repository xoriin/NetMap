from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.audit import list_audit_logs
from app.db.session import Base
from app.models import device, site, snmp_profile, topology_group  # noqa: F401  (mapper config)
from app.models.audit_log import AuditLog


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[AuditLog.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_login_category_filter_excludes_non_login_actions():
    db = _session()
    now = datetime.now(timezone.utc)
    db.add_all([
        AuditLog(action="auth.login_success", actor_user_id=1, target="user:alice", detail="ip=10.0.0.1", created_at=now),
        AuditLog(action="auth.login_failed", target="user:bob", detail="ip=10.0.0.2", created_at=now - timedelta(minutes=1)),
        AuditLog(action="auth.logout", actor_user_id=1, target="user:alice", detail="ip=10.0.0.1", created_at=now - timedelta(minutes=2)),
        AuditLog(action="auth.profile_updated", actor_user_id=1, target="user:alice", created_at=now - timedelta(minutes=3)),
        AuditLog(action="ipam.reservation_created", actor_user_id=1, created_at=now - timedelta(minutes=4)),
    ])
    db.commit()

    result = list_audit_logs(None, db, limit=100, offset=0, actor_user_id=None, category="login")  # type: ignore[arg-type]
    assert result.total == 3
    assert {r.action for r in result.records} == {"auth.login_success", "auth.login_failed", "auth.logout"}

    result_all = list_audit_logs(None, db, limit=100, offset=0, actor_user_id=None, category=None)  # type: ignore[arg-type]
    assert result_all.total == 5


def test_login_category_filter_combines_with_actor_filter():
    db = _session()
    now = datetime.now(timezone.utc)
    db.add_all([
        AuditLog(action="auth.login_success", actor_user_id=1, created_at=now),
        AuditLog(action="auth.login_success", actor_user_id=2, created_at=now - timedelta(minutes=1)),
    ])
    db.commit()

    result = list_audit_logs(None, db, limit=100, offset=0, actor_user_id=1, category="login")  # type: ignore[arg-type]
    assert result.total == 1
    assert result.records[0].actor_user_id == 1

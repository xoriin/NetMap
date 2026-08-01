from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1 import exports
from app.db.session import Base
from app.models import site, topology_group  # noqa: F401  (device mapper relationships)
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.user import User


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[User.__table__, Device.__table__, AuditLog.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_export_summary_reports_real_rows_activity_and_last_export(monkeypatch):
    db = _session()
    user = User(id=1, username="admin", password_hash="x", role="SuperAdmin")
    db.add(user)
    db.add_all([
        Device(hostname="router", ip_address="10.0.0.1"),
        Device(hostname="switch", ip_address="10.0.0.2"),
    ])
    now = datetime.now(timezone.utc)
    db.add_all([
        AuditLog(action="export.inventory", actor_user_id=1, detail="format=csv", created_at=now),
        AuditLog(action="export.firewall", actor_user_id=1, detail="format=json rows=42", created_at=now - timedelta(days=2)),
        AuditLog(action="export.report_pdf", actor_user_id=1, created_at=now - timedelta(days=40)),
        AuditLog(action="export.inventory", actor_user_id=2, created_at=now - timedelta(days=1)),
    ])
    db.commit()
    monkeypatch.setattr(exports, "count_events", lambda: 731)

    result = exports.export_summary(user, db)

    assert result.inventory_rows == 2
    assert result.firewall_events == 731
    assert result.exports_last_30_days == 2
    assert result.last_export_type == "Inventory"
    assert result.last_export_detail == "format=csv"
    assert result.last_export_at == now


def test_export_summary_hides_restricted_dataset_counts(monkeypatch):
    db = _session()
    viewer = User(id=2, username="viewer", password_hash="x", role="Viewer")
    db.add(viewer)
    db.commit()
    monkeypatch.setattr(exports, "count_events", lambda: 999)

    result = exports.export_summary(viewer, db)

    assert result.inventory_rows is None
    assert result.firewall_events is None
    assert result.exports_last_30_days == 0
    assert result.last_export_at is None

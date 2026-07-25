from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import retention as retention_module
from app.db.retention import delete_rows_before
from app.db.session import Base
from app.models import device, site, snmp_profile, topology_group  # noqa: F401  (mapper config)
from app.models.monitor import Monitor, MonitorCheckHistory


def _factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Monitor.__table__, MonitorCheckHistory.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def _seed(factory, now, old_count, fresh_count):
    with factory() as db:
        db.add(Monitor(id=1, name="m", url="https://example.com"))
        for i in range(old_count):
            db.add(MonitorCheckHistory(
                monitor_id=1, checked_at=now - timedelta(days=40, seconds=i), status="online",
            ))
        for i in range(fresh_count):
            db.add(MonitorCheckHistory(
                monitor_id=1, checked_at=now - timedelta(hours=1, seconds=i), status="online",
            ))
        db.commit()


def test_delete_rows_before_removes_only_rows_older_than_cutoff(monkeypatch):
    factory = _factory()
    monkeypatch.setattr(retention_module, "SessionLocal", factory)
    now = datetime.now(timezone.utc)
    _seed(factory, now, old_count=25, fresh_count=7)

    deleted = delete_rows_before(
        "monitor_check_history", "checked_at", now - timedelta(days=30), batch_size=4,
    )

    assert deleted == 25
    with factory() as db:
        assert db.query(MonitorCheckHistory).count() == 7


def test_delete_rows_before_commits_each_batch(monkeypatch):
    """Each batch must land in its own transaction so the write lock is released."""
    factory = _factory()
    monkeypatch.setattr(retention_module, "SessionLocal", factory)
    now = datetime.now(timezone.utc)
    _seed(factory, now, old_count=10, fresh_count=0)

    sessions_opened = {"count": 0}
    original = factory

    def counting_factory():
        sessions_opened["count"] += 1
        return original()

    monkeypatch.setattr(retention_module, "SessionLocal", counting_factory)

    delete_rows_before("monitor_check_history", "checked_at", now - timedelta(days=30), batch_size=3)

    # 10 rows at 3 per batch: 4 batches, the last one short and ending the loop.
    assert sessions_opened["count"] == 4


def test_delete_rows_before_stops_at_max_rows(monkeypatch):
    factory = _factory()
    monkeypatch.setattr(retention_module, "SessionLocal", factory)
    now = datetime.now(timezone.utc)
    _seed(factory, now, old_count=20, fresh_count=0)

    deleted = delete_rows_before(
        "monitor_check_history", "checked_at", now - timedelta(days=30),
        batch_size=5, max_rows=10,
    )

    assert deleted == 10
    with factory() as db:
        assert db.query(MonitorCheckHistory).count() == 10


def test_delete_rows_before_rejects_non_identifier_arguments():
    with pytest.raises(ValueError):
        delete_rows_before("monitor_check_history; DROP TABLE monitors", "checked_at", datetime.now(timezone.utc))
    with pytest.raises(ValueError):
        delete_rows_before("monitor_check_history", "checked_at) --", datetime.now(timezone.utc))


def test_cutoff_matches_stored_timestamp_format(monkeypatch):
    """Comparison is textual, so the cutoff must not be ISO-with-offset."""
    factory = _factory()
    monkeypatch.setattr(retention_module, "SessionLocal", factory)
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=30)

    with factory() as db:
        db.add(Monitor(id=1, name="m", url="https://example.com"))
        db.add(MonitorCheckHistory(monitor_id=1, checked_at=cutoff - timedelta(seconds=1), status="online"))
        db.add(MonitorCheckHistory(monitor_id=1, checked_at=cutoff + timedelta(seconds=1), status="online"))
        db.commit()
        stored = db.execute(text("SELECT checked_at FROM monitor_check_history ORDER BY id LIMIT 1")).scalar_one()

    assert "T" not in str(stored) and "+" not in str(stored)

    assert delete_rows_before("monitor_check_history", "checked_at", cutoff) == 1
    with factory() as db:
        assert db.query(MonitorCheckHistory).count() == 1

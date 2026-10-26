from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base
from app.models.auth_session import LoginThrottleState
from app.models.site import Site  # noqa: F401 - imported so Device relationships resolve
from app.models.topology_group import TopologyGroup  # noqa: F401
from app.services.auth import security
from app.services.auth.security import is_locked, record_login_failure

SUBJECT = ["user:alice"]
NOW = datetime(2026, 10, 26, 12, 0, 0, tzinfo=timezone.utc)
WINDOW = timedelta(minutes=15)


@pytest.fixture()
def db(monkeypatch):
    monkeypatch.setattr(security.settings, "auth_max_failed_attempts", 3)
    monkeypatch.setattr(security.settings, "auth_lockout_minutes", 15)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[LoginThrottleState.__table__])
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield session
    session.close()


def _seed(db, attempts, last_failed_at, locked_until=None):
    db.add(LoginThrottleState(subject=SUBJECT[0], failed_attempts=attempts, last_failed_at=last_failed_at, locked_until=locked_until, updated_at=last_failed_at))
    db.commit()


def test_lockout_still_applies_in_its_final_second(db):
    _seed(db, 3, NOW - WINDOW, locked_until=NOW + timedelta(milliseconds=400))
    assert is_locked(db, SUBJECT, now=NOW) == (True, 1)


def test_lockout_ends_exactly_at_locked_until(db):
    _seed(db, 3, NOW - WINDOW, locked_until=NOW)
    assert is_locked(db, SUBJECT, now=NOW) == (False, 0)


def test_failure_exactly_one_window_old_no_longer_counts(db):
    _seed(db, 2, NOW - WINDOW)
    assert record_login_failure(db, SUBJECT, now=NOW) == 1
    assert is_locked(db, SUBJECT, now=NOW)[0] is False


def test_failure_just_inside_the_window_still_counts(db):
    _seed(db, 2, NOW - WINDOW + timedelta(microseconds=1))
    assert record_login_failure(db, SUBJECT, now=NOW) == 3
    assert is_locked(db, SUBJECT, now=NOW) == (True, 15 * 60)


def test_failure_while_locked_keeps_the_count_and_the_lock(db):
    _seed(db, 3, NOW - timedelta(minutes=5), locked_until=NOW + timedelta(minutes=10))
    assert record_login_failure(db, SUBJECT, now=NOW) == 4
    db.commit()
    db.expire_all()
    state = db.query(LoginThrottleState).one()
    assert state.failed_attempts == 4
    assert is_locked(db, SUBJECT, now=NOW)[0] is True


def test_failure_after_the_lock_expired_starts_a_fresh_count(db):
    _seed(db, 3, NOW - timedelta(minutes=14), locked_until=NOW - timedelta(seconds=1))
    assert record_login_failure(db, SUBJECT, now=NOW) == 1
    assert is_locked(db, SUBJECT, now=NOW) == (False, 0)

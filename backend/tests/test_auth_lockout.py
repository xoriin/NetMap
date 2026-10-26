from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base
from app.models.auth_session import LoginThrottleState
from app.models.site import Site  # noqa: F401 - imported so Device relationships resolve in tests
from app.models.topology_group import TopologyGroup  # noqa: F401
from app.services.auth.security import clear_user_login_lockout, is_locked, record_login_failure


def _session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine, tables=[LoginThrottleState.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_clear_user_login_lockout_resets_username_throttle_state():
    db = _session()
    locked_until = datetime.now(timezone.utc) + timedelta(minutes=40)
    db.add(
        LoginThrottleState(
            subject="user:admin",
            failed_attempts=5,
            last_failed_at=datetime.now(timezone.utc),
            locked_until=locked_until,
        )
    )
    db.commit()

    locked, _wait = is_locked(db, ["user:admin"])
    assert locked is True

    assert clear_user_login_lockout(db, "Admin") is True

    locked, wait = is_locked(db, ["user:admin"])
    assert locked is False
    assert wait == 0
    state = db.query(LoginThrottleState).filter_by(subject="user:admin").one()
    assert state.failed_attempts == 0
    assert state.last_failed_at is None
    assert state.locked_until is None


def test_clear_user_login_lockout_returns_false_when_no_state_exists():
    db = _session()

    assert clear_user_login_lockout(db, "missing") is False


def test_ip_throttle_uses_shared_nat_safe_threshold(monkeypatch):
    from app.services.auth import security

    db = _session()
    monkeypatch.setattr(security.settings, "auth_max_failed_attempts", 2)
    monkeypatch.setattr(security.settings, "auth_ip_max_failed_attempts", 4)

    record_login_failure(db, ["user:alice", "ip:192.0.2.10"])
    db.commit()
    record_login_failure(db, ["user:alice", "ip:192.0.2.10"])
    db.commit()

    assert is_locked(db, ["user:alice"])[0] is True
    assert is_locked(db, ["ip:192.0.2.10"])[0] is False


def test_reset_rate_limit_allows_a_full_quota_again_after_the_lockout_expires():
    from app.services.auth.security import _check_reset_rate_limit

    db = _session()
    assert [_check_reset_rate_limit(db, "192.0.2.10") for _ in range(6)] == [False] * 5 + [True]

    state = db.query(LoginThrottleState).filter_by(subject="reset:ip:192.0.2.10").one()
    two_hours_ago = datetime.now(timezone.utc) - timedelta(hours=2)
    state.locked_until = two_hours_ago
    state.last_failed_at = two_hours_ago
    db.commit()

    assert [_check_reset_rate_limit(db, "192.0.2.10") for _ in range(6)] == [False] * 5 + [True]


def test_failures_older_than_the_lockout_window_do_not_count(monkeypatch):
    from app.services.auth import security

    db = _session()
    monkeypatch.setattr(security.settings, "auth_max_failed_attempts", 5)
    monkeypatch.setattr(security.settings, "auth_lockout_minutes", 15)
    old = datetime.now(timezone.utc) - timedelta(minutes=16)
    # Four failures (one short of the limit) spread over a long time ago.
    db.add(LoginThrottleState(subject="user:slow-typo", failed_attempts=4, last_failed_at=old))
    db.commit()

    attempts = record_login_failure(db, ["user:slow-typo"])
    db.commit()

    assert attempts == 1
    assert is_locked(db, ["user:slow-typo"])[0] is False


def test_recent_failures_still_lock_the_account(monkeypatch):
    from app.services.auth import security

    db = _session()
    monkeypatch.setattr(security.settings, "auth_max_failed_attempts", 5)
    monkeypatch.setattr(security.settings, "auth_lockout_minutes", 15)
    recent = datetime.now(timezone.utc) - timedelta(minutes=5)
    db.add(LoginThrottleState(subject="user:guesser", failed_attempts=4, last_failed_at=recent))
    db.commit()

    attempts = record_login_failure(db, ["user:guesser"])
    db.commit()

    assert attempts == 5
    assert is_locked(db, ["user:guesser"])[0] is True


def test_expired_lockout_restarts_the_failure_count(monkeypatch):
    from app.services.auth import security

    db = _session()
    monkeypatch.setattr(security.settings, "auth_max_failed_attempts", 5)
    monkeypatch.setattr(security.settings, "auth_lockout_minutes", 15)
    now = datetime.now(timezone.utc)
    # SQLite hands back naive datetimes; they must be read as UTC.
    db.add(LoginThrottleState(
        subject="user:returning",
        failed_attempts=5,
        last_failed_at=(now - timedelta(minutes=16)).replace(tzinfo=None),
        locked_until=(now - timedelta(minutes=1)).replace(tzinfo=None),
    ))
    db.commit()

    attempts = record_login_failure(db, ["user:returning"])
    db.commit()

    assert attempts == 1
    assert is_locked(db, ["user:returning"])[0] is False

from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base
from app.models.auth_session import LoginThrottleState
from app.models.site import Site  # noqa: F401 - imported so Device relationships resolve in tests
from app.models.topology_group import TopologyGroup  # noqa: F401
from app.services.auth.security import clear_user_login_lockout, is_locked


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

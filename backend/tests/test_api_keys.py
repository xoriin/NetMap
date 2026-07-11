"""Service-layer tests for API key generation, verification, and lifecycle."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base
from app.core.security import hash_password
from app.models.api_key import ApiKey, ApiKeyThrottleState
from app.models.user import User, UserRole
from app.services.api_keys.service import (
    KEY_SCHEME,
    PREFIX_LEN,
    create_api_key,
    generate_api_key,
    list_keys_for_user,
    revoke_key,
    verify_and_load,
)
from app.services.api_keys.throttle import (
    check_and_record,
    clear_lookup_failures,
    is_lookup_locked,
    record_lookup_failure,
)


def _session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    from app.models import alert_rule, api_key, auth_session, audit_log, device, device_type, dhcp_lease, discovery, ip_reservation, monitor_history, notification_delivery, notification_profile, oidc, password_reset_token, port_target, relationship, saved_search, site, snmp_profile, subnet, system_setting, topology_group, topology_layout, user, user_device_favourite  # noqa: F401
    from app.models.audit_log import AuditLog

    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            AuditLog.__table__,
            ApiKey.__table__,
            ApiKeyThrottleState.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


@pytest.fixture()
def db():
    factory = _session_factory()
    session = factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def user(db):
    account = User(
        username="keyowner",
        password_hash=hash_password("Password123!"),
        role=UserRole.VIEWER,
        is_active=True,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def test_generate_api_key_format():
    full_key, prefix, key_hash = generate_api_key()
    assert full_key.startswith(f"{KEY_SCHEME}_")
    parts = full_key.split("_", 2)
    assert len(parts) == 3
    assert parts[1] == prefix
    assert len(prefix) == PREFIX_LEN
    assert len(parts[2]) >= 40
    assert prefix.isalnum()
    assert parts[2].isalnum()
    assert len(key_hash) == 64
    int(key_hash, 16)  # valid hex digest


def test_generated_prefixes_are_unique():
    prefixes = {generate_api_key()[1] for _ in range(200)}
    assert len(prefixes) == 200


def test_verify_valid_key(db, user):
    key, plaintext = create_api_key(db, user, name="ci", expires_in_days=None)
    db.commit()
    resolved = verify_and_load(db, plaintext)
    assert resolved is not None
    assert resolved.id == key.id
    assert resolved.user_id == user.id


def test_verify_rejects_tampered_secret(db, user):
    key, plaintext = create_api_key(db, user, name="ci", expires_in_days=None)
    db.commit()
    tampered = f"{KEY_SCHEME}_{key.prefix}_" + "A" * 43
    assert verify_and_load(db, tampered) is None


def test_verify_rejects_unknown_prefix(db, user):
    _, plaintext = create_api_key(db, user, name="ci", expires_in_days=None)
    db.commit()
    parts = plaintext.split("_", 2)
    unknown = f"{KEY_SCHEME}_{'x' * PREFIX_LEN}_{parts[2]}"
    assert verify_and_load(db, unknown) is None


def test_verify_rejects_malformed_values(db):
    assert verify_and_load(db, "") is None
    assert verify_and_load(db, "nonsense") is None
    assert verify_and_load(db, "nm_onlyprefix") is None
    assert verify_and_load(db, "other_abc_def") is None


def test_expired_key_is_rejected(db, user):
    key, plaintext = create_api_key(db, user, name="ci", expires_in_days=30)
    key.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.commit()
    assert verify_and_load(db, plaintext) is None


def test_future_expiry_and_no_expiry_are_accepted(db, user):
    _, expiring = create_api_key(db, user, name="expiring", expires_in_days=30)
    _, permanent = create_api_key(db, user, name="permanent", expires_in_days=None)
    db.commit()
    assert verify_and_load(db, expiring) is not None
    assert verify_and_load(db, permanent) is not None


def test_revoked_key_is_rejected(db, user):
    key, plaintext = create_api_key(db, user, name="ci", expires_in_days=None)
    db.commit()
    revoke_key(db, key, reason="revoked by owner")
    db.commit()
    assert verify_and_load(db, plaintext) is None
    assert key.revoked_reason == "revoked by owner"


def test_plaintext_is_never_persisted(db, user):
    key, plaintext = create_api_key(db, user, name="ci", expires_in_days=None)
    db.commit()
    assert key.key_hash != plaintext
    secret_part = plaintext.split("_", 2)[2]
    for row in db.execute(text("SELECT * FROM api_keys")).mappings():
        for value in row.values():
            if isinstance(value, str):
                assert plaintext not in value
                assert secret_part not in value


def test_list_keys_for_user_scoped_to_owner(db, user):
    other = User(
        username="other",
        password_hash=hash_password("Password123!"),
        role=UserRole.VIEWER,
        is_active=True,
    )
    db.add(other)
    db.commit()
    create_api_key(db, user, name="mine", expires_in_days=None)
    create_api_key(db, other, name="theirs", expires_in_days=None)
    db.commit()
    names = [key.name for key in list_keys_for_user(db, user.id)]
    assert names == ["mine"]


def test_rate_limit_window(db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "api_key_rate_limit_max_calls", 3)
    monkeypatch.setattr(settings, "api_key_rate_limit_window_seconds", 60)
    for _ in range(3):
        assert check_and_record(db, api_key_id=1) is True
    assert check_and_record(db, api_key_id=1) is False

    # Roll the window back so the next call starts a fresh window.
    state = db.scalar(select(ApiKeyThrottleState).where(ApiKeyThrottleState.subject == "apikey:1:calls"))
    state.window_started_at = datetime.now(timezone.utc) - timedelta(seconds=61)
    db.commit()
    assert check_and_record(db, api_key_id=1) is True


def test_failed_lookup_lockout(db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "api_key_max_failed_lookups", 3)
    monkeypatch.setattr(settings, "api_key_lookup_lockout_minutes", 15)
    assert is_lookup_locked(db, "10.0.0.9") is False
    assert record_lookup_failure(db, "10.0.0.9") is False
    assert record_lookup_failure(db, "10.0.0.9") is False
    assert record_lookup_failure(db, "10.0.0.9") is True  # crosses the threshold
    assert is_lookup_locked(db, "10.0.0.9") is True

    clear_lookup_failures(db, "10.0.0.9")
    assert is_lookup_locked(db, "10.0.0.9") is False


def test_lookup_failure_without_ip_is_noop(db):
    assert record_lookup_failure(db, None) is False
    assert is_lookup_locked(db, None) is False

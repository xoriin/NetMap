import uuid

import pyotp
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base, import_all_models
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.services import totp

NOW = 1_800_000_000.0


@pytest.fixture()
def db():
    import_all_models()

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[User.__table__, SystemSetting.__table__])
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield session
    session.close()


def _user(db, role="Viewer"):
    user = User(username=f"user-{uuid.uuid4().hex[:8]}", password_hash="x", role=role, is_active=True)
    db.add(user)
    db.commit()
    return user


def _code(secret, at):
    return pyotp.TOTP(secret).at(at)


def _enrolled(db, role="Viewer"):
    user = _user(db, role)
    secret, _uri = totp.begin_enrolment(db, user)
    codes = totp.confirm_enrolment(db, user, _code(secret, NOW), now=NOW)
    return user, secret, codes


def test_enrolment_stores_an_encrypted_secret_and_only_enables_after_confirmation(db):
    user = _user(db)
    secret, uri = totp.begin_enrolment(db, user)

    assert user.totp_secret and secret not in user.totp_secret
    assert user.totp_enabled is False
    assert uri.startswith("otpauth://totp/") and "issuer=NetMap" in uri and user.username in uri

    assert totp.confirm_enrolment(db, user, "000000", now=NOW) is None
    assert user.totp_enabled is False

    codes = totp.confirm_enrolment(db, user, _code(secret, NOW), now=NOW)
    assert user.totp_enabled is True
    assert len(codes) == 10 and all(len(c) == 11 and c[5] == "-" for c in codes)
    assert user.recovery_codes_remaining == 10
    assert all(c.replace("-", "") not in user.totp_recovery_codes for c in codes)


def test_begin_enrolment_twice_replaces_the_pending_secret(db):
    user = _user(db)
    first, _ = totp.begin_enrolment(db, user)
    second, _ = totp.begin_enrolment(db, user)
    assert first != second
    assert totp.confirm_enrolment(db, user, _code(first, NOW), now=NOW) is None
    assert totp.confirm_enrolment(db, user, _code(second, NOW), now=NOW) is not None


def test_issuer_uses_the_application_name(db):
    db.add(SystemSetting(key="app_name", value="Acme Map"))
    db.commit()
    _secret, uri = totp.begin_enrolment(db, _user(db))
    assert "issuer=Acme%20Map" in uri


def test_codes_within_one_step_are_accepted_and_two_steps_are_not(db):
    user, secret, _ = _enrolled(db)
    later = NOW + 300
    assert totp.verify(db, user, _code(secret, later - 30), now=later) == "totp"
    assert totp.verify(db, user, _code(secret, later + 30), now=later) == "totp"
    assert totp.verify(db, user, _code(secret, later + 400), now=later) is None
    user2, secret2, _ = _enrolled(db)
    later2 = NOW + 600
    assert totp.verify(db, user2, _code(secret2, later2 - 60), now=later2) is None
    assert totp.verify(db, user2, _code(secret2, later2 + 60), now=later2) is None


def test_a_code_cannot_be_replayed(db):
    user, secret, _ = _enrolled(db)
    later = NOW + 300
    code = _code(secret, later)
    assert totp.verify(db, user, code, now=later) == "totp"
    assert totp.verify(db, user, code, now=later) is None


def test_codes_with_spaces_are_accepted(db):
    user, secret, _ = _enrolled(db)
    later = NOW + 300
    code = _code(secret, later)
    assert totp.verify(db, user, f"{code[:3]} {code[3:]}", now=later) == "totp"


def test_unicode_digits_are_rejected(db):
    user, secret, _ = _enrolled(db)
    later = NOW + 300
    assert totp.verify(db, user, "²²²²²²", now=later) is None


def test_recovery_codes_are_single_use_and_format_tolerant(db):
    user, _secret, codes = _enrolled(db)
    assert totp.verify(db, user, codes[0].lower().replace("-", ""), now=NOW + 300) == "recovery"
    assert user.recovery_codes_remaining == 9
    assert totp.verify(db, user, codes[0], now=NOW + 600) is None


def test_regenerate_replaces_all_recovery_codes(db):
    user, _secret, old = _enrolled(db)
    new = totp.regenerate_recovery_codes(db, user)
    assert set(new).isdisjoint(old)
    assert totp.verify(db, user, old[1], now=NOW + 300) is None
    assert totp.verify(db, user, new[1], now=NOW + 300) == "recovery"


def test_disable_clears_everything(db):
    user, _secret, _codes = _enrolled(db)
    totp.disable(db, user)
    assert (user.totp_secret, user.totp_enabled_at, user.totp_last_step, user.totp_recovery_codes) == (None, None, None, None)


def test_verify_without_enrolment_is_rejected(db):
    assert totp.verify(db, _user(db), "123456", now=NOW) is None


@pytest.mark.parametrize(
    ("setting", "role", "required"),
    [
        (None, "SuperAdmin", False),
        ("off", "SuperAdmin", False),
        ("admins", "SuperAdmin", True),
        ("admins", "NetworkAdmin", True),
        ("admins", "Viewer", False),
        ("all", "Viewer", True),
        ("all", "SecurityAnalyst", True),
    ],
)
def test_requirement_policy(db, setting, role, required):
    if setting:
        db.add(SystemSetting(key="totp_required", value=setting))
        db.commit()
    assert totp.is_required_for(db, _user(db, role)) is required

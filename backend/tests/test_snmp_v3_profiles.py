"""SNMPv3 profiles: validation, encryption at rest, no secrets in responses, migration 0095."""

import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import require_snmp_profile_manage
from app.api.v1.tools import create_snmp_profile, list_snmp_profiles, router, update_snmp_profile
from app.core.secrets import decrypt_secret
import app.models  # noqa: F401  (register mappers)
import app.models.site  # noqa: F401
import app.models.topology_group  # noqa: F401
from app.db.session import Base, _live_columns, _migrate_snmp_v3_profiles
from app.models.audit_log import AuditLog
from app.models.snmp_profile import SnmpProfile
from app.models.user import User, UserRole
from app.schemas.tools import SnmpProfileCreate, SnmpProfileUpdate
from app.services.snmp import SnmpV3Credentials
from app.services.snmp_profiles import profile_credentials

AUTH_KEY = "auth-secret-123"
PRIV_KEY = "priv-secret-456"


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[User.__table__, AuditLog.__table__, SnmpProfile.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def _admin(db):
    admin = User(username="admin", password_hash="x", role=UserRole.SUPER_ADMIN.value)
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return admin


def _create(db, admin, **fields):
    payload = {"name": "core", **fields}
    return create_snmp_profile(SnmpProfileCreate(**payload), admin, db)


def _v3(**overrides):
    fields = {
        "version": "v3",
        "username": "netmap",
        "security_level": "authPriv",
        "auth_protocol": "SHA-256",
        "auth_key": AUTH_KEY,
        "priv_protocol": "AES",
        "priv_key": PRIV_KEY,
    }
    fields.update(overrides)
    return fields


def _no_secrets(read) -> None:
    dumped = json.dumps(read.model_dump(mode="json"))
    for secret in (AUTH_KEY, PRIV_KEY, "public-ish"):
        assert secret not in dumped
    assert "auth_key" not in read.model_dump()
    assert "priv_key" not in read.model_dump()


def test_v2c_profile_is_unchanged():
    db = _session()
    admin = _admin(db)
    read = _create(db, admin, community="public-ish")
    assert read.version == "v2c"
    assert read.has_community is True
    assert (read.has_auth_key, read.has_priv_key, read.username) == (False, False, None)
    _no_secrets(read)
    profile = db.get(SnmpProfile, read.id)
    assert profile_credentials(profile) == "public-ish"


def test_v3_auth_priv_keys_are_encrypted_and_never_returned():
    db = _session()
    admin = _admin(db)
    read = _create(db, admin, **_v3(context_name="vlan10"))
    assert read.version == "v3"
    assert (read.has_community, read.has_auth_key, read.has_priv_key) == (False, True, True)
    assert (read.username, read.security_level, read.auth_protocol, read.priv_protocol, read.context_name) == (
        "netmap", "authPriv", "SHA-256", "AES", "vlan10",
    )
    _no_secrets(read)
    _no_secrets(list_snmp_profiles(admin, db)[0])

    profile = db.get(SnmpProfile, read.id)
    raw = db.execute(text("SELECT auth_key_encrypted, priv_key_encrypted, community_encrypted FROM snmp_profiles")).one()
    assert AUTH_KEY not in raw[0] and PRIV_KEY not in raw[1]
    assert decrypt_secret(raw[0]) == AUTH_KEY and decrypt_secret(raw[1]) == PRIV_KEY
    assert raw[2] == ""
    credentials = profile_credentials(profile)
    assert isinstance(credentials, SnmpV3Credentials)
    assert (credentials.auth_key, credentials.priv_key, credentials.context_name) == (AUTH_KEY, PRIV_KEY, "vlan10")
    assert AUTH_KEY not in repr(credentials) and PRIV_KEY not in repr(credentials)

    audit = " ".join(row.detail or "" for row in db.query(AuditLog).all())
    assert AUTH_KEY not in audit and PRIV_KEY not in audit


def test_v3_no_auth_profile():
    db = _session()
    admin = _admin(db)
    read = _create(db, admin, version="v3", username="reader", security_level="noAuthNoPriv")
    assert (read.has_auth_key, read.has_priv_key, read.auth_protocol) == (False, False, None)


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        (_v3(username=None), "Username is required"),
        (_v3(security_level=None), "Security level is required"),
        (_v3(auth_key=None), "Authentication protocol and key are required"),
        (_v3(auth_protocol=None), "Authentication protocol and key are required"),
        (_v3(priv_key=None), "Privacy protocol and key are required"),
        (_v3(security_level="authNoPriv"), "Privacy protocol and key are not used with authNoPriv"),
        (_v3(security_level="noAuthNoPriv", priv_protocol=None, priv_key=None), "Authentication protocol and key are not used"),
        (_v3(community="public"), "Community is only valid for SNMP v2c"),
        ({"version": "v2c"}, "Community is required"),
        ({"community": "public", "username": "x"}, "SNMPv3 fields are only valid for v3"),
    ],
)
def test_invalid_combinations_are_422(fields, message):
    db = _session()
    admin = _admin(db)
    with pytest.raises(HTTPException) as caught:
        _create(db, admin, **fields)
    assert caught.value.status_code == 422
    assert message in caught.value.detail
    assert db.query(SnmpProfile).count() == 0


@pytest.mark.parametrize("field", ["auth_key", "priv_key"])
def test_keys_shorter_than_eight_characters_are_rejected(field):
    with pytest.raises(ValidationError):
        SnmpProfileCreate(name="x", **_v3(**{field: "short7!"}))


def test_unknown_protocols_are_rejected():
    with pytest.raises(ValidationError):
        SnmpProfileCreate(name="x", **_v3(auth_protocol="SHA-1024"))
    with pytest.raises(ValidationError):
        SnmpProfileCreate(name="x", **_v3(priv_protocol="3DES"))


def test_blank_keys_on_update_keep_the_stored_keys():
    db = _session()
    admin = _admin(db)
    read = _create(db, admin, **_v3())
    before = db.execute(text("SELECT auth_key_encrypted, priv_key_encrypted FROM snmp_profiles")).one()
    updated = update_snmp_profile(
        read.id, SnmpProfileUpdate(auth_key="", priv_key="", auth_protocol="SHA-512", name="core2"), admin, db,
    )
    after = db.execute(text("SELECT auth_key_encrypted, priv_key_encrypted FROM snmp_profiles")).one()
    assert tuple(after) == tuple(before)
    assert (updated.name, updated.auth_protocol, updated.has_auth_key, updated.has_priv_key) == ("core2", "SHA-512", True, True)
    _no_secrets(updated)


def test_update_replaces_a_key_when_one_is_sent():
    db = _session()
    admin = _admin(db)
    read = _create(db, admin, **_v3())
    update_snmp_profile(read.id, SnmpProfileUpdate(priv_key="another-priv-9"), admin, db)
    credentials = profile_credentials(db.get(SnmpProfile, read.id))
    assert credentials.priv_key == "another-priv-9" and credentials.auth_key == AUTH_KEY


def test_lowering_the_security_level_clears_unused_keys():
    db = _session()
    admin = _admin(db)
    read = _create(db, admin, **_v3())
    updated = update_snmp_profile(read.id, SnmpProfileUpdate(security_level="authNoPriv"), admin, db)
    assert (updated.priv_protocol, updated.has_priv_key, updated.has_auth_key) == (None, False, True)


def test_update_rejects_fields_that_do_not_match_the_level():
    db = _session()
    admin = _admin(db)
    read = _create(db, admin, **_v3(security_level="authNoPriv", priv_protocol=None, priv_key=None))
    with pytest.raises(HTTPException) as caught:
        update_snmp_profile(read.id, SnmpProfileUpdate(priv_key="new-priv-key"), admin, db)
    assert caught.value.status_code == 422
    with pytest.raises(HTTPException) as caught:
        update_snmp_profile(read.id, SnmpProfileUpdate(security_level="authPriv"), admin, db)
    assert caught.value.status_code == 422


def test_switching_versions_both_ways():
    db = _session()
    admin = _admin(db)
    read = _create(db, admin, community="public-ish")
    with pytest.raises(HTTPException):
        update_snmp_profile(read.id, SnmpProfileUpdate(version="v3"), admin, db)
    v3 = update_snmp_profile(read.id, SnmpProfileUpdate(**_v3()), admin, db)
    assert (v3.version, v3.has_community, v3.has_auth_key) == ("v3", False, True)
    with pytest.raises(HTTPException) as caught:
        update_snmp_profile(read.id, SnmpProfileUpdate(version="v2c"), admin, db)
    assert "Community is required" in caught.value.detail
    back = update_snmp_profile(read.id, SnmpProfileUpdate(version="v2c", community="new-community"), admin, db)
    assert (back.version, back.has_community, back.has_auth_key, back.username) == ("v2c", True, False, None)
    profile = db.get(SnmpProfile, read.id)
    assert profile.auth_key_encrypted is None and profile.priv_key_encrypted is None
    assert profile_credentials(profile) == "new-community"


def test_profile_routes_require_the_manage_permission():
    for route in router.routes:
        if "/snmp/profiles" not in route.path:
            continue
        calls = {dependency.call for dependency in route.dependant.dependencies}
        assert require_snmp_profile_manage in calls, route.path


def test_0095_adds_columns_keeps_v2c_rows_and_is_idempotent():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE snmp_profiles (id INTEGER PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE, "
            "version VARCHAR(16) NOT NULL DEFAULT 'v2c', community_encrypted TEXT NOT NULL, port INTEGER NOT NULL, "
            "timeout_seconds INTEGER NOT NULL, retries INTEGER NOT NULL, created_at DATETIME NOT NULL, "
            "updated_at DATETIME NOT NULL)"
        ))
        conn.execute(text(
            "INSERT INTO snmp_profiles (name, version, community_encrypted, port, timeout_seconds, retries, created_at, updated_at) "
            "VALUES ('legacy', 'v2c', 'gAAAA-encrypted', 161, 3, 1, '2026-01-01', '2026-01-01')"
        ))
        _migrate_snmp_v3_profiles(conn, None)
        columns = _live_columns(conn, "snmp_profiles")
        _migrate_snmp_v3_profiles(conn, None)
        row = conn.execute(text(
            "SELECT name, version, community_encrypted, port, username, security_level, auth_key_encrypted FROM snmp_profiles"
        )).one()
    assert {"username", "security_level", "auth_protocol", "auth_key_encrypted", "priv_protocol",
            "priv_key_encrypted", "context_name"} <= columns
    assert tuple(row) == ("legacy", "v2c", "gAAAA-encrypted", 161, None, None, None)


def test_0095_on_a_fresh_schema_and_without_the_table():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as conn:
        _migrate_snmp_v3_profiles(conn, None)  # no table yet: nothing to do
    Base.metadata.create_all(engine, tables=[SnmpProfile.__table__])
    with engine.begin() as conn:
        before = _live_columns(conn, "snmp_profiles")
        _migrate_snmp_v3_profiles(conn, None)
        assert _live_columns(conn, "snmp_profiles") == before

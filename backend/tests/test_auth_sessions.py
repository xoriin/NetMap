"""Per-device sessions (sid claim): single-device sign-out, and a replayed
rotated refresh token ends the whole family."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import StaticPool

from app.core.security import create_access_token, create_refresh_token, decode_token
from app.db import session as db_session
from app.models.audit_log import AuditLog
from app.models.auth_session import AuthSession, RefreshTokenState
from app.services.auth import register_refresh_token
from tests.test_session_version import _cookie, _login, _me, _user
from tests.test_session_version import client_and_db as client_and_db_fixture

client_and_db = client_and_db_fixture


def _refresh(client, token):
    return client.post("/api/v1/auth/refresh", json={"refresh_token": token})


def _age_rotation(db, seconds=60):
    db.expire_all()
    for row in db.query(RefreshTokenState).filter(RefreshTokenState.revoked_reason == "rotated"):
        row.revoked_at = datetime.now(timezone.utc) - timedelta(seconds=seconds)
    db.commit()


def test_tokens_carry_one_session_per_sign_in(client_and_db):
    client, db = client_and_db
    _user(db)
    access, refresh = _login(client)
    sid = decode_token(access, "access")["sid"]
    assert decode_token(refresh, "refresh")["sid"] == sid
    assert db.get(AuthSession, sid).revoked_at is None
    rotated = _refresh(client, refresh)
    assert decode_token(rotated.json()["access_token"], "access")["sid"] == sid
    assert decode_token(_cookie(rotated, "netmap_refresh"), "refresh")["sid"] == sid


def test_logout_ends_only_this_device(client_and_db):
    client, db = client_and_db
    _user(db)
    access_a, refresh_a = _login(client)
    access_b, refresh_b = _login(client)
    assert client.post("/api/v1/auth/logout", json={"refresh_token": refresh_a}).status_code == 204
    assert _me(client, access_a) == 401
    assert _refresh(client, refresh_a).status_code == 401
    assert _me(client, access_b) == 200
    assert _refresh(client, refresh_b).status_code == 200


def test_replayed_rotated_refresh_token_ends_the_family(client_and_db):
    client, db = client_and_db
    _user(db)
    access_a, refresh_a = _login(client)
    access_b, _refresh_b = _login(client)
    rotated = _refresh(client, refresh_a)
    assert rotated.status_code == 200
    new_access, new_refresh = rotated.json()["access_token"], _cookie(rotated, "netmap_refresh")
    _age_rotation(db)
    assert _refresh(client, refresh_a).status_code == 401
    # The thief's and the victim's tokens from this sign-in all stop working.
    assert _me(client, access_a) == 401
    assert _me(client, new_access) == 401
    assert _refresh(client, new_refresh).status_code == 401
    # Other devices are untouched.
    assert _me(client, access_b) == 200
    db.expire_all()
    assert db.query(AuditLog).filter(AuditLog.action == "auth.refresh_replay_detected").count() == 1


def test_concurrent_refresh_inside_the_grace_period_does_not_end_the_session(client_and_db):
    client, db = client_and_db
    _user(db)
    _access, refresh = _login(client)
    first = _refresh(client, refresh)
    assert first.status_code == 200
    assert _refresh(client, refresh).status_code == 401
    assert _me(client, first.json()["access_token"]) == 200


def test_legacy_refresh_token_joins_a_new_session_and_replay_still_ends_it(client_and_db):
    client, db = client_and_db
    user = _user(db)
    legacy = create_refresh_token(user.id)
    register_refresh_token(db, user_id=user.id, refresh_token=legacy, client_ip=None)
    db.commit()
    rotated = _refresh(client, legacy)
    assert rotated.status_code == 200
    access = rotated.json()["access_token"]
    sid = decode_token(access, "access")["sid"]
    assert db.get(AuthSession, sid) is not None
    _age_rotation(db)
    assert _refresh(client, legacy).status_code == 401
    assert _me(client, access) == 401


def test_legacy_access_token_without_sid_is_accepted(client_and_db):
    client, db = client_and_db
    user = _user(db)
    assert _me(client, create_access_token(user.id, {"sv": 0})) == 200


@pytest.mark.parametrize("bad", ["", 5, None, "no-such-session"])
def test_unknown_or_malformed_sid_fails_closed(client_and_db, bad):
    client, db = client_and_db
    user = _user(db)
    assert _me(client, create_access_token(user.id, {"sv": 0, "sid": bad})) == 401


def test_another_users_session_id_is_refused(client_and_db):
    client, db = client_and_db
    _user(db)
    bob = _user(db, "bob")
    access, _ = _login(client)
    sid = decode_token(access, "access")["sid"]
    assert _me(client, create_access_token(bob.id, {"sv": 0, "sid": sid})) == 401


def test_logout_all_revokes_every_session_row(client_and_db):
    client, db = client_and_db
    _user(db)
    access, _ = _login(client)
    _login(client)
    assert client.post("/api/v1/auth/logout-all", headers={"Authorization": f"Bearer {access}"}).status_code == 204
    db.expire_all()
    assert all(row.revoked_reason == "logout_all" for row in db.query(AuthSession).all())


def test_websocket_session_check_follows_the_session(monkeypatch, client_and_db):
    from app.api.v1 import syslog
    from tests.oidc_helpers import memory_session_factory

    session_factory = memory_session_factory()
    monkeypatch.setattr(syslog, "SessionLocal", session_factory)
    db = session_factory()
    user = _user(db, "sec", "SecurityAnalyst")
    db.add(AuthSession(id="s1", user_id=user.id))
    db.commit()
    payload = decode_token(create_access_token(user.id, {"sv": 0, "sid": "s1"}), "access")
    assert syslog.websocket_session_still_valid(payload)
    db.get(AuthSession, "s1").revoked_at = datetime.now(timezone.utc)
    db.commit()
    assert not syslog.websocket_session_still_valid(payload)
    db.close()


def _engine():
    return create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)


def test_migration_0086_upgrades_existing_refresh_tokens_idempotently():
    engine = _engine()
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(80))"))
        conn.execute(text("CREATE TABLE refresh_token_state (id INTEGER PRIMARY KEY, user_id INTEGER, jti VARCHAR(80))"))
        conn.execute(text("INSERT INTO refresh_token_state (id, user_id, jti) VALUES (1, 1, 'old')"))
        db_session._migrate_auth_sessions(conn, None)
        db_session._migrate_auth_sessions(conn, None)
        assert conn.execute(text("SELECT jti, session_id FROM refresh_token_state")).one() == ("old", None)
        assert "auth_sessions" in db_session._live_tables(conn)


def test_migration_0086_fresh_install_and_rerun(monkeypatch):
    engine = _engine()
    monkeypatch.setattr(db_session, "engine", engine)
    db_session.init_db()
    db_session.init_db()
    inspector = inspect(engine)
    assert "session_id" in {c["name"] for c in inspector.get_columns("refresh_token_state")}
    assert "auth_sessions" in inspector.get_table_names()
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM schema_migrations WHERE name = '0086_auth_sessions'")).scalar_one() == 1

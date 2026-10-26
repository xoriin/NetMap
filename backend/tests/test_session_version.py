"""Session version (sv claim): signing out everywhere, credential and role
changes end every existing token at once; the current device is reissued."""
from http.cookies import SimpleCookie

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text

from app.api.v1 import auth as auth_api
from app.core.security import create_access_token, create_refresh_token, decode_token, hash_password
from app.db import session as db_session
from app.db.session import get_db
from app.models.auth_session import RefreshTokenState
from app.models.user import User
from app.services.auth import register_refresh_token, security
from tests.oidc_helpers import memory_session_factory

PASSWORD = "correct horse battery"


@pytest.fixture()
def client_and_db(monkeypatch):
    monkeypatch.setattr(auth_api, "apply_progressive_delay", lambda _attempts: None)
    monkeypatch.setattr(security.settings, "auth_max_failed_attempts", 5)
    session_factory = memory_session_factory()
    app = FastAPI()
    app.include_router(auth_api.router, prefix="/api/v1")

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    db = session_factory()
    try:
        yield TestClient(app, base_url="http://testserver"), db
    finally:
        db.close()


def _user(db, name="alice", role="Viewer"):
    user = User(username=name, email=f"{name}@example.com", password_hash=hash_password(PASSWORD), role=role, is_active=True)
    db.add(user)
    db.commit()
    return user


def _login(client, name="alice"):
    response = client.post("/api/v1/auth/login", json={"username": name, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.json()["access_token"], _cookie(response, "netmap_refresh")


def _me(client, access):
    return client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {access}"}).status_code


def _cookie(response, name):
    jar = SimpleCookie()
    for header in response.headers.get_list("set-cookie"):
        jar.load(header)
    return jar[name].value


def test_issued_tokens_carry_the_session_version(client_and_db):
    client, db = client_and_db
    _user(db)
    access, refresh = _login(client)
    assert decode_token(access, "access")["sv"] == 0
    assert decode_token(refresh, "refresh")["sv"] == 0


def test_tokens_without_sv_count_as_version_zero(client_and_db):
    client, db = client_and_db
    user = _user(db)
    legacy = create_access_token(user.id)
    assert "sv" not in decode_token(legacy, "access")
    assert _me(client, legacy) == 200
    user.token_version = 1
    db.commit()
    assert _me(client, legacy) == 401


@pytest.mark.parametrize("bad", ["0", None, True, 0.0, [0]])
def test_malformed_sv_fails_closed(client_and_db, bad):
    client, db = client_and_db
    user = _user(db)
    assert _me(client, create_access_token(user.id, {"sv": bad})) == 401


def test_legacy_refresh_token_still_refreshes(client_and_db):
    client, db = client_and_db
    user = _user(db)
    legacy_refresh = create_refresh_token(user.id)
    register_refresh_token(db, user_id=user.id, refresh_token=legacy_refresh, client_ip=None)
    db.commit()
    response = client.post("/api/v1/auth/refresh", json={"refresh_token": legacy_refresh})
    assert response.status_code == 200, response.text
    assert decode_token(response.json()["access_token"], "access")["sv"] == 0


def test_logout_all_ends_every_access_and_refresh_token(client_and_db):
    client, db = client_and_db
    _user(db)
    access_a, refresh_a = _login(client)
    access_b, refresh_b = _login(client)
    response = client.post("/api/v1/auth/logout-all", headers={"Authorization": f"Bearer {access_a}"})
    assert response.status_code == 204
    assert _me(client, access_a) == 401
    assert _me(client, access_b) == 401
    for refresh in (refresh_a, refresh_b):
        assert client.post("/api/v1/auth/refresh", json={"refresh_token": refresh}).status_code == 401
    db.expire_all()
    assert db.query(User).one().token_version == 1
    assert all(row.revoked_at is not None for row in db.query(RefreshTokenState).all())


def test_password_change_ends_other_sessions_and_reissues_this_device(client_and_db):
    client, db = client_and_db
    _user(db)
    access_a, _ = _login(client)
    access_b, refresh_b = _login(client)
    response = client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {access_a}"},
        json={"current_password": PASSWORD, "new_password": "another long password"},
    )
    assert response.status_code == 204, response.text
    assert _me(client, access_a) == 401
    assert _me(client, access_b) == 401
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": refresh_b}).status_code == 401
    fresh_access = _cookie(response, "netmap_access")
    fresh_refresh = _cookie(response, "netmap_refresh")
    assert decode_token(fresh_access, "access")["sv"] == 1
    assert _me(client, fresh_access) == 200
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": fresh_refresh}).status_code == 200


def test_admin_force_logout_ends_access_tokens_immediately(client_and_db):
    client, db = client_and_db
    _user(db, "root", "SuperAdmin")
    _user(db)
    admin_access, _ = _login(client, "root")
    victim_access, _ = _login(client)
    alice = db.query(User).filter_by(username="alice").one()
    response = client.delete(f"/api/v1/auth/users/{alice.id}/sessions", headers={"Authorization": f"Bearer {admin_access}"})
    assert response.status_code == 204, response.text
    assert _me(client, victim_access) == 401
    assert _me(client, admin_access) == 200


@pytest.mark.parametrize("change", [{"role": "Operator"}, {"is_active": False}])
def test_role_or_status_change_ends_sessions(client_and_db, change):
    client, db = client_and_db
    _user(db, "root", "SuperAdmin")
    _user(db)
    admin_access, _ = _login(client, "root")
    victim_access, victim_refresh = _login(client)
    alice = db.query(User).filter_by(username="alice").one()
    response = client.patch(f"/api/v1/auth/users/{alice.id}", headers={"Authorization": f"Bearer {admin_access}"}, json=change)
    assert response.status_code == 200, response.text
    assert _me(client, victim_access) == 401
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": victim_refresh}).status_code == 401


def test_unrelated_profile_edit_keeps_sessions(client_and_db):
    client, db = client_and_db
    _user(db, "root", "SuperAdmin")
    _user(db)
    admin_access, _ = _login(client, "root")
    victim_access, _ = _login(client)
    alice = db.query(User).filter_by(username="alice").one()
    response = client.patch(
        f"/api/v1/auth/users/{alice.id}", headers={"Authorization": f"Bearer {admin_access}"}, json={"role": "Viewer"}
    )
    assert response.status_code == 200, response.text
    assert _me(client, victim_access) == 200


def _engine():
    from sqlalchemy.pool import StaticPool

    return create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)


def test_migration_0085_upgrades_existing_users_idempotently():
    engine = _engine()
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(80))"))
        conn.execute(text("INSERT INTO users (id, username) VALUES (1, 'alice')"))
        db_session._migrate_user_token_version(conn, None)
        db_session._migrate_user_token_version(conn, None)
        assert conn.execute(text("SELECT username, token_version FROM users")).one() == ("alice", 0)
        conn.execute(text("INSERT INTO users (id, username) VALUES (2, 'bob')"))
        assert conn.execute(text("SELECT token_version FROM users WHERE id = 2")).scalar_one() == 0


def test_migration_0085_fresh_install_and_rerun(monkeypatch):
    engine = _engine()
    monkeypatch.setattr(db_session, "engine", engine)
    db_session.init_db()
    db_session.init_db()
    assert "token_version" in {c["name"] for c in inspect(engine).get_columns("users")}
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT COUNT(*) FROM schema_migrations WHERE name = '0085_user_token_version'")
        ).scalar_one() == 1


def test_enabling_totp_ends_other_sessions_and_returns_a_fresh_token(client_and_db):
    import time

    import pyotp

    client, db = client_and_db
    _user(db)
    access_a, _ = _login(client)
    access_b, _ = _login(client)
    headers = {"Authorization": f"Bearer {access_a}"}
    secret = client.post("/api/v1/auth/me/totp/setup", headers=headers, json={"password": PASSWORD}).json()["secret"]
    response = client.post("/api/v1/auth/me/totp/confirm", headers=headers, json={"code": pyotp.TOTP(secret).at(time.time())})
    assert response.status_code == 200, response.text
    fresh = response.json()["access_token"]
    assert _me(client, access_b) == 401
    assert _me(client, access_a) == 401
    assert _me(client, fresh) == 200
    assert _cookie(response, "netmap_access") == fresh


def test_websocket_session_check_follows_the_session_version(monkeypatch):
    from app.api.v1 import syslog

    session_factory = memory_session_factory()
    monkeypatch.setattr(syslog, "SessionLocal", session_factory)
    db = session_factory()
    user = _user(db, "sec", "SecurityAnalyst")
    payload = decode_token(create_access_token(user.id, {"sv": 0}), "access")
    assert syslog.websocket_session_still_valid(payload)
    user.token_version = 1
    db.commit()
    assert not syslog.websocket_session_still_valid(payload)
    assert not syslog.websocket_session_still_valid(None)
    db.close()


def test_websocket_closes_on_the_heartbeat_once_the_session_ends(monkeypatch):
    from types import SimpleNamespace

    from starlette.websockets import WebSocketDisconnect

    from app.api.v1 import syslog

    valid = {"now": True}
    monkeypatch.setattr(syslog, "get_websocket_user", lambda _token: SimpleNamespace(role="SecurityAnalyst"))
    monkeypatch.setattr(syslog, "websocket_session_still_valid", lambda _payload: valid["now"])
    monkeypatch.setattr(syslog, "WS_SESSION_RECHECK_SECONDS", 0.0)
    app = FastAPI()
    app.include_router(syslog.router, prefix="/api/v1")
    with TestClient(app).websocket_connect("/api/v1/syslog/events/live") as websocket:
        websocket.send_text("token")
        assert websocket.receive_json() == {"type": "ready"}
        websocket.send_text("ping")
        assert websocket.receive_json() == {"type": "heartbeat"}
        valid["now"] = False
        websocket.send_text("ping")
        with pytest.raises(WebSocketDisconnect) as closed:
            websocket.receive_json()
        assert closed.value.code == 1008

"""New-device sign-in emails: a browser is recognised by the netmap_device cookie."""
import time

import pyotp
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text

from app.api.v1 import auth as auth_api
from app.core.security import hash_password
from app.db import session as db_session
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.known_device import KnownDevice
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.services import notifications, totp
from app.services.auth import devices
from tests.oidc_helpers import memory_session_factory

PASSWORD = "correct horse battery"
FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0"
SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"


class _InlineSender:
    def submit(self, fn, *args):
        fn(*args)


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setattr(auth_api, "apply_progressive_delay", lambda _attempts: None)
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
    sent: list[dict] = []

    def fake_email(_db, **fields):
        return lambda: sent.append(fields) or "ok"

    monkeypatch.setattr(notifications, "new_device_sign_in_email", fake_email)
    monkeypatch.setattr(devices, "_sender", _InlineSender())
    db = session_factory()
    browsers = {name: TestClient(app, base_url="http://testserver", headers={"User-Agent": agent}) for name, agent in (("firefox", FIREFOX), ("safari", SAFARI))}
    try:
        yield browsers, db, sent
    finally:
        db.close()


def _user(db, name="alice", email="alice@example.com", enrol=False):
    user = User(username=name, email=email, password_hash=hash_password(PASSWORD), role="Viewer", is_active=True)
    db.add(user)
    db.commit()
    secret = None
    if enrol:
        secret, _ = totp.begin_enrolment(db, user)
        totp.confirm_enrolment(db, user, pyotp.TOTP(secret).at(time.time() - 60), now=time.time() - 60)
        db.commit()
    return user, secret


def _sign_in(client, name="alice"):
    response = client.post("/api/v1/auth/login", json={"username": name, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response


def test_first_browser_is_remembered_silently_and_a_second_one_is_emailed(env):
    browsers, db, sent = env
    _user(db)
    first = _sign_in(browsers["firefox"])
    cookie = first.headers.get_list("set-cookie")
    device_cookie = next(c for c in cookie if c.startswith("netmap_device="))
    assert "HttpOnly" in device_cookie and "SameSite=lax" in device_cookie and "Path=/api/v1/auth/" in device_cookie
    assert sent == []

    _sign_in(browsers["firefox"])
    assert sent == []

    _sign_in(browsers["safari"])
    assert len(sent) == 1
    notice = sent[0]
    assert notice["email"] == "alice@example.com"
    assert notice["device"] == "Safari on iPhone"
    assert notice["method"] == "password"
    assert notice["ip"]
    assert db.scalar(select(AuditLog.action).where(AuditLog.action == "auth.new_device_notice")) == "auth.new_device_notice"

    _sign_in(browsers["safari"])
    assert len(sent) == 1
    rows = db.scalars(select(KnownDevice).where(KnownDevice.user_id == 1)).all()
    assert sorted(row.label for row in rows) == ["Firefox on Windows", "Safari on iPhone"]
    assert all(len(row.token_hash) == 64 for row in rows)
    raw = browsers["firefox"].cookies.get("netmap_device")
    assert raw and all(row.token_hash != raw for row in rows)


def test_a_shared_browser_keeps_one_cookie_for_every_account(env):
    browsers, db, sent = env
    _user(db, "alice")
    _user(db, "bob", email="bob@example.com")
    _sign_in(browsers["firefox"], "alice")
    token = browsers["firefox"].cookies.get("netmap_device")
    _sign_in(browsers["firefox"], "bob")
    assert browsers["firefox"].cookies.get("netmap_device") == token
    _sign_in(browsers["firefox"], "alice")
    assert sent == []


def test_a_forged_cookie_value_is_replaced(env):
    browsers, db, sent = env
    _user(db)
    _sign_in(browsers["firefox"])
    browsers["safari"].cookies.set("netmap_device", "short", path="/api/v1/auth/")
    response = _sign_in(browsers["safari"])
    issued = next(c for c in response.headers.get_list("set-cookie") if c.startswith("netmap_device="))
    value = issued.split(";", 1)[0].split("=", 1)[1]
    assert value != "short" and len(value) >= 32
    assert len(sent) == 1


def test_two_factor_sign_in_is_checked_after_the_code(env):
    browsers, db, sent = env
    _account, secret = _user(db, enrol=True)
    for name in ("firefox", "safari"):
        challenge = _sign_in(browsers[name]).json()["challenge"]
        assert sent == [] or name == "safari"
        response = browsers[name].post("/api/v1/auth/login/totp", json={"challenge": challenge, "code": pyotp.TOTP(secret).now()})
        assert response.status_code == 200, response.text
        db.execute(text("UPDATE users SET totp_last_step = NULL"))
        db.commit()
    assert [notice["method"] for notice in sent] == ["password and an authentication code"]


@pytest.mark.parametrize("opt_out", ["user", "admin", "no_email"])
def test_no_email_when_switched_off_or_without_an_address(env, opt_out):
    browsers, db, sent = env
    user, _ = _user(db, email=None if opt_out == "no_email" else "alice@example.com")
    if opt_out == "user":
        user.new_device_alerts = False
    if opt_out == "admin":
        db.add(SystemSetting(key="new_device_alerts_enabled", value="false"))
    db.commit()
    _sign_in(browsers["firefox"])
    _sign_in(browsers["safari"])
    assert sent == []
    assert db.scalar(select(KnownDevice.id).where(KnownDevice.label == "Safari on iPhone")) is not None


def test_profile_can_switch_the_emails_off(env):
    browsers, db, _sent = env
    _user(db)
    access = _sign_in(browsers["firefox"]).json()["access_token"]
    headers = {"Authorization": f"Bearer {access}"}
    assert browsers["firefox"].get("/api/v1/auth/me", headers=headers).json()["new_device_alerts"] is True
    response = browsers["firefox"].patch("/api/v1/auth/me", headers=headers, json={"new_device_alerts": False})
    assert response.status_code == 200, response.text
    assert response.json()["new_device_alerts"] is False


def test_known_devices_are_capped_per_user(env, monkeypatch):
    browsers, db, _sent = env
    monkeypatch.setattr(devices, "MAX_DEVICES_PER_USER", 3)
    _user(db)
    for _ in range(5):
        browsers["firefox"].cookies.clear()
        _sign_in(browsers["firefox"])
    assert db.scalar(select(KnownDevice.id).order_by(KnownDevice.id.desc())) is not None
    assert len(db.scalars(select(KnownDevice.id)).all()) == 3


def test_an_email_failure_never_blocks_sign_in(env, monkeypatch):
    browsers, db, _sent = env

    def broken(_db, **_fields):
        return lambda: (_ for _ in ()).throw(OSError("smtp down"))

    monkeypatch.setattr(notifications, "new_device_sign_in_email", broken)
    _user(db)
    _sign_in(browsers["firefox"])
    assert _sign_in(browsers["safari"]).status_code == 200


@pytest.mark.parametrize(("agent", "label"), [
    (FIREFOX, "Firefox on Windows"),
    (SAFARI, "Safari on iPhone"),
    ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Chrome on Linux"),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", "Edge on macOS"),
    ("curl/8.0", "Unknown browser"),
    (None, "Unknown browser"),
])
def test_user_agent_is_described_briefly(agent, label):
    assert devices.describe_user_agent(agent) == label


def test_email_lists_the_sign_in_and_needs_smtp(monkeypatch):
    from tests.app_helpers import memory_factory

    db = memory_factory()()
    assert notifications.new_device_sign_in_email(
        db, username="alice", display_name=None, email="alice@example.com",
        when="31 Oct 2026, 08:00 UTC", device="Safari on iPhone", ip="203.0.113.9", method="password",
    ) is None
    db.add_all([SystemSetting(key="smtp_host", value="smtp.example"), SystemSetting(key="smtp_to", value="ops@example.com")])
    db.commit()
    captured = {}
    monkeypatch.setattr(notifications, "_send_smtp", lambda body, settings, **kwargs: captured.update(body=body, settings=settings, **kwargs) or "ok")
    send = notifications.new_device_sign_in_email(
        db, username="alice", display_name="Alice", email="alice@example.com",
        when="31 Oct 2026, 08:00 UTC", device="Safari on iPhone", ip="203.0.113.9", method="password", app_name="Acme NetMap",
    )
    assert captured == {}
    send()
    assert captured["settings"]["smtp_to"] == "alice@example.com"
    assert captured["subject"] == "Acme NetMap — New sign-in to your account"
    for fact in ("31 Oct 2026, 08:00 UTC", "Safari on iPhone", "203.0.113.9", "password", "Hi Alice"):
        assert fact in captured["body"]
    assert captured["content"].heading == "New sign-in to your account"


def test_migration_0092_adds_the_opt_out_switched_on():
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(80))"))
        conn.execute(text("INSERT INTO users VALUES (1, 'alice')"))
        db_session._migrate_new_device_alerts(conn, None)
        db_session._migrate_new_device_alerts(conn, None)
        assert conn.execute(text("SELECT new_device_alerts FROM users")).scalar() == 1
    with create_engine("sqlite://").begin() as conn:
        db_session._migrate_new_device_alerts(conn, None)

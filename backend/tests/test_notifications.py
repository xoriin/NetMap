import io
import urllib.error
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base
from app.models.notification_profile import NotificationProfile
from app.models.site import Site  # noqa: F401
from app.models.system_setting import SystemSetting
from app.schemas.alert import AlertRuleCreate
from app.services.notifications import (
    _support_contact_line,
    create_notification_profile,
    get_notification_profile,
    list_notification_profiles,
    send_notification,
    send_notification_target,
)


def _session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine, tables=[NotificationProfile.__table__, SystemSetting.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_send_notification_does_not_return_http_error_body() -> None:
    error = urllib.error.HTTPError(
        url="https://example.invalid/hook",
        code=500,
        msg="Internal Server Error",
        hdrs=None,
        fp=io.BytesIO(b"/srv/app/internal.py traceback details"),
    )

    with patch("app.services.notifications._send_ntfy", side_effect=error):
        result = send_notification("ntfy", "test", {"ntfy_url": "https://example.invalid/hook"})

    assert result == "HTTP 500: delivery failed"
    assert "internal.py" not in result
    assert "traceback" not in result


def test_send_notification_does_not_return_exception_detail() -> None:
    with patch("app.services.notifications._send_smtp", side_effect=RuntimeError("/srv/app/secret.py failed")):
        result = send_notification("smtp", "test", {"smtp_host": "smtp.example.com", "smtp_to": "admin@example.com"})

    assert result == "Error: delivery failed"
    assert "secret.py" not in result


def test_notification_profile_config_is_redacted_but_available_for_delivery() -> None:
    db = _session()
    profile = create_notification_profile(
        db,
        name="Discord",
        provider="apprise",
        enabled=True,
        config={"url": "discord://webhook-id/webhook-token", "title": "NetMap"},
    )

    redacted = get_notification_profile(db, profile.id, redacted=True)
    internal = get_notification_profile(db, profile.id, redacted=False)

    assert redacted is not None
    assert redacted["config"]["url"] == "__redacted__"
    assert internal is not None
    assert internal["config"]["url"] == "discord://webhook-id/webhook-token"


def test_send_notification_target_dispatches_profile(monkeypatch) -> None:
    db = _session()
    profile = create_notification_profile(
        db,
        name="Apprise",
        provider="apprise",
        enabled=True,
        config={"url": "json://example.invalid/hook", "title": "NetMap"},
    )
    profiles = {int(row["id"]): row for row in list_notification_profiles(db, redacted=False)}

    monkeypatch.setattr("app.services.notifications.send_notification_profile", lambda p, m: f"sent:{p['name']}:{m}")

    result = send_notification_target(f"profile:{profile.id}", "hello", {}, profiles)

    assert result == "sent:Apprise:hello"


def test_send_notification_profile_dispatches_legacy_provider(monkeypatch) -> None:
    db = _session()
    profile = create_notification_profile(
        db,
        name="Ops email",
        provider="smtp",
        enabled=True,
        config={"smtp_host": "smtp.example.com", "smtp_to": "ops@example.com"},
    )
    profiles = {int(row["id"]): row for row in list_notification_profiles(db, redacted=False)}

    monkeypatch.setattr("app.services.notifications._send_smtp", lambda message, settings: f"smtp:{settings['smtp_to']}:{message}")

    result = send_notification_target(f"profile:{profile.id}", "hello", {}, profiles)

    assert result == "smtp:ops@example.com:hello"


def test_legacy_notification_settings_backfill_profiles() -> None:
    db = _session()
    db.add_all([
        SystemSetting(key="smtp_host", value="smtp.example.com"),
        SystemSetting(key="smtp_to", value="ops@example.com"),
        SystemSetting(key="smtp_port", value="2525"),
    ])
    db.commit()

    profiles = list_notification_profiles(db, redacted=True)

    assert len(profiles) == 1
    assert profiles[0]["name"] == "Existing Email"
    assert profiles[0]["provider"] == "smtp"
    assert profiles[0]["config"]["smtp_host"] == "smtp.example.com"
    assert profiles[0]["config"]["smtp_to"] == "ops@example.com"


def test_alert_rule_accepts_notification_profile_targets() -> None:
    rule = AlertRuleCreate(
        name="Core offline",
        event_type="device_offline",
        channels=["smtp", "profile:42"],
    )

    assert rule.channels == ["smtp", "profile:42"]


def test_support_contact_line_empty_when_unconfigured() -> None:
    db = _session()
    assert _support_contact_line(db) == ""


def test_support_contact_line_includes_configured_email_and_url() -> None:
    db = _session()
    db.add_all([
        SystemSetting(key="support_email", value="help@example.com"),
        SystemSetting(key="support_url", value="https://example.com/support"),
    ])
    db.commit()

    line = _support_contact_line(db)
    assert "help@example.com" in line
    assert "https://example.com/support" in line


def test_support_contact_line_includes_only_email_when_url_unset() -> None:
    db = _session()
    db.add(SystemSetting(key="support_email", value="help@example.com"))
    db.commit()

    line = _support_contact_line(db)
    assert "help@example.com" in line
    assert "http" not in line

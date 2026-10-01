import io
import urllib.error
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base
from app.models.notification_profile import NotificationProfile
from app.models.site import Site  # noqa: F401
from app.models.system_setting import SystemSetting
from app.schemas.alert import AlertRuleCreate
from app.schemas.admin import EmailBrandingSettingsUpdate
from app.schemas.auth import ForgotPasswordRequest
from app.api.v1.admin import preview_email_branding, update_email_branding
from app.services.email_templates import EmailContent, build_email_message, load_email_branding_settings
from app.services.notifications import (
    _support_contact_line,
    create_notification_profile,
    get_notification_profile,
    list_notification_profiles,
    send_password_reset_email,
    send_self_service_password_reset_email,
    send_notification,
    send_notification_target,
    send_welcome_email,
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

    monkeypatch.setattr("app.services.notifications.send_notification_profile", lambda p, m, **_kwargs: f"sent:{p['name']}:{m}")

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


def test_smtp_profile_inherits_global_email_branding(monkeypatch) -> None:
    db = _session()
    profile = create_notification_profile(
        db,
        name="Ops email",
        provider="smtp",
        enabled=True,
        config={"smtp_host": "smtp.example.com", "smtp_to": "ops@example.com"},
    )
    profiles = {int(row["id"]): row for row in list_notification_profiles(db, redacted=False)}
    delivered: list[dict[str, str]] = []
    monkeypatch.setattr(
        "app.services.notifications._send_smtp",
        lambda _message, settings, **_kwargs: delivered.append(settings) or "ok",
    )

    result = send_notification_target(
        f"profile:{profile.id}",
        "hello",
        {"email_brand_name": "Acme Networks", "email_brand_accent": "#123456"},
        profiles,
    )

    assert result == "ok"
    assert delivered[0]["email_brand_name"] == "Acme Networks"
    assert delivered[0]["email_brand_accent"] == "#123456"


def test_account_emails_use_an_enabled_smtp_profile(monkeypatch) -> None:
    db = _session()
    create_notification_profile(
        db,
        name="Account email",
        provider="smtp",
        enabled=True,
        config={
            "smtp_host": "smtp.profile.example",
            "smtp_port": "2525",
            "smtp_user": "profile-user",
            "smtp_password": "profile-password",
            "smtp_from": "netmap@example.com",
            "smtp_to": "alerts@example.com",
            "smtp_tls": "true",
        },
    )
    sent: list[tuple[str, dict[str, str], str]] = []
    monkeypatch.setattr(
        "app.services.notifications._send_smtp",
        lambda message, settings, *, subject="NetMap Notification", **_kwargs: sent.append((message, settings, subject)) or "ok",
    )

    send_self_service_password_reset_email(
        db,
        username="alice",
        display_name="Alice",
        email="alice@example.com",
        reset_link="https://netmap.example/?reset_token=self-service",
    )
    send_password_reset_email(
        db,
        username="bob",
        display_name=None,
        email="bob@example.com",
        reset_link="https://netmap.example/?reset_token=admin-reset",
    )
    send_welcome_email(
        db,
        username="carol",
        display_name="Carol",
        email="carol@example.com",
        role="User",
    )

    assert [settings["smtp_to"] for _, settings, _ in sent] == [
        "alice@example.com",
        "bob@example.com",
        "carol@example.com",
    ]
    assert all(settings["smtp_host"] == "smtp.profile.example" for _, settings, _ in sent)
    assert all(settings["smtp_user"] == "profile-user" for _, settings, _ in sent)
    assert [subject for _, _, subject in sent] == [
        "NetMap — Password reset request",
        "NetMap — Your password has been reset",
        "NetMap — Your account has been created",
    ]


def test_account_email_prefers_profile_over_stale_legacy_smtp(monkeypatch) -> None:
    db = _session()
    db.add_all([
        SystemSetting(key="smtp_host", value="smtp.legacy.example"),
        SystemSetting(key="smtp_to", value="legacy@example.com"),
    ])
    db.commit()
    create_notification_profile(
        db,
        name="Current SMTP",
        provider="smtp",
        enabled=True,
        config={"smtp_host": "smtp.current.example", "smtp_to": "alerts@example.com"},
    )
    sent: list[dict[str, str]] = []
    monkeypatch.setattr(
        "app.services.notifications._send_smtp",
        lambda _message, settings, **_kwargs: sent.append(settings) or "ok",
    )

    send_self_service_password_reset_email(
        db,
        username="alice",
        display_name=None,
        email="alice@example.com",
        reset_link="https://netmap.example/?reset_token=token",
    )

    assert sent[0]["smtp_host"] == "smtp.current.example"
    assert sent[0]["smtp_to"] == "alice@example.com"


def test_account_email_falls_back_to_legacy_smtp_settings(monkeypatch) -> None:
    db = _session()
    db.add_all([
        SystemSetting(key="smtp_host", value="smtp.legacy.example"),
        SystemSetting(key="smtp_to", value="legacy@example.com"),
    ])
    db.commit()
    sent: list[dict[str, str]] = []
    monkeypatch.setattr(
        "app.services.notifications._send_smtp",
        lambda _message, settings, **_kwargs: sent.append(settings) or "ok",
    )

    send_self_service_password_reset_email(
        db,
        username="alice",
        display_name=None,
        email="alice@example.com",
        reset_link="https://netmap.example/?reset_token=token",
    )

    assert sent[0]["smtp_host"] == "smtp.legacy.example"
    assert sent[0]["smtp_to"] == "alice@example.com"


def test_forgot_password_logs_delivery_failure_without_exposing_it(monkeypatch, caplog) -> None:
    from app.api.v1 import auth

    user = SimpleNamespace(
        id=42,
        username="alice",
        display_name="Alice",
        email="alice@example.com",
        is_active=True,
    )

    class FakeSession:
        def scalar(self, _statement):
            return user

    monkeypatch.setattr(auth, "request_client_ip", lambda _request: "192.0.2.10")
    monkeypatch.setattr(auth, "_check_reset_rate_limit", lambda _db, _client_ip: False)
    monkeypatch.setattr(auth, "_invalidate_pending_reset_tokens", lambda _db, _user_id: None)
    monkeypatch.setattr(auth, "create_password_reset_token", lambda _user_id: "reset-token")
    monkeypatch.setattr(auth, "_store_reset_token", lambda _db, _token, _user_id: None)
    monkeypatch.setattr(auth.settings, "app_url", "https://netmap.example")
    monkeypatch.setattr(
        auth,
        "send_self_service_password_reset_email",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("SMTP rejected message")),
    )
    caplog.set_level("ERROR", logger="app.api.v1.auth")

    result = auth.forgot_password(
        ForgotPasswordRequest(username_or_email="alice"),
        object(),
        FakeSession(),
    )

    assert result is None
    assert "Password reset email delivery failed for user_id=42" in caplog.text


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


def test_email_message_contains_plain_html_and_inline_logo() -> None:
    message = build_email_message(
        "Plain fallback with <unsafe> text",
        {
            "app_name": "NetMap",
            "email_brand_name": "Example & Co",
            "email_brand_theme": "login_banner",
            "email_brand_accent": "#1d9ab0",
            "email_brand_footer": "Managed <carefully>",
            "email_brand_url": "https://netmap.example",
            "email_brand_show_support": "true",
            "support_email": "help@example.com",
        },
        subject="Security notice",
        from_addr="netmap@example.com",
        to_addr="alice@example.com",
        content=EmailContent(
            eyebrow="Account security",
            heading="Reset <requested>",
            paragraphs=("Hi Alice,", "Use the secure link."),
            action_label="Reset password",
            action_url="https://netmap.example/reset?token=a&b=c",
            note="Ignore this if it was not you.",
        ),
    )

    plain = message.get_body(preferencelist=("plain",))
    html = message.get_body(preferencelist=("html",))
    assert plain is not None and plain.get_content() == "Plain fallback with <unsafe> text\n"
    assert html is not None
    rendered = html.get_content()
    assert "Reset &lt;requested&gt;" in rendered
    assert "Example &amp; Co" in rendered
    assert "token=a&amp;b=c" in rendered
    assert "<unsafe>" not in rendered
    assert any(part.get("Content-ID") == "<netmap-brand-logo>" for part in message.walk())


def test_email_branding_settings_validate_logo_colour_and_url() -> None:
    one_pixel_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    parsed = EmailBrandingSettingsUpdate(
        email_brand_accent="#22c0cf",
        email_brand_url="https://netmap.example",
        email_brand_logo=one_pixel_png,
    )
    assert parsed.email_brand_logo == one_pixel_png

    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        EmailBrandingSettingsUpdate(email_brand_accent="teal")
    with pytest.raises(ValidationError):
        EmailBrandingSettingsUpdate(email_brand_url="javascript:alert(1)")
    with pytest.raises(ValidationError):
        EmailBrandingSettingsUpdate(email_brand_logo="data:image/svg+xml;base64,PHN2Zz4=")


def test_email_branding_loads_existing_app_and_support_settings() -> None:
    db = _session()
    db.add_all([
        SystemSetting(key="app_name", value="Acme Map"),
        SystemSetting(key="support_email", value="help@example.com"),
        SystemSetting(key="email_brand_theme", value="clean_stripe"),
        SystemSetting(key="email_brand_name", value="Acme Networks"),
    ])
    db.commit()

    settings = load_email_branding_settings(db)
    assert settings["app_name"] == "Acme Map"
    assert settings["support_email"] == "help@example.com"
    assert settings["email_brand_theme"] == "clean_stripe"
    assert settings["email_brand_name"] == "Acme Networks"


def test_email_branding_update_persists_only_controlled_settings() -> None:
    db = _session()
    response = update_email_branding(
        EmailBrandingSettingsUpdate(
            email_brand_theme="clean_stripe",
            email_brand_name="Acme Networks",
            email_brand_show_support=False,
        ),
        SimpleNamespace(role="SuperAdmin"),
        db,
    )

    assert response.email_brand_theme == "clean_stripe"
    assert response.email_brand_name == "Acme Networks"
    assert response.email_brand_show_support is False
    assert db.get(SystemSetting, "email_brand_name").value == "Acme Networks"
    assert db.get(SystemSetting, "email_brand_show_support").value == "False"


def test_email_branding_preview_renders_unsaved_values_with_inline_logo() -> None:
    db = _session()
    db.add_all([
        SystemSetting(key="app_name", value="Acme Map"),
        SystemSetting(key="support_email", value="help@example.com"),
        SystemSetting(key="email_brand_footer", value="Saved footer"),
    ])
    db.commit()
    one_pixel_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

    response = preview_email_branding(
        EmailBrandingSettingsUpdate(
            email_brand_theme="clean_stripe",
            email_brand_name="Unsaved <Brand>",
            email_brand_logo=one_pixel_png,
            email_brand_show_support=False,
        ),
        SimpleNamespace(role="SuperAdmin"),
        db,
    )

    html = response["html"]
    assert "Unsaved &lt;Brand&gt;" in html
    assert "<Brand>" not in html
    assert "Reset your password" in html
    assert "Saved footer" in html
    assert "help@example.com" not in html
    assert "border-top:5px solid" in html
    assert "cid:" not in html
    assert f'src="{one_pixel_png}"' in html
    # Previewing must not persist anything.
    assert db.get(SystemSetting, "email_brand_name") is None


def test_email_branding_preview_falls_back_to_default_logo() -> None:
    db = _session()
    response = preview_email_branding(EmailBrandingSettingsUpdate(), SimpleNamespace(role="SuperAdmin"), db)
    assert 'src="data:image/svg+xml;base64,' in response["html"]
    assert "cid:" not in response["html"]

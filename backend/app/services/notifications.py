import ipaddress
import json
import logging
import smtplib
import socket
import ssl
import urllib.error
import urllib.request
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Any
from urllib.parse import urlparse, urlunparse
from sqlalchemy import select
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


NOTIFICATION_DEFAULTS: dict[str, str] = {
    "ntfy_url": "",
    "ntfy_token": "",
    "telegram_bot_token": "",
    "telegram_chat_id": "",
    "signal_url": "",
    "signal_number": "",
    "signal_recipient": "",
    "smtp_host": "",
    "smtp_port": "587",
    "smtp_user": "",
    "smtp_password": "",
    "smtp_from": "",
    "smtp_to": "",
    "smtp_tls": "true",
}

# Fields whose values are encrypted at rest and redacted in API responses.
_SECRET_FIELDS = frozenset({"ntfy_token", "telegram_bot_token", "smtp_password"})
_PROFILE_SECRET_KEYS = frozenset({
    "url",
    "ntfy_token",
    "telegram_bot_token",
    "signal_number",
    "signal_recipient",
    "smtp_password",
    "webhook_url",
    "webhook_token",
})
_REDACTED = "__redacted__"
_ENC_PREFIX = "enc:"
LEGACY_CHANNELS = ("smtp", "ntfy", "telegram", "signal")

_PRIVATE_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _is_private_hostname(hostname: str) -> bool:
    try:
        addr = socket.getaddrinfo(hostname, None)[0][4][0]
        ip = ipaddress.ip_address(addr)
        return any(ip in net for net in _PRIVATE_NETWORKS)
    except (socket.gaierror, ValueError, OSError):
        return True  # fail closed — treat unresolvable as private


def _validate_outbound_url(url: str) -> None:
    from app.core.config import settings as app_settings
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Notification URL scheme must be http or https (got {parsed.scheme!r})")
    if not parsed.hostname:
        raise ValueError("Notification URL has no hostname")
    if app_settings.notification_block_private_targets and _is_private_hostname(parsed.hostname):
        raise ValueError(
            f"Outbound requests to private/loopback addresses are blocked "
            f"(NOTIFICATION_BLOCK_PRIVATE_TARGETS=true)"
        )


def _validate_smtp_host(host: str) -> None:
    from app.core.config import settings as app_settings
    if app_settings.notification_block_private_targets and _is_private_hostname(host):
        raise ValueError(
            f"SMTP connections to private/loopback addresses are blocked "
            f"(NOTIFICATION_BLOCK_PRIVATE_TARGETS=true)"
        )


def _encrypt(value: str) -> str:
    from app.core.secrets import encrypt_secret
    return _ENC_PREFIX + encrypt_secret(value)


def _decrypt(value: str) -> str:
    if value.startswith(_ENC_PREFIX):
        from app.core.secrets import decrypt_secret
        return decrypt_secret(value[len(_ENC_PREFIX):])
    return value


def _encrypt_profile_config(config: dict[str, Any]) -> str:
    return _encrypt(json.dumps(config, separators=(",", ":")))


def _decrypt_profile_config(value: str) -> dict[str, Any]:
    if not value:
        return {}
    try:
        decoded = _decrypt(value)
        data = json.loads(decoded)
        return data if isinstance(data, dict) else {}
    except Exception:
        logger.warning("Failed to decode notification profile config", exc_info=True)
        return {}


def _redact_profile_config(config: dict[str, Any]) -> dict[str, Any]:
    redacted = dict(config)
    for key in _PROFILE_SECRET_KEYS:
        if redacted.get(key):
            redacted[key] = _REDACTED
    return redacted


def _merge_profile_config(existing: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for key, value in updates.items():
        if key in _PROFILE_SECRET_KEYS and value == _REDACTED:
            continue
        merged[key] = value
    return merged


def _profile_to_dict(profile, *, redacted: bool) -> dict[str, Any]:
    config = _decrypt_profile_config(profile.config_json)
    return {
        "id": profile.id,
        "name": profile.name,
        "provider": profile.provider,
        "enabled": profile.enabled,
        "config": _redact_profile_config(config) if redacted else config,
        "created_at": profile.created_at,
        "updated_at": profile.updated_at,
    }


def load_notification_settings(db: Session) -> dict[str, str]:
    """Load and decrypt notification settings for internal use (sending notifications)."""
    from app.models.system_setting import SystemSetting
    rows = db.scalars(select(SystemSetting)).all()
    result = dict(NOTIFICATION_DEFAULTS)
    for row in rows:
        if row.key in result:
            result[row.key] = _decrypt(row.value) if row.key in _SECRET_FIELDS else row.value
    return result


def load_notification_settings_redacted(db: Session) -> dict[str, str]:
    """Load notification settings for API responses — secrets are redacted."""
    from app.models.system_setting import SystemSetting
    rows = db.scalars(select(SystemSetting)).all()
    result = dict(NOTIFICATION_DEFAULTS)
    stored: dict[str, str] = {}
    for row in rows:
        if row.key in result:
            stored[row.key] = row.value
    for key in result:
        raw = stored.get(key, "")
        if key in _SECRET_FIELDS:
            result[key] = _REDACTED if raw else ""
        else:
            result[key] = raw
    return result


def save_notification_setting(db: Session, key: str, value: str) -> None:
    """Encrypt secret fields before persisting."""
    from datetime import datetime, timezone
    from app.models.system_setting import SystemSetting
    stored_value = _encrypt(value) if key in _SECRET_FIELDS and value and value != _REDACTED else value
    now = datetime.now(timezone.utc)
    existing = db.get(SystemSetting, key)
    if existing:
        existing.value = stored_value
        existing.updated_at = now
    else:
        db.add(SystemSetting(key=key, value=stored_value, updated_at=now))


def list_notification_profiles(db: Session, *, redacted: bool = True) -> list[dict[str, Any]]:
    from app.models.notification_profile import NotificationProfile

    _ensure_legacy_notification_profiles(db)
    profiles = db.scalars(select(NotificationProfile).order_by(NotificationProfile.name)).all()
    return [_profile_to_dict(profile, redacted=redacted) for profile in profiles]


def get_notification_profile(db: Session, profile_id: int, *, redacted: bool = True) -> dict[str, Any] | None:
    from app.models.notification_profile import NotificationProfile

    profile = db.get(NotificationProfile, profile_id)
    if not profile:
        return None
    return _profile_to_dict(profile, redacted=redacted)


def create_notification_profile(
    db: Session,
    *,
    name: str,
    provider: str,
    enabled: bool,
    config: dict[str, Any],
):
    from app.models.notification_profile import NotificationProfile

    profile = NotificationProfile(
        name=name.strip(),
        provider=provider.strip().lower(),
        enabled=enabled,
        config_json=_encrypt_profile_config(config),
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


def _ensure_legacy_notification_profiles(db: Session) -> None:
    from app.models.notification_profile import NotificationProfile

    existing = set(db.scalars(select(NotificationProfile.provider)).all())
    settings = load_notification_settings(db)
    candidates: list[tuple[str, str, dict[str, Any]]] = []
    if "ntfy" not in existing and settings.get("ntfy_url"):
        candidates.append(("Existing ntfy", "ntfy", {
            "ntfy_url": settings.get("ntfy_url", ""),
            "ntfy_token": settings.get("ntfy_token", ""),
            "method": "ntfy",
            "method_label": "ntfy",
        }))
    if "telegram" not in existing and settings.get("telegram_bot_token") and settings.get("telegram_chat_id"):
        candidates.append(("Existing Telegram", "telegram", {
            "telegram_bot_token": settings.get("telegram_bot_token", ""),
            "telegram_chat_id": settings.get("telegram_chat_id", ""),
            "method": "telegram",
            "method_label": "Telegram",
        }))
    if (
        "signal" not in existing
        and settings.get("signal_url")
        and settings.get("signal_number")
        and settings.get("signal_recipient")
    ):
        candidates.append(("Existing Signal", "signal", {
            "signal_url": settings.get("signal_url", ""),
            "signal_number": settings.get("signal_number", ""),
            "signal_recipient": settings.get("signal_recipient", ""),
            "method": "signal",
            "method_label": "Signal",
        }))
    if "smtp" not in existing and settings.get("smtp_host") and settings.get("smtp_to"):
        candidates.append(("Existing Email", "smtp", {
            "smtp_host": settings.get("smtp_host", ""),
            "smtp_port": settings.get("smtp_port", "587"),
            "smtp_user": settings.get("smtp_user", ""),
            "smtp_password": settings.get("smtp_password", ""),
            "smtp_from": settings.get("smtp_from", ""),
            "smtp_to": settings.get("smtp_to", ""),
            "smtp_tls": settings.get("smtp_tls", "true"),
            "method": "smtp",
            "method_label": "Email (SMTP)",
        }))
    if not candidates:
        return
    for name, provider, config in candidates:
        db.add(NotificationProfile(
            name=name,
            provider=provider,
            enabled=True,
            config_json=_encrypt_profile_config(config),
        ))
    db.commit()


def update_notification_profile(db: Session, profile, updates: dict[str, Any]):
    if "name" in updates and updates["name"] is not None:
        profile.name = updates["name"].strip()
    if "provider" in updates and updates["provider"] is not None:
        profile.provider = updates["provider"].strip().lower()
    if "enabled" in updates and updates["enabled"] is not None:
        profile.enabled = bool(updates["enabled"])
    if "config" in updates and updates["config"] is not None:
        existing = _decrypt_profile_config(profile.config_json)
        profile.config_json = _encrypt_profile_config(_merge_profile_config(existing, updates["config"]))
    db.commit()
    db.refresh(profile)
    return profile


def send_notification(channel: str, message: str, settings: dict[str, str]) -> str:
    try:
        if channel == "ntfy":
            return _send_ntfy(message, settings)
        elif channel == "telegram":
            return _send_telegram(message, settings)
        elif channel == "signal":
            return _send_signal(message, settings)
        elif channel == "smtp":
            return _send_smtp(message, settings)
        return f"Unknown channel: {channel}"
    except urllib.error.HTTPError as exc:
        logger.warning("Notification delivery failed for channel %s with HTTP %s", channel, exc.code, exc_info=True)
        return f"HTTP {exc.code}: delivery failed"
    except Exception as exc:
        logger.warning("Notification delivery failed for channel %s", channel, exc_info=True)
        return "Error: delivery failed"


def send_notification_target(
    target: str,
    message: str,
    settings: dict[str, str],
    profiles: dict[int, dict[str, Any]],
) -> str:
    if target.startswith("profile:"):
        try:
            profile_id = int(target.split(":", 1)[1])
        except ValueError:
            return f"Invalid notification profile target: {target}"
        profile = profiles.get(profile_id)
        if not profile:
            return f"Notification profile {profile_id} was not found"
        if not profile.get("enabled", True):
            return "Notification profile is disabled"
        return send_notification_profile(profile, message)
    return send_notification(target, message, settings)


def send_notification_profile(profile: dict[str, Any], message: str) -> str:
    provider = str(profile.get("provider", "")).lower()
    config = profile.get("config") if isinstance(profile.get("config"), dict) else {}
    try:
        if provider == "apprise":
            return _send_apprise(message, config)
        if provider == "webhook":
            return _send_webhook(message, config)
        if provider in LEGACY_CHANNELS:
            settings = {key: "" if value is None else str(value) for key, value in config.items()}
            return send_notification(provider, message, settings)
        return f"Unknown notification provider: {provider}"
    except Exception:
        logger.warning("Notification profile delivery failed for provider %s", provider, exc_info=True)
        return "Error: delivery failed"


def _support_contact_line(db: Session) -> str:
    from app.api.v1.admin import load_settings

    settings = load_settings(db)
    email = settings.get("support_email", "")
    url = settings.get("support_url", "")
    contacts = [c for c in (email, url) if c]
    if not contacts:
        return ""
    return f"Need help? Contact {' or '.join(contacts)}.\n\n"


def send_password_reset_email(
    db: Session,
    *,
    username: str,
    display_name: str | None,
    email: str,
    reset_link: str,
    app_name: str = "NetMap",
) -> None:
    s = load_notification_settings(db)
    if not s.get("smtp_host") or not email:
        return
    name = display_name or username
    body = (
        f"Hi {name},\n\n"
        f"Your password for your {app_name} account has been reset by an administrator.\n\n"
        f"Username: {username}\n\n"
        f"Use the link below to set a new password (valid for 1 hour):\n\n"
        f"{reset_link}\n\n"
        f"If you did not expect this, please contact your administrator.\n\n"
        f"{_support_contact_line(db)}"
        f"— {app_name}"
    )
    _send_smtp(body, {**s, "smtp_to": email}, subject=f"{app_name} — Your password has been reset")


def send_self_service_password_reset_email(
    db: Session,
    *,
    username: str,
    display_name: str | None,
    email: str,
    reset_link: str,
    app_name: str = "NetMap",
) -> None:
    s = load_notification_settings(db)
    if not s.get("smtp_host") or not email:
        raise ValueError("SMTP is not configured or user has no email address")
    name = display_name or username
    body = (
        f"Hi {name},\n\n"
        f"We received a request to reset the password for your {app_name} account.\n\n"
        f"Click the link below to set a new password (valid for 1 hour):\n\n"
        f"{reset_link}\n\n"
        f"If you did not request a password reset, you can safely ignore this email.\n\n"
        f"{_support_contact_line(db)}"
        f"— {app_name}"
    )
    _send_smtp(body, {**s, "smtp_to": email}, subject=f"{app_name} — Password reset request")


def send_welcome_email(
    db: Session,
    *,
    username: str,
    display_name: str | None,
    email: str,
    role: str,
    app_name: str = "NetMap",
) -> None:
    s = load_notification_settings(db)
    if not s.get("smtp_host") or not email:
        return
    name = display_name or username
    body = (
        f"Hi {name},\n\n"
        f"A {app_name} account has been created for you.\n\n"
        f"Username: {username}\n"
        f"Role: {role}\n\n"
        f"Please contact your administrator to obtain your initial credentials.\n\n"
        f"— {app_name}"
    )
    _send_smtp(body, {**s, "smtp_to": email}, subject=f"{app_name} — Your account has been created")


def _send_ntfy(message: str, s: dict[str, str]) -> str:
    import base64

    url = s.get("ntfy_url", "").strip()
    if not url:
        return "ntfy URL is not configured"

    # Strip credentials embedded in the URL (https://user:pass@host/topic)
    parsed = urlparse(url)
    url_creds: str | None = None
    if parsed.username:
        creds = f"{parsed.username}:{parsed.password or ''}"
        url_creds = creds
        netloc = parsed.hostname + (f":{parsed.port}" if parsed.port else "")
        url = urlunparse(parsed._replace(netloc=netloc))

    _validate_outbound_url(url)

    token = s.get("ntfy_token", "").strip()
    headers: dict[str, str] = {
        "Title": "NetMap",
        "Content-Type": "text/plain",
        "User-Agent": "NetMap/1.0",
    }
    auth = token or url_creds
    if auth:
        if ":" in auth:
            headers["Authorization"] = "Basic " + base64.b64encode(auth.encode()).decode()
        else:
            headers["Authorization"] = f"Bearer {auth}"

    req = urllib.request.Request(url, data=message.encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return "ok" if resp.status == 200 else f"HTTP {resp.status}"


def _send_telegram(message: str, s: dict[str, str]) -> str:
    bot_token = s.get("telegram_bot_token", "").strip()
    chat_id = s.get("telegram_chat_id", "").strip()
    if not bot_token or not chat_id:
        return "Telegram bot token and chat ID are required"
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    # Telegram API is always HTTPS to a known domain — no SSRF risk
    payload = json.dumps({"chat_id": chat_id, "text": message}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return "ok" if resp.status == 200 else f"HTTP {resp.status}"


def _send_signal(message: str, s: dict[str, str]) -> str:
    url = s.get("signal_url", "").strip()
    number = s.get("signal_number", "").strip()
    recipient = s.get("signal_recipient", "").strip()
    if not url or not number or not recipient:
        return "Signal REST URL, sender number, and recipient are required"
    _validate_outbound_url(url)
    endpoint = f"{url.rstrip('/')}/v2/send"
    payload = json.dumps({"message": message, "number": number, "recipients": [recipient]}).encode()
    req = urllib.request.Request(endpoint, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return "ok" if resp.status in (200, 201) else f"HTTP {resp.status}"


def _send_smtp(message: str, s: dict[str, str], *, subject: str = "NetMap Notification") -> str:
    host = s.get("smtp_host", "").strip()
    to_addr = s.get("smtp_to", "").strip()
    if not host or not to_addr:
        return "SMTP host and recipient address are required"
    _validate_smtp_host(host)
    port = int(s.get("smtp_port", "587").strip() or "587")
    user = s.get("smtp_user", "").strip()
    password = s.get("smtp_password", "").strip()
    from_addr = s.get("smtp_from", "").strip() or user or "netmap@localhost"
    tls = s.get("smtp_tls", "true").strip().lower() == "true"
    msg = MIMEText(message)
    msg["Subject"] = subject
    msg["From"] = formataddr(("NetMap", from_addr))
    msg["To"] = to_addr
    if tls:
        ctx = ssl.create_default_context()
        with smtplib.SMTP(host, port, timeout=15) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ctx)
            if user and password:
                smtp.login(user, password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=15) as smtp:
            if user and password:
                smtp.login(user, password)
            smtp.send_message(msg)
    return "ok"


def _send_webhook(message: str, config: dict[str, Any]) -> str:
    url = str(config.get("webhook_url", "")).strip()
    if not url:
        return "Webhook URL is required"
    _validate_outbound_url(url)
    headers = {"Content-Type": "application/json", "User-Agent": "NetMap/1.0"}
    token = str(config.get("webhook_token", "")).strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = json.dumps({"title": "NetMap", "message": message}).encode()
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return "ok" if 200 <= resp.status < 300 else f"HTTP {resp.status}"


def _send_apprise(message: str, config: dict[str, Any]) -> str:
    url = str(config.get("url", "")).strip()
    if not url:
        return "Apprise URL is required"
    parsed = urlparse(url)
    if parsed.scheme in ("http", "https"):
        _validate_outbound_url(url)
    try:
        import apprise
    except ImportError:
        return "Apprise is not installed in this image"

    notifier = apprise.Apprise()
    if not notifier.add(url):
        return "Apprise URL was not accepted"
    title = str(config.get("title", "NetMap")).strip() or "NetMap"
    ok = notifier.notify(body=message, title=title)
    return "ok" if ok else "Apprise delivery failed"

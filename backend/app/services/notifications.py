import json
import smtplib
import ssl
import urllib.error
import urllib.request
from email.mime.text import MIMEText
from sqlalchemy import select
from sqlalchemy.orm import Session


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


def load_notification_settings(db: Session) -> dict[str, str]:
    from app.models.system_setting import SystemSetting
    rows = db.scalars(select(SystemSetting)).all()
    result = dict(NOTIFICATION_DEFAULTS)
    for row in rows:
        if row.key in result:
            result[row.key] = row.value
    return result


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
        body = exc.read().decode("utf-8", errors="replace")[:200]
        return f"HTTP {exc.code}: {body}"
    except Exception as exc:
        return f"Error: {exc}"


def send_password_reset_email(
    db: Session,
    *,
    username: str,
    display_name: str | None,
    email: str,
    new_password: str,
    app_name: str = "NetMap",
) -> None:
    s = load_notification_settings(db)
    if not s.get("smtp_host") or not email:
        return
    name = display_name or username
    body = (
        f"Hi {name},\n\n"
        f"Your password for your {app_name} account has been reset by an administrator.\n\n"
        f"Username: {username}\n"
        f"New password: {new_password}\n\n"
        f"Please log in and change your password immediately.\n\n"
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
        f"— {app_name}"
    )
    _send_smtp(body, {**s, "smtp_to": email}, subject=f"{app_name} — Password reset request")


def send_welcome_email(
    db: Session,
    *,
    username: str,
    display_name: str | None,
    email: str,
    password: str,
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
        f"Password: {password}\n"
        f"Role: {role}\n\n"
        f"Please log in and change your password after your first sign-in.\n\n"
        f"— {app_name}"
    )
    _send_smtp(body, {**s, "smtp_to": email}, subject=f"{app_name} — Your account has been created")


def _send_ntfy(message: str, s: dict[str, str]) -> str:
    import base64
    from urllib.parse import urlparse, urlunparse

    url = s.get("ntfy_url", "").strip()
    if not url:
        return "ntfy URL is not configured"
    token = s.get("ntfy_token", "").strip()

    # Strip credentials embedded in the URL (https://user:pass@host/topic)
    parsed = urlparse(url)
    url_creds: str | None = None
    if parsed.username:
        creds = f"{parsed.username}:{parsed.password or ''}"
        url_creds = creds
        netloc = parsed.hostname + (f":{parsed.port}" if parsed.port else "")
        url = urlunparse(parsed._replace(netloc=netloc))

    headers: dict[str, str] = {
        "Title": "NetMap",
        "Content-Type": "text/plain",
        "User-Agent": "NetMap/1.0",
    }
    # Explicit token field takes priority over URL-embedded credentials
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
    port = int(s.get("smtp_port", "587").strip() or "587")
    user = s.get("smtp_user", "").strip()
    password = s.get("smtp_password", "").strip()
    from_addr = s.get("smtp_from", "").strip() or user or "netmap@localhost"
    tls = s.get("smtp_tls", "true").strip().lower() == "true"
    msg = MIMEText(message)
    msg["Subject"] = subject
    msg["From"] = from_addr
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

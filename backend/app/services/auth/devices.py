"""New-device sign-in notices. A long-lived netmap_device cookie identifies the
browser; each user keeps the hashes of the browsers they have signed in from."""

import hashlib
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from secrets import token_urlsafe
from typing import Callable

from fastapi import Request, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.known_device import KnownDevice
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.services.audit.service import write_audit

logger = logging.getLogger(__name__)

DEVICE_COOKIE = "netmap_device"
DEVICE_COOKIE_PATH = "/api/v1/auth/"
DEVICE_COOKIE_MAX_AGE = 400 * 86400
MAX_DEVICES_PER_USER = 50
SETTING_KEY = "new_device_alerts_enabled"
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,64}$")

_sender = ThreadPoolExecutor(max_workers=2, thread_name_prefix="new-device-email")

_BROWSERS = (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari"))
_SYSTEMS = (("Android", "Android"), ("iPhone", "iPhone"), ("iPad", "iPad"), ("Windows", "Windows"),
            ("Mac OS X", "macOS"), ("CrOS", "ChromeOS"), ("Linux", "Linux"))


def describe_user_agent(user_agent: str | None) -> str:
    ua = user_agent or ""
    browser = next((name for marker, name in _BROWSERS if marker in ua), None)
    system = next((name for marker, name in _SYSTEMS if marker in ua), None)
    if browser and system:
        return f"{browser} on {system}"
    return browser or system or "Unknown browser"


def method_label(method: str) -> str:
    base = "single sign-on" if method.startswith("oidc") else "password"
    if "totp" in method:
        return f"{base} and an authentication code"
    if "recovery" in method:
        return f"{base} and a recovery code"
    return base


def alerts_enabled(db: Session) -> bool:
    row = db.get(SystemSetting, SETTING_KEY)
    return row is None or row.value.strip().lower() not in ("false", "0", "")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def record_sign_in_device(
    db: Session,
    user: User,
    request: Request,
    *,
    client_ip: str | None,
    method: str,
) -> tuple[str, Callable[[], str] | None]:
    """Remember this browser for the user. Returns the cookie value to set and,
    for an unrecognised browser on an account that already has a known one, a
    callable that sends the notice. The caller commits before sending."""
    token = request.cookies.get(DEVICE_COOKIE) or ""
    if not _TOKEN_RE.match(token):
        token = token_urlsafe(32)
    now = datetime.now(timezone.utc)
    label = describe_user_agent(request.headers.get("user-agent"))
    known = db.scalar(select(KnownDevice).where(KnownDevice.user_id == user.id, KnownDevice.token_hash == _hash(token)))
    if known is not None:
        known.last_seen_at = now
        known.last_ip = client_ip
        known.label = label
        return token, None

    first_device = db.scalar(select(KnownDevice.id).where(KnownDevice.user_id == user.id).limit(1)) is None
    db.add(KnownDevice(user_id=user.id, token_hash=_hash(token), label=label, first_seen_at=now, last_seen_at=now, last_ip=client_ip))
    db.flush()
    stale = db.scalars(
        select(KnownDevice.id).where(KnownDevice.user_id == user.id)
        .order_by(KnownDevice.last_seen_at.desc(), KnownDevice.id.desc())
        .offset(MAX_DEVICES_PER_USER)
    ).all()
    if stale:
        db.execute(delete(KnownDevice).where(KnownDevice.id.in_(stale)))

    if first_device or not user.new_device_alerts or not user.email or not alerts_enabled(db):
        return token, None
    from app.services.notifications import new_device_sign_in_email

    app_name_row = db.get(SystemSetting, "app_name")
    send = new_device_sign_in_email(
        db,
        username=user.username,
        display_name=user.display_name,
        email=user.email,
        when=now.strftime("%d %b %Y, %H:%M UTC"),
        device=label,
        ip=client_ip or "unknown",
        method=method_label(method),
        app_name=(app_name_row.value if app_name_row and app_name_row.value else "NetMap"),
    )
    if send is not None:
        write_audit(
            db,
            action="auth.new_device_notice",
            actor_user_id=user.id,
            target=f"user:{user.username}",
            detail=f"device={label} ip={client_ip or '-'}",
        )
    return token, send


def set_device_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=DEVICE_COOKIE,
        value=token,
        httponly=True,
        secure=settings.auth_cookies_secure,
        # Lax so the single sign-on callback (a redirect from the provider) still sends it.
        samesite="lax",
        path=DEVICE_COOKIE_PATH,
        max_age=DEVICE_COOKIE_MAX_AGE,
    )


def _send_logged(send: Callable[[], str]) -> None:
    try:
        send()
    except Exception:
        logger.exception("Could not send the new-device sign-in email")


def send_notice_later(send: Callable[[], str] | None) -> None:
    if send is not None:
        _sender.submit(_send_logged, send)

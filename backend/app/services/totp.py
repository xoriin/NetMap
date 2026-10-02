from __future__ import annotations

import hashlib
import json
import secrets
import time
from datetime import datetime, timezone
from hmac import compare_digest
from typing import Literal

import pyotp
from sqlalchemy.orm import Session

from app.core.secrets import decrypt_secret, encrypt_secret
from app.models.system_setting import SystemSetting
from app.models.user import User, UserRole

STEP_SECONDS = 30
RECOVERY_CODE_COUNT = 10
_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
_ADMIN_ROLES = {UserRole.SUPER_ADMIN, UserRole.NETWORK_ADMIN}


def begin_enrolment(db: Session, user: User) -> tuple[str, str]:
    secret = pyotp.random_base32()
    user.totp_secret = encrypt_secret(secret)
    user.totp_enabled_at = None
    user.totp_last_step = None
    user.totp_recovery_codes = None
    db.flush()
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.username, issuer_name=_issuer(db))
    return secret, uri


def confirm_enrolment(db: Session, user: User, code: str, *, now: float | None = None) -> list[str] | None:
    if not user.totp_secret or user.totp_enabled_at is not None:
        return None
    step = _matching_step(decrypt_secret(user.totp_secret), code, now, last_step=None)
    if step is None:
        return None
    user.totp_last_step = step
    user.totp_enabled_at = datetime.now(timezone.utc)
    codes = _new_recovery_codes(user)
    db.flush()
    return codes


def verify(db: Session, user: User, code: str, *, now: float | None = None) -> Literal["totp", "recovery"] | None:
    if not user.totp_secret or user.totp_enabled_at is None:
        return None
    step = _matching_step(decrypt_secret(user.totp_secret), code, now, last_step=user.totp_last_step)
    if step is not None:
        user.totp_last_step = step
        db.flush()
        return "totp"
    hashes = json.loads(user.totp_recovery_codes or "[]")
    candidate = _hash_recovery(code)
    for stored in hashes:
        if compare_digest(stored, candidate):
            hashes.remove(stored)
            user.totp_recovery_codes = json.dumps(hashes)
            db.flush()
            return "recovery"
    return None


def regenerate_recovery_codes(db: Session, user: User) -> list[str]:
    codes = _new_recovery_codes(user)
    db.flush()
    return codes


def disable(db: Session, user: User) -> None:
    user.totp_secret = None
    user.totp_enabled_at = None
    user.totp_last_step = None
    user.totp_recovery_codes = None
    db.flush()


def is_required_for(db: Session, user: User) -> bool:
    row = db.get(SystemSetting, "totp_required")
    policy = row.value if row else "off"
    if policy == "all":
        return True
    if policy == "admins":
        return user.role in _ADMIN_ROLES
    return False


def _issuer(db: Session) -> str:
    row = db.get(SystemSetting, "app_name")
    return (row.value.strip() if row and row.value else "") or "NetMap"


def _matching_step(secret: str, code: str, now: float | None, *, last_step: int | None) -> int | None:
    digits = "".join(code.split())
    if len(digits) != 6 or not digits.isascii() or not digits.isdigit():
        return None
    current = int((time.time() if now is None else now) // STEP_SECONDS)
    otp = pyotp.TOTP(secret)
    for step in (current - 1, current, current + 1):
        if last_step is not None and step <= last_step:
            continue
        if compare_digest(otp.generate_otp(step), digits):
            return step
    return None


def _new_recovery_codes(user: User) -> list[str]:
    codes = []
    for _ in range(RECOVERY_CODE_COUNT):
        raw = "".join(secrets.choice(_BASE32) for _ in range(10))
        codes.append(f"{raw[:5]}-{raw[5:]}")
    user.totp_recovery_codes = json.dumps([_hash_recovery(c) for c in codes])
    return codes


def _hash_recovery(code: str) -> str:
    normalized = "".join(code.split()).replace("-", "").upper()
    return hashlib.sha256(normalized.encode("ascii", "ignore")).hexdigest()

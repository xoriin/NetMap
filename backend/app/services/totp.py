from __future__ import annotations

import hashlib
import json
import secrets
import time
from datetime import datetime, timezone
from hmac import compare_digest
from typing import Literal

import pyotp
from sqlalchemy import or_, update
from sqlalchemy.orm import Session

from app.core.secrets import decrypt_secret, encrypt_secret
from app.models.system_setting import SystemSetting
from app.models.user import User, UserRole

STEP_SECONDS = 30
RECOVERY_CODE_COUNT = 10
_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
_ADMIN_ROLES = {UserRole.SUPER_ADMIN, UserRole.NETWORK_ADMIN}
_STATE = ["totp_secret", "totp_enabled_at", "totp_last_step", "totp_recovery_codes"]
_CLAIM_ATTEMPTS = 3


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
    codes, stored = _recovery_codes()
    claimed = _claim(
        db,
        user,
        User.totp_enabled_at.is_(None),
        totp_last_step=step,
        totp_enabled_at=datetime.now(timezone.utc),
        totp_recovery_codes=stored,
    )
    return codes if claimed else None


def verify(db: Session, user: User, code: str, *, now: float | None = None) -> Literal["totp", "recovery"] | None:
    for _ in range(_CLAIM_ATTEMPTS):
        if not user.totp_secret or user.totp_enabled_at is None:
            return None
        step = _matching_step(decrypt_secret(user.totp_secret), code, now, last_step=user.totp_last_step)
        if step is not None:
            if _claim(db, user, or_(User.totp_last_step.is_(None), User.totp_last_step < step), totp_last_step=step):
                return "totp"
            continue
        hashes = json.loads(user.totp_recovery_codes or "[]")
        candidate = _hash_recovery(code)
        match = next((stored for stored in hashes if compare_digest(stored, candidate)), None)
        if match is None:
            return None
        hashes.remove(match)
        if _claim(db, user, User.totp_recovery_codes == user.totp_recovery_codes, totp_recovery_codes=json.dumps(hashes)):
            return "recovery"
    return None


def regenerate_recovery_codes(db: Session, user: User) -> list[str]:
    codes, user.totp_recovery_codes = _recovery_codes()
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


def _claim(db: Session, user: User, *conditions, **values) -> bool:
    result = db.execute(
        update(User)
        .where(User.id == user.id, User.totp_secret == user.totp_secret, *conditions)
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    db.refresh(user, _STATE)
    return result.rowcount == 1


def _recovery_codes() -> tuple[list[str], str]:
    codes = []
    for _ in range(RECOVERY_CODE_COUNT):
        raw = "".join(secrets.choice(_BASE32) for _ in range(10))
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes, json.dumps([_hash_recovery(c) for c in codes])


def _hash_recovery(code: str) -> str:
    normalized = "".join(code.split()).replace("-", "").upper()
    return hashlib.sha256(normalized.encode("ascii", "ignore")).hexdigest()

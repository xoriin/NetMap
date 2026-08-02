from __future__ import annotations

import hashlib
import hmac
import secrets
import string
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.secrets import signing_secret
from app.models.api_key import ApiKey
from app.models.user import User

KEY_SCHEME = "nm"
PREFIX_LEN = 12
SECRET_LEN = 43
DISPLAY_SUFFIX_LEN = 4

# Alphanumeric only — the key format is `nm_<prefix>_<secret>`, so neither part
# may contain an underscore or the parse in verify_and_load would break.
_KEY_ALPHABET = string.ascii_letters + string.digits


def _random_token(length: int) -> str:
    return "".join(secrets.choice(_KEY_ALPHABET) for _ in range(length))


def _hash_key(raw_key: str) -> str:
    return hmac.new(
        signing_secret().encode("utf-8"),
        raw_key.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _as_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def generate_api_key() -> tuple[str, str, str]:
    """Return (full_key, prefix, key_hash). The full key is shown exactly once."""
    prefix = _random_token(PREFIX_LEN)
    secret = _random_token(SECRET_LEN)
    full_key = f"{KEY_SCHEME}_{prefix}_{secret}"
    return full_key, prefix, _hash_key(full_key)


def is_key_active(key: ApiKey, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    if key.revoked_at is not None:
        return False
    if key.expires_at is not None and _as_aware_utc(key.expires_at) <= now:
        return False
    return True


def verify_and_load(db: Session, raw_key: str) -> ApiKey | None:
    """Resolve an active key and backfill its safe display suffix when needed."""
    if not raw_key.startswith(f"{KEY_SCHEME}_"):
        return None
    parts = raw_key.split("_", 2)
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return None
    candidate = db.scalar(select(ApiKey).where(ApiKey.prefix == parts[1]))
    if candidate is None:
        return None
    if not hmac.compare_digest(candidate.key_hash, _hash_key(raw_key)):
        return None
    if not is_key_active(candidate):
        return None
    # Keys created before the display-suffix migration cannot be reversed from
    # their digest. A successful authentication is the one safe opportunity to
    # retain only their final four characters without persisting the raw key.
    if candidate.suffix is None:
        candidate.suffix = raw_key[-DISPLAY_SUFFIX_LEN:]
    return candidate


def create_api_key(
    db: Session,
    user: User,
    name: str,
    expires_in_days: int | None,
    created_ip: str | None = None,
) -> tuple[ApiKey, str]:
    """Create a key for the user. Returns (row, plaintext); plaintext is never persisted."""
    full_key, prefix, key_hash = generate_api_key()
    expires_at = (
        datetime.now(timezone.utc) + timedelta(days=expires_in_days)
        if expires_in_days is not None
        else None
    )
    key = ApiKey(
        user_id=user.id,
        name=name,
        prefix=prefix,
        suffix=full_key[-DISPLAY_SUFFIX_LEN:],
        key_hash=key_hash,
        expires_at=expires_at,
        created_ip=created_ip,
    )
    db.add(key)
    db.flush()
    return key, full_key


def list_keys_for_user(db: Session, user_id: int) -> list[ApiKey]:
    return list(db.scalars(select(ApiKey).where(ApiKey.user_id == user_id).order_by(ApiKey.created_at.desc())))


def list_all_keys(db: Session) -> list[tuple[ApiKey, str]]:
    """All keys with the owning username, newest first, for SuperAdmin oversight."""
    rows = db.execute(
        select(ApiKey, User.username).join(User, User.id == ApiKey.user_id).order_by(ApiKey.created_at.desc())
    ).all()
    return [(key, username) for key, username in rows]


def get_key(db: Session, key_id: int) -> ApiKey | None:
    return db.get(ApiKey, key_id)


def revoke_key(db: Session, key: ApiKey, reason: str) -> None:
    if key.revoked_at is None:
        key.revoked_at = datetime.now(timezone.utc)
        key.revoked_reason = reason[:120]


def touch_last_used(db: Session, key: ApiKey, ip: str | None) -> None:
    key.last_used_at = datetime.now(timezone.utc)
    key.last_used_ip = ip

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
import jwt as _jwt
from jwt.exceptions import PyJWTError as JWTError

from app.core.config import settings
from app.core.secrets import signing_secret

ALGORITHM = "HS256"
password_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except (VerificationError, VerifyMismatchError):
        return False


_dummy_password_hash: str | None = None


def verify_password_or_dummy(password: str, password_hash: str | None) -> bool:
    """Verify a password, or spend the same Argon2 work when there is no usable
    account, so response timing does not reveal which usernames exist."""
    global _dummy_password_hash
    if password_hash is None:
        if _dummy_password_hash is None:
            _dummy_password_hash = hash_password(secrets.token_urlsafe(16))
        verify_password(password, _dummy_password_hash)
        return False
    return verify_password(password, password_hash)


def create_token(
    subject: str, token_type: str, expires_delta: timedelta, claims: dict[str, Any] | None = None
) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "typ": token_type,
        "iat": int(now.timestamp()),
        "exp": int((now + expires_delta).timestamp()),
        "jti": str(uuid4()),
        **(claims or {}),
    }
    return _jwt.encode(payload, signing_secret(), algorithm=ALGORITHM)


def decode_token(token: str, expected_type: str) -> dict[str, Any] | None:
    try:
        payload = _jwt.decode(token, signing_secret(), algorithms=[ALGORITHM])
    except JWTError:
        return None
    if payload.get("typ") != expected_type:
        return None
    return payload


def create_access_token(user_id: int) -> str:
    return create_token(
        str(user_id),
        "access",
        timedelta(minutes=settings.access_token_minutes),
    )


def create_refresh_token(user_id: int) -> str:
    return create_token(
        str(user_id),
        "refresh",
        timedelta(days=settings.refresh_token_days),
    )


def create_password_reset_token(user_id: int) -> str:
    return create_token(str(user_id), "password_reset", timedelta(hours=1))

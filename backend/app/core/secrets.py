from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from secrets import token_urlsafe

from cryptography.fernet import Fernet

from app.core.config import settings


def _read_secret_file(path: str | None) -> str | None:
    if not path:
        return None
    file_path = Path(path)
    if not file_path.exists():
        return None
    value = file_path.read_text(encoding="utf-8").strip()
    return value or None


@lru_cache
def signing_secret() -> str:
    from_file = _read_secret_file(settings.secret_key_file)
    if settings.secret_key:
        return settings.secret_key
    if from_file:
        return from_file
    return token_urlsafe(48)


@lru_cache
def encryption_cipher() -> Fernet:
    key = settings.master_key or _read_secret_file(settings.master_key_file)
    if key:
        return Fernet(key.encode("utf-8"))
    return Fernet(Fernet.generate_key())


def encrypt_secret(value: str) -> str:
    return encryption_cipher().encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_secret(value: str) -> str:
    return encryption_cipher().decrypt(value.encode("utf-8")).decode("utf-8")

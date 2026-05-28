from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.secrets import decrypt_secret, encrypt_secret
from app.models.snmp_profile import SnmpProfile


def profile_to_dict(profile: SnmpProfile) -> dict:
    return {
        "id": profile.id,
        "name": profile.name,
        "version": profile.version,
        "port": profile.port,
        "timeout_seconds": profile.timeout_seconds,
        "retries": profile.retries,
        "created_at": profile.created_at,
        "updated_at": profile.updated_at,
    }


def create_profile(
    db: Session,
    *,
    name: str,
    community: str,
    port: int,
    timeout_seconds: int,
    retries: int,
) -> SnmpProfile:
    now = datetime.now(timezone.utc)
    profile = SnmpProfile(
        name=name,
        version="v2c",
        community_encrypted=encrypt_secret(community),
        port=port,
        timeout_seconds=timeout_seconds,
        retries=retries,
        created_at=now,
        updated_at=now,
    )
    db.add(profile)
    return profile


def update_profile(
    profile: SnmpProfile,
    *,
    name: str | None = None,
    community: str | None = None,
    port: int | None = None,
    timeout_seconds: int | None = None,
    retries: int | None = None,
) -> None:
    if name is not None:
        profile.name = name
    if community is not None:
        profile.community_encrypted = encrypt_secret(community)
    if port is not None:
        profile.port = port
    if timeout_seconds is not None:
        profile.timeout_seconds = timeout_seconds
    if retries is not None:
        profile.retries = retries
    profile.updated_at = datetime.now(timezone.utc)


def decrypt_profile_community(profile: SnmpProfile) -> str:
    return decrypt_secret(profile.community_encrypted)

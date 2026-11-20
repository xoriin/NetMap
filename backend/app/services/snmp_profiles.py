from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.core.secrets import decrypt_secret, encrypt_secret
from app.models.snmp_profile import SnmpProfile
from app.services.snmp import SnmpV3Credentials

V3_FIELDS = ("username", "security_level", "auth_protocol", "priv_protocol", "context_name")


class SnmpProfileValidationError(ValueError):
    """A profile whose fields do not fit its version or security level (HTTP 422)."""


def profile_to_dict(profile: SnmpProfile) -> dict:
    """API shape. Secrets are never included, only whether they are set."""
    return {
        "id": profile.id,
        "name": profile.name,
        "version": profile.version,
        "port": profile.port,
        "timeout_seconds": profile.timeout_seconds,
        "retries": profile.retries,
        "username": profile.username,
        "security_level": profile.security_level,
        "auth_protocol": profile.auth_protocol,
        "priv_protocol": profile.priv_protocol,
        "context_name": profile.context_name,
        "has_community": bool(profile.community_encrypted),
        "has_auth_key": bool(profile.auth_key_encrypted),
        "has_priv_key": bool(profile.priv_key_encrypted),
        "created_at": profile.created_at,
        "updated_at": profile.updated_at,
    }


def _validate(state: dict[str, Any]) -> None:
    """Check the merged profile state. `has_*` keys say whether a secret will be stored."""
    if state["version"] == "v2c":
        if not state["has_community"]:
            raise SnmpProfileValidationError("Community is required for SNMP v2c profiles")
        if any(state.get(name) for name in V3_FIELDS) or state["has_auth_key"] or state["has_priv_key"]:
            raise SnmpProfileValidationError("SNMPv3 fields are only valid for v3 profiles")
        return
    if state["community_given"]:
        raise SnmpProfileValidationError("Community is only valid for SNMP v2c profiles")
    if not state.get("username"):
        raise SnmpProfileValidationError("Username is required for SNMPv3 profiles")
    level = state.get("security_level")
    if level is None:
        raise SnmpProfileValidationError("Security level is required for SNMPv3 profiles")
    wants_auth = level in ("authNoPriv", "authPriv")
    wants_priv = level == "authPriv"
    if wants_auth:
        if not state.get("auth_protocol") or not state["has_auth_key"]:
            raise SnmpProfileValidationError(f"Authentication protocol and key are required for {level}")
    elif state.get("auth_protocol") or state["has_auth_key"]:
        raise SnmpProfileValidationError(f"Authentication protocol and key are not used with {level}")
    if wants_priv:
        if not state.get("priv_protocol") or not state["has_priv_key"]:
            raise SnmpProfileValidationError("Privacy protocol and key are required for authPriv")
    elif state.get("priv_protocol") or state["has_priv_key"]:
        raise SnmpProfileValidationError(f"Privacy protocol and key are not used with {level}")


def create_profile(
    db: Session,
    *,
    name: str,
    community: str | None,
    port: int,
    timeout_seconds: int,
    retries: int,
    version: str = "v2c",
    username: str | None = None,
    security_level: str | None = None,
    auth_protocol: str | None = None,
    auth_key: str | None = None,
    priv_protocol: str | None = None,
    priv_key: str | None = None,
    context_name: str | None = None,
) -> SnmpProfile:
    _validate({
        "version": version,
        "has_community": bool(community),
        "community_given": community is not None,
        "username": username,
        "security_level": security_level,
        "auth_protocol": auth_protocol,
        "priv_protocol": priv_protocol,
        "context_name": context_name,
        "has_auth_key": bool(auth_key),
        "has_priv_key": bool(priv_key),
    })
    now = datetime.now(timezone.utc)
    is_v3 = version == "v3"
    profile = SnmpProfile(
        name=name,
        version=version,
        community_encrypted="" if is_v3 else encrypt_secret(community or ""),
        username=username if is_v3 else None,
        security_level=security_level if is_v3 else None,
        auth_protocol=auth_protocol if is_v3 else None,
        auth_key_encrypted=encrypt_secret(auth_key) if is_v3 and auth_key else None,
        priv_protocol=priv_protocol if is_v3 else None,
        priv_key_encrypted=encrypt_secret(priv_key) if is_v3 and priv_key else None,
        context_name=context_name if is_v3 else None,
        port=port,
        timeout_seconds=timeout_seconds,
        retries=retries,
        created_at=now,
        updated_at=now,
    )
    db.add(profile)
    return profile


def update_profile(profile: SnmpProfile, **changes: Any) -> None:
    """Apply a PATCH. Omitted fields and blank (None) secrets keep the stored values.
    Values sent that do not fit the version or security level are rejected; stored
    protocols and keys the new security level no longer uses are cleared."""
    version = changes.get("version") or profile.version
    was_v3 = profile.version == "v3"
    community = changes.get("community")

    if version != "v3":
        _validate({
            "version": version,
            "has_community": bool(community) or (not was_v3 and bool(profile.community_encrypted)),
            "community_given": community is not None,
            **{name: changes.get(name) for name in V3_FIELDS},
            "has_auth_key": bool(changes.get("auth_key")),
            "has_priv_key": bool(changes.get("priv_key")),
        })
        _apply_common(profile, changes)
        profile.version = version
        if community:
            profile.community_encrypted = encrypt_secret(community)
        for name in V3_FIELDS:
            setattr(profile, name, None)
        profile.auth_key_encrypted = None
        profile.priv_key_encrypted = None
        return

    def current(name: str) -> Any:
        if name in changes:
            return changes[name]
        return getattr(profile, name) if was_v3 else None

    level = current("security_level")
    auth_protocol = current("auth_protocol")
    priv_protocol = current("priv_protocol")
    new_auth_key = changes.get("auth_key")
    new_priv_key = changes.get("priv_key")
    stored_auth_key = profile.auth_key_encrypted if was_v3 else None
    stored_priv_key = profile.priv_key_encrypted if was_v3 else None
    if level not in ("authNoPriv", "authPriv") and "auth_protocol" not in changes and not new_auth_key:
        auth_protocol, stored_auth_key = None, None
    if level != "authPriv" and "priv_protocol" not in changes and not new_priv_key:
        priv_protocol, stored_priv_key = None, None
    _validate({
        "version": "v3",
        "has_community": False,
        "community_given": community is not None,
        "username": current("username"),
        "security_level": level,
        "auth_protocol": auth_protocol,
        "priv_protocol": priv_protocol,
        "context_name": current("context_name"),
        "has_auth_key": bool(new_auth_key or stored_auth_key),
        "has_priv_key": bool(new_priv_key or stored_priv_key),
    })
    _apply_common(profile, changes)
    profile.version = "v3"
    profile.community_encrypted = ""
    profile.username = current("username")
    profile.security_level = level
    profile.context_name = current("context_name")
    profile.auth_protocol = auth_protocol
    profile.priv_protocol = priv_protocol
    profile.auth_key_encrypted = encrypt_secret(new_auth_key) if new_auth_key else stored_auth_key
    profile.priv_key_encrypted = encrypt_secret(new_priv_key) if new_priv_key else stored_priv_key


def _apply_common(profile: SnmpProfile, changes: dict[str, Any]) -> None:
    for name in ("name", "port", "timeout_seconds", "retries"):
        if changes.get(name) is not None:
            setattr(profile, name, changes[name])
    profile.updated_at = datetime.now(timezone.utc)


def decrypt_profile_community(profile: SnmpProfile) -> str:
    return decrypt_secret(profile.community_encrypted)


def profile_credentials(profile: SnmpProfile) -> str | SnmpV3Credentials:
    """What SnmpClient needs: the community for v2c, SnmpV3Credentials for v3."""
    if profile.version != "v3":
        return decrypt_profile_community(profile)
    return SnmpV3Credentials(
        username=profile.username or "",
        security_level=profile.security_level or "noAuthNoPriv",
        auth_protocol=profile.auth_protocol,
        auth_key=decrypt_secret(profile.auth_key_encrypted) if profile.auth_key_encrypted else None,
        priv_protocol=profile.priv_protocol,
        priv_key=decrypt_secret(profile.priv_key_encrypted) if profile.priv_key_encrypted else None,
        context_name=profile.context_name or "",
    )

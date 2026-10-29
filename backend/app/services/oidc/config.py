"""Effective OIDC configuration.

Values may come from environment settings (Phase 1) or from admin-managed
``system_settings`` rows keyed ``oidc.*`` (Phase 3). A non-empty DB row
overrides the corresponding environment value; ``require_sso`` is DB-only so
it can never be enabled by accident through a stale env file.

The client secret is stored encrypted (Fernet via MASTER_KEY) when managed
in-app and is never returned to API clients.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.secrets import decrypt_secret, encrypt_secret
from app.models.system_setting import SystemSetting
from app.models.user import UserRole

logger = logging.getLogger(__name__)

OIDC_SETTING_PREFIX = "oidc."

# Admin-manageable keys (without prefix) and whether they are secret.
OIDC_DB_KEYS = (
    "enabled",
    "issuer",
    "client_id",
    "client_secret_encrypted",
    "redirect_url",
    "scopes",
    "allowed_email_domains",
    "auto_provision",
    "provider_name",
    "link_by_email",
    "allow_unverified_email",
    "group_claim",
    "role_mappings",
    "manage_roles",
    "default_role",
    "allow_super_admin",
    "require_sso",
    "mfa_policy",
    "mfa_trusted_amr",
    "mfa_trusted_acr",
    "mfa_max_auth_age_seconds",
)

MFA_POLICIES = ("local_totp", "trust_idp")

REDACTED_SECRET = "__redacted__"


@dataclass
class OidcRuntimeConfig:
    enabled: bool = False
    issuer: str = ""
    client_id: str = ""
    client_secret: str = ""
    redirect_url: str = ""
    scopes: str = "openid profile email"
    allowed_email_domains: list[str] = field(default_factory=list)
    auto_provision: bool = False
    provider_name: str = "SSO"
    link_by_email: bool = False
    allow_unverified_email: bool = False
    group_claim: str = "groups"
    role_mappings: dict[str, str] = field(default_factory=dict)
    manage_roles: bool = False
    default_role: str = UserRole.VIEWER
    allow_super_admin: bool = False
    require_sso: bool = False
    mfa_policy: str = "local_totp"
    mfa_trusted_amr: list[str] = field(default_factory=lambda: ["mfa"])
    mfa_trusted_acr: list[str] = field(default_factory=list)
    mfa_max_auth_age_seconds: int = 300

    @property
    def is_usable(self) -> bool:
        return self.enabled and bool(self.issuer) and bool(self.client_id)

    def scope_list(self) -> list[str]:
        scopes = [s for s in self.scopes.split() if s]
        if "openid" not in scopes:
            scopes.insert(0, "openid")
        return scopes


def _read_secret_file(path: str | None) -> str:
    if not path:
        return ""
    try:
        from pathlib import Path

        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _parse_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _parse_role_mappings(raw: str) -> dict[str, str]:
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("Ignoring invalid OIDC role mappings JSON")
        return {}
    if not isinstance(parsed, dict):
        logger.warning("Ignoring OIDC role mappings: expected a JSON object")
        return {}
    return {str(k): str(v) for k, v in parsed.items() if str(k) and str(v)}


def _parse_domains(raw: str | list[str]) -> list[str]:
    if isinstance(raw, list):
        items = raw
    else:
        items = raw.split(",")
    return [d.strip().lower().lstrip("@") for d in items if d.strip()]


def load_oidc_db_settings(db: Session) -> dict[str, str]:
    rows = db.scalars(
        select(SystemSetting).where(SystemSetting.key.like(f"{OIDC_SETTING_PREFIX}%"))
    ).all()
    return {row.key.removeprefix(OIDC_SETTING_PREFIX): row.value for row in rows}


def _env_client_secret() -> str:
    return settings.oidc_client_secret or _read_secret_file(settings.oidc_client_secret_file)


def get_oidc_config(db: Session) -> OidcRuntimeConfig:
    """Resolve the effective OIDC configuration (DB overrides env)."""
    db_values = load_oidc_db_settings(db)

    def pick(key: str, env_value: str) -> str:
        db_value = db_values.get(key, "")
        return db_value if db_value.strip() else env_value

    def pick_bool(key: str, env_value: bool) -> bool:
        db_value = db_values.get(key, "")
        if db_value.strip():
            return _parse_bool(db_value)
        return env_value

    client_secret = _env_client_secret()
    encrypted = db_values.get("client_secret_encrypted", "").strip()
    if encrypted:
        try:
            client_secret = decrypt_secret(encrypted)
        except Exception:
            logger.error("Unable to decrypt stored OIDC client secret; falling back to env value")

    default_role = pick("default_role", settings.oidc_default_role).strip() or UserRole.VIEWER

    return OidcRuntimeConfig(
        enabled=pick_bool("enabled", settings.oidc_enabled),
        issuer=pick("issuer", settings.oidc_issuer).strip().rstrip("/"),
        client_id=pick("client_id", settings.oidc_client_id).strip(),
        client_secret=client_secret,
        redirect_url=pick("redirect_url", settings.oidc_redirect_url).strip(),
        scopes=pick("scopes", settings.oidc_scopes).strip() or "openid profile email",
        allowed_email_domains=_parse_domains(
            db_values.get("allowed_email_domains", "").strip() or settings.oidc_allowed_email_domains
        ),
        auto_provision=pick_bool("auto_provision", settings.oidc_auto_provision),
        provider_name=pick("provider_name", settings.oidc_provider_name).strip() or "SSO",
        link_by_email=pick_bool("link_by_email", settings.oidc_link_by_email),
        allow_unverified_email=pick_bool("allow_unverified_email", settings.oidc_allow_unverified_email),
        group_claim=pick("group_claim", settings.oidc_group_claim).strip() or "groups",
        role_mappings=_parse_role_mappings(pick("role_mappings", settings.oidc_role_mappings)),
        manage_roles=pick_bool("manage_roles", settings.oidc_manage_roles),
        default_role=default_role,
        allow_super_admin=pick_bool("allow_super_admin", settings.oidc_allow_super_admin),
        # DB-only on purpose: never enabled through the environment.
        require_sso=_parse_bool(db_values.get("require_sso", "")),
        mfa_policy=_parse_mfa_policy(pick("mfa_policy", settings.oidc_mfa_policy)),
        mfa_trusted_amr=_parse_list(pick("mfa_trusted_amr", settings.oidc_mfa_trusted_amr)),
        mfa_trusted_acr=_parse_list(pick("mfa_trusted_acr", settings.oidc_mfa_trusted_acr)),
        mfa_max_auth_age_seconds=_parse_auth_age(
            pick("mfa_max_auth_age_seconds", str(settings.oidc_mfa_max_auth_age_seconds))
        ),
    )


def _parse_mfa_policy(value: str) -> str:
    # Anything unrecognised falls back to the strict policy; there is no "off".
    value = value.strip().lower()
    return value if value in MFA_POLICIES else "local_totp"


def _parse_list(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _parse_auth_age(value: str) -> int:
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return 300
    return min(max(seconds, 30), 86400)


def save_oidc_db_settings(db: Session, updates: dict[str, str | None]) -> None:
    """Persist admin-managed OIDC settings. ``None`` clears the override."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    for key, value in updates.items():
        if key not in OIDC_DB_KEYS:
            continue
        full_key = f"{OIDC_SETTING_PREFIX}{key}"
        existing = db.get(SystemSetting, full_key)
        if value is None:
            if existing is not None:
                db.delete(existing)
            continue
        if existing is not None:
            existing.value = value
            existing.updated_at = now
        else:
            db.add(SystemSetting(key=full_key, value=value, updated_at=now))


def store_client_secret(db: Session, plaintext: str | None) -> None:
    """Encrypt and store the client secret; empty string clears it."""
    if plaintext is None:
        return
    save_oidc_db_settings(
        db,
        {"client_secret_encrypted": encrypt_secret(plaintext) if plaintext else ""},
    )


LINK_BY_EMAIL_WARNING = (
    "Single sign-on links sign-ins to existing NetMap accounts by matching email (link by email is on). "
    "It was kept on when this install was upgraded. Turn it off in SSO settings unless every email at "
    "your identity provider is trustworthy. Admin and 2FA accounts are never linked this way; their "
    "owners link SSO from their Profile. If you trust your provider's emails, choose "
    "\"I understand, keep it on\" in SSO settings to hide this notice."
)


# The link-by-email acknowledgement is stored outside OIDC_DB_KEYS so the normal
# settings save can never set it. It applies only to the exact effective
# configuration it was given for (see link_by_email_fingerprint).
ACK_FINGERPRINT_KEY = "link_by_email_ack_fingerprint"
ACK_BY_KEY = "link_by_email_ack_by"
ACK_AT_KEY = "link_by_email_ack_at"


def link_by_email_fingerprint(config: OidcRuntimeConfig) -> str:
    """sha256 of the effective issuer, client ID and link-by-email value."""
    import hashlib

    canonical = json.dumps(
        {
            "issuer": config.issuer.strip().rstrip("/"),
            "client_id": config.client_id.strip(),
            "link_by_email": bool(config.link_by_email),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def link_by_email_acknowledgement(db: Session, config: OidcRuntimeConfig | None = None) -> dict:
    """Stored acknowledgement and whether it matches the current effective config."""
    from datetime import datetime, timezone

    config = config or get_oidc_config(db)
    db_values = load_oidc_db_settings(db)
    fingerprint = db_values.get(ACK_FINGERPRINT_KEY, "").strip()
    acknowledged_at = None
    raw_at = db_values.get(ACK_AT_KEY, "").strip()
    if raw_at:
        try:
            acknowledged_at = datetime.fromisoformat(raw_at)
        except ValueError:
            acknowledged_at = None
        else:
            if acknowledged_at.tzinfo is None:
                acknowledged_at = acknowledged_at.replace(tzinfo=timezone.utc)
    return {
        "acknowledged": bool(
            fingerprint and config.link_by_email and fingerprint == link_by_email_fingerprint(config)
        ),
        "by": db_values.get(ACK_BY_KEY, "").strip() or None,
        "at": acknowledged_at,
    }


def acknowledge_link_by_email(db: Session, config: OidcRuntimeConfig, actor: str) -> str:
    """Store the acknowledgement for this effective config; caller commits."""
    from datetime import datetime, timezone

    fingerprint = link_by_email_fingerprint(config)
    now = datetime.now(timezone.utc)
    for key, value in (
        (ACK_FINGERPRINT_KEY, fingerprint),
        (ACK_BY_KEY, actor),
        (ACK_AT_KEY, now.isoformat()),
    ):
        full_key = f"{OIDC_SETTING_PREFIX}{key}"
        existing = db.get(SystemSetting, full_key)
        if existing is not None:
            existing.value = value
            existing.updated_at = now
        else:
            db.add(SystemSetting(key=full_key, value=value, updated_at=now))
    return fingerprint


def oidc_security_warnings(db: Session, *, include_acknowledged: bool = False) -> list[str]:
    """Runtime OIDC warnings. The link-by-email warning is hidden while an
    acknowledgement matches the current effective config, unless
    include_acknowledged is set (the startup log always warns)."""
    config = get_oidc_config(db)
    if config.enabled and config.link_by_email:
        if include_acknowledged or not link_by_email_acknowledgement(db, config)["acknowledged"]:
            return [LINK_BY_EMAIL_WARNING]
    return []

"""Mapping verified OIDC claims onto local NetMap users.

Linking rules (in order):
1. An existing ``external_identities`` row for (issuer, sub) wins.
2. Otherwise, when ``link_by_email`` is on, a single active local user with
   the same verified email and no identity from this issuer is linked
   (audited).
3. Otherwise, when ``auto_provision`` is on, a new user is created with the
   configured default role (audited).

Role mapping (Phase 4) only rewrites roles when ``manage_roles`` is on, and
never assigns SuperAdmin unless ``allow_super_admin`` is explicitly enabled.
Locally managed roles are the default precedence: with ``manage_roles`` off,
mapped roles apply only at provisioning time.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
import secrets

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models.oidc import ExternalIdentity
from app.models.user import User, UserRole
from app.services.audit.service import write_audit
from app.services.oidc.config import OidcRuntimeConfig
from app.services.oidc.provider import OidcProviderError

# Highest privilege first; used to pick one role when several groups match.
_BUILT_IN_ROLE_PRIORITY = (
    UserRole.SUPER_ADMIN,
    UserRole.NETWORK_ADMIN,
    UserRole.SECURITY_ANALYST,
    UserRole.VIEWER,
)


@dataclass
class OidcLoginResult:
    user: User
    identity: ExternalIdentity
    provisioned: bool = False
    linked: bool = False
    role_changed: bool = False


def _normalized_email(claims: dict) -> str:
    return str(claims.get("email") or "").strip().lower()


def check_email_policy(config: OidcRuntimeConfig, claims: dict) -> str:
    """Validate email presence, verification, and domain allowlist."""
    email = _normalized_email(claims)
    if not email or "@" not in email:
        raise OidcProviderError("email_missing", "Identity provider did not supply an email address")
    verified = claims.get("email_verified")
    if verified is not True and not config.allow_unverified_email:
        raise OidcProviderError(
            "email_unverified",
            "The identity provider did not mark this email address as verified",
        )
    if config.allowed_email_domains:
        domain = email.rsplit("@", 1)[1]
        if domain not in config.allowed_email_domains:
            raise OidcProviderError("email_domain_denied", "This email domain is not allowed to sign in")
    return email


def _claim_groups(config: OidcRuntimeConfig, claims: dict) -> list[str] | None:
    """Group/role values from the configured claim; None when claim absent."""
    if config.group_claim not in claims:
        return None
    raw = claims[config.group_claim]
    if isinstance(raw, str):
        values = [v.strip() for v in raw.split(",")]
    elif isinstance(raw, list):
        values = [str(v).strip() for v in raw]
    else:
        return None
    return [v for v in values if v]


def resolve_mapped_role(config: OidcRuntimeConfig, claims: dict) -> str | None:
    """The NetMap role the provider claims map to, or None when unmapped.

    Unknown groups are ignored; among matches the highest-privilege built-in
    role wins, then custom roles in mapping order. SuperAdmin is stripped
    unless explicitly allowed.
    """
    if not config.role_mappings:
        return None
    groups = _claim_groups(config, claims)
    if groups is None:
        return None
    matched = [config.role_mappings[g] for g in groups if g in config.role_mappings]
    if not matched:
        return None
    if not config.allow_super_admin:
        matched = [r for r in matched if r != UserRole.SUPER_ADMIN]
        if not matched:
            return None
    for role in _BUILT_IN_ROLE_PRIORITY:
        if role in matched:
            return str(role)
    return matched[0]


def _initial_role(config: OidcRuntimeConfig, claims: dict) -> str:
    mapped = resolve_mapped_role(config, claims)
    if mapped is not None:
        return mapped
    default = config.default_role
    if default == UserRole.SUPER_ADMIN and not config.allow_super_admin:
        return UserRole.VIEWER
    return default


def _apply_managed_role(db: Session, config: OidcRuntimeConfig, user: User, claims: dict) -> bool:
    """Sync the user's role from provider claims. Returns True on change."""
    if not config.manage_roles:
        return False
    if user.role == UserRole.SUPER_ADMIN and not config.allow_super_admin:
        # Never silently downgrade the instance owner through claim changes.
        return False
    target = resolve_mapped_role(config, claims)
    if target is None:
        target = _initial_role(config, claims)
    if user.role == target:
        return False
    previous = user.role
    user.role = target
    # The new role applies to every session, not only the one signing in now.
    from app.services.auth.tokens import revoke_all_user_refresh_tokens

    revoke_all_user_refresh_tokens(db, user_id=user.id, reason="role_or_status_changed")
    write_audit(
        db,
        action="auth.oidc_role_synced",
        actor_user_id=user.id,
        target=f"user:{user.username}",
        detail=f"previous={previous} new={target}",
    )
    return True


def _unique_username(db: Session, email: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_.-]", ".", email.split("@", 1)[0]).strip(".")[:60] or "sso.user"
    if len(base) < 3:
        base = f"{base}{'.sso'}"[:60]
    candidate = base
    suffix = 1
    while db.scalar(select(User).where(func.lower(User.username) == candidate.lower())) is not None:
        suffix += 1
        candidate = f"{base}.{suffix}"[:80]
    return candidate


def _display_name(claims: dict) -> str | None:
    name = str(claims.get("name") or claims.get("preferred_username") or "").strip()
    return name[:100] or None


_PRIVILEGED_ROLES = {UserRole.SUPER_ADMIN, UserRole.NETWORK_ADMIN}


def _links_from_profile_only(user: User) -> bool:
    """Admin and 2FA accounts are never linked by email; only from their Profile."""
    return user.role in _PRIVILEGED_ROLES or user.totp_enabled


def _local_email_matches(db: Session, email: str) -> list[User]:
    if not email:
        return []
    return list(db.scalars(select(User).where(func.lower(User.email) == email)).all())


def _find_email_link_candidate(db: Session, issuer: str, email: str) -> User | None:
    users = _local_email_matches(db, email)
    if len(users) != 1:
        # Zero or ambiguous matches: never guess between duplicate emails.
        return None
    user = users[0]
    if _links_from_profile_only(user):
        return None
    existing = db.scalar(
        select(ExternalIdentity).where(
            ExternalIdentity.issuer == issuer,
            ExternalIdentity.user_id == user.id,
        )
    )
    if existing is not None:
        # Already linked to a *different* subject at this issuer — refuse.
        return None
    return user


def login_with_claims(db: Session, config: OidcRuntimeConfig, claims: dict) -> OidcLoginResult:
    """Resolve verified claims to a local user, linking or provisioning."""
    email = check_email_policy(config, claims)
    issuer = config.issuer
    subject = str(claims["sub"])
    now = datetime.now(timezone.utc)

    identity = db.scalar(
        select(ExternalIdentity).where(
            ExternalIdentity.issuer == issuer,
            ExternalIdentity.subject == subject,
        )
    )

    provisioned = False
    linked = False

    if identity is not None:
        user = db.get(User, identity.user_id)
        if user is None:
            db.delete(identity)
            db.flush()
            identity = None

    if identity is None:
        # Email-based first-time linking is only safe with a provider-verified
        # email, even when unverified emails are otherwise tolerated.
        can_link_by_email = config.link_by_email and claims.get("email_verified") is True
        user = _find_email_link_candidate(db, issuer, email) if can_link_by_email else None
        matches = _local_email_matches(db, email) if user is None else []
        held_back = can_link_by_email and len(matches) == 1 and _links_from_profile_only(matches[0])
        if matches and (held_back or config.auto_provision):
            # Never create a second account for an email a local account already
            # uses, nor auto-link an admin or 2FA account; the owner links SSO
            # from their Profile instead.
            raise OidcProviderError(
                "link_from_profile",
                "A NetMap account already uses this email; sign in and link single sign-on from your Profile",
            )
        if user is None:
            if not config.auto_provision:
                raise OidcProviderError(
                    "account_not_linked",
                    "No local account is linked to this identity and auto-provisioning is disabled",
                )
            user = User(
                username=_unique_username(db, email),
                # Random unusable password: OIDC-provisioned accounts have no
                # local credential until an admin sets one.
                password_hash=hash_password(secrets.token_urlsafe(32)),
                role=_initial_role(config, claims),
                email=email,
                display_name=_display_name(claims),
            )
            db.add(user)
            db.flush()
            provisioned = True
            write_audit(
                db,
                action="auth.oidc_user_provisioned",
                actor_user_id=user.id,
                target=f"user:{user.username}",
                detail=f"issuer={issuer} role={user.role}",
            )
        else:
            if not user.is_active:
                # Never link an identity to a disabled account.
                raise OidcProviderError("account_disabled", "This account is disabled")
            linked = True
        identity = ExternalIdentity(
            provider_key="oidc",
            issuer=issuer,
            subject=subject,
            user_id=user.id,
            email=email,
            email_verified=claims.get("email_verified") is True,
            display_name=_display_name(claims),
        )
        db.add(identity)
        if linked:
            write_audit(
                db,
                action="auth.oidc_identity_linked",
                actor_user_id=user.id,
                target=f"user:{user.username}",
                detail=f"issuer={issuer} match=verified_email",
            )

    if not user.is_active:
        raise OidcProviderError("account_disabled", "This account is disabled")

    role_changed = _apply_managed_role(db, config, user, claims)

    identity.email = email
    identity.email_verified = claims.get("email_verified") is True
    identity.display_name = _display_name(claims) or identity.display_name
    identity.last_login_at = now

    return OidcLoginResult(
        user=user,
        identity=identity,
        provisioned=provisioned,
        linked=linked,
        role_changed=role_changed,
    )


def auth_source_map(db: Session, user_ids: list[int]) -> dict[int, ExternalIdentity]:
    """Latest linked identity per user, for Admin -> Users visibility."""
    if not user_ids:
        return {}
    rows = db.scalars(
        select(ExternalIdentity).where(ExternalIdentity.user_id.in_(user_ids))
    ).all()
    result: dict[int, ExternalIdentity] = {}
    for row in rows:
        current = result.get(row.user_id)
        if current is None or (row.last_login_at or row.created_at) > (
            current.last_login_at or current.created_at
        ):
            result[row.user_id] = row
    return result

"""OIDC login routes and SuperAdmin-managed SSO settings.

Login flow: ``GET /auth/oidc/login`` stores a state/nonce/PKCE transaction
and redirects to the provider; ``GET /auth/oidc/callback`` validates state
(server row + browser-bound cookie), exchanges the code, verifies the ID
token, resolves the local user, and issues the normal NetMap session cookies
before redirecting into the SPA. Provider tokens never reach the browser.

Callback failures redirect to ``/?sso_error=<code>`` so the login screen can
show a friendly message; details are audited server-side only.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_super_admin
from app.core.config import settings
from app.core.network import request_client_ip

from app.db.session import get_db
from app.models.user import User, UserRole
from app.schemas.oidc import (
    OidcCheckResult,
    OidcPublicStatus,
    OidcSettingsRead,
    OidcSettingsUpdate,
    OidcTestResult,
)
from app.services.audit.service import write_audit
from app.services.auth import issue_token_pair
from app.services.oidc.accounts import login_with_claims
from app.services.oidc.config import (
    OidcRuntimeConfig,
    get_oidc_config,
    save_oidc_db_settings,
    store_client_secret,
)
from app.services.oidc.flow import (
    begin_login,
    consume_login_state,
    exchange_code,
    resolve_profile_claims,
    verify_id_token,
)
from app.services.oidc.provider import (
    OidcProviderError,
    clear_provider_caches,
    fetch_jwks,
    fetch_provider_metadata,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["oidc"])

TXN_COOKIE_NAME = "netmap_oidc_txn"
TXN_COOKIE_PATH = "/api/v1/auth/oidc/"
CALLBACK_PATH = "/api/v1/auth/oidc/callback"


def _effective_redirect_url(config: OidcRuntimeConfig, request: Request | None = None) -> str:
    if config.redirect_url:
        return config.redirect_url
    base = settings.app_url.rstrip("/")
    if not base and request is not None:
        base = str(request.base_url).rstrip("/")
    return f"{base}{CALLBACK_PATH}" if base else ""


def _sso_error_redirect(code: str) -> RedirectResponse:
    response = RedirectResponse(url=f"/?sso_error={quote(code)}", status_code=status.HTTP_302_FOUND)
    response.delete_cookie(key=TXN_COOKIE_NAME, path=TXN_COOKIE_PATH)
    return response


@router.get("/auth/oidc/status", response_model=OidcPublicStatus)
def oidc_status(db: Annotated[Session, Depends(get_db)]) -> OidcPublicStatus:
    config = get_oidc_config(db)
    return OidcPublicStatus(
        enabled=config.is_usable,
        provider_name=config.provider_name,
        require_sso=config.require_sso and config.is_usable,
    )


@router.get("/auth/oidc/login")
def oidc_login(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
):
    config = get_oidc_config(db)
    if not config.is_usable:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SSO login is not enabled")
    redirect_uri = _effective_redirect_url(config, request)
    if not redirect_uri:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SSO redirect URL is not configured (set APP_URL or the OIDC redirect URL)",
        )
    try:
        authorize_url, state = begin_login(db, config, redirect_uri)
    except OidcProviderError as exc:
        logger.warning("OIDC login start failed: %s", exc.detail)
        db.rollback()
        return _sso_error_redirect(exc.code)
    db.commit()
    response = RedirectResponse(url=authorize_url, status_code=status.HTTP_302_FOUND)
    # Lax (not Strict): the callback arrives as a top-level cross-site
    # navigation from the provider and must still carry this cookie.
    response.set_cookie(
        key=TXN_COOKIE_NAME,
        value=state,
        httponly=True,
        secure=settings.auth_cookies_secure,
        samesite="lax",
        path=TXN_COOKIE_PATH,
        max_age=600,
    )
    return response


@router.get("/auth/oidc/callback")
def oidc_callback(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    config = get_oidc_config(db)
    if not config.is_usable:
        return _sso_error_redirect("sso_disabled")
    if error:
        write_audit(db, action="auth.oidc_login_failed", detail=f"provider_error={error[:120]}")
        db.commit()
        return _sso_error_redirect("provider_denied" if error == "access_denied" else "provider_error")

    txn_cookie = request.cookies.get(TXN_COOKIE_NAME, "")
    try:
        if not code or not state:
            raise OidcProviderError("invalid_state", "Callback is missing code or state")
        if not txn_cookie or txn_cookie != state:
            raise OidcProviderError("invalid_state", "Login state does not match this browser session")
        login_state = consume_login_state(db, state)
        code_verifier = login_state.code_verifier
        redirect_uri = login_state.redirect_uri
        nonce = login_state.nonce
        # Persist the single-use state and end the transaction before talking
        # to the identity provider; no DB session is held across network I/O.
        db.commit()
        token_response = exchange_code(
            config,
            code=code,
            code_verifier=code_verifier,
            redirect_uri=redirect_uri,
        )
        claims = verify_id_token(config, str(token_response["id_token"]), expected_nonce=nonce)
        claims = resolve_profile_claims(config, claims, token_response)
        result = login_with_claims(db, config, claims)
    except OidcProviderError as exc:
        logger.warning("OIDC callback failed: %s (%s)", exc.code, exc.detail)
        # Discard anything a refused login staged (for example an identity link).
        db.rollback()
        write_audit(db, action="auth.oidc_login_failed", detail=f"code={exc.code}")
        db.commit()
        return _sso_error_redirect(exc.code)

    user = result.user
    client_ip = request_client_ip(request)
    access_token, refresh_token = issue_token_pair(db, user, client_ip=client_ip)
    write_audit(
        db,
        action="auth.oidc_login_success",
        actor_user_id=user.id,
        target=f"user:{user.username}",
        detail=f"issuer={config.issuer} provisioned={result.provisioned} linked={result.linked} ip={client_ip or '-'}",
    )
    db.commit()

    from app.api.v1.auth import _set_auth_cookies

    response = RedirectResponse(url="/", status_code=status.HTTP_302_FOUND)
    response.delete_cookie(key=TXN_COOKIE_NAME, path=TXN_COOKIE_PATH)
    _set_auth_cookies(response, access_token, refresh_token)
    return response


# --- SuperAdmin-managed settings (Phase 3) ---------------------------------


def _settings_read(db: Session, request: Request | None = None) -> OidcSettingsRead:
    from app.services.oidc.config import load_oidc_db_settings

    config = get_oidc_config(db)
    db_values = load_oidc_db_settings(db)
    env_configured = bool(settings.oidc_issuer or settings.oidc_client_id or settings.oidc_enabled)
    return OidcSettingsRead(
        enabled=config.enabled,
        issuer=config.issuer,
        client_id=config.client_id,
        client_secret_set=bool(config.client_secret),
        redirect_url=db_values.get("redirect_url", "") or settings.oidc_redirect_url,
        effective_redirect_url=_effective_redirect_url(config, request),
        scopes=config.scopes,
        allowed_email_domains=", ".join(config.allowed_email_domains),
        auto_provision=config.auto_provision,
        provider_name=config.provider_name,
        link_by_email=config.link_by_email,
        allow_unverified_email=config.allow_unverified_email,
        group_claim=config.group_claim,
        role_mappings=json.dumps(config.role_mappings) if config.role_mappings else "",
        manage_roles=config.manage_roles,
        default_role=config.default_role,
        allow_super_admin=config.allow_super_admin,
        require_sso=config.require_sso,
        env_configured=env_configured,
    )


@router.get("/admin/oidc-settings", response_model=OidcSettingsRead)
def get_oidc_settings(
    request: Request,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> OidcSettingsRead:
    return _settings_read(db, request)


def _run_provider_checks(config: OidcRuntimeConfig, redirect_url: str) -> list[OidcCheckResult]:
    checks: list[OidcCheckResult] = []

    def add(name: str, ok: bool, message: str) -> None:
        checks.append(OidcCheckResult(name=name, ok=ok, message=message))

    add("configuration", bool(config.issuer and config.client_id),
        "Issuer and client ID are set" if config.issuer and config.client_id
        else "Issuer and client ID are required before SSO can be tested")
    if not (config.issuer and config.client_id):
        return checks

    add("redirect_url", bool(redirect_url),
        f"Redirect URL: {redirect_url}" if redirect_url
        else "No redirect URL — set APP_URL or an explicit OIDC redirect URL")

    metadata: dict | None = None
    try:
        clear_provider_caches()
        metadata = fetch_provider_metadata(config.issuer, force_refresh=True)
        add("discovery", True, "Discovery metadata fetched and issuer matches")
    except OidcProviderError as exc:
        add("discovery", False, _explain_provider_error(exc))

    if metadata is not None:
        try:
            jwks = fetch_jwks(str(metadata["jwks_uri"]), force_refresh=True)
            add("jwks", True, f"JWKS fetched ({len(jwks.get('keys', []))} signing keys)")
        except OidcProviderError as exc:
            add("jwks", False, _explain_provider_error(exc))
        supported = metadata.get("code_challenge_methods_supported")
        if supported is not None and "S256" not in supported:
            add("pkce", False, "Provider does not advertise PKCE S256 support")
        else:
            add("pkce", True, "PKCE S256 supported")
    if config.role_mappings or config.manage_roles:
        add(
            "role_mappings",
            bool(config.role_mappings) or not config.manage_roles,
            "Role mappings configured" if config.role_mappings
            else "Provider-managed roles is on but no role mappings are configured — users will get the default role",
        )
    return checks


def _explain_provider_error(exc: OidcProviderError) -> str:
    hints = {
        "provider_unreachable": "The provider could not be reached. Check the issuer URL, DNS, and container egress.",
        "insecure_provider_url": "Provider URLs must use HTTPS (plain HTTP is only allowed for localhost).",
        "issuer_mismatch": "The issuer in the discovery document differs from the configured issuer. Copy the issuer exactly as the provider publishes it.",
        "provider_metadata_invalid": "The discovery document is incomplete. Confirm the issuer URL points at an OIDC provider (not an OAuth2-only endpoint).",
        "jwks_invalid": "The provider JWKS endpoint returned no usable signing keys.",
    }
    hint = hints.get(exc.code, "")
    return f"{exc.detail}. {hint}".strip()


@router.post("/admin/oidc-settings/test", response_model=OidcTestResult)
def test_oidc_provider(
    request: Request,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> OidcTestResult:
    config = get_oidc_config(db)
    checks = _run_provider_checks(config, _effective_redirect_url(config, request))
    return OidcTestResult(ok=all(c.ok for c in checks), checks=checks)


_BOOL_KEYS = (
    "enabled",
    "auto_provision",
    "link_by_email",
    "allow_unverified_email",
    "manage_roles",
    "allow_super_admin",
)
_TEXT_KEYS = (
    "issuer",
    "client_id",
    "redirect_url",
    "scopes",
    "allowed_email_domains",
    "provider_name",
    "group_claim",
    "role_mappings",
    "default_role",
)


@router.put("/admin/oidc-settings", response_model=OidcSettingsRead)
def update_oidc_settings(
    payload: OidcSettingsUpdate,
    request: Request,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> OidcSettingsRead:
    updates = payload.model_dump(exclude_unset=True)

    if "role_mappings" in updates and updates["role_mappings"]:
        try:
            parsed = json.loads(updates["role_mappings"])
            if not isinstance(parsed, dict):
                raise ValueError
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail='Role mappings must be a JSON object, e.g. {"netmap-admins": "NetworkAdmin"}',
            )

    if "default_role" in updates and updates["default_role"]:
        if updates["default_role"] == UserRole.SUPER_ADMIN:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The default role for provisioned users cannot be SuperAdmin",
            )

    db_updates: dict[str, str | None] = {}
    for key in _TEXT_KEYS:
        if key in updates and updates[key] is not None:
            db_updates[key] = str(updates[key]).strip()
    for key in _BOOL_KEYS:
        if key in updates and updates[key] is not None:
            db_updates[key] = "true" if updates[key] else "false"

    # Phase 5 guard rails: require-SSO can only be switched on when the
    # provider verifiably works and an emergency SuperAdmin path exists.
    if "require_sso" in updates and updates["require_sso"] is not None:
        currently_required = get_oidc_config(db).require_sso
        if updates["require_sso"] and not currently_required:
            preview_db = dict(db_updates)
            save_oidc_db_settings(db, preview_db)
            if payload.client_secret is not None and payload.client_secret != "":
                store_client_secret(db, payload.client_secret)
            db.flush()
            candidate = get_oidc_config(db)
            if not candidate.is_usable:
                db.rollback()
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot require SSO: SSO login is not enabled or fully configured",
                )
            checks = _run_provider_checks(candidate, _effective_redirect_url(candidate, request))
            failed = [c for c in checks if not c.ok]
            if failed:
                db.rollback()
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Cannot require SSO: provider test failed ({failed[0].message})",
                )
            super_admin_count = db.scalar(
                select(func.count()).select_from(User).where(
                    User.role == UserRole.SUPER_ADMIN,
                    User.is_active.is_(True),
                )
            ) or 0
            if super_admin_count == 0:
                db.rollback()
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot require SSO: no active SuperAdmin account exists for emergency local recovery",
                )
            write_audit(
                db,
                action="admin.oidc_require_sso_enabled",
                actor_user_id=current_user.id,
                detail="Local login restricted to SuperAdmin emergency access",
            )
        elif not updates["require_sso"] and currently_required:
            write_audit(db, action="admin.oidc_require_sso_disabled", actor_user_id=current_user.id)
        db_updates["require_sso"] = "true" if updates["require_sso"] else "false"

    save_oidc_db_settings(db, db_updates)
    if payload.client_secret is not None:
        store_client_secret(db, payload.client_secret)

    changed_keys = sorted(set(db_updates) | ({"client_secret"} if payload.client_secret is not None else set()))
    if changed_keys:
        write_audit(
            db,
            action="admin.oidc_settings_updated",
            actor_user_id=current_user.id,
            detail=f"keys={','.join(changed_keys)}",
        )
    db.commit()
    clear_provider_caches()
    return _settings_read(db, request)

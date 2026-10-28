"""Authorization Code + PKCE flow mechanics.

State, nonce, and the PKCE verifier live server-side in ``oidc_login_states``
(single use, 10 minute expiry). The browser is additionally bound to the
transaction by an HttpOnly SameSite=Lax cookie holding the state value, which
the callback must present — this prevents login CSRF and state fixation.

ID tokens are verified against the provider JWKS: signature (asymmetric
algorithms only), issuer, audience (+ ``azp`` when multiple audiences),
expiry, and nonce. Provider access/refresh tokens are used server-side only
for the optional userinfo fetch and are never stored or sent to the SPA.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import secrets
import urllib.parse

import jwt as _jwt
from jwt.exceptions import PyJWTError

from app.models.oidc import OidcLoginState
from app.services.oidc.config import OidcRuntimeConfig
from app.services.oidc.provider import (
    OidcProviderError,
    _http_post_form,
    fetch_jwks,
    fetch_provider_metadata,
)

from sqlalchemy import select
from sqlalchemy.orm import Session

STATE_TTL_MINUTES = 10
ALLOWED_ID_TOKEN_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512"]
CLOCK_LEEWAY_SECONDS = 60


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _prune_expired_states(db: Session) -> None:
    now = datetime.now(timezone.utc)
    expired = db.scalars(select(OidcLoginState).where(OidcLoginState.expires_at < now)).all()
    for row in expired:
        db.delete(row)


REAUTH_TTL_SECONDS = 300
REAUTH_MAX_AGE_SECONDS = 300
_AUTH_TIME_SKEW_SECONDS = 60


def begin_login(
    db: Session,
    config: OidcRuntimeConfig,
    redirect_uri: str,
    *,
    user_id: int | None = None,
    purpose: str | None = None,
    pending_value: str | None = None,
) -> tuple[str, str]:
    """Create a login transaction; returns (authorize_url, state).

    With a purpose the transaction is a signed-in user's fresh re-authentication:
    it lives five minutes and asks the provider for a new sign-in."""
    metadata = fetch_provider_metadata(config.issuer)

    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    code_verifier = _b64url(secrets.token_bytes(48))
    code_challenge = _b64url(hashlib.sha256(code_verifier.encode("ascii")).digest())

    _prune_expired_states(db)
    db.add(
        OidcLoginState(
            state=state,
            nonce=nonce,
            code_verifier=code_verifier,
            redirect_uri=redirect_uri,
            expires_at=datetime.now(timezone.utc)
            + (timedelta(seconds=REAUTH_TTL_SECONDS) if purpose else timedelta(minutes=STATE_TTL_MINUTES)),
            user_id=user_id if purpose else None,
            purpose=purpose,
            pending_value=pending_value if purpose else None,
        )
    )
    params = {}
    if purpose:
        params = {"prompt": "login", "max_age": str(REAUTH_MAX_AGE_SECONDS)}

    query = urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": config.client_id,
            "redirect_uri": redirect_uri,
            "scope": " ".join(config.scope_list()),
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            **params,
        }
    )
    separator = "&" if "?" in metadata["authorization_endpoint"] else "?"
    return f"{metadata['authorization_endpoint']}{separator}{query}", state


def consume_login_state(db: Session, state: str) -> OidcLoginState:
    """Validate and single-use-consume a state row."""
    row = db.scalar(select(OidcLoginState).where(OidcLoginState.state == state)) if state else None
    now = datetime.now(timezone.utc)
    if row is None or row.used_at is not None:
        raise OidcProviderError("invalid_state", "Unknown or already-used login state")
    expires_at = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= now:
        raise OidcProviderError("invalid_state", "Login attempt expired; please try again")
    row.used_at = now
    return row


def require_fresh_auth_time(claims: dict, now: datetime | None = None) -> None:
    """A re-authentication must come with a provider sign-in from the last five
    minutes. Without auth_time we cannot tell, so it fails closed."""
    auth_time = claims.get("auth_time")
    if isinstance(auth_time, bool) or not isinstance(auth_time, (int, float)):
        raise OidcProviderError("reauth_required", "The identity provider did not confirm a fresh sign-in")
    current = (now or datetime.now(timezone.utc)).timestamp()
    if auth_time > current + _AUTH_TIME_SKEW_SECONDS or current - auth_time > REAUTH_MAX_AGE_SECONDS:
        raise OidcProviderError("reauth_required", "The identity provider did not confirm a fresh sign-in")


def exchange_code(
    config: OidcRuntimeConfig,
    *,
    code: str,
    code_verifier: str,
    redirect_uri: str,
) -> dict:
    metadata = fetch_provider_metadata(config.issuer)
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": config.client_id,
        "code_verifier": code_verifier,
    }
    basic_auth: tuple[str, str] | None = None
    if config.client_secret:
        auth_methods = metadata.get("token_endpoint_auth_methods_supported") or []
        if "client_secret_basic" in auth_methods or not auth_methods:
            basic_auth = (config.client_id, config.client_secret)
        else:
            data["client_secret"] = config.client_secret
    token_response = _http_post_form(metadata["token_endpoint"], data, basic_auth=basic_auth)
    if not token_response.get("id_token"):
        raise OidcProviderError("token_exchange_failed", "Token response did not include an ID token")
    return token_response


def _signing_key_for(id_token: str, jwks_uri: str):
    try:
        header = _jwt.get_unverified_header(id_token)
    except PyJWTError as exc:
        raise OidcProviderError("id_token_invalid", "ID token header could not be parsed") from exc
    alg = header.get("alg")
    if alg not in ALLOWED_ID_TOKEN_ALGS:
        raise OidcProviderError("id_token_invalid", f"ID token uses a disallowed algorithm ({alg})")
    kid = header.get("kid")

    def find_key(jwks: dict):
        for key_data in jwks.get("keys", []):
            if kid is None or key_data.get("kid") == kid:
                try:
                    return _jwt.PyJWK(key_data).key, alg
                except PyJWTError:
                    continue
        return None

    found = find_key(fetch_jwks(jwks_uri))
    if found is None:
        # Unknown kid: the provider may have rotated keys — refetch once.
        found = find_key(fetch_jwks(jwks_uri, force_refresh=True))
    if found is None:
        raise OidcProviderError("id_token_invalid", "No JWKS key matches the ID token signature")
    return found


def verify_id_token(config: OidcRuntimeConfig, id_token: str, *, expected_nonce: str) -> dict:
    metadata = fetch_provider_metadata(config.issuer)
    key, alg = _signing_key_for(id_token, metadata["jwks_uri"])
    try:
        claims = _jwt.decode(
            id_token,
            key,
            algorithms=[alg],
            audience=config.client_id,
            issuer=metadata["issuer"],
            leeway=CLOCK_LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except _jwt.InvalidIssuerError as exc:
        raise OidcProviderError("issuer_mismatch", "ID token issuer does not match the configured issuer") from exc
    except _jwt.InvalidAudienceError as exc:
        raise OidcProviderError("audience_mismatch", "ID token audience does not include this client") from exc
    except _jwt.ExpiredSignatureError as exc:
        raise OidcProviderError("id_token_expired", "ID token is expired") from exc
    except PyJWTError as exc:
        raise OidcProviderError("id_token_invalid", f"ID token verification failed: {exc}") from exc

    aud = claims.get("aud")
    if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != config.client_id:
        raise OidcProviderError("audience_mismatch", "ID token azp does not match this client")
    if claims.get("nonce") != expected_nonce:
        raise OidcProviderError("nonce_mismatch", "ID token nonce does not match the login attempt")
    return claims


def resolve_profile_claims(config: OidcRuntimeConfig, claims: dict, token_response: dict) -> dict:
    """Merge userinfo into ID-token claims when key claims are missing."""
    needs_userinfo = not claims.get("email") or (
        config.manage_roles and config.group_claim not in claims
    )
    access_token = token_response.get("access_token")
    if not needs_userinfo or not access_token:
        return claims
    metadata = fetch_provider_metadata(config.issuer)
    userinfo_endpoint = metadata.get("userinfo_endpoint")
    if not userinfo_endpoint:
        return claims
    from app.services.oidc.provider import fetch_userinfo

    userinfo = fetch_userinfo(str(userinfo_endpoint), str(access_token))
    if userinfo.get("sub") and userinfo["sub"] != claims.get("sub"):
        # Userinfo for a different subject must never be merged.
        return claims
    merged = dict(userinfo)
    merged.update(claims)
    return merged

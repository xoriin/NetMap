"""Whether an SSO sign-in can skip the local NetMap authenticator code."""
from __future__ import annotations

import time

from app.services.oidc.config import OidcRuntimeConfig

# Allow for small clock differences between NetMap and the provider.
CLOCK_SKEW_SECONDS = 60


def provider_proved_recent_mfa(config: OidcRuntimeConfig, claims: dict, now: float | None = None) -> bool:
    """Only under ``trust_idp``, and only when the ID token says the user
    completed an allowlisted MFA method (amr) or assurance level (acr) within
    the configured window. A missing or malformed auth_time never qualifies."""
    if config.mfa_policy != "trust_idp":
        return False
    amr = claims.get("amr")
    amr_values = {str(v) for v in amr} if isinstance(amr, list) else set()
    acr = claims.get("acr")
    method_ok = bool(amr_values & set(config.mfa_trusted_amr)) or (
        isinstance(acr, str) and acr in config.mfa_trusted_acr
    )
    if not method_ok:
        return False
    auth_time = claims.get("auth_time")
    if isinstance(auth_time, bool) or not isinstance(auth_time, (int, float)):
        return False
    current = time.time() if now is None else now
    if auth_time > current + CLOCK_SKEW_SECONDS:
        return False
    return current - auth_time <= config.mfa_max_auth_age_seconds

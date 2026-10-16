"""Non-blocking deployment security checks for the administrator warning."""

from app.core.config import Settings, settings


def https_security_warnings(configuration: Settings | None = None) -> list[str]:
    configured = configuration if configuration is not None else settings
    if configured.app_env.lower() != "production":
        return []
    warnings = []
    if (configured.app_uses_https or configured.secure_hsts_enabled) and not configured.auth_cookies_secure:
        if configured.auth_cookie_secure is False:
            warnings.append(
                "AUTH_COOKIE_SECURE=false leaves sign-in cookies without the Secure flag. "
                "Remove AUTH_COOKIE_SECURE so cookies follow APP_URL, or set AUTH_COOKIE_SECURE=true. "
                "Recreate the container after changing its environment."
            )
        else:
            warnings.append(
                "Sign-in cookies are not marked Secure because APP_URL does not start with https://, "
                "although SECURE_HSTS_ENABLED is on. Set APP_URL to the https:// address users open, "
                "or set AUTH_COOKIE_SECURE=true. Recreate the container after changing its environment."
            )
    if configured.app_uses_https and not configured.secure_hsts_enabled:
        warnings.append(
            "Set SECURE_HSTS_ENABLED=true once this hostname is served exclusively over HTTPS. "
            "Recreate the container after changing its environment."
        )
    if configured.app_uses_https and not configured.secure_headers_enabled:
        warnings.append(
            "Set SECURE_HEADERS_ENABLED=true to send the configured security headers, including HSTS. "
            "Recreate the container after changing its environment."
        )
    return warnings

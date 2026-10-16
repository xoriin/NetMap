"""Non-blocking deployment security checks for the administrator warning."""

from app.core.config import Settings, settings


def https_security_warnings(configuration: Settings | None = None) -> list[str]:
    configured = configuration if configuration is not None else settings
    if configured.app_env.lower() != "production":
        return []
    warnings = []
    if (configured.app_uses_https or configured.secure_hsts_enabled) and not configured.auth_cookies_secure:
        warnings.append(
            "AUTH_COOKIE_SECURE=false leaves sign-in cookies without the Secure flag. "
            "Set AUTH_COOKIE_SECURE=true to mark sign-in cookies Secure. "
            "Recreate the container after changing its environment."
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

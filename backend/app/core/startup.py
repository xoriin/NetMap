from __future__ import annotations

import logging
import os
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger(__name__)

_LOCALHOST_ORIGINS = {"localhost", "127.0.0.1", "::1"}

_PLACEHOLDER_SECRET_KEYS = frozenset({
    "change-me-in-production",
    "change-me",
    "replace-with-a-long-random-secret",
    "replace-with-output-of-python-secrets-token-urlsafe",
})

_PLACEHOLDER_MASTER_KEYS = frozenset({
    "replace-with-a-fernet-key",
    "replace-with-output-of-fernet-generate-key",
})


def validate_runtime_configuration() -> None:
    ensure_data_directory()
    ensure_secret_configuration()
    ensure_retention_configuration()
    ensure_production_network_configuration()


def ensure_data_directory() -> None:
    data_dir = Path(settings.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    if not data_dir.is_dir():
        raise RuntimeError(f"DATA_DIR is not a directory: {data_dir}")
    if not os.access(data_dir, os.W_OK):
        raise RuntimeError(f"DATA_DIR is not writable: {data_dir}")


def ensure_secret_configuration() -> None:
    if settings.app_env.lower() == "production":
        # Check placeholders first so they get a clear error rather than
        # "not a valid Fernet key" when the value is still the example default.
        _reject_placeholder_secret_values()
        if not (settings.secret_key or settings.secret_key_file):
            raise RuntimeError("Production requires SECRET_KEY or SECRET_KEY_FILE")
        if not (settings.master_key or settings.master_key_file):
            raise RuntimeError("Production requires MASTER_KEY or MASTER_KEY_FILE")

    # Always validate MASTER_KEY format if one is configured (placeholder values
    # are already handled above, so they are skipped here to avoid a confusing error).
    _validate_master_key_format()


def _reject_placeholder_secret_values() -> None:
    secret_key = _configured_secret_value(settings.secret_key, settings.secret_key_file)
    if secret_key in _PLACEHOLDER_SECRET_KEYS:
        raise RuntimeError(
            "SECRET_KEY must not use a placeholder value. "
            "Generate one with: python3 -c \"import secrets; print(secrets.token_urlsafe(32))\""
        )

    master_key = _configured_secret_value(settings.master_key, settings.master_key_file)
    if master_key in _PLACEHOLDER_MASTER_KEYS:
        raise RuntimeError(
            "MASTER_KEY must not use a placeholder value. "
            "Generate one with: python3 -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )


def _configured_secret_value(value: str | None, file_path: str | None) -> str | None:
    if value:
        return value.strip()
    if not file_path:
        return None
    p = Path(file_path)
    return p.read_text(encoding="utf-8").strip() if p.exists() else None


def _validate_master_key_format() -> None:
    """Eagerly validate MASTER_KEY is a usable Fernet key if one is configured."""
    key = _configured_secret_value(settings.master_key, settings.master_key_file)
    if not key or key in _PLACEHOLDER_MASTER_KEYS:
        return
    try:
        from cryptography.fernet import Fernet
        Fernet(key.encode("utf-8"))
    except Exception:
        raise RuntimeError(
            "MASTER_KEY is not a valid Fernet key. "
            "Generate one with: python3 -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )


def ensure_retention_configuration() -> None:
    if settings.firewall_log_retention_days < 1:
        raise RuntimeError("FIREWALL_LOG_RETENTION_DAYS must be at least 1")
    if settings.event_retention_days < 1:
        raise RuntimeError("EVENT_RETENTION_DAYS must be at least 1")


def ensure_production_network_configuration() -> None:
    if settings.app_env.lower() != "production":
        return

    _check_app_url()
    _check_cors_origins()
    _check_trusted_hosts()
    _check_syslog_allowlist()


def _check_app_url() -> None:
    if not settings.app_url:
        logger.warning(
            "APP_URL is not set, so password reset emails will not be sent. Set APP_URL to "
            "the address users open NetMap on (e.g. https://netmap.example.com)."
        )


def _check_cors_origins() -> None:
    if "*" in settings.cors_origins:
        logger.warning(
            "CORS_ORIGINS allows all origins. "
            "Use exact origins if the API is accessed cross-origin."
        )


def _check_trusted_hosts() -> None:
    if not settings.trusted_hosts:
        logger.warning(
            "TRUSTED_HOSTS is empty — TrustedHostMiddleware is disabled. "
            "Set TRUSTED_HOSTS to your domain(s) to prevent host-header injection."
        )
        return
    if "*" in settings.trusted_hosts:
        logger.warning(
            "TRUSTED_HOSTS uses a wildcard — all Host headers are accepted. "
            "Set TRUSTED_HOSTS to your exact domain(s) if this instance is internet-facing."
        )
        return
    localhost_only = all(h in _LOCALHOST_ORIGINS for h in settings.trusted_hosts)
    if localhost_only:
        logger.warning(
            "TRUSTED_HOSTS contains only localhost/loopback values. "
            "Set TRUSTED_HOSTS to your public domain(s) before exposing this service."
        )


def _check_syslog_allowlist() -> None:
    if not settings.syslog_sender_allowlist:
        logger.warning(
            "SYSLOG_SENDER_ALLOWLIST is empty — all senders are accepted. "
            "Set SYSLOG_SENDER_ALLOWLIST to restrict which IPs can submit syslog events."
        )

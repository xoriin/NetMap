from __future__ import annotations

import logging
import os
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger(__name__)

_LOCALHOST_ORIGINS = {"localhost", "127.0.0.1", "::1"}


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
    if settings.app_env.lower() != "production":
        return
    if not (settings.secret_key or settings.secret_key_file):
        raise RuntimeError("Production requires SECRET_KEY or SECRET_KEY_FILE")
    if settings.secret_key == "change-me-in-production":
        raise RuntimeError("SECRET_KEY must not use the default placeholder value")
    if not (settings.master_key or settings.master_key_file):
        raise RuntimeError("Production requires MASTER_KEY or MASTER_KEY_FILE")


def ensure_retention_configuration() -> None:
    if settings.firewall_log_retention_days < 1:
        raise RuntimeError("FIREWALL_LOG_RETENTION_DAYS must be at least 1")
    if settings.event_retention_days < 1:
        raise RuntimeError("EVENT_RETENTION_DAYS must be at least 1")


def ensure_production_network_configuration() -> None:
    if settings.app_env.lower() != "production":
        return

    _check_cors_origins()
    _check_trusted_hosts()
    _check_syslog_allowlist()


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
            "TRUSTED_HOSTS allows all hostnames. "
            "Set TRUSTED_HOSTS to exact domain(s) for public deployments."
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

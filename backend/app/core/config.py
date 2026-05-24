from functools import lru_cache
import os
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


VERSION_FILE_CANDIDATES = (
    Path("/app/VERSION"),
    Path(__file__).resolve().parents[3] / "VERSION",
)


def _read_version_file() -> str:
    for path in VERSION_FILE_CANDIDATES:
        try:
            version = path.read_text().strip()
            if version:
                return version
        except OSError:
            continue
    return os.getenv("APP_VERSION", "dev")


def installed_app_version(configured_version: str | None = None) -> str:
    version = _read_version_file()
    if version != "dev":
        return version
    return (configured_version or os.getenv("APP_VERSION") or version).strip() or "dev"


class Settings(BaseSettings):
    app_env: str = Field(default="development", alias="APP_ENV")
    database_url: str = Field(
        default="sqlite:////app/data/netmap.db",
        alias="DATABASE_URL",
    )
    secret_key: str | None = Field(default=None, alias="SECRET_KEY")
    secret_key_file: str | None = Field(default=None, alias="SECRET_KEY_FILE")
    master_key: str | None = Field(default=None, alias="MASTER_KEY")
    master_key_file: str | None = Field(default=None, alias="MASTER_KEY_FILE")
    cors_origins: list[str] = Field(
        default=["http://localhost:8080", "http://localhost:5173"],
        alias="CORS_ORIGINS",
    )
    data_dir: str = Field(default="/app/data", alias="DATA_DIR")
    event_retention_days: int = Field(default=7, alias="EVENT_RETENTION_DAYS")
    firewall_log_retention_days: int = Field(default=7, alias="FIREWALL_LOG_RETENTION_DAYS")
    syslog_enabled: bool = Field(default=True, alias="SYSLOG_ENABLED")
    syslog_udp_enabled: bool = Field(default=True, alias="SYSLOG_UDP_ENABLED")
    syslog_tcp_enabled: bool = Field(default=True, alias="SYSLOG_TCP_ENABLED")
    syslog_host: str = Field(default="0.0.0.0", alias="SYSLOG_HOST")
    syslog_udp_port: int = Field(default=1514, alias="SYSLOG_UDP_PORT")
    syslog_tcp_port: int = Field(default=1514, alias="SYSLOG_TCP_PORT")
    syslog_tls_enabled: bool = Field(default=False, alias="SYSLOG_TLS_ENABLED")
    syslog_tls_port: int = Field(default=6514, alias="SYSLOG_TLS_PORT")
    syslog_tls_certfile: str | None = Field(default=None, alias="SYSLOG_TLS_CERTFILE")
    syslog_tls_keyfile: str | None = Field(default=None, alias="SYSLOG_TLS_KEYFILE")
    syslog_sender_allowlist: list[str] = Field(default=[], alias="SYSLOG_SENDER_ALLOWLIST")
    syslog_max_line_bytes: int = Field(default=8192, alias="SYSLOG_MAX_LINE_BYTES")
    syslog_max_tcp_connections: int = Field(default=50, alias="SYSLOG_MAX_TCP_CONNECTIONS")
    syslog_ws_max_connections: int = Field(default=50, alias="SYSLOG_WS_MAX_CONNECTIONS")
    access_token_minutes: int = Field(default=60, alias="ACCESS_TOKEN_MINUTES")
    idle_timeout_minutes: int = Field(default=15, alias="IDLE_TIMEOUT_MINUTES")
    refresh_token_days: int = Field(default=7, alias="REFRESH_TOKEN_DAYS")
    auth_max_failed_attempts: int = Field(default=5, alias="AUTH_MAX_FAILED_ATTEMPTS")
    auth_lockout_minutes: int = Field(default=15, alias="AUTH_LOCKOUT_MINUTES")
    auth_progressive_delay_seconds: float = Field(default=0.5, alias="AUTH_PROGRESSIVE_DELAY_SECONDS")
    auth_ip_lockout_enabled: bool = Field(default=False, alias="AUTH_IP_LOCKOUT_ENABLED")
    discovery_scan_timeout_seconds: int = Field(default=60, alias="DISCOVERY_SCAN_TIMEOUT_SECONDS")
    discovery_rate_limit_seconds: int = Field(default=60, alias="DISCOVERY_RATE_LIMIT_SECONDS")
    discovery_max_hosts_without_confirmation: int = Field(
        default=256,
        alias="DISCOVERY_MAX_HOSTS_WITHOUT_CONFIRMATION",
    )
    discovery_max_hosts: int = Field(default=1024, alias="DISCOVERY_MAX_HOSTS")
    tool_rate_limit_max_calls: int = Field(default=20, alias="TOOL_RATE_LIMIT_MAX_CALLS")
    tool_rate_limit_window_seconds: int = Field(default=60, alias="TOOL_RATE_LIMIT_WINDOW_SECONDS")
    active_network_public_targets_enabled: bool = Field(
        default=False,
        alias="ACTIVE_NETWORK_PUBLIC_TARGETS_ENABLED",
    )
    trusted_proxy_ips: list[str] = Field(default=[], alias="TRUSTED_PROXY_IPS")
    trusted_hosts: list[str] = Field(default=[], alias="TRUSTED_HOSTS")
    secure_headers_enabled: bool = Field(default=True, alias="SECURE_HEADERS_ENABLED")
    secure_hsts_enabled: bool = Field(default=False, alias="SECURE_HSTS_ENABLED")
    auth_cookie_secure: bool = Field(default=False, alias="AUTH_COOKIE_SECURE")
    secure_hsts_max_age: int = Field(default=31536000, alias="SECURE_HSTS_MAX_AGE")
    secure_content_security_policy: str = Field(
        default=(
            "default-src 'self'; "
            "base-uri 'self'; "
            "frame-ancestors 'none'; "
            "img-src 'self' data: blob:; "
            "object-src 'none'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "connect-src 'self' ws: wss:; "
            "font-src 'self' data:"
        ),
        alias="SECURE_CONTENT_SECURITY_POLICY",
    )
    secure_referrer_policy: str = Field(
        default="strict-origin-when-cross-origin",
        alias="SECURE_REFERRER_POLICY",
    )
    secure_permissions_policy: str = Field(
        default="camera=(), geolocation=(), microphone=()",
        alias="SECURE_PERMISSIONS_POLICY",
    )
    notification_block_private_targets: bool = Field(default=False, alias="NOTIFICATION_BLOCK_PRIVATE_TARGETS")
    app_url: str = Field(default="", alias="APP_URL")
    log_level: str = Field(default="info", alias="LOG_LEVEL")
    app_version: str = Field(default_factory=_read_version_file, alias="APP_VERSION")

    model_config = SettingsConfigDict(
        env_file=(".env", "/etc/netmap/netmap.env"),
        env_file_encoding="utf-8",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

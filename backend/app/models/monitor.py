from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class Monitor(Base):
    """A standalone HTTP/HTTPS uptime monitor, independent of any inventory device."""

    __tablename__ = "monitors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    http_method: Mapped[str] = mapped_column(String(10), nullable=False, default="GET")
    expected_status_min: Mapped[int] = mapped_column(Integer, nullable=False, default=200)
    expected_status_max: Mapped[int] = mapped_column(Integer, nullable=False, default=399)
    timeout_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=10.0)
    # public-facing targets are expected to have valid certs, unlike LAN device checks
    verify_tls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    follow_redirects: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    max_redirects: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    accepted_status_codes: Mapped[str] = mapped_column(String(255), nullable=False, default="200-399")
    request_headers_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_body_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    body_encoding: Mapped[str] = mapped_column(String(20), nullable=False, default="json")
    auth_type: Mapped[str] = mapped_column(String(20), nullable=False, default="none")
    auth_username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    auth_password_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    bearer_token_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    oauth_token_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    oauth_client_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    oauth_client_secret_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    oauth_scopes: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    oauth_audience: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    oauth_auth_method: Mapped[str] = mapped_column(String(30), nullable=False, default="client_secret_basic")
    proxy_url_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    tls_ca_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    tls_cert_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    tls_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    keyword: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    keyword_inverted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    json_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    json_operator: Mapped[str] = mapped_column(String(20), nullable=False, default="equals")
    expected_value: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    cache_bust: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    upside_down: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    check_interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    # consecutive failures required before flipping to "offline" (flap dampening)
    max_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    retry_interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=20)
    certificate_expiry_alert: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    certificate_expiry_days: Mapped[int] = mapped_column(Integer, nullable=False, default=14)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # runtime state, updated by StandaloneMonitorService on every check
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_cert_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_cert_issuer: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class MonitorCheckHistory(Base):
    __tablename__ = "monitor_check_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    monitor_id: Mapped[int] = mapped_column(Integer, ForeignKey("monitors.id", ondelete="CASCADE"), index=True, nullable=False)
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
        nullable=False,
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    response_time_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(String(255), nullable=True)
    assertion_detail: Mapped[str | None] = mapped_column(String(255), nullable=True)
    response_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cert_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

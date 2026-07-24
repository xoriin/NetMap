from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class Monitor(Base):
    """A standalone HTTP/HTTPS uptime monitor, independent of any inventory device."""

    __tablename__ = "monitors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    http_method: Mapped[str] = mapped_column(String(10), nullable=False, default="GET")
    expected_status_min: Mapped[int] = mapped_column(Integer, nullable=False, default=200)
    expected_status_max: Mapped[int] = mapped_column(Integer, nullable=False, default=399)
    timeout_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=10.0)
    # public-facing targets are expected to have valid certs, unlike LAN device checks
    verify_tls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    follow_redirects: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    check_interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    # consecutive failures required before flipping to "offline" (flap dampening)
    max_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # runtime state, updated by StandaloneMonitorService on every check
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

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

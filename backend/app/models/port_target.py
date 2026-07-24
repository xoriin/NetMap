from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class DevicePortTarget(Base):
    __tablename__ = "device_port_targets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    # null device_id = apply to all devices
    device_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=True, index=True)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(String(60), nullable=False)
    check_type: Mapped[str] = mapped_column(String(20), nullable=False, default="tcp")
    # http/https checks only: request path, defaults to "/"
    http_path: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # http/https checks only
    http_method: Mapped[str] = mapped_column(String(10), nullable=False, default="GET")
    expected_status_min: Mapped[int] = mapped_column(Integer, nullable=False, default=200)
    expected_status_max: Mapped[int] = mapped_column(Integer, nullable=False, default=399)
    # null = fall back to the monitor's default HTTP timeout
    timeout_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    verify_tls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    follow_redirects: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

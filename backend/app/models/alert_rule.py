from datetime import datetime, timezone
from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from app.db.session import Base

class AlertRule(Base):
    __tablename__ = "alert_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    event_type: Mapped[str] = mapped_column(String(40), nullable=False)
    # null = all devices, set = specific device
    device_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # service_down / service_slow rules only: null = any service check, set = one specific check
    port_target_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    channels: Mapped[str] = mapped_column(Text, default="[]", nullable=False)  # JSON array
    cooldown_minutes: Mapped[int] = mapped_column(Integer, default=30, nullable=False)
    # rtt_above rules only: fire when a device's probe RTT exceeds this many ms
    # service_slow rules: fire when a service check's response time exceeds this many ms
    threshold_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # ping_loss_above rules only: fire when the % of failed probes over the
    # trailing loss_window_minutes reaches loss_pct_threshold
    loss_pct_threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    loss_window_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
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

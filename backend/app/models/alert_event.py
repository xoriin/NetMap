from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AlertEvent(Base):
    __tablename__ = "alert_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    alert_rule_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("alert_rules.id", ondelete="SET NULL"), nullable=True)
    alert_rule_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    device_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("devices.id", ondelete="SET NULL"), nullable=True)
    event_type: Mapped[str] = mapped_column(String(60), nullable=False)
    fired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")

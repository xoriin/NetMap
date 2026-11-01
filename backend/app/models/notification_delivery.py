from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class NotificationDelivery(Base):
    __tablename__ = "notification_deliveries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    rule_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    device_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # channel or "profile:<id>" target string, as stored on the alert rule
    target: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False)  # sent | failed
    detail: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # what was sent, the trigger and the device/endpoint name at the time (empty before 0093)
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    event_type: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    source_label: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )

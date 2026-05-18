from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class DevicePortTarget(Base):
    __tablename__ = "device_port_targets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    # null device_id = apply to all devices
    device_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=True, index=True)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    label: Mapped[str] = mapped_column(String(60), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

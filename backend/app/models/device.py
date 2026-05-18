from datetime import datetime, timezone
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from typing import Optional

from app.db.session import Base


class DeviceStatus(StrEnum):
    ONLINE = "online"
    OFFLINE = "offline"
    WARNING = "warning"
    UNKNOWN = "unknown"
    DISABLED = "disabled"


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ip_address: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    mac_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    vendor: Mapped[str | None] = mapped_column(String(120), nullable=True)
    device_type: Mapped[str | None] = mapped_column(String(80), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default=DeviceStatus.UNKNOWN, nullable=False)
    monitor_status: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, default=None)
    last_monitored_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    is_favourite: Mapped[Optional[bool]] = mapped_column(nullable=True, default=False)
    icon: Mapped[str] = mapped_column(String(40), default="device", nullable=False)
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    vlan_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    subnet: Mapped[str | None] = mapped_column(String(64), nullable=True)
    topology_group_id: Mapped[int | None] = mapped_column(ForeignKey("topology_groups.id"), nullable=True, index=True)
    topology_group: Mapped[str | None] = mapped_column(String(120), nullable=True)
    group = relationship("TopologyGroup", back_populates="devices")
    site_id: Mapped[int | None] = mapped_column(ForeignKey("sites.id"), nullable=True, index=True)
    site = relationship("Site", back_populates="devices")
    tags: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
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

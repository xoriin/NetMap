from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class FirewallEvent(Base):
    __tablename__ = "firewall_events"
    __table_args__ = (
        Index("ix_firewall_events_received_at_id", "received_at", "id"),
        Index("ix_firewall_events_event_time_id", "event_time", "id"),
        Index("ix_firewall_events_src_ip_received_at", "src_ip", "received_at"),
        Index("ix_firewall_events_dst_ip_received_at", "dst_ip", "received_at"),
        Index("ix_firewall_events_action_received_at", "action", "received_at"),
        Index("ix_firewall_events_interface_received_at", "interface", "received_at"),
        Index("ix_firewall_events_protocol_received_at", "protocol", "received_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
        nullable=False,
    )
    event_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        index=True,
        nullable=True,
    )
    source_host: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    src_ip: Mapped[str | None] = mapped_column(String(45), index=True, nullable=True)
    dst_ip: Mapped[str | None] = mapped_column(String(45), index=True, nullable=True)
    src_port: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    dst_port: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    protocol: Mapped[str | None] = mapped_column(String(20), index=True, nullable=True)
    action: Mapped[str | None] = mapped_column(String(40), index=True, nullable=True)
    interface: Mapped[str | None] = mapped_column(String(80), index=True, nullable=True)
    direction: Mapped[str | None] = mapped_column(String(20), nullable=True)
    rule_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    tracker_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw_log: Mapped[str] = mapped_column(Text, nullable=False)

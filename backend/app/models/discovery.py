from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class DiscoveryScan(Base):
    __tablename__ = "discovery_scans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    schedule_id: Mapped[int | None] = mapped_column(ForeignKey("discovery_schedules.id", ondelete="SET NULL"), index=True, nullable=True)
    target: Mapped[str] = mapped_column(String(255), nullable=False)
    scan_type: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(40), index=True, nullable=False)
    host_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    result_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    results_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
        nullable=False,
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    progress_done: Mapped[int | None] = mapped_column(Integer, nullable=True)


class DiscoverySchedule(Base):
    __tablename__ = "discovery_schedules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    target: Mapped[str] = mapped_column(String(255), nullable=False)
    scan_type: Mapped[str] = mapped_column(String(40), nullable=False, default="ping")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    interval_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=1440)
    confirm_large_scan: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    topology_group_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("topology_groups.id", ondelete="SET NULL"), nullable=True)
    site_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("sites.id", ondelete="SET NULL"), nullable=True)
    snmp_profile_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("snmp_profiles.id", ondelete="SET NULL"), nullable=True)
    snmp_targets_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    notification_targets_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True, nullable=True)
    last_scan_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("discovery_scans.id", ondelete="SET NULL"), nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class DiscoveryObservation(Base):
    __tablename__ = "discovery_observations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    schedule_id: Mapped[int] = mapped_column(Integer, ForeignKey("discovery_schedules.id", ondelete="CASCADE"), index=True, nullable=False)
    scan_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("discovery_scans.id", ondelete="SET NULL"), index=True, nullable=True)
    device_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("devices.id", ondelete="SET NULL"), index=True, nullable=True)
    observation_type: Mapped[str] = mapped_column(String(40), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(20), index=True, nullable=False, default="open")
    ip_address: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    mac_address: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    summary: Mapped[str] = mapped_column(String(255), nullable=False)
    details_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
        nullable=False,
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

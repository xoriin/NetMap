from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ExternalIpPool(Base):
    __tablename__ = "external_ip_pools"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # Ranges live in `external_ip_ranges`. The pool no longer carries a privileged
    # "primary" CIDR of its own — it is purely an allocation source (migration 0071).
    provider_id: Mapped[int | None] = mapped_column(
        ForeignKey("cloud_providers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    account: Mapped[str | None] = mapped_column(String(120), nullable=True)
    region: Mapped[str | None] = mapped_column(String(120), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False
    )


class ExternalIpRange(Base):
    __tablename__ = "external_ip_ranges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    pool_id: Mapped[int] = mapped_column(
        ForeignKey("external_ip_pools.id", ondelete="CASCADE"), nullable=False, index=True
    )
    cidr: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)


class ExternalIpAssignment(Base):
    __tablename__ = "external_ip_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    pool_id: Mapped[int] = mapped_column(
        ForeignKey("external_ip_pools.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ip_address: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    device_id: Mapped[int | None] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # DEPRECATED (migration 0072): superseded by `device_id`. A cloud asset is an
    # inventory device, so the separate `cloud_assets` record was one indirection too
    # many. Retained for one release as a rollback path.
    asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("cloud_assets.id", ondelete="SET NULL"), nullable=True, index=True
    )
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="in_use", index=True)
    # DEPRECATED (migration 0070): provider/account/service moved to `cloud_assets`.
    # Retained for one release as a rollback path; no longer written by the API.
    provider: Mapped[str | None] = mapped_column(String(80), nullable=True)
    account: Mapped[str | None] = mapped_column(String(120), nullable=True)
    owner: Mapped[str | None] = mapped_column(String(120), nullable=True)
    service: Mapped[str | None] = mapped_column(String(120), nullable=True)
    tags: Mapped[str | None] = mapped_column(String(500), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False
    )

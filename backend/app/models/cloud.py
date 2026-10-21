import re
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


# Icon identifiers accepted for a cloud provider. `custom` pairs with `icon_data`.
CLOUD_PROVIDER_ICONS = ("aws", "azure", "google_cloud", "cloudflare", "cloud", "globe", "custom")

# Built-in asset types plus normalised user-added custom types (`cloud_asset_types`), like device types.
BUILT_IN_CLOUD_ASSET_TYPES = (
    ("server", "Server"),
    ("load_balancer", "Load balancer"),
    ("database", "Database"),
    ("storage", "Storage"),
    ("network", "Network"),
    ("other", "Other"),
)
BUILT_IN_CLOUD_ASSET_TYPE_VALUES = frozenset(value for value, _ in BUILT_IN_CLOUD_ASSET_TYPES)


def normalize_cloud_asset_type_value(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")[:40].strip("_")


class CloudAssetType(Base):
    __tablename__ = "cloud_asset_types"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    value: Mapped[str] = mapped_column(String(40), nullable=False, unique=True, index=True)
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class CloudProvider(Base):
    """A cloud or hosting provider.

    Replaces the free-text `provider` string that used to live on both
    `external_ip_pools` and `external_ip_assignments`, plus the JSON catalogue
    that was stored in the `cloud_provider_catalog` system setting. Provider
    identity is now referential, so renaming one no longer splits its group.
    """

    __tablename__ = "cloud_providers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    key: Mapped[str] = mapped_column(String(60), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    # JSON array of alternate names used to auto-match a provider on import.
    aliases: Mapped[str | None] = mapped_column(Text, nullable=True)
    icon: Mapped[str] = mapped_column(String(40), nullable=False, default="cloud")
    icon_data: Mapped[str | None] = mapped_column(Text, nullable=True)
    builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class CloudAsset(Base):
    """A cloud resource that consumes one or more public addresses.

    This is the tier the original model was missing: an EC2 instance, VM, or load
    balancer holding several addresses. `external_ip_assignments.asset_id` points
    here, while `pool_id` continues to record which allocation an address came
    from — "what uses it" and "where it came from" are separate relationships.

    `device_id` is an optional bridge into inventory. It is nullable on purpose:
    a NAT gateway or CDN endpoint should be groupable here without being probed,
    counted as a device, or shown in the health donut.
    """

    __tablename__ = "cloud_assets"
    __table_args__ = (UniqueConstraint("provider_id", "account", "name", name="uq_cloud_assets_identity"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str | None] = mapped_column(String(40), nullable=True)
    provider_id: Mapped[int | None] = mapped_column(
        ForeignKey("cloud_providers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    account: Mapped[str | None] = mapped_column(String(120), nullable=True)
    region: Mapped[str | None] = mapped_column(String(120), nullable=True)
    device_id: Mapped[int | None] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

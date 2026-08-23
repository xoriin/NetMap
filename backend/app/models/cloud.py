from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


# Icon identifiers accepted for a cloud provider. `custom` pairs with `icon_data`.
CLOUD_PROVIDER_ICONS = ("aws", "azure", "google_cloud", "cloudflare", "cloud", "globe", "custom")

# Asset kinds. Fixed rather than user-extensible, mirroring the built-in device-type
# constants in `api/v1/admin.py` — a free-text kind is what produced the original
# "EC2 typed into the account field" problem this table exists to fix.
CLOUD_ASSET_KINDS = (
    "ec2",
    "vm",
    "load_balancer",
    "nat_gateway",
    "k8s_ingress",
    "database",
    "storage",
    "cdn",
    "other",
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

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint, func, text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

OPEN_INCIDENT_DEFAULT_EVENTS = {"device_offline", "device_unexpected_state", "service_down", "monitor_down"}

_SOURCE_SHAPE = (
    "(kind = 'device' AND device_id IS NOT NULL AND monitor_id IS NULL AND port_target_id IS NULL) OR "
    "(kind = 'monitor' AND monitor_id IS NOT NULL AND device_id IS NULL AND port_target_id IS NULL) OR "
    "(kind = 'service_check' AND device_id IS NOT NULL AND port_target_id IS NOT NULL AND monitor_id IS NULL)"
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), default=_now, nullable=False)


class StatusPage(Base):
    __tablename__ = "status_pages"
    __table_args__ = (
        CheckConstraint("visibility IN ('public', 'private')", name="ck_status_pages_visibility"),
        CheckConstraint("heartbeat_window IN ('1h', '24h')", name="ck_status_pages_heartbeat_window"),
        CheckConstraint(
            "length(slug) BETWEEN 1 AND 48 AND slug NOT GLOB '*[^a-z0-9-]*'", name="ck_status_pages_slug"
        ),
        CheckConstraint("accent IS NULL OR accent GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'", name="ck_status_pages_accent"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    slug: Mapped[str] = mapped_column(String(48), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    visibility: Mapped[str] = mapped_column(String(10), default="public", nullable=False)
    heartbeat_window: Mapped[str] = mapped_column(String(4), default="1h", nullable=False)
    logo: Mapped[str | None] = mapped_column(Text, nullable=True)
    accent: Mapped[str | None] = mapped_column(String(7), nullable=True)
    custom_css: Mapped[str | None] = mapped_column(Text, nullable=True)
    generation: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)


class StatusPageGroup(Base):
    __tablename__ = "status_page_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    collapsed_by_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class StatusPageItem(Base):
    __tablename__ = "status_page_items"
    __table_args__ = (
        CheckConstraint(_SOURCE_SHAPE, name="ck_status_page_items_shape"),
        CheckConstraint("length(display_name) > 0", name="ck_status_page_items_display_name"),
        Index(
            "uq_status_page_items_source",
            "page_id", "kind", func.coalesce(text("device_id"), 0), func.coalesce(text("monitor_id"), 0),
            func.coalesce(text("port_target_id"), 0),
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), index=True, nullable=False)
    group_id: Mapped[int] = mapped_column(ForeignKey("status_page_groups.id", ondelete="CASCADE"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True, nullable=True)
    monitor_id: Mapped[int | None] = mapped_column(ForeignKey("monitors.id", ondelete="CASCADE"), index=True, nullable=True)
    port_target_id: Mapped[int | None] = mapped_column(
        ForeignKey("device_port_targets.id", ondelete="CASCADE"), index=True, nullable=True
    )
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    extras: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)


class StatusIncident(Base):
    __tablename__ = "status_incidents"
    __table_args__ = (
        CheckConstraint("source IN ('netmap', 'person', 'token')", name="ck_status_incidents_source"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), default="minor", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="investigating", nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(10), nullable=False)
    condition_family: Mapped[str | None] = mapped_column(String(40), nullable=True)
    ticket_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    ticket_label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    opened_by_rule_id: Mapped[int | None] = mapped_column(ForeignKey("alert_rules.id", ondelete="SET NULL"), nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_token_id: Mapped[int | None] = mapped_column(
        ForeignKey("status_integration_tokens.id", ondelete="SET NULL"), nullable=True
    )
    resolution_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StatusIncidentSource(Base):
    __tablename__ = "status_incident_sources"
    __table_args__ = (
        Index(
            "uq_status_incident_sources_active",
            "source_key", "condition_family", "page_id",
            unique=True,
            sqlite_where=text("active = 1"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    incident_id: Mapped[int] = mapped_column(ForeignKey("status_incidents.id", ondelete="CASCADE"), index=True, nullable=False)
    source_key: Mapped[str] = mapped_column(String(80), nullable=False)
    condition_family: Mapped[str] = mapped_column(String(40), nullable=False)
    page_id: Mapped[int] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), index=True, nullable=False)
    rule_id: Mapped[int | None] = mapped_column(ForeignKey("alert_rules.id", ondelete="SET NULL"), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    cleared: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class StatusIncidentPage(Base):
    __tablename__ = "status_incident_pages"

    incident_id: Mapped[int] = mapped_column(ForeignKey("status_incidents.id", ondelete="CASCADE"), primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), primary_key=True)


class StatusIncidentUpdate(Base):
    __tablename__ = "status_incident_updates"
    __table_args__ = (
        CheckConstraint("author_kind IN ('netmap', 'person', 'token')", name="ck_status_incident_updates_author"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    incident_id: Mapped[int] = mapped_column(ForeignKey("status_incidents.id", ondelete="CASCADE"), index=True, nullable=False)
    page_id: Mapped[int | None] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), nullable=True)
    created_at: Mapped[datetime] = _created_at()
    author_kind: Mapped[str] = mapped_column(String(10), nullable=False)
    author_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    author_token_id: Mapped[int | None] = mapped_column(
        ForeignKey("status_integration_tokens.id", ondelete="SET NULL"), nullable=True
    )
    author_label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    event_code: Mapped[str | None] = mapped_column(String(60), nullable=True)
    event_data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_public: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    status_change: Mapped[str | None] = mapped_column(String(20), nullable=True)


class StatusIncidentAlias(Base):
    __tablename__ = "status_incident_aliases"
    __table_args__ = (UniqueConstraint("incident_id", "page_id", "source_key", name="uq_status_incident_aliases"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    incident_id: Mapped[int] = mapped_column(ForeignKey("status_incidents.id", ondelete="CASCADE"), index=True, nullable=False)
    page_id: Mapped[int] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), nullable=False)
    source_key: Mapped[str] = mapped_column(String(80), nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)


class StatusBreachStreak(Base):
    __tablename__ = "status_breach_streaks"
    __table_args__ = (UniqueConstraint("rule_id", "source_key", "page_id", name="uq_status_breach_streaks"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    rule_id: Mapped[int] = mapped_column(ForeignKey("alert_rules.id", ondelete="CASCADE"), nullable=False)
    source_key: Mapped[str] = mapped_column(String(80), nullable=False)
    page_id: Mapped[int] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), nullable=False)
    streak: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rule_version: Mapped[str | None] = mapped_column(String(40), nullable=True)
    resolution_latched: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class StatusIntegrationToken(Base):
    __tablename__ = "status_integration_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    prefix: Mapped[str] = mapped_column(String(16), index=True, nullable=False)
    hash: Mapped[str] = mapped_column(String(128), nullable=False)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = _created_at()
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StatusIntegrationTokenPage(Base):
    __tablename__ = "status_integration_token_pages"

    token_id: Mapped[int] = mapped_column(ForeignKey("status_integration_tokens.id", ondelete="CASCADE"), primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), primary_key=True)


class StatusNotice(Base):
    __tablename__ = "status_notices"
    __table_args__ = (
        UniqueConstraint("page_id", "owner_kind", "owner_id", name="uq_status_notices_owner"),
        CheckConstraint("owner_kind IN ('user', 'token')", name="ck_status_notices_owner_kind"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), index=True, nullable=False)
    owner_kind: Mapped[str] = mapped_column(String(10), nullable=False)
    owner_id: Mapped[int] = mapped_column(Integer, nullable=False)
    level: Mapped[str] = mapped_column(String(20), default="info", nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    link: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    author: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = _created_at()
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StatusMaintenance(Base):
    __tablename__ = "status_maintenance"
    __table_args__ = (CheckConstraint("ends_at > starts_at", name="ck_status_maintenance_window"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True, nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True, nullable=False)
    suppress_alerts: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    exit_processed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_token_id: Mapped[int | None] = mapped_column(
        ForeignKey("status_integration_tokens.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = _created_at()


class StatusMaintenanceItem(Base):
    __tablename__ = "status_maintenance_items"
    __table_args__ = (
        CheckConstraint(_SOURCE_SHAPE, name="ck_status_maintenance_items_shape"),
        Index(
            "uq_status_maintenance_items_source",
            "maintenance_id", "kind", func.coalesce(text("device_id"), 0), func.coalesce(text("monitor_id"), 0),
            func.coalesce(text("port_target_id"), 0),
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    maintenance_id: Mapped[int] = mapped_column(ForeignKey("status_maintenance.id", ondelete="CASCADE"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), nullable=True)
    monitor_id: Mapped[int | None] = mapped_column(ForeignKey("monitors.id", ondelete="CASCADE"), nullable=True)
    port_target_id: Mapped[int | None] = mapped_column(ForeignKey("device_port_targets.id", ondelete="CASCADE"), nullable=True)


class StatusMaintenancePage(Base):
    __tablename__ = "status_maintenance_pages"

    maintenance_id: Mapped[int] = mapped_column(ForeignKey("status_maintenance.id", ondelete="CASCADE"), primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("status_pages.id", ondelete="CASCADE"), primary_key=True)


class StatusIdempotencyKey(Base):
    __tablename__ = "status_idempotency_keys"
    __table_args__ = (UniqueConstraint("token_id", "operation", "key", name="uq_status_idempotency_keys"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    token_id: Mapped[int] = mapped_column(ForeignKey("status_integration_tokens.id", ondelete="CASCADE"), nullable=False)
    operation: Mapped[str] = mapped_column(String(60), nullable=False)
    key: Mapped[str] = mapped_column(String(120), nullable=False)
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _created_at()

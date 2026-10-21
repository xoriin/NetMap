import re
from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.image_validation import validate_email_logo_data_uri
from app.services.status_pages.sources import SourceRef

SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$")
ACCENT_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

Visibility = Literal["public", "private"]
HeartbeatWindow = Literal["1h", "24h"]


def _slug(value: str) -> str:
    if not SLUG_RE.fullmatch(value):
        raise ValueError("Slug must be 1-48 lowercase letters, digits or hyphens, not starting or ending with a hyphen")
    return value


def _accent(value: str | None) -> str | None:
    if value is None:
        return None
    if not ACCENT_RE.fullmatch(value):
        raise ValueError("Accent must be a #rrggbb colour")
    return value.lower()


def _logo(value: str | None) -> str | None:
    return None if value is None else validate_email_logo_data_uri(value)


class StatusPageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    slug: str
    visibility: Visibility = "public"
    title: str | None = Field(default=None, max_length=200)
    accent: str | None = None
    heartbeat_window: HeartbeatWindow = "1h"
    logo: str | None = None

    @field_validator("slug")
    @classmethod
    def _check_slug(cls, value: str) -> str:
        return _slug(value)

    @field_validator("accent")
    @classmethod
    def _check_accent(cls, value: str | None) -> str | None:
        return _accent(value)

    @field_validator("logo")
    @classmethod
    def _check_logo(cls, value: str | None) -> str | None:
        return _logo(value)

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name is required")
        return value


class StatusPageUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    slug: str | None = None
    visibility: Visibility | None = None
    title: str | None = Field(default=None, max_length=200)
    accent: str | None = None
    heartbeat_window: HeartbeatWindow | None = None
    logo: str | None = None
    custom_css: str | None = Field(default=None, max_length=200_000)

    @field_validator("accent")
    @classmethod
    def _check_accent(cls, value: str | None) -> str | None:
        return _accent(value)

    @field_validator("logo")
    @classmethod
    def _check_logo(cls, value: str | None) -> str | None:
        return _logo(value)

    @field_validator("slug")
    @classmethod
    def _check_slug(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("Slug cannot be cleared")
        return _slug(value)

    @field_validator("name", "visibility", "heartbeat_window")
    @classmethod
    def _not_null(cls, value):
        if value is None:
            raise ValueError("This field cannot be cleared")
        if isinstance(value, str) and not value.strip():
            raise ValueError("This field is required")
        return value.strip() if isinstance(value, str) else value


class StatusPageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    name: str
    title: str | None
    visibility: Visibility
    heartbeat_window: HeartbeatWindow
    logo: str | None
    accent: str | None
    custom_css: str | None
    created_at: datetime
    updated_at: datetime


class ItemExtras(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rtt_graph: bool = False
    uptime_period: Literal["24h", "7d", "30d"] | None = None
    avg_response: bool = False
    p95_response: bool = False
    failure_rate: bool = False
    last_check: bool = False


class ItemSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device: int | None = Field(default=None, ge=1)
    monitor: int | None = Field(default=None, ge=1)
    service_check: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _shape(self):
        shape = (self.device is not None, self.monitor is not None, self.service_check is not None)
        if shape not in {(True, False, False), (False, True, False), (True, False, True)}:
            raise ValueError("Source must be {device}, {monitor} or {device, service_check}")
        return self

    def to_ref(self) -> SourceRef:
        if self.monitor is not None:
            return SourceRef("monitor", monitor_id=self.monitor)
        if self.service_check is not None:
            return SourceRef("service_check", device_id=self.device, port_target_id=self.service_check)
        return SourceRef("device", device_id=self.device)



class LayoutItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int | None = None
    source: ItemSource
    display_name: str = Field(min_length=1, max_length=200)
    extras: ItemExtras = Field(default_factory=ItemExtras)

    @field_validator("display_name")
    @classmethod
    def _display_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Display name is required")
        return value


class LayoutGroup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int | None = None
    name: str = Field(min_length=1, max_length=120)
    collapsed_by_default: bool = False
    items: list[LayoutItem] = Field(default_factory=list, max_length=500)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Group name is required")
        return value


class LayoutUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    groups: list[LayoutGroup] = Field(max_length=100)


class LayoutItemRead(BaseModel):
    id: int
    source: dict[str, int]
    source_key: str
    display_name: str
    extras: ItemExtras


class LayoutGroupRead(BaseModel):
    id: int
    name: str
    collapsed_by_default: bool
    items: list[LayoutItemRead]


class StatusPageDetail(StatusPageRead):
    groups: list[LayoutGroupRead]


IncidentSeverity = Literal["performance", "partial", "major"]
IncidentStatus = Literal["investigating", "identified", "monitoring", "resolved"]
NoticeLevel = Literal["info", "warning", "critical"]


class TicketInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(max_length=2048)
    label: str | None = Field(default=None, max_length=120)


class IncidentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(max_length=200)
    severity: IncidentSeverity
    message: str = Field(max_length=5000)
    is_public: bool = True
    page_ids: list[int] = Field(min_length=1, max_length=100)
    items: list[ItemSource] = Field(default_factory=list, max_length=500)
    ticket: TicketInput | None = None


class IncidentUpdateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str | None = Field(default=None, max_length=5000)
    is_public: bool = True
    page_id: int | None = None
    status_change: IncidentStatus | None = None
    ticket: TicketInput | None = None


class IncidentResolve(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=500)


class IncidentPublish(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_ids: list[int] = Field(min_length=1, max_length=100)


class NoticeSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    level: NoticeLevel = "info"
    title: str = Field(max_length=200)
    body: str | None = Field(default=None, max_length=2000)
    link: str | None = Field(default=None, max_length=2048)
    expires_at: datetime | None = None


class NoticeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    page_id: int
    owner_kind: str
    level: NoticeLevel
    title: str
    body: str | None
    link: str | None
    author: str | None
    created_at: datetime
    expires_at: datetime | None


class NoticeManagerRead(NoticeRead):
    owner_id: int
    mine: bool
    token_active: bool | None


class TokenCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        max_length=120,
        description="Shown publicly as the author of this token's notices and incident updates, e.g. 'backup-server'.",
    )
    page_ids: list[int] = Field(min_length=1, max_length=100)
    expires_at: datetime | None = None


class TokenRead(BaseModel):
    id: int
    name: str
    prefix: str
    page_ids: list[int]
    created_by: str | None
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None
    active: bool


class TokenCreated(TokenRead):
    secret: str = Field(description="Shown once. Send it as 'Authorization: Bearer <secret>'.")
    name_is_public: bool = Field(
        default=True, description="The token name is shown publicly as the author label on status pages.",
    )


class IntegrationIncidentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(max_length=200)
    severity: IncidentSeverity
    message: str = Field(max_length=5000)
    items: list[ItemSource] = Field(default_factory=list, max_length=500)
    pages: list[str] = Field(default_factory=list, max_length=100)
    ticket_url: str | None = Field(default=None, max_length=2048)
    ticket_label: str | None = Field(default=None, max_length=120)
    is_public: bool = True

    @model_validator(mode="after")
    def _audience(self):
        if bool(self.items) == bool(self.pages):
            raise ValueError("Give either items or pages")
        if self.ticket_label is not None and self.ticket_url is None:
            raise ValueError("A ticket label needs a ticket_url")
        return self


class IntegrationIncidentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str | None = Field(default=None, max_length=5000)
    status: IncidentStatus | None = None
    ticket_url: str | None = Field(default=None, max_length=2048)
    ticket_label: str | None = Field(default=None, max_length=120)
    is_public: bool = True

    @model_validator(mode="after")
    def _ticket(self):
        if self.ticket_label is not None and self.ticket_url is None:
            raise ValueError("A ticket label needs a ticket_url")
        return self


class MaintenanceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    starts_at: AwareDatetime
    ends_at: AwareDatetime
    items: list[ItemSource] = Field(min_length=1, max_length=500)
    page_ids: list[int] | None = Field(
        default=None, max_length=100, description="Pages that announce the window; omit for every page showing an affected item.",
    )
    suppress_alerts: bool = Field(
        default=False, description="Also suppress monitoring alerts for these items throughout NetMap. Requires Manage alert rules.",
    )


class MaintenanceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None
    items: list[ItemSource] | None = Field(default=None, min_length=1, max_length=500)
    page_ids: list[int] | None = Field(default=None, max_length=100)
    suppress_alerts: bool | None = None

    @field_validator("title", "starts_at", "ends_at", "items", "page_ids", "suppress_alerts")
    @classmethod
    def _not_null(cls, value):
        if value is None:
            raise ValueError("This field cannot be cleared")
        return value


class IntegrationMaintenanceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    starts_at: AwareDatetime
    ends_at: AwareDatetime
    items: list[ItemSource] = Field(min_length=1, max_length=500)
    pages: list[str] | None = Field(default=None, max_length=100)
    suppress_alerts: bool = False


class IntegrationMaintenanceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None
    items: list[ItemSource] | None = Field(default=None, min_length=1, max_length=500)
    pages: list[str] | None = Field(default=None, max_length=100)
    suppress_alerts: bool | None = None

    @field_validator("title", "starts_at", "ends_at", "items", "suppress_alerts")
    @classmethod
    def _not_null(cls, value):
        if value is None:
            raise ValueError("This field cannot be cleared")
        return value


class IncidentBoardVisibility(BaseModel):
    model_config = ConfigDict(extra="forbid")

    visible: bool


class StatusPreviewDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    heartbeat_window: HeartbeatWindow | None = None
    groups: list[LayoutGroup] | None = Field(default=None, max_length=100)

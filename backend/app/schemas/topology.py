import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.validation import normalize_cidr, normalize_ip, validate_hostname, validate_mac
from app.models.device import DeviceStatus

_ICON_RE = re.compile(r'^[a-z0-9][a-z0-9_-]*$')


class DeviceBase(BaseModel):
    display_name: str | None = Field(default=None, max_length=255)
    hostname: str | None = Field(default=None, max_length=255)
    ip_address: str | None = Field(default=None, max_length=64)
    mac_address: str | None = Field(default=None, max_length=64)
    vendor: str | None = Field(default=None, max_length=120)
    device_type: str | None = Field(default=None, max_length=80)
    status: DeviceStatus = DeviceStatus.UNKNOWN
    icon: str = Field(default="device", max_length=120)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    vlan_id: str | None = Field(default=None, max_length=32)
    subnet: str | None = Field(default=None, max_length=64)
    topology_group_id: int | None = None
    topology_group: str | None = Field(default=None, max_length=120)
    site_id: int | None = None
    tags: list[str] = Field(default_factory=list, max_length=20)
    notes: str | None = Field(default=None, max_length=4000)

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, tags: list[str]) -> list[str]:
        normalized: list[str] = []
        for tag in tags:
            value = tag.strip()
            if not value:
                continue
            if len(value) > 40:
                raise ValueError("Tags must be 40 characters or fewer")
            if value not in normalized:
                normalized.append(value)
        return normalized

    @field_validator("icon")
    @classmethod
    def validate_icon(cls, icon: str) -> str:
        value = icon.strip().lower()
        if not value:
            return "device"
        if not _ICON_RE.match(value):
            raise ValueError("Icon must start with a letter or digit and contain only letters, digits, hyphens, and underscores")
        return "device" if value == "unknown" else value

class DeviceCreate(DeviceBase):
    @field_validator("ip_address")
    @classmethod
    def validate_ip_address(cls, ip_address: str | None) -> str | None:
        if ip_address is None:
            return None
        value = ip_address.strip()
        if not value:
            return None
        return normalize_ip(value)

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, display_name: str | None) -> str | None:
        if display_name is None:
            return None
        normalized = display_name.strip()
        return normalized or None

    @field_validator("hostname")
    @classmethod
    def validate_hostname_value(cls, hostname: str | None) -> str | None:
        if hostname is None:
            return None
        normalized = hostname.strip()
        return normalized or None

    @field_validator("mac_address")
    @classmethod
    def validate_mac_address(cls, mac_address: str | None) -> str | None:
        if mac_address is None:
            return None
        return validate_mac(mac_address)

    @field_validator("subnet")
    @classmethod
    def validate_subnet(cls, subnet: str | None) -> str | None:
        if subnet is None:
            return None
        return normalize_cidr(subnet)

    @field_validator("topology_group")
    @classmethod
    def validate_topology_group(cls, topology_group: str | None) -> str | None:
        if topology_group is None:
            return None
        value = topology_group.strip()
        if not value:
            return None
        return value


class DeviceUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=255)
    hostname: str | None = Field(default=None, max_length=255)
    ip_address: str | None = Field(default=None, max_length=64)
    mac_address: str | None = Field(default=None, max_length=64)
    vendor: str | None = Field(default=None, max_length=120)
    device_type: str | None = Field(default=None, max_length=80)
    status: DeviceStatus | None = None
    icon: str | None = Field(default=None, max_length=40)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    vlan_id: str | None = Field(default=None, max_length=32)
    subnet: str | None = Field(default=None, max_length=64)
    topology_group_id: int | None = None
    topology_group: str | None = Field(default=None, max_length=120)
    site_id: int | None = None
    tags: list[str] | None = Field(default=None, max_length=20)
    notes: str | None = Field(default=None, max_length=4000)

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, tags: list[str] | None) -> list[str] | None:
        if tags is None:
            return None
        return DeviceBase.normalize_tags(tags)

    @field_validator("icon")
    @classmethod
    def validate_icon(cls, icon: str | None) -> str | None:
        if icon is None:
            return None
        return DeviceBase.validate_icon(icon)

    @field_validator("ip_address")
    @classmethod
    def validate_ip_address(cls, ip_address: str | None) -> str | None:
        if ip_address is None:
            return None
        value = ip_address.strip()
        if not value:
            return None
        return normalize_ip(value)

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, display_name: str | None) -> str | None:
        if display_name is None:
            return None
        normalized = display_name.strip()
        return normalized or None

    @field_validator("hostname")
    @classmethod
    def validate_hostname_value(cls, hostname: str | None) -> str | None:
        if hostname is None:
            return None
        return validate_hostname(hostname)

    @field_validator("mac_address")
    @classmethod
    def validate_mac_address(cls, mac_address: str | None) -> str | None:
        if mac_address is None:
            return None
        return validate_mac(mac_address)

    @field_validator("subnet")
    @classmethod
    def validate_subnet(cls, subnet: str | None) -> str | None:
        if subnet is None:
            return None
        return normalize_cidr(subnet)

    @field_validator("topology_group")
    @classmethod
    def validate_topology_group(cls, topology_group: str | None) -> str | None:
        if topology_group is None:
            return None
        value = topology_group.strip()
        if not value:
            return None
        return value


class DeviceRead(DeviceBase):
    id: int
    topology_group: str
    monitor_status: str | None = None
    last_monitored_at: datetime | None = None
    is_favourite: bool = False
    created_at: datetime
    updated_at: datetime


class RelationshipBase(BaseModel):
    source_device_id: int
    target_device_id: int
    relationship_type: str = Field(default="link", min_length=1, max_length=80)
    allow_outbound: bool = True
    allow_inbound: bool = True
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def different_devices(self) -> "RelationshipBase":
        if self.source_device_id == self.target_device_id:
            raise ValueError("Relationship must connect two different devices")
        return self


class RelationshipCreate(RelationshipBase):
    pass


class RelationshipUpdate(BaseModel):
    source_device_id: int | None = None
    target_device_id: int | None = None
    relationship_type: str | None = Field(default=None, min_length=1, max_length=80)
    allow_outbound: bool | None = None
    allow_inbound: bool | None = None
    notes: str | None = Field(default=None, max_length=2000)


class RelationshipRead(RelationshipBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TopologyGraph(BaseModel):
    devices: list[DeviceRead]
    relationships: list[RelationshipRead]


class LayoutPosition(BaseModel):
    x: float
    y: float


class TopologyLayoutBase(BaseModel):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Layout name is required")
        return normalized


class TopologyLayoutCreate(TopologyLayoutBase):
    positions: dict[str, LayoutPosition] = Field(default_factory=dict)

    @field_validator("positions")
    @classmethod
    def validate_positions(cls, positions: dict[str, LayoutPosition]) -> dict[str, LayoutPosition]:
        return normalize_layout_positions(positions)


class TopologyLayoutRead(TopologyLayoutBase):
    id: int
    owner_user_id: int
    positions: dict[str, LayoutPosition] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


def normalize_layout_positions(
    positions: dict[str, LayoutPosition],
) -> dict[str, LayoutPosition]:
    normalized: dict[str, LayoutPosition] = {}
    for key, value in positions.items():
        node_id = key.strip()
        if not node_id.startswith("device-"):
            raise ValueError("Layout positions must only reference device nodes")
        normalized[node_id] = value
    return normalized


class CorrelatedFirewallEvent(BaseModel):
    id: int
    received_at: datetime
    event_time: datetime | None = None
    src_ip: str | None = None
    dst_ip: str | None = None
    src_port: int | None = None
    dst_port: int | None = None
    protocol: str | None = None
    action: str | None = None
    interface: str | None = None
    direction: str | None = None
    rule_id: str | None = None
    reason: str | None = None
    relation: str = "unknown"


class DeviceSecurityEventSummary(BaseModel):
    device_id: int
    window_hours: int
    blocked_count: int
    passed_count: int
    total_count: int
    last_seen_event_time: datetime | None = None
    events: list[CorrelatedFirewallEvent] = Field(default_factory=list)


class DeviceEventCount(BaseModel):
    device_id: int
    ip_address: str
    hostname: str | None = None
    event_count: int
    blocked_count: int
    passed_count: int
    last_seen_event_time: datetime | None = None


class DeviceEventCountList(BaseModel):
    window_hours: int
    devices: list[DeviceEventCount] = Field(default_factory=list)


class DeviceLiveStatusRequest(BaseModel):
    device_ids: list[int] = Field(default_factory=list, max_length=128)
    timeout_seconds: int = Field(default=1, ge=1, le=5)


class DeviceLiveStatus(BaseModel):
    device_id: int
    status: DeviceStatus
    latency_ms: float | None = None
    last_checked_at: datetime
    error: str | None = None


class DeviceLiveStatusList(BaseModel):
    statuses: list[DeviceLiveStatus] = Field(default_factory=list)


class DeviceBulkImportRequest(BaseModel):
    devices: list[DeviceCreate]

class DeviceBulkImportResult(BaseModel):
    created: int
    updated: int
    errors: list[str]

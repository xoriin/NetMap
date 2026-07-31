from datetime import datetime
import ipaddress

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.validation import normalize_cidr


class TopologyGroupBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    vlan_id: str | None = Field(default=None, max_length=16)
    ip_range: str | None = Field(default=None, max_length=64)
    gateway: str | None = Field(default=None, max_length=64)
    dhcp_start: str | None = Field(default=None, max_length=64)
    dhcp_end: str | None = Field(default=None, max_length=64)
    dns_servers: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Group name is required")
        return normalized

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("ip_range")
    @classmethod
    def normalize_ip_range(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        return normalize_cidr(normalized)

    @field_validator("gateway", "dhcp_start", "dhcp_end", "dns_servers")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @model_validator(mode="after")
    def validate_dhcp_range(self) -> "TopologyGroupBase":
        validate_group_dhcp_range(self.ip_range, self.dhcp_start, self.dhcp_end)
        return self


class TopologyGroupCreate(TopologyGroupBase):
    pass


class TopologyGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    vlan_id: str | None = Field(default=None, max_length=16)
    ip_range: str | None = Field(default=None, max_length=64)
    gateway: str | None = Field(default=None, max_length=64)
    dhcp_start: str | None = Field(default=None, max_length=64)
    dhcp_end: str | None = Field(default=None, max_length=64)
    dns_servers: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("Group name is required")
        return normalized

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("ip_range")
    @classmethod
    def normalize_ip_range(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        return normalize_cidr(normalized)

    @field_validator("gateway", "dhcp_start", "dhcp_end", "dns_servers")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @model_validator(mode="after")
    def validate_dhcp_range(self) -> "TopologyGroupUpdate":
        if self.ip_range is not None or self.dhcp_start is not None or self.dhcp_end is not None:
            validate_group_dhcp_range(self.ip_range, self.dhcp_start, self.dhcp_end, allow_partial=True)
        return self


def validate_group_dhcp_range(
    cidr: str | None,
    start: str | None,
    end: str | None,
    *,
    allow_partial: bool = False,
) -> None:
    if not start and not end:
        return
    if not start or not end:
        if allow_partial:
            return
        raise ValueError("DHCP range requires both start and end IPs")
    if not cidr:
        if allow_partial:
            return
        raise ValueError("DHCP range requires a subnet CIDR")
    try:
        net = ipaddress.ip_network(cidr, strict=False)
        start_ip = ipaddress.ip_address(start)
        end_ip = ipaddress.ip_address(end)
    except ValueError as exc:
        raise ValueError("Invalid DHCP range") from exc
    if start_ip.version != net.version or end_ip.version != net.version:
        raise ValueError("DHCP range IP version must match subnet")
    if start_ip not in net or end_ip not in net:
        raise ValueError("DHCP range must be inside the subnet")
    if int(start_ip) > int(end_ip):
        raise ValueError("DHCP range start must be before the end")


class TopologyGroupRead(TopologyGroupBase):
    id: int
    created_at: datetime
    updated_at: datetime


class DeviceBulkUpdateRequest(BaseModel):
    device_ids: list[int] = Field(min_length=1, max_length=200)
    topology_group_id: int | None = None
    topology_group: str | None = Field(default=None, max_length=120)
    site_id: int | None = None

    @field_validator("device_ids")
    @classmethod
    def normalize_device_ids(cls, value: list[int]) -> list[int]:
        deduped = list(dict.fromkeys(value))
        if not deduped:
            raise ValueError("At least one device id is required")
        return deduped

    @field_validator("topology_group")
    @classmethod
    def normalize_topology_group(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class DeviceBulkUpdateResult(BaseModel):
    updated: int


class GroupResetAssignmentsResult(BaseModel):
    updated: int

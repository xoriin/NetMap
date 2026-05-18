from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.core.validation import normalize_cidr


class TopologyGroupBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    vlan_id: str | None = Field(default=None, max_length=16)
    ip_range: str | None = Field(default=None, max_length=64)
    gateway: str | None = Field(default=None, max_length=64)
    dns_servers: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)

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


class TopologyGroupCreate(TopologyGroupBase):
    pass


class TopologyGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    vlan_id: str | None = Field(default=None, max_length=16)
    ip_range: str | None = Field(default=None, max_length=64)
    gateway: str | None = Field(default=None, max_length=64)
    dns_servers: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)

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


class TopologyGroupRead(TopologyGroupBase):
    id: int
    created_at: datetime
    updated_at: datetime


class DeviceBulkUpdateRequest(BaseModel):
    device_ids: list[int] = Field(min_length=1, max_length=200)
    topology_group_id: int | None = None
    topology_group: str | None = Field(default=None, max_length=120)

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

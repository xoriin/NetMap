from __future__ import annotations

from datetime import datetime

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SubnetCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    cidr: str = Field(..., min_length=1, max_length=50)
    description: str | None = None
    vlan_id: str | None = None
    site_id: int | None = None
    gateway: str | None = None
    dhcp_start: str | None = None
    dhcp_end: str | None = None
    dns_servers: str | None = None
    notes: str | None = None


class SubnetUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    cidr: str | None = None
    description: str | None = None
    vlan_id: str | None = None
    site_id: int | None = None
    gateway: str | None = None
    dhcp_start: str | None = None
    dhcp_end: str | None = None
    dns_servers: str | None = None
    notes: str | None = None


class SubnetOut(BaseModel):
    id: int
    name: str
    cidr: str
    description: str | None
    vlan_id: str | None
    site_id: int | None
    gateway: str | None
    dhcp_start: str | None
    dhcp_end: str | None
    dns_servers: str | None
    notes: str | None
    created_at: datetime
    updated_at: datetime
    # Computed fields
    total_hosts: int = 0
    used: int = 0
    free: int = 0
    utilization: float = 0.0
    device_count: int = 0
    dhcp_count: int = 0
    reservation_count: int = 0

    model_config = {"from_attributes": True}


class IpAddressEntry(BaseModel):
    ip: str
    kind: str  # network | broadcast | gateway | device | dhcp | reserved | free
    label: str | None = None
    display_name: str | None = None
    mac_address: str | None = None
    vendor: str | None = None
    dhcp_range: bool = False


class ConflictEntry(BaseModel):
    type: str
    severity: str  # error | warning
    description: str
    ip: str | None = None
    device_id: int | None = None


class IpamSummary(BaseModel):
    subnet_count: int
    total_hosts: int
    used: int
    free: int
    utilization: float
    conflict_count: int
    dhcp_lease_count: int
    reservation_count: int = 0


class IpReservationCreate(BaseModel):
    ip_address: str = Field(..., min_length=1, max_length=64)
    subnet_id: int | None = None
    label: str = Field(..., min_length=1, max_length=120)
    mac_address: str | None = None
    notes: str | None = None
    expires_at: datetime | None = None


class IpReservationUpdate(BaseModel):
    label: str | None = Field(None, min_length=1, max_length=120)
    subnet_id: int | None = None
    mac_address: str | None = None
    notes: str | None = None
    expires_at: datetime | None = None


class IpReservationOut(BaseModel):
    id: int
    ip_address: str
    subnet_id: int | None
    label: str
    mac_address: str | None
    notes: str | None
    reserved_by: str | None
    expires_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DhcpLeaseOut(BaseModel):
    id: int
    ip_address: str
    mac_address: str | None
    hostname: str | None
    expires_at: datetime | None
    is_active: bool
    source: str
    imported_at: datetime

    model_config = {"from_attributes": True}


class DhcpImportRequest(BaseModel):
    content: str = Field(..., description="Raw DHCP lease file content (ISC or dnsmasq format)")


class VlanSuggestion(BaseModel):
    id: int
    name: str
    display_name: str | None
    vlan_id: str | None
    ip_range: str
    gateway: str | None
    dns_servers: str | None
    already_imported: bool


class VlanImportRequest(BaseModel):
    group_ids: list[int]


class ExternalIpDeviceOut(BaseModel):
    """Minimal device identity for an external address."""

    id: int
    display_name: str | None = None
    hostname: str | None = None
    ip_address: str
    device_type: str | None = None
    site_id: int | None = None

    model_config = {"from_attributes": True}


class CloudProviderOut(BaseModel):
    id: int
    key: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    icon: str
    icon_data: str | None = None
    builtin: bool = False

    model_config = {"from_attributes": True}


class ExternalAccountCreate(BaseModel):
    provider_id: int | None = None
    name: str = Field(default="", max_length=120)


class ExternalAccountOut(ExternalAccountCreate):
    id: int
    model_config = {"from_attributes": True}


class ExternalLocationCreate(BaseModel):
    account_id: int | None = Field(default=None, ge=1)
    name: str = Field(min_length=1, max_length=120)
    region: str | None = Field(default=None, max_length=120)

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value):
        if not value.strip():
            raise ValueError("Location name is required")
        return value.strip()


class ExternalLocationOut(ExternalLocationCreate):
    id: int
    model_config = {"from_attributes": True}


class ExternalIpSummary(BaseModel):
    total: int
    in_use: int
    reserved: int
    free: int


class ExternalIpAddressBase(BaseModel):
    location_id: int | None = None
    device_id: int | None = None
    status: Literal["in_use", "reserved", "available"] = "in_use"
    label: str | None = Field(default=None, max_length=120)
    url: str | None = Field(default=None, max_length=2048)
    owner: str | None = Field(default=None, max_length=120)
    tags: str | None = Field(default=None, max_length=500)
    notes: str | None = None


class ExternalIpAddressCreate(ExternalIpAddressBase):
    ip_address: str = Field(min_length=1, max_length=128)


class ExternalIpAddressUpdate(ExternalIpAddressBase):
    ip_address: str | None = Field(default=None, max_length=64)


class ExternalIpAddressOut(ExternalIpAddressBase):
    id: int
    ip_address: str
    device: ExternalIpDeviceOut | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ExternalMigrationDecline(BaseModel):
    cidr: str
    location: str
    kept: int


class ExternalMigrationSkip(BaseModel):
    """A range the migration could not read at all — recorded so odd real-world data
    never disappears without a trace."""
    cidr: str
    location: str
    reason: str


class ExternalMigrationReport(BaseModel):
    migrated: int
    declined: list[ExternalMigrationDecline]
    skipped: list[ExternalMigrationSkip] = []

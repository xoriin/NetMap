from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class SubnetCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    cidr: str = Field(..., min_length=1, max_length=50)
    description: str | None = None
    vlan_id: str | None = None
    site_id: int | None = None
    gateway: str | None = None
    dns_servers: str | None = None
    notes: str | None = None


class SubnetUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    cidr: str | None = None
    description: str | None = None
    vlan_id: str | None = None
    site_id: int | None = None
    gateway: str | None = None
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

    model_config = {"from_attributes": True}


class IpAddressEntry(BaseModel):
    ip: str
    kind: str  # network | broadcast | gateway | device | dhcp | free
    label: str | None = None
    mac_address: str | None = None
    vendor: str | None = None


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

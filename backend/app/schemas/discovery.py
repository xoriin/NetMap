from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.validation import normalize_ip


ScanType = Literal["ping", "basic_ports"]


class DiscoveryStart(BaseModel):
    target: str = Field(min_length=1, max_length=255)
    scan_type: ScanType = "ping"
    confirm_large_scan: bool = False


class DiscoveryHost(BaseModel):
    ip_address: str
    hostname: str | None = None
    mac_address: str | None = None
    vendor: str | None = None
    status: str = "unknown"
    open_ports: list[int] = Field(default_factory=list)

    @field_validator("ip_address")
    @classmethod
    def validate_ip_address(cls, ip_address: str) -> str:
        return normalize_ip(ip_address)


class DiscoveryScanRead(BaseModel):
    id: int
    target: str
    scan_type: str
    status: str
    host_count: int
    result_count: int
    results: list[DiscoveryHost] = Field(default_factory=list)
    error: str | None = None
    created_at: datetime
    completed_at: datetime | None = None


class DiscoveryImportRequest(BaseModel):
    scan_id: int
    ip_addresses: list[str] = Field(default_factory=list)
    topology_group_id: int | None = None
    site_id: int | None = None

    @field_validator("ip_addresses")
    @classmethod
    def validate_ip_addresses(cls, ip_addresses: list[str]) -> list[str]:
        return [normalize_ip(ip_address) for ip_address in ip_addresses]


class DiscoveryImportResult(BaseModel):
    created: int
    updated: int

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.validation import normalize_ip


ScanType = Literal["ping", "basic_ports"]
DiscoveryImportMode = Literal["new_only", "fill_missing", "override_existing"]


class DiscoveryStart(BaseModel):
    target: str = Field(min_length=1, max_length=255)
    scan_type: ScanType = "ping"
    confirm_large_scan: bool = False
    topology_group_id: int | None = None
    snmp_community: str | None = Field(default=None, min_length=1, max_length=128)
    snmp_profile_id: int | None = None
    snmp_targets: list[str] = Field(default_factory=list, max_length=8)
    snmp_port: int = Field(default=161, ge=1, le=65535)
    snmp_timeout_seconds: int = Field(default=3, ge=1, le=15)

    @field_validator("snmp_targets")
    @classmethod
    def validate_snmp_targets(cls, targets: list[str]) -> list[str]:
        return [normalize_ip(target) for target in targets if target.strip()]


class DiscoveryHost(BaseModel):
    ip_address: str
    hostname: str | None = None
    mac_address: str | None = None
    vendor: str | None = None
    os: str | None = None
    status: str = "unknown"
    open_ports: list[int] = Field(default_factory=list)
    existing_device_id: int | None = None
    import_status: Literal["new", "existing", "changed"] = "new"
    proposed_updates: list[str] = Field(default_factory=list)

    @field_validator("ip_address")
    @classmethod
    def validate_ip_address(cls, ip_address: str) -> str:
        return normalize_ip(ip_address)


class DiscoveryScanRead(BaseModel):
    id: int
    schedule_id: int | None = None
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
    mode: DiscoveryImportMode = "fill_missing"
    update_fields: list[Literal["hostname", "mac_address", "vendor", "os"]] = Field(
        default_factory=lambda: ["hostname", "mac_address", "vendor", "os"]
    )
    update_ip_on_mac_match: bool = False

    @field_validator("ip_addresses")
    @classmethod
    def validate_ip_addresses(cls, ip_addresses: list[str]) -> list[str]:
        return [normalize_ip(ip_address) for ip_address in ip_addresses]


class DiscoveryImportResult(BaseModel):
    created: int
    updated: int
    skipped_existing: int = 0


class DiscoveryScheduleBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1, max_length=255)
    scan_type: ScanType = "ping"
    enabled: bool = True
    interval_minutes: int = Field(default=1440, ge=15, le=10080)
    confirm_large_scan: bool = False
    topology_group_id: int | None = None
    site_id: int | None = None
    snmp_profile_id: int | None = None
    snmp_targets: list[str] = Field(default_factory=list, max_length=8)
    notification_targets: list[str] = Field(default_factory=list, max_length=8)

    @field_validator("snmp_targets")
    @classmethod
    def validate_schedule_snmp_targets(cls, targets: list[str]) -> list[str]:
        return [normalize_ip(target) for target in targets if target.strip()]


class DiscoveryScheduleCreate(DiscoveryScheduleBase):
    pass


class DiscoveryScheduleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    target: str | None = Field(default=None, min_length=1, max_length=255)
    scan_type: ScanType | None = None
    enabled: bool | None = None
    interval_minutes: int | None = Field(default=None, ge=15, le=10080)
    confirm_large_scan: bool | None = None
    topology_group_id: int | None = None
    site_id: int | None = None
    snmp_profile_id: int | None = None
    snmp_targets: list[str] | None = Field(default=None, max_length=8)
    notification_targets: list[str] | None = Field(default=None, max_length=8)

    @field_validator("snmp_targets")
    @classmethod
    def validate_update_snmp_targets(cls, targets: list[str] | None) -> list[str] | None:
        if targets is None:
            return None
        return [normalize_ip(target) for target in targets if target.strip()]


class DiscoveryScheduleRead(DiscoveryScheduleBase):
    id: int
    owner_user_id: int
    last_run_at: datetime | None = None
    next_run_at: datetime | None = None
    last_scan_id: int | None = None
    last_status: str | None = None
    last_error: str | None = None
    open_observation_count: int = 0
    created_at: datetime
    updated_at: datetime


class DiscoveryObservationRead(BaseModel):
    id: int
    schedule_id: int
    scan_id: int | None = None
    device_id: int | None = None
    observation_type: str
    status: str
    ip_address: str | None = None
    mac_address: str | None = None
    hostname: str | None = None
    summary: str
    details: dict = Field(default_factory=dict)
    first_seen_at: datetime
    last_seen_at: datetime
    resolved_at: datetime | None = None


class DiscoveryObservationUpdate(BaseModel):
    status: Literal["open", "acknowledged", "resolved"]

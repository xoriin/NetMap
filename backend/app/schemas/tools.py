from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.core.validation import normalize_cidr, normalize_ip, validate_dns_name, validate_port

DnsRecordType = Literal["A", "AAAA", "MX", "TXT", "NS", "CNAME"]


class DnsLookupRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    record_type: DnsRecordType

    @field_validator("name")
    @classmethod
    def validate_name(cls, name: str) -> str:
        return validate_dns_name(name)


class ReverseDnsRequest(BaseModel):
    ip_address: str = Field(min_length=1, max_length=64)

    @field_validator("ip_address")
    @classmethod
    def validate_ip_address(cls, ip_address: str) -> str:
        return normalize_ip(ip_address)


class PingRequest(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    count: int = Field(default=4, ge=1, le=10)
    timeout_seconds: int = Field(default=3, ge=1, le=30)

    @field_validator("host")
    @classmethod
    def validate_host(cls, host: str) -> str:
        return normalize_host(host)


class TracerouteRequest(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    max_hops: int = Field(default=20, ge=1, le=64)
    timeout_seconds: int = Field(default=10, ge=1, le=60)

    @field_validator("host")
    @classmethod
    def validate_host(cls, host: str) -> str:
        return normalize_host(host)


class TcpPortCheckRequest(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    timeout_seconds: int = Field(default=3, ge=1, le=30)
    protocol: Literal["tcp", "udp"] = "tcp"

    @field_validator("host")
    @classmethod
    def validate_host(cls, host: str) -> str:
        return normalize_host(host)

    @field_validator("port")
    @classmethod
    def validate_port_value(cls, port: int) -> int:
        return validate_port(port)


class SubnetCalculatorRequest(BaseModel):
    cidr: str = Field(min_length=1, max_length=64)

    @field_validator("cidr")
    @classmethod
    def validate_cidr(cls, cidr: str) -> str:
        return normalize_cidr(cidr)


class SnmpProbeRequest(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    community: str | None = Field(default=None, min_length=1, max_length=128)
    profile_id: int | None = None
    port: int = Field(default=161, ge=1, le=65535)
    timeout_seconds: int = Field(default=3, ge=1, le=15)

    @field_validator("host")
    @classmethod
    def validate_host(cls, host: str) -> str:
        return normalize_host(host)


class DnsRecord(BaseModel):
    value: str


class DnsLookupResult(BaseModel):
    queried_name: str
    record_type: DnsRecordType
    records: list[DnsRecord] = Field(default_factory=list)
    source: str
    duration_ms: int


class ReverseDnsResult(BaseModel):
    ip_address: str
    ptr_records: list[str] = Field(default_factory=list)
    source: str
    duration_ms: int


class PingResult(BaseModel):
    host: str
    transmitted: int | None = None
    received: int | None = None
    packet_loss: float | None = None
    average_ms: float | None = None
    min_ms: float | None = None
    max_ms: float | None = None
    raw_output: str
    duration_ms: int


class TracerouteHop(BaseModel):
    hop: int
    address: str | None = None
    host: str | None = None
    rtt_ms: float | None = None


class TracerouteResult(BaseModel):
    host: str
    hops: list[TracerouteHop] = Field(default_factory=list)
    raw_output: str
    duration_ms: int


class TcpPortCheckResult(BaseModel):
    host: str
    port: int
    protocol: str
    reachable: bool
    duration_ms: int
    detail: str


class SubnetCalculatorResult(BaseModel):
    cidr: str
    network: str
    netmask: str
    broadcast: str | None = None
    first_host: str | None = None
    last_host: str | None = None
    total_addresses: int
    usable_hosts: int
    version: int
    prefix_length: int
    calculated_at: datetime


class SnmpInterfaceResult(BaseModel):
    index: int
    name: str | None = None
    oper_status: str | None = None


class SnmpArpEntryResult(BaseModel):
    ip_address: str
    mac_address: str
    vendor: str | None = None
    interface_index: int | None = None


class SnmpProbeResult(BaseModel):
    host: str
    sys_name: str | None = None
    sys_descr: str | None = None
    sys_uptime_seconds: float | None = None
    interfaces: list[SnmpInterfaceResult] = Field(default_factory=list)
    arp_entries: list[SnmpArpEntryResult] = Field(default_factory=list)
    duration_ms: int


class SnmpProfileBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    port: int = Field(default=161, ge=1, le=65535)
    timeout_seconds: int = Field(default=3, ge=1, le=15)
    retries: int = Field(default=1, ge=0, le=3)


class SnmpProfileCreate(SnmpProfileBase):
    community: str = Field(min_length=1, max_length=128)


class SnmpProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    community: str | None = Field(default=None, min_length=1, max_length=128)
    port: int | None = Field(default=None, ge=1, le=65535)
    timeout_seconds: int | None = Field(default=None, ge=1, le=15)
    retries: int | None = Field(default=None, ge=0, le=3)


class SnmpProfileRead(SnmpProfileBase):
    id: int
    version: str
    created_at: datetime
    updated_at: datetime


def normalize_host(value: str) -> str:
    candidate = value.strip()
    try:
        return normalize_ip(candidate)
    except ValueError:
        return validate_dns_name(candidate)

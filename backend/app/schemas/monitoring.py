from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator, model_validator


class PortResult(BaseModel):
    target_id: int | None = None
    port: int
    label: str
    check_type: str = "tcp"
    open: bool
    status: str | None = None
    response_time_ms: float | None = None
    # http/https checks only: the HTTP status code returned, if the server responded at all
    status_code: int | None = None
    error: str | None = None


class MonitorHistoryPoint(BaseModel):
    id: int
    checked_at: datetime
    status: str
    expected_status: str = "online"
    is_healthy: bool | None = None
    rtt_ms: float | None
    port_results: list[PortResult]

    model_config = {"from_attributes": True}


class DeviceMonitorSummary(BaseModel):
    device_id: int
    display_name: str | None
    hostname: str | None
    ip_address: str
    device_type: str | None = None
    icon: str | None = None
    status: str
    expected_status: str = "online"
    health_status: str = "unknown"
    lifecycle: str = "active"
    monitoring_paused: bool = False
    topology_group: str | None
    site_id: int | None
    site_name: str | None
    vlan_id: str | None
    last_checked: datetime | None
    uptime_24h: float | None  # 0.0–1.0
    uptime_7d: float | None
    compliance_24h: float | None = None
    compliance_7d: float | None = None
    avg_rtt_24h: float | None
    latest_port_results: list[PortResult]
    heartbeat: list[str] = []  # last 50 poll statuses, oldest → newest
    heartbeat_health: list[str] = []  # expected-state result matching heartbeat
    rtt_sparkline: list[float | None] = []  # matching rtt_ms values, same order
    is_favourite: bool = False
    flapping: bool = False  # >= 4 status transitions in the last hour


class FleetSummary(BaseModel):
    total: int
    online: int
    offline: int
    unknown: int
    paused: int = 0
    healthy: int = 0
    unhealthy: int = 0
    avg_rtt_ms: float | None
    last_checked: datetime | None


class DeviceAnalysis(BaseModel):
    device_id: int
    # Baseline stats (7-day window)
    baseline_rtt_ms: float | None   # mean RTT over 7 days
    rtt_stddev: float | None        # std-dev of RTT over 7 days
    rtt_p50: float | None           # median RTT
    rtt_p95: float | None           # 95th-percentile RTT
    current_rtt_ms: float | None    # most recent RTT reading
    # Anomaly
    anomaly_score: float | None     # z-score: (current - baseline) / stddev
    anomaly_level: str              # "normal" | "elevated" | "anomalous" | "insufficient_data"
    # Trend (recent 6 h vs 6–24 h window)
    trend: str                      # "rising" | "falling" | "stable" | "insufficient_data"
    trend_pct: float | None         # % change between windows
    # Stability
    flap_count_24h: int             # status transitions in last 24 h
    longest_outage_minutes: int | None  # longest offline streak in 7 days


VALID_HTTP_METHODS = {"GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"}


class PortTargetOut(BaseModel):
    id: int
    device_id: int | None
    port: int
    label: str
    check_type: str = "tcp"
    http_path: str | None = None
    http_method: str = "GET"
    expected_status_min: int = 200
    expected_status_max: int = 399
    timeout_seconds: float | None = None
    verify_tls: bool = False
    follow_redirects: bool = True
    enabled: bool = True
    created_at: datetime

    model_config = {"from_attributes": True}


class PortTargetCreate(BaseModel):
    device_id: int | None = None
    port: int = Field(..., ge=1, le=65535)
    label: str = Field(..., min_length=1, max_length=60)
    check_type: str = Field(default="tcp", pattern="^(tcp|udp|dhcp|http|https)$")
    http_path: str | None = Field(default=None, max_length=200)
    http_method: str = Field(default="GET", max_length=10)
    expected_status_min: int = Field(default=200, ge=100, le=599)
    expected_status_max: int = Field(default=399, ge=100, le=599)
    timeout_seconds: float | None = Field(default=None, ge=1, le=30)
    verify_tls: bool = False
    follow_redirects: bool = True
    enabled: bool = True

    @field_validator("http_path")
    @classmethod
    def validate_http_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        path = value.strip()
        if not path:
            return None
        if not path.startswith("/"):
            raise ValueError("HTTP path must start with /")
        if any(ch in path for ch in ("\r", "\n", " ", "#")):
            raise ValueError("HTTP path contains invalid characters")
        return path

    @field_validator("http_method")
    @classmethod
    def validate_http_method(cls, value: str) -> str:
        method = value.strip().upper()
        if method not in VALID_HTTP_METHODS:
            raise ValueError(f"http_method must be one of {sorted(VALID_HTTP_METHODS)}")
        return method

    @model_validator(mode="after")
    def validate_status_range(self) -> "PortTargetCreate":
        if self.expected_status_min > self.expected_status_max:
            raise ValueError("expected_status_min must be <= expected_status_max")
        if self.check_type == "dhcp":
            if self.device_id is None:
                raise ValueError("DHCP checks must target a specific device")
            if self.port != 67:
                raise ValueError("DHCP checks use server port 67")
        return self

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class PortResult(BaseModel):
    port: int
    label: str
    open: bool


class MonitorHistoryPoint(BaseModel):
    id: int
    checked_at: datetime
    status: str
    rtt_ms: float | None
    port_results: list[PortResult]

    model_config = {"from_attributes": True}


class DeviceMonitorSummary(BaseModel):
    device_id: int
    display_name: str | None
    hostname: str | None
    ip_address: str
    status: str
    topology_group: str | None
    site_id: int | None
    site_name: str | None
    vlan_id: str | None
    last_checked: datetime | None
    uptime_24h: float | None  # 0.0–1.0
    uptime_7d: float | None
    avg_rtt_24h: float | None
    latest_port_results: list[PortResult]
    heartbeat: list[str] = []  # last 50 poll statuses, oldest → newest
    is_favourite: bool = False


class FleetSummary(BaseModel):
    total: int
    online: int
    offline: int
    unknown: int
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


class PortTargetOut(BaseModel):
    id: int
    device_id: int | None
    port: int
    label: str
    created_at: datetime

    model_config = {"from_attributes": True}


class PortTargetCreate(BaseModel):
    device_id: int | None = None
    port: int = Field(..., ge=1, le=65535)
    label: str = Field(..., min_length=1, max_length=60)

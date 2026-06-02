from datetime import datetime

from pydantic import BaseModel, Field


class FirewallEventRead(BaseModel):
    id: int
    received_at: datetime
    event_time: datetime | None = None
    source_host: str | None = None
    src_ip: str | None = None
    dst_ip: str | None = None
    src_port: int | None = None
    dst_port: int | None = None
    protocol: str | None = None
    action: str | None = None
    interface: str | None = None
    direction: str | None = None
    rule_id: str | None = None
    tracker_id: str | None = None
    reason: str | None = None
    raw_log: str


class FirewallEventList(BaseModel):
    retention_days: int
    total: int
    offset: int = 0
    limit: int = 100
    events: list[FirewallEventRead] = Field(default_factory=list)


class SyslogStatus(BaseModel):
    enabled: bool
    udp_enabled: bool
    tcp_enabled: bool
    tls_enabled: bool
    udp_port: int
    tcp_port: int
    tls_port: int
    retention_days: int
    allowlist_enabled: bool
    total_events: int
    retention_last_run_at: datetime | None = None
    retention_last_deleted: int = 0
    retention_last_error: str | None = None
    last_event_received_at: datetime | None = None
    received_packets: int = 0
    stored_events: int = 0
    dropped_unparsed: int = 0
    denied_senders: int = 0
    last_packet_at: datetime | None = None
    last_packet_sender: str | None = None
    last_stored_at: datetime | None = None
    last_stored_sender: str | None = None
    last_drop_at: datetime | None = None
    last_drop_sender: str | None = None
    last_drop_raw: str | None = None
    last_denied_at: datetime | None = None
    last_denied_sender: str | None = None

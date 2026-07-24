import json
import re
from datetime import datetime
from pydantic import BaseModel, Field, field_validator, model_validator

VALID_EVENT_TYPES = {
    "device_offline", "device_online", "device_warning", "any_status_change",
    "rtt_above", "device_flapping", "ping_loss_above", "service_down", "service_slow",
    "monitor_down", "monitor_slow",
}
VALID_CHANNELS = {"smtp", "ntfy", "telegram", "signal"}
PROFILE_TARGET_RE = re.compile(r"^profile:[1-9][0-9]*$")


class AlertRuleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    enabled: bool = True
    event_type: str
    device_id: int | None = None
    port_target_id: int | None = None
    monitor_id: int | None = None
    channels: list[str] = Field(default_factory=list)
    cooldown_minutes: int = Field(default=30, ge=1, le=1440)
    threshold_ms: int | None = Field(default=None, ge=1, le=60000)
    loss_pct_threshold: float | None = Field(default=None, ge=1, le=100)
    loss_window_minutes: int | None = Field(default=60, ge=5, le=1440)

    @field_validator("event_type")
    @classmethod
    def validate_event_type(cls, v: str) -> str:
        if v not in VALID_EVENT_TYPES:
            raise ValueError(f"event_type must be one of {sorted(VALID_EVENT_TYPES)}")
        return v

    @model_validator(mode="after")
    def require_threshold_for_rtt(self) -> "AlertRuleCreate":
        if self.event_type == "rtt_above" and self.threshold_ms is None:
            raise ValueError("threshold_ms is required for rtt_above rules")
        if self.event_type == "ping_loss_above" and self.loss_pct_threshold is None:
            raise ValueError("loss_pct_threshold is required for ping_loss_above rules")
        if self.event_type == "service_slow" and self.threshold_ms is None:
            raise ValueError("threshold_ms is required for service_slow rules")
        if self.event_type == "monitor_slow" and self.threshold_ms is None:
            raise ValueError("threshold_ms is required for monitor_slow rules")
        return self

    @field_validator("channels")
    @classmethod
    def validate_channels(cls, v: list[str]) -> list[str]:
        invalid = {channel for channel in v if channel not in VALID_CHANNELS and not PROFILE_TARGET_RE.match(channel)}
        if invalid:
            raise ValueError(f"Invalid channels: {invalid}")
        return v


class AlertRuleUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    enabled: bool | None = None
    event_type: str | None = None
    device_id: int | None = None
    port_target_id: int | None = None
    monitor_id: int | None = None
    channels: list[str] | None = None
    cooldown_minutes: int | None = Field(None, ge=1, le=1440)
    threshold_ms: int | None = Field(None, ge=1, le=60000)
    loss_pct_threshold: float | None = Field(None, ge=1, le=100)
    loss_window_minutes: int | None = Field(None, ge=5, le=1440)

    @field_validator("event_type")
    @classmethod
    def validate_event_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_EVENT_TYPES:
            raise ValueError(f"event_type must be one of {sorted(VALID_EVENT_TYPES)}")
        return v

    @field_validator("channels")
    @classmethod
    def validate_channels(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        invalid = {channel for channel in v if channel not in VALID_CHANNELS and not PROFILE_TARGET_RE.match(channel)}
        if invalid:
            raise ValueError(f"Invalid channels: {invalid}")
        return v


class AlertRuleRead(BaseModel):
    id: int
    name: str
    enabled: bool
    event_type: str
    device_id: int | None
    port_target_id: int | None
    monitor_id: int | None
    channels: list[str]
    cooldown_minutes: int
    threshold_ms: int | None
    loss_pct_threshold: float | None
    loss_window_minutes: int | None
    last_triggered_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    @field_validator("channels", mode="before")
    @classmethod
    def parse_channels(cls, v: object) -> list[str]:
        if isinstance(v, str):
            return json.loads(v)
        return list(v)  # type: ignore[arg-type]


class AlertEventRead(BaseModel):
    id: int
    alert_rule_id: int | None
    alert_rule_name: str
    device_id: int | None
    event_type: str
    fired_at: datetime
    message: str

    model_config = {"from_attributes": True}


class NotificationDeliveryRead(BaseModel):
    id: int
    rule_name: str
    device_id: int | None
    target: str
    status: str
    detail: str
    sent_at: datetime

    model_config = {"from_attributes": True}

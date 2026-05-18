import json
from datetime import datetime
from pydantic import BaseModel, Field, field_validator

VALID_EVENT_TYPES = {"device_offline", "device_online", "device_warning", "any_status_change"}
VALID_CHANNELS = {"smtp", "ntfy", "telegram", "signal"}


class AlertRuleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    enabled: bool = True
    event_type: str
    device_id: int | None = None
    channels: list[str] = Field(default_factory=list)
    cooldown_minutes: int = Field(default=30, ge=1, le=1440)

    @field_validator("event_type")
    @classmethod
    def validate_event_type(cls, v: str) -> str:
        if v not in VALID_EVENT_TYPES:
            raise ValueError(f"event_type must be one of {sorted(VALID_EVENT_TYPES)}")
        return v

    @field_validator("channels")
    @classmethod
    def validate_channels(cls, v: list[str]) -> list[str]:
        invalid = set(v) - VALID_CHANNELS
        if invalid:
            raise ValueError(f"Invalid channels: {invalid}")
        return v


class AlertRuleUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    enabled: bool | None = None
    event_type: str | None = None
    device_id: int | None = None
    channels: list[str] | None = None
    cooldown_minutes: int | None = Field(None, ge=1, le=1440)

    @field_validator("event_type")
    @classmethod
    def validate_event_type(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_EVENT_TYPES:
            raise ValueError(f"event_type must be one of {sorted(VALID_EVENT_TYPES)}")
        return v


class AlertRuleRead(BaseModel):
    id: int
    name: str
    enabled: bool
    event_type: str
    device_id: int | None
    channels: list[str]
    cooldown_minutes: int
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

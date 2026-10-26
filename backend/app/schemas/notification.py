from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.schemas.datetimes import UtcDatetime


VALID_NOTIFICATION_PROVIDERS = {"apprise", "ntfy", "telegram", "signal", "smtp", "webhook"}


class NotificationProfileBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    provider: str
    enabled: bool = True
    config: dict[str, Any] = Field(default_factory=dict)

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, value: str) -> str:
        provider = value.strip().lower()
        if provider not in VALID_NOTIFICATION_PROVIDERS:
            raise ValueError(f"provider must be one of {sorted(VALID_NOTIFICATION_PROVIDERS)}")
        return provider

    @field_validator("config")
    @classmethod
    def validate_config(cls, value: dict[str, Any]) -> dict[str, Any]:
        return _validate_config(value)


class NotificationProfileCreate(NotificationProfileBase):
    pass


class NotificationProfileUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    provider: str | None = None
    enabled: bool | None = None
    config: dict[str, Any] | None = None

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, value: str | None) -> str | None:
        if value is None:
            return None
        provider = value.strip().lower()
        if provider not in VALID_NOTIFICATION_PROVIDERS:
            raise ValueError(f"provider must be one of {sorted(VALID_NOTIFICATION_PROVIDERS)}")
        return provider

    @field_validator("config")
    @classmethod
    def validate_config(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        return _validate_config(value) if value is not None else None


class NotificationProfileRead(NotificationProfileBase):
    id: int
    created_at: UtcDatetime
    updated_at: UtcDatetime

    model_config = {"from_attributes": True}


def _validate_config(value: dict[str, Any]) -> dict[str, Any]:
    if len(value) > 32:
        raise ValueError("Notification config may contain at most 32 fields")
    if any(not isinstance(key, str) or len(key) > 100 for key in value):
        raise ValueError("Notification config keys must be 100 characters or fewer")
    try:
        encoded = json.dumps(value, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError("Notification config must contain JSON-safe values") from exc
    if len(encoded.encode("utf-8")) > 32_768:
        raise ValueError("Notification config is too large (32 KB max)")
    return value

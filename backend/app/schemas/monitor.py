from __future__ import annotations

from datetime import datetime
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator

VALID_HTTP_METHODS = {"GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"}


def _validate_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("URL must be a valid http:// or https:// address")
    return value.strip()


def _validate_method(value: str) -> str:
    method = value.strip().upper()
    if method not in VALID_HTTP_METHODS:
        raise ValueError(f"http_method must be one of {sorted(VALID_HTTP_METHODS)}")
    return method


class MonitorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=2048)
    http_method: str = Field(default="GET", max_length=10)
    expected_status_min: int = Field(default=200, ge=100, le=599)
    expected_status_max: int = Field(default=399, ge=100, le=599)
    timeout_seconds: float = Field(default=10.0, ge=1, le=60)
    verify_tls: bool = True
    follow_redirects: bool = True
    check_interval_seconds: int = Field(default=60, ge=20, le=86400)
    max_retries: int = Field(default=0, ge=0, le=10)
    enabled: bool = True

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        return _validate_url(value)

    @field_validator("http_method")
    @classmethod
    def validate_method(cls, value: str) -> str:
        return _validate_method(value)

    @model_validator(mode="after")
    def validate_status_range(self) -> "MonitorCreate":
        if self.expected_status_min > self.expected_status_max:
            raise ValueError("expected_status_min must be <= expected_status_max")
        return self


class MonitorUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    url: str | None = Field(None, min_length=1, max_length=2048)
    http_method: str | None = Field(None, max_length=10)
    expected_status_min: int | None = Field(None, ge=100, le=599)
    expected_status_max: int | None = Field(None, ge=100, le=599)
    timeout_seconds: float | None = Field(None, ge=1, le=60)
    verify_tls: bool | None = None
    follow_redirects: bool | None = None
    check_interval_seconds: int | None = Field(None, ge=20, le=86400)
    max_retries: int | None = Field(None, ge=0, le=10)
    enabled: bool | None = None

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str | None) -> str | None:
        return _validate_url(value) if value is not None else None

    @field_validator("http_method")
    @classmethod
    def validate_method(cls, value: str | None) -> str | None:
        return _validate_method(value) if value is not None else None


class MonitorRead(BaseModel):
    id: int
    name: str
    url: str
    http_method: str
    expected_status_min: int
    expected_status_max: int
    timeout_seconds: float
    verify_tls: bool
    follow_redirects: bool
    check_interval_seconds: int
    max_retries: int
    enabled: bool
    consecutive_failures: int
    last_status: str | None
    last_checked_at: datetime | None
    uptime_24h: float | None = None
    uptime_7d: float | None = None
    avg_response_time_24h: float | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class MonitorCheckHistoryRead(BaseModel):
    id: int
    checked_at: datetime
    status: str
    response_time_ms: float | None
    status_code: int | None
    error: str | None

    model_config = {"from_attributes": True}

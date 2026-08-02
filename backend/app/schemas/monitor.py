from __future__ import annotations

from datetime import datetime
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator

VALID_HTTP_METHODS = {"GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"}
VALID_BODY_ENCODINGS = {"json", "text", "form", "xml"}
VALID_AUTH_TYPES = {"none", "basic", "bearer", "oauth2", "mtls"}
VALID_JSON_OPERATORS = {"equals", "not_equals", "contains", "not_contains", "exists", "not_exists", "gt", "gte", "lt", "lte"}
VALID_OAUTH_AUTH_METHODS = {"client_secret_basic", "client_secret_post"}


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


def _validate_status_codes(value: str) -> str:
    parts = [part.strip() for part in value.split(",") if part.strip()]
    if not parts or len(parts) > 30:
        raise ValueError("accepted_status_codes must contain between 1 and 30 codes or ranges")
    canonical: list[str] = []
    for part in parts:
        bounds = part.split("-", 1)
        if len(bounds) == 1:
            low = high = int(bounds[0])
        else:
            low, high = int(bounds[0]), int(bounds[1])
        if not (100 <= low <= high <= 599):
            raise ValueError("accepted status codes must be between 100 and 599")
        canonical.append(str(low) if low == high else f"{low}-{high}")
    return ",".join(canonical)


class MonitorFields(BaseModel):
    description: str | None = Field(None, max_length=4000)
    tags: list[str] = Field(default_factory=list, max_length=30)
    accepted_status_codes: str = Field(default="200-399", max_length=255)
    max_redirects: int = Field(default=10, ge=0, le=20)
    request_headers: dict[str, str] | None = None
    request_body: str | None = Field(None, max_length=65536)
    body_encoding: str = "json"
    auth_type: str = "none"
    auth_username: str | None = Field(None, max_length=255)
    auth_password: str | None = Field(None, max_length=4096)
    bearer_token: str | None = Field(None, max_length=16384)
    oauth_token_url: str | None = Field(None, max_length=2048)
    oauth_client_id: str | None = Field(None, max_length=255)
    oauth_client_secret: str | None = Field(None, max_length=4096)
    oauth_scopes: str | None = Field(None, max_length=1000)
    oauth_audience: str | None = Field(None, max_length=1000)
    oauth_auth_method: str = "client_secret_basic"
    proxy_url: str | None = Field(None, max_length=2048)
    tls_ca: str | None = Field(None, max_length=65536)
    tls_cert: str | None = Field(None, max_length=65536)
    tls_key: str | None = Field(None, max_length=65536)
    keyword: str | None = Field(None, max_length=1000)
    keyword_inverted: bool = False
    json_path: str | None = Field(None, max_length=1000)
    json_operator: str = "equals"
    expected_value: str | None = Field(None, max_length=2000)
    cache_bust: bool = False
    upside_down: bool = False
    retry_interval_seconds: int = Field(default=20, ge=5, le=86400)
    certificate_expiry_alert: bool = False
    certificate_expiry_days: int = Field(default=14, ge=1, le=365)

    @field_validator("accepted_status_codes")
    @classmethod
    def validate_status_codes(cls, value: str) -> str:
        return _validate_status_codes(value)

    @field_validator("body_encoding")
    @classmethod
    def validate_body_encoding(cls, value: str) -> str:
        if value not in VALID_BODY_ENCODINGS:
            raise ValueError(f"body_encoding must be one of {sorted(VALID_BODY_ENCODINGS)}")
        return value

    @field_validator("auth_type")
    @classmethod
    def validate_auth_type(cls, value: str) -> str:
        if value not in VALID_AUTH_TYPES:
            raise ValueError(f"auth_type must be one of {sorted(VALID_AUTH_TYPES)}")
        return value

    @field_validator("json_operator")
    @classmethod
    def validate_json_operator(cls, value: str) -> str:
        if value not in VALID_JSON_OPERATORS:
            raise ValueError(f"json_operator must be one of {sorted(VALID_JSON_OPERATORS)}")
        return value

    @field_validator("oauth_auth_method")
    @classmethod
    def validate_oauth_auth_method(cls, value: str) -> str:
        if value not in VALID_OAUTH_AUTH_METHODS:
            raise ValueError(f"oauth_auth_method must be one of {sorted(VALID_OAUTH_AUTH_METHODS)}")
        return value

    @field_validator("request_headers")
    @classmethod
    def validate_headers(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        if value is None:
            return None
        if len(value) > 50:
            raise ValueError("request_headers cannot contain more than 50 headers")
        for name, header_value in value.items():
            if not name or len(name) > 128 or len(header_value) > 8192 or "\r" in name or "\n" in name or "\r" in header_value or "\n" in header_value:
                raise ValueError("request_headers contains an invalid header name or value")
        return value

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, value: list[str]) -> list[str]:
        cleaned = []
        for tag in value:
            item = tag.strip()
            if item and item not in cleaned:
                if len(item) > 40:
                    raise ValueError("tags must be no longer than 40 characters")
                cleaned.append(item)
        return cleaned


class MonitorCreate(MonitorFields):
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
        if self.auth_type == "oauth2" and (not self.oauth_token_url or not self.oauth_client_id or not self.oauth_client_secret):
            raise ValueError("OAuth2 monitors require token URL, client ID, and client secret")
        if self.oauth_token_url is not None:
            _validate_url(self.oauth_token_url)
        if self.auth_type == "mtls" and (not self.tls_cert or not self.tls_key):
            raise ValueError("mTLS monitors require a client certificate and private key")
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
    description: str | None = Field(None, max_length=4000)
    tags: list[str] | None = Field(None, max_length=30)
    accepted_status_codes: str | None = Field(None, max_length=255)
    max_redirects: int | None = Field(None, ge=0, le=20)
    request_headers: dict[str, str] | None = None
    request_body: str | None = Field(None, max_length=65536)
    body_encoding: str | None = None
    auth_type: str | None = None
    auth_username: str | None = Field(None, max_length=255)
    auth_password: str | None = Field(None, max_length=4096)
    bearer_token: str | None = Field(None, max_length=16384)
    oauth_token_url: str | None = Field(None, max_length=2048)
    oauth_client_id: str | None = Field(None, max_length=255)
    oauth_client_secret: str | None = Field(None, max_length=4096)
    oauth_scopes: str | None = Field(None, max_length=1000)
    oauth_audience: str | None = Field(None, max_length=1000)
    oauth_auth_method: str | None = None
    proxy_url: str | None = Field(None, max_length=2048)
    tls_ca: str | None = Field(None, max_length=65536)
    tls_cert: str | None = Field(None, max_length=65536)
    tls_key: str | None = Field(None, max_length=65536)
    keyword: str | None = Field(None, max_length=1000)
    keyword_inverted: bool | None = None
    json_path: str | None = Field(None, max_length=1000)
    json_operator: str | None = None
    expected_value: str | None = Field(None, max_length=2000)
    cache_bust: bool | None = None
    upside_down: bool | None = None
    retry_interval_seconds: int | None = Field(None, ge=5, le=86400)
    certificate_expiry_alert: bool | None = None
    certificate_expiry_days: int | None = Field(None, ge=1, le=365)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str | None) -> str | None:
        return _validate_url(value) if value is not None else None

    @field_validator("http_method")
    @classmethod
    def validate_method(cls, value: str | None) -> str | None:
        return _validate_method(value) if value is not None else None

    @field_validator("accepted_status_codes")
    @classmethod
    def validate_status_codes(cls, value: str | None) -> str | None:
        return _validate_status_codes(value) if value is not None else None

    @field_validator("body_encoding")
    @classmethod
    def validate_body_encoding(cls, value: str | None) -> str | None:
        if value is not None and value not in VALID_BODY_ENCODINGS:
            raise ValueError(f"body_encoding must be one of {sorted(VALID_BODY_ENCODINGS)}")
        return value

    @field_validator("auth_type")
    @classmethod
    def validate_auth_type(cls, value: str | None) -> str | None:
        if value is not None and value not in VALID_AUTH_TYPES:
            raise ValueError(f"auth_type must be one of {sorted(VALID_AUTH_TYPES)}")
        return value

    @field_validator("json_operator")
    @classmethod
    def validate_json_operator(cls, value: str | None) -> str | None:
        if value is not None and value not in VALID_JSON_OPERATORS:
            raise ValueError(f"json_operator must be one of {sorted(VALID_JSON_OPERATORS)}")
        return value

    @field_validator("oauth_auth_method")
    @classmethod
    def validate_oauth_auth_method(cls, value: str | None) -> str | None:
        if value is not None and value not in VALID_OAUTH_AUTH_METHODS:
            raise ValueError(f"oauth_auth_method must be one of {sorted(VALID_OAUTH_AUTH_METHODS)}")
        return value

    @field_validator("request_headers")
    @classmethod
    def validate_headers(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        return MonitorFields.validate_headers(value)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, value: list[str] | None) -> list[str] | None:
        return MonitorFields.validate_tags(value) if value is not None else None


class MonitorRead(BaseModel):
    id: int
    name: str
    description: str | None
    tags: list[str] = Field(default_factory=list)
    url: str
    http_method: str
    expected_status_min: int
    expected_status_max: int
    timeout_seconds: float
    verify_tls: bool
    follow_redirects: bool
    max_redirects: int
    accepted_status_codes: str
    body_encoding: str
    auth_type: str
    auth_username: str | None
    oauth_token_url: str | None
    oauth_client_id: str | None
    oauth_scopes: str | None
    oauth_audience: str | None
    oauth_auth_method: str
    keyword: str | None
    keyword_inverted: bool
    json_path: str | None
    json_operator: str
    expected_value: str | None
    cache_bust: bool
    upside_down: bool
    retry_interval_seconds: int
    certificate_expiry_alert: bool
    certificate_expiry_days: int
    has_request_headers: bool = False
    has_request_body: bool = False
    has_auth_password: bool = False
    has_bearer_token: bool = False
    has_oauth_client_secret: bool = False
    has_proxy_url: bool = False
    has_tls_ca: bool = False
    has_tls_cert: bool = False
    has_tls_key: bool = False
    check_interval_seconds: int
    max_retries: int
    enabled: bool
    consecutive_failures: int
    last_status: str | None
    last_checked_at: datetime | None
    last_cert_expires_at: datetime | None
    last_cert_issuer: str | None
    uptime_24h: float | None = None
    uptime_7d: float | None = None
    avg_response_time_24h: float | None = None
    heartbeat: list[str] = Field(default_factory=list)
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
    assertion_detail: str | None
    response_size_bytes: int | None
    cert_expires_at: datetime | None

    model_config = {"from_attributes": True}

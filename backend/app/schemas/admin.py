import json
import re
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, ValidationInfo, field_validator

from app.schemas.alert import PROFILE_TARGET_RE, VALID_CHANNELS
from app.core.image_validation import validate_email_logo_data_uri, validate_icon_data_uri


class AdminPasswordResetRequest(BaseModel):
    new_password: str = Field(min_length=12, max_length=256)


class SystemSettingsRead(BaseModel):
    app_name: str
    login_message: str
    announcement: str
    support_email: str = ""
    support_url: str = ""
    live_ping_enabled: bool = True
    monitor_interval_seconds: int = 300
    idle_timeout_minutes: int = 0
    active_network_public_targets_enabled: bool = False
    ip_reservation_default_expiry_enabled: bool = True
    ip_reservation_reminder_enabled: bool = False
    ip_reservation_reminder_days: int = 3
    ip_reservation_reminder_channels: list[str] = Field(default_factory=list)
    backup_schedule_enabled: bool = False
    backup_schedule_interval_hours: int = 24
    backup_retention_count: int = 7
    backup_filename_prefix: str = "netmap-backup"
    backup_date_format: str = "yyyy-MM-dd"
    totp_required: Literal["off", "admins", "all"] = "off"

    @field_validator(
        "live_ping_enabled", "active_network_public_targets_enabled",
        "ip_reservation_default_expiry_enabled", "ip_reservation_reminder_enabled",
        "backup_schedule_enabled",
        mode="before",
    )
    @classmethod
    def _coerce_bool(cls, v: object) -> bool:
        if isinstance(v, bool):
            return v
        return str(v).lower() not in ("false", "0", "")

    @field_validator(
        "idle_timeout_minutes", "monitor_interval_seconds", "ip_reservation_reminder_days",
        "backup_schedule_interval_hours", "backup_retention_count",
        mode="before",
    )
    @classmethod
    def _coerce_int(cls, v: object, info: ValidationInfo) -> int:
        fallback = {
            "monitor_interval_seconds": 300, "ip_reservation_reminder_days": 3,
            "backup_schedule_interval_hours": 24, "backup_retention_count": 7,
        }.get(info.field_name, 15)
        try:
            return max(1, int(v))
        except (TypeError, ValueError):
            return fallback

    @field_validator("ip_reservation_reminder_channels", mode="before")
    @classmethod
    def _parse_channels(cls, v: object) -> list[str]:
        if isinstance(v, str):
            if not v:
                return []
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return []
        return list(v) if v else []  # type: ignore[arg-type]


class SystemSettingsUpdate(BaseModel):
    app_name: str | None = Field(None, max_length=80)
    login_message: str | None = Field(None, max_length=300)
    announcement: str | None = Field(None, max_length=500)
    support_email: str | None = Field(None, max_length=254)
    support_url: str | None = Field(None, max_length=500)
    live_ping_enabled: bool | None = None
    monitor_interval_seconds: int | None = Field(None, ge=30, le=3600)
    idle_timeout_minutes: int | None = Field(None, ge=0, le=480)
    active_network_public_targets_enabled: bool | None = None
    ip_reservation_default_expiry_enabled: bool | None = None
    ip_reservation_reminder_enabled: bool | None = None
    ip_reservation_reminder_days: int | None = Field(None, ge=1, le=30)
    ip_reservation_reminder_channels: list[str] | None = None
    backup_schedule_enabled: bool | None = None
    backup_schedule_interval_hours: int | None = Field(None, ge=1, le=168)
    backup_retention_count: int | None = Field(None, ge=1, le=90)
    backup_filename_prefix: str | None = Field(None, min_length=1, max_length=60, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
    backup_date_format: Literal["yyyy-MM-dd", "MM-dd-yyyy", "dd-MM-yyyy"] | None = None
    totp_required: Literal["off", "admins", "all"] | None = None

    @field_validator("ip_reservation_reminder_channels")
    @classmethod
    def validate_channels(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        invalid = {channel for channel in v if channel not in VALID_CHANNELS and not PROFILE_TARGET_RE.match(channel)}
        if invalid:
            raise ValueError(f"Invalid channels: {invalid}")
        return v


class NotificationSettings(BaseModel):
    ntfy_url: str = ""
    ntfy_token: str = ""
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    signal_url: str = ""
    signal_number: str = ""
    signal_recipient: str = ""
    smtp_host: str = ""
    smtp_port: str = "587"
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_to: str = ""
    smtp_tls: str = "true"


class NotificationSettingsUpdate(BaseModel):
    ntfy_url: str | None = Field(default=None, max_length=2048)
    ntfy_token: str | None = Field(default=None, max_length=2048)
    telegram_bot_token: str | None = Field(default=None, max_length=2048)
    telegram_chat_id: str | None = Field(default=None, max_length=256)
    signal_url: str | None = Field(default=None, max_length=2048)
    signal_number: str | None = Field(default=None, max_length=64)
    signal_recipient: str | None = Field(default=None, max_length=256)
    smtp_host: str | None = Field(default=None, max_length=255)
    smtp_port: str | None = Field(default=None, max_length=5, pattern=r"^\d{1,5}$")
    smtp_user: str | None = Field(default=None, max_length=254)
    smtp_password: str | None = Field(default=None, max_length=2048)
    smtp_from: str | None = Field(default=None, max_length=254)
    smtp_to: str | None = Field(default=None, max_length=2000)
    smtp_tls: str | None = Field(default=None, pattern=r"^(true|false)$")


class EmailBrandingSettings(BaseModel):
    email_brand_theme: Literal["login_banner", "clean_stripe"] = "login_banner"
    email_brand_name: str = ""
    email_brand_accent: str = "#1d9ab0"
    email_brand_logo: str = ""
    email_brand_footer: str = ""
    email_brand_url: str = ""
    email_brand_show_support: bool = True

    @field_validator("email_brand_show_support", mode="before")
    @classmethod
    def _coerce_brand_bool(cls, value: object) -> bool:
        if isinstance(value, bool):
            return value
        return str(value).lower() not in ("false", "0", "")


class EmailBrandingSettingsUpdate(BaseModel):
    email_brand_theme: Literal["login_banner", "clean_stripe"] | None = None
    email_brand_name: str | None = Field(None, max_length=80, pattern=r"^[^\r\n]*$")
    email_brand_accent: str | None = Field(None, pattern=r"^#[0-9A-Fa-f]{6}$")
    email_brand_logo: str | None = Field(None, max_length=360_000)
    email_brand_footer: str | None = Field(None, max_length=300)
    email_brand_url: str | None = Field(None, max_length=500)
    email_brand_show_support: bool | None = None

    @field_validator("email_brand_logo")
    @classmethod
    def _validate_logo(cls, value: str | None) -> str | None:
        return validate_email_logo_data_uri(value) if value else value

    @field_validator("email_brand_url")
    @classmethod
    def _validate_url(cls, value: str | None) -> str | None:
        if not value:
            return value
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Installation URL must be a complete http or https URL")
        return value


class TestNotificationRequest(BaseModel):
    channel: str = Field(min_length=1, max_length=120)
    message: str = Field(default="NetMap test notification", min_length=1, max_length=4000)


class PermissionMeta(BaseModel):
    key: str
    label: str
    description: str


class RolePermissionsResponse(BaseModel):
    permissions: list[PermissionMeta]
    roles: dict[str, list[str]]  # role name → granted permission keys


class RolePermissionsUpdate(BaseModel):
    roles: dict[str, list[str]]


class RoleCreate(BaseModel):
    name: str = Field(min_length=2, max_length=40, pattern=r"^[A-Za-z][A-Za-z0-9_-]*$")


def normalize_device_type_value(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not normalized:
        raise ValueError("Device type must contain at least one letter or number")
    return normalized[:80]


class DeviceTypeRead(BaseModel):
    id: int | None = None
    value: str
    label: str
    icon: str = "device"
    is_builtin: bool = False
    # Merged in from the `device_type_colors` system setting rather than stored
    # per row: built-in types have no DB row to carry a colour on.
    color: str | None = None


class DeviceTypeColorsUpdate(BaseModel):
    colors: dict[str, str] = Field(default_factory=dict)

    @field_validator("colors")
    @classmethod
    def normalize_colors(cls, value: dict[str, str]) -> dict[str, str]:
        normalized: dict[str, str] = {}
        for key, color in value.items():
            type_value = normalize_device_type_value(key)
            candidate = (color or "").strip()
            if not candidate:
                continue
            if not re.fullmatch(r"#[0-9A-Fa-f]{6}", candidate):
                raise ValueError(f"Invalid colour for device type '{type_value}'")
            normalized[type_value] = candidate.lower()
        return normalized


class CloudProviderRead(BaseModel):
    id: int | None = None
    key: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    icon: str = "cloud"
    icon_data: str | None = None
    builtin: bool = False


class CloudProviderCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    aliases: list[str] = Field(default_factory=list, max_length=20)
    icon: str = Field(default="custom", pattern="^(aws|azure|google_cloud|cloudflare|cloud|globe|custom)$")
    icon_data: str | None = Field(default=None, max_length=400_000)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return " ".join(value.strip().split())

    @field_validator("aliases")
    @classmethod
    def clean_aliases(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(" ".join(value.strip().split())[:80] for value in values if value.strip()))

    @field_validator("icon_data")
    @classmethod
    def validate_icon_data(cls, value: str | None) -> str | None:
        return validate_icon_data_uri(value) if value else value


class CloudProviderUpdate(CloudProviderCreate):
    pass


class DeviceTypeCreate(BaseModel):
    label: str = Field(min_length=2, max_length=80)
    value: str | None = Field(default=None, max_length=80)
    icon: str = Field(default="device", min_length=1, max_length=80)

    @field_validator("label")
    @classmethod
    def normalize_label(cls, value: str) -> str:
        normalized = " ".join(value.strip().split())
        if not normalized:
            raise ValueError("Device type label is required")
        return normalized

    @field_validator("value")
    @classmethod
    def normalize_value(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return normalize_device_type_value(value)

    @field_validator("icon")
    @classmethod
    def normalize_icon(cls, value: str) -> str:
        normalized = value.strip() or "device"
        return normalized[:80]


class DeviceTypeUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=2, max_length=80)
    value: str | None = Field(default=None, max_length=80)
    icon: str | None = Field(default=None, min_length=1, max_length=80)

    @field_validator("label")
    @classmethod
    def normalize_label(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.strip().split())
        if not normalized:
            raise ValueError("Device type label is required")
        return normalized

    @field_validator("value")
    @classmethod
    def normalize_value(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return normalize_device_type_value(value)

    @field_validator("icon")
    @classmethod
    def normalize_icon(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip() or "device"
        return normalized[:80]

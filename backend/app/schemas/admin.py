import json
import re

from pydantic import BaseModel, Field, ValidationInfo, field_validator

from app.schemas.alert import PROFILE_TARGET_RE, VALID_CHANNELS


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
    idle_timeout_minutes: int = 15
    active_network_public_targets_enabled: bool = False
    ip_reservation_default_expiry_enabled: bool = True
    ip_reservation_reminder_enabled: bool = False
    ip_reservation_reminder_days: int = 3
    ip_reservation_reminder_channels: list[str] = Field(default_factory=list)

    @field_validator(
        "live_ping_enabled", "active_network_public_targets_enabled",
        "ip_reservation_default_expiry_enabled", "ip_reservation_reminder_enabled",
        mode="before",
    )
    @classmethod
    def _coerce_bool(cls, v: object) -> bool:
        if isinstance(v, bool):
            return v
        return str(v).lower() not in ("false", "0", "")

    @field_validator("idle_timeout_minutes", "monitor_interval_seconds", "ip_reservation_reminder_days", mode="before")
    @classmethod
    def _coerce_int(cls, v: object, info: ValidationInfo) -> int:
        fallback = {"monitor_interval_seconds": 300, "ip_reservation_reminder_days": 3}.get(info.field_name, 15)
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
    idle_timeout_minutes: int | None = Field(None, ge=1, le=480)
    active_network_public_targets_enabled: bool | None = None
    ip_reservation_default_expiry_enabled: bool | None = None
    ip_reservation_reminder_enabled: bool | None = None
    ip_reservation_reminder_days: int | None = Field(None, ge=1, le=30)
    ip_reservation_reminder_channels: list[str] | None = None

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
    ntfy_url: str | None = None
    ntfy_token: str | None = None
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    signal_url: str | None = None
    signal_number: str | None = None
    signal_recipient: str | None = None
    smtp_host: str | None = None
    smtp_port: str | None = None
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None
    smtp_to: str | None = None
    smtp_tls: str | None = None


class TestNotificationRequest(BaseModel):
    channel: str
    message: str = "NetMap test notification"


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

from pydantic import BaseModel, Field, field_validator


class AdminPasswordResetRequest(BaseModel):
    new_password: str = Field(min_length=12, max_length=256)


class SystemSettingsRead(BaseModel):
    app_name: str
    login_message: str
    announcement: str
    live_ping_enabled: bool = True
    idle_timeout_minutes: int = 15

    @field_validator("live_ping_enabled", mode="before")
    @classmethod
    def _coerce_bool(cls, v: object) -> bool:
        if isinstance(v, bool):
            return v
        return str(v).lower() not in ("false", "0", "")

    @field_validator("idle_timeout_minutes", mode="before")
    @classmethod
    def _coerce_int(cls, v: object) -> int:
        try:
            return max(1, int(v))
        except (TypeError, ValueError):
            return 15


class SystemSettingsUpdate(BaseModel):
    app_name: str | None = Field(None, max_length=80)
    login_message: str | None = Field(None, max_length=300)
    announcement: str | None = Field(None, max_length=500)
    live_ping_enabled: bool | None = None
    idle_timeout_minutes: int | None = Field(None, ge=1, le=480)


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

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.image_validation import shrink_avatar_data_uri
from app.models.user import UserRole
from app.schemas.datetimes import UtcDatetime


class SetupStatus(BaseModel):
    needs_setup: bool


class AdminCreate(BaseModel):
    username: str = Field(min_length=3, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=12, max_length=256)


class UserCreateRequest(BaseModel):
    username: str = Field(min_length=3, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=12, max_length=256)
    role: str = UserRole.VIEWER
    is_active: bool = True
    email: str | None = Field(default=None, max_length=254)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


class RefreshRequest(BaseModel):
    refresh_token: str | None = Field(default=None, min_length=1)


class LogoutRequest(BaseModel):
    refresh_token: str | None = Field(default=None, min_length=1)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


class UserUpdateRequest(BaseModel):
    role: str | None = None
    is_active: bool | None = None
    email: str | None = Field(default=None, max_length=254)
    avatar_data: str | None = Field(default=None, max_length=2_800_000)

    @field_validator("avatar_data")
    @classmethod
    def validate_avatar(cls, value: str | None) -> str | None:
        return shrink_avatar_data_uri(value) if value else value


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=100)
    avatar_data: str | None = Field(default=None, max_length=2_800_000)
    email: str | None = Field(default=None, max_length=254)
    entity_colors_enabled: bool | None = None
    # Re-authentication, required only when the email address changes.
    current_password: str | None = Field(default=None, min_length=1, max_length=256)
    totp_code: str | None = Field(default=None, min_length=1, max_length=32)

    @field_validator("avatar_data")
    @classmethod
    def validate_avatar(cls, value: str | None) -> str | None:
        return shrink_avatar_data_uri(value) if value else value


class WhatsNewAckRequest(BaseModel):
    version: str = Field(min_length=1, max_length=40)


class TokenPair(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MfaChallengeResponse(BaseModel):
    mfa_required: bool = False
    mfa_setup_required: bool = False
    challenge: str


class TotpLoginRequest(BaseModel):
    # Omitted after single sign-on: the challenge then comes from the HttpOnly
    # netmap_mfa_pending cookie the SSO callback set.
    challenge: str | None = Field(default=None, min_length=1, max_length=2048)
    code: str = Field(min_length=1, max_length=32)


class UserRead(BaseModel):
    id: int
    username: str
    role: str
    is_active: bool
    display_name: str | None = None
    avatar_data: str | None = None
    email: str | None = None
    auth_source: str = "local"
    sso_issuer: str | None = None
    sso_last_login_at: UtcDatetime | None = None
    whats_new_acknowledged_version: str | None = None
    entity_colors_enabled: bool = True
    totp_enabled: bool = False
    totp_required: bool = False
    recovery_codes_remaining: int = 0
    permissions: list[str] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class TotpCodeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class TotpPasswordRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class TotpManageRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=1, max_length=32)


class TotpChallengeRequest(BaseModel):
    # Omitted after single sign-on: the challenge then comes from the HttpOnly
    # netmap_mfa_pending cookie the SSO callback set.
    challenge: str | None = Field(default=None, min_length=1, max_length=2048)


class TotpSetupConfirmRequest(BaseModel):
    # Omitted after single sign-on: the challenge then comes from the HttpOnly
    # netmap_mfa_pending cookie the SSO callback set.
    challenge: str | None = Field(default=None, min_length=1, max_length=2048)
    code: str = Field(min_length=1, max_length=32)


class TotpSetupResponse(BaseModel):
    secret: str
    otpauth_uri: str


class TotpCodesResponse(BaseModel):
    recovery_codes: list[str]
    access_token: str | None = None


class ForgotPasswordRequest(BaseModel):
    username_or_email: str = Field(min_length=1, max_length=254)


class ResetPasswordRequest(BaseModel):
    reset_token: str = Field(min_length=1)
    new_password: str = Field(min_length=12, max_length=256)


class DashboardSummary(BaseModel):
    user_count: int
    device_count: int
    group_count: int
    relationship_count: int

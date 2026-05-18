from pydantic import BaseModel, ConfigDict, Field

from app.models.user import UserRole


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
    refresh_token: str = Field(min_length=1)


class LogoutRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


class UserUpdateRequest(BaseModel):
    role: str | None = None
    is_active: bool | None = None
    email: str | None = Field(default=None, max_length=254)
    avatar_data: str | None = None


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=100)
    avatar_data: str | None = None
    email: str | None = Field(default=None, max_length=254)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserRead(BaseModel):
    id: int
    username: str
    role: str
    is_active: bool
    display_name: str | None = None
    avatar_data: str | None = None
    email: str | None = None

    model_config = ConfigDict(from_attributes=True)


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

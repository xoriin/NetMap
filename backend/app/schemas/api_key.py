from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.datetimes import UtcDatetime


class ApiKeyCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    expires_in_days: Literal[30, 90, 365] | None = None


class ApiKeyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    prefix: str
    suffix: str | None
    created_at: UtcDatetime
    expires_at: UtcDatetime | None
    last_used_at: UtcDatetime | None
    last_used_ip: str | None
    revoked_at: UtcDatetime | None


class ApiKeyCreateResponse(ApiKeyRead):
    """The only schema that ever carries the plaintext key — returned once at creation."""

    key: str


class ApiKeyAdminRead(ApiKeyRead):
    user_id: int
    username: str

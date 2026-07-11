from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ApiKeyCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    expires_in_days: Literal[30, 90, 365] | None = None


class ApiKeyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    prefix: str
    created_at: datetime
    expires_at: datetime | None
    last_used_at: datetime | None
    last_used_ip: str | None
    revoked_at: datetime | None


class ApiKeyCreateResponse(ApiKeyRead):
    """The only schema that ever carries the plaintext key — returned once at creation."""

    key: str


class ApiKeyAdminRead(ApiKeyRead):
    user_id: int
    username: str

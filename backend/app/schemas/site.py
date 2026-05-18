from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class SiteBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    address: str | None = Field(default=None, max_length=255)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Site name is required")
        return normalized

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None

    @field_validator("address")
    @classmethod
    def normalize_address(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class SiteCreate(SiteBase):
    pass


class SiteUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    display_name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    address: str | None = Field(default=None, max_length=255)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("Site name is required")
        return normalized

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None

    @field_validator("address")
    @classmethod
    def normalize_address(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class SiteRead(SiteBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

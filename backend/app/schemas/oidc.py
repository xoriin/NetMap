from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.datetimes import UtcDatetime


class OidcPublicStatus(BaseModel):
    enabled: bool
    provider_name: str
    require_sso: bool


class OidcSettingsRead(BaseModel):
    enabled: bool
    issuer: str
    client_id: str
    client_secret_set: bool
    redirect_url: str
    effective_redirect_url: str
    scopes: str
    allowed_email_domains: str
    auto_provision: bool
    provider_name: str
    link_by_email: bool
    allow_unverified_email: bool
    group_claim: str
    role_mappings: str
    manage_roles: bool
    default_role: str
    allow_super_admin: bool
    require_sso: bool
    env_configured: bool
    mfa_policy: str
    mfa_trusted_amr: str
    mfa_trusted_acr: str
    mfa_max_auth_age_seconds: int


class OidcSettingsUpdate(BaseModel):
    enabled: bool | None = None
    issuer: str | None = Field(default=None, max_length=512)
    client_id: str | None = Field(default=None, max_length=255)
    # Write-only: omitted = unchanged, "" = clear, other value = rotate.
    client_secret: str | None = Field(default=None, max_length=512)
    redirect_url: str | None = Field(default=None, max_length=512)
    scopes: str | None = Field(default=None, max_length=255)
    allowed_email_domains: str | None = Field(default=None, max_length=1024)
    auto_provision: bool | None = None
    provider_name: str | None = Field(default=None, max_length=60)
    link_by_email: bool | None = None
    allow_unverified_email: bool | None = None
    group_claim: str | None = Field(default=None, max_length=120)
    role_mappings: str | None = Field(default=None, max_length=4096)
    manage_roles: bool | None = None
    default_role: str | None = Field(default=None, max_length=50)
    allow_super_admin: bool | None = None
    require_sso: bool | None = None
    mfa_policy: Literal["local_totp", "trust_idp"] | None = None
    mfa_trusted_amr: str | None = Field(default=None, max_length=512)
    mfa_trusted_acr: str | None = Field(default=None, max_length=1024)
    mfa_max_auth_age_seconds: int | None = Field(default=None, ge=30, le=86400)


class OidcCheckResult(BaseModel):
    name: str
    ok: bool
    message: str


class OidcTestResult(BaseModel):
    ok: bool
    checks: list[OidcCheckResult]


class LinkedIdentityRead(BaseModel):
    id: int
    provider_name: str
    issuer: str
    email: str | None = None
    created_at: UtcDatetime
    last_login_at: UtcDatetime | None = None


class IdentityReauthRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    totp_code: str | None = Field(default=None, min_length=1, max_length=32)


class SsoEmailChangeRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    totp_code: str | None = Field(default=None, min_length=1, max_length=32)


class SsoRedirectResponse(BaseModel):
    authorize_url: str

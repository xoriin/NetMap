"""Shared fake-provider plumbing for the OIDC tests.

Runs the real flow code against an in-memory provider: discovery metadata
and JWKS are served from dicts, ID tokens are RS256-signed with a generated
RSA key, and no network I/O happens.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives.asymmetric import rsa
import jwt
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base

ISSUER = "https://idp.test"
CLIENT_ID = "netmap-client"
KID = "test-key-1"

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)

METADATA = {
    "issuer": ISSUER,
    "authorization_endpoint": f"{ISSUER}/auth",
    "token_endpoint": f"{ISSUER}/token",
    "jwks_uri": f"{ISSUER}/jwks",
    "userinfo_endpoint": f"{ISSUER}/userinfo",
    "code_challenge_methods_supported": ["S256"],
    "token_endpoint_auth_methods_supported": ["client_secret_basic", "none"],
}


def public_jwks() -> dict:
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(_PRIVATE_KEY.public_key(), as_dict=True)
    jwk["kid"] = KID
    jwk["use"] = "sig"
    jwk["alg"] = "RS256"
    return {"keys": [jwk]}


def make_id_token(
    *,
    sub: str = "subject-1",
    email: str | None = "user@example.com",
    email_verified: bool | None = True,
    nonce: str | None = None,
    issuer: str = ISSUER,
    audience: str | list[str] = CLIENT_ID,
    expires_in: int = 300,
    extra_claims: dict | None = None,
    kid: str = KID,
) -> str:
    now = datetime.now(timezone.utc)
    claims: dict = {
        "iss": issuer,
        "aud": audience,
        "sub": sub,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=expires_in)).timestamp()),
    }
    if email is not None:
        claims["email"] = email
    if email_verified is not None:
        claims["email_verified"] = email_verified
    if nonce is not None:
        claims["nonce"] = nonce
    if extra_claims:
        claims.update(extra_claims)
    return jwt.encode(claims, _PRIVATE_KEY, algorithm="RS256", headers={"kid": kid})


class FakeProviderHttp:
    """Drop-in replacements for the urllib helpers in services.oidc.provider."""

    def __init__(self) -> None:
        self.metadata = dict(METADATA)
        self.jwks = public_jwks()
        self.token_response: dict = {}
        self.userinfo: dict = {}
        self.offline = False
        self.token_requests: list[dict] = []

    def get_json(self, url: str) -> dict:
        from app.services.oidc.provider import OidcProviderError

        if self.offline:
            raise OidcProviderError("provider_unreachable", "Unable to reach identity provider: test outage")
        if url == f"{ISSUER}/.well-known/openid-configuration":
            return dict(self.metadata)
        if url == self.metadata["jwks_uri"]:
            return dict(self.jwks)
        raise OidcProviderError("provider_unreachable", f"Unexpected URL in test: {url}")

    def post_form(self, url: str, data: dict, *, basic_auth=None) -> dict:
        from app.services.oidc.provider import OidcProviderError

        if self.offline:
            raise OidcProviderError("provider_unreachable", "Unable to reach identity provider: test outage")
        self.token_requests.append(dict(data))
        return dict(self.token_response)


def memory_session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    # Import the same module set as init_db so relationship targets resolve
    # when SQLAlchemy configures mappers.
    from app.models import alert_rule, auth_session, audit_log, device, device_type, dhcp_lease, discovery, ip_reservation, monitor_history, notification_delivery, notification_profile, oidc, password_reset_token, port_target, relationship, saved_search, site, snmp_profile, subnet, system_setting, topology_group, topology_layout, user, user_device_favourite  # noqa: F401
    from app.models.audit_log import AuditLog
    from app.models.auth_session import AuthSession, LoginThrottleState, RefreshTokenState
    from app.models.known_device import KnownDevice
    from app.models.oidc import ExternalIdentity, OidcLoginState
    from app.models.password_reset_token import PasswordResetToken
    from app.models.system_setting import SystemSetting
    from app.models.user import User

    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            SystemSetting.__table__,
            AuditLog.__table__,
            RefreshTokenState.__table__,
            AuthSession.__table__,
            KnownDevice.__table__,
            LoginThrottleState.__table__,
            PasswordResetToken.__table__,
            OidcLoginState.__table__,
            ExternalIdentity.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def set_oidc_db_settings(db, **overrides: str) -> None:
    from app.services.oidc.config import save_oidc_db_settings

    defaults = {
        "enabled": "true",
        "issuer": ISSUER,
        "client_id": CLIENT_ID,
        "auto_provision": "true",
    }
    defaults.update(overrides)
    save_oidc_db_settings(db, defaults)
    db.commit()

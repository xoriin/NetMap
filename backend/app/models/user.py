from datetime import datetime, timezone
from enum import StrEnum
import json

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class UserRole(StrEnum):
    SUPER_ADMIN = "SuperAdmin"
    NETWORK_ADMIN = "NetworkAdmin"
    SECURITY_ANALYST = "SecurityAnalyst"
    VIEWER = "Viewer"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    display_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    avatar_data: Mapped[str | None] = mapped_column(Text, nullable=True)
    email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    whats_new_acknowledged_version: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # Per-user opt-out for the coloured VLAN/group, location, and device type
    # chips. Off falls back to neutral grey chips, not to plain text.
    entity_colors_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    totp_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    totp_enabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    totp_last_step: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Bumped whenever every session must end; tokens carry it as the sv claim.
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    # False for accounts created by single sign-on until a password is set for
    # them; their stored hash is random and can never be used to sign in.
    has_local_password: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1", nullable=False)
    new_device_alerts: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1", nullable=False)
    totp_recovery_codes: Mapped[str | None] = mapped_column(Text, nullable=True)

    @property
    def totp_enabled(self) -> bool:
        return self.totp_enabled_at is not None

    @property
    def recovery_codes_remaining(self) -> int:
        return len(json.loads(self.totp_recovery_codes or "[]"))

    @property
    def permissions(self) -> list[str]:
        """Return the effective permissions exposed to the signed-in client."""
        from app.services.rbac.permissions import PERMISSION_KEYS, get_all_permissions

        if self.role == UserRole.SUPER_ADMIN:
            return list(PERMISSION_KEYS)
        return get_all_permissions().get(self.role, [])

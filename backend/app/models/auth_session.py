from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class RefreshTokenState(Base):
    __tablename__ = "refresh_token_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    jti: Mapped[str] = mapped_column(String(80), unique=True, nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    created_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    revoked_reason: Mapped[str | None] = mapped_column(String(120), nullable=True)
    replaced_by_jti: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # The sign-in this token belongs to; NULL for tokens issued before sessions existed.
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


class AuthSession(Base):
    """One sign-in on one device. Tokens carry its id as the sid claim, so a
    single device can be signed out, and a replayed refresh token ends it."""

    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_reason: Mapped[str | None] = mapped_column(String(120), nullable=True)


class LoginThrottleState(Base):
    __tablename__ = "login_throttle_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    subject: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

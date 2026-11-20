from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class SnmpProfile(Base):
    __tablename__ = "snmp_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    version: Mapped[str] = mapped_column(String(16), default="v2c", nullable=False)
    # v2c: the encrypted community. v3 profiles store an empty string.
    community_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    # SNMPv3 (USM). Keys are encrypted like the community and never returned.
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    security_level: Mapped[str | None] = mapped_column(String(16), nullable=True)
    auth_protocol: Mapped[str | None] = mapped_column(String(16), nullable=True)
    auth_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    priv_protocol: Mapped[str | None] = mapped_column(String(16), nullable=True)
    priv_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    context_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    port: Mapped[int] = mapped_column(Integer, default=161, nullable=False)
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    retries: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
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

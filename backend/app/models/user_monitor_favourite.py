from __future__ import annotations

from sqlalchemy import ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class UserMonitorFavourite(Base):
    """Per-user favourited standalone endpoint monitors.

    Mirrors `user_device_favourites` — favourites are a personal view, never a
    property of the monitor itself, so two users on one instance keep separate
    Overview panels.
    """

    __tablename__ = "user_monitor_favourites"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    monitor_id: Mapped[int] = mapped_column(
        ForeignKey("monitors.id", ondelete="CASCADE"), primary_key=True
    )

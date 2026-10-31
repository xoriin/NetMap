from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class NoticeDismissal(Base):
    """A user hid an info or warning notice from the release notice feed."""

    __tablename__ = "user_notice_dismissals"
    __table_args__ = (UniqueConstraint("user_id", "notice_id", name="uq_user_notice_dismissals"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    notice_id: Mapped[str] = mapped_column(String(64), nullable=False)
    dismissed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)

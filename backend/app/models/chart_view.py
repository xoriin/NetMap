"""One personal presentation override per account and stable chart identifier."""

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from app.db.session import Base


class ChartView(Base):
    __tablename__ = "user_chart_views"
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    chart_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    options: Mapped[str] = mapped_column(Text, nullable=False)

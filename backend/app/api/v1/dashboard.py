from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.device import Device
from app.models.relationship import DeviceRelationship
from app.models.topology_group import TopologyGroup
from app.models.user import User
from app.schemas.auth import DashboardSummary

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=DashboardSummary)
def dashboard_summary(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> DashboardSummary:
    row = db.execute(
        select(
            select(func.count()).select_from(User).scalar_subquery().label("user_count"),
            select(func.count()).select_from(Device).scalar_subquery().label("device_count"),
            select(func.count()).select_from(TopologyGroup).scalar_subquery().label("group_count"),
            select(func.count()).select_from(DeviceRelationship).scalar_subquery().label("relationship_count"),
        )
    ).one()
    return DashboardSummary(
        user_count=row.user_count or 0,
        device_count=row.device_count or 0,
        group_count=row.group_count or 0,
        relationship_count=row.relationship_count or 0,
    )

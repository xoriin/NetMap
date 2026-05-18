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
    return DashboardSummary(
        user_count=db.scalar(select(func.count()).select_from(User)) or 0,
        device_count=db.scalar(select(func.count()).select_from(Device)) or 0,
        group_count=db.scalar(select(func.count()).select_from(TopologyGroup)) or 0,
        relationship_count=db.scalar(select(func.count()).select_from(DeviceRelationship)) or 0,
    )

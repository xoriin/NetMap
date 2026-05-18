from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_super_admin
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.user import User
from app.schemas.audit import AuditLogList, AuditLogRead

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("/logs", response_model=AuditLogList)
def list_audit_logs(
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    actor_user_id: Annotated[int | None, Query()] = None,
) -> AuditLogList:
    base_q = select(AuditLog)
    count_q = select(func.count()).select_from(AuditLog)
    if actor_user_id is not None:
        base_q = base_q.where(AuditLog.actor_user_id == actor_user_id)
        count_q = count_q.where(AuditLog.actor_user_id == actor_user_id)
    total = int(db.scalar(count_q) or 0)
    records = db.scalars(
        base_q.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).offset(offset).limit(limit),
    ).all()
    return AuditLogList(
        total=total,
        limit=limit,
        offset=offset,
        records=[AuditLogRead.model_validate(record) for record in records],
    )

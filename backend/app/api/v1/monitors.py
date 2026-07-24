from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.user import User
from app.schemas.monitor import (
    MonitorCheckHistoryRead,
    MonitorCreate,
    MonitorRead,
    MonitorUpdate,
)
from app.services.audit.service import write_audit

router = APIRouter(prefix="/monitors", tags=["monitors"])


def _require_write(current_user: User) -> None:
    if current_user.role not in ("SuperAdmin", "NetworkAdmin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _build_reads(db: Session, monitors: list[Monitor]) -> list[MonitorRead]:
    if not monitors:
        return []
    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d = now - timedelta(days=7)
    ids = [m.id for m in monitors]

    def _uptime_map(cutoff: datetime) -> dict[int, float]:
        rows = db.execute(
            select(
                MonitorCheckHistory.monitor_id,
                func.count(MonitorCheckHistory.id),
                func.sum(case((MonitorCheckHistory.status == "online", 1), else_=0)),
            ).where(MonitorCheckHistory.monitor_id.in_(ids), MonitorCheckHistory.checked_at >= cutoff)
            .group_by(MonitorCheckHistory.monitor_id),
        ).all()
        return {row[0]: (row[2] or 0) / row[1] * 100 for row in rows if row[1]}

    uptime_24h_map = _uptime_map(cutoff_24h)
    uptime_7d_map = _uptime_map(cutoff_7d)

    avg_rows = db.execute(
        select(
            MonitorCheckHistory.monitor_id,
            func.avg(MonitorCheckHistory.response_time_ms),
        )
        .where(
            MonitorCheckHistory.monitor_id.in_(ids),
            MonitorCheckHistory.checked_at >= cutoff_24h,
            MonitorCheckHistory.response_time_ms.is_not(None),
        )
        .group_by(MonitorCheckHistory.monitor_id),
    ).all()
    avg_rtt_map = {row[0]: round(row[1], 2) for row in avg_rows if row[1] is not None}

    reads = []
    for monitor in monitors:
        read = MonitorRead.model_validate(monitor)
        read.uptime_24h = round(uptime_24h_map[monitor.id], 1) if monitor.id in uptime_24h_map else None
        read.uptime_7d = round(uptime_7d_map[monitor.id], 1) if monitor.id in uptime_7d_map else None
        read.avg_response_time_24h = avg_rtt_map.get(monitor.id)
        reads.append(read)
    return reads


@router.get("", response_model=list[MonitorRead])
def list_monitors(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[MonitorRead]:
    monitors = list(db.scalars(select(Monitor).order_by(Monitor.name)))
    return _build_reads(db, monitors)


@router.post("", response_model=MonitorRead, status_code=status.HTTP_201_CREATED)
def create_monitor(
    payload: MonitorCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MonitorRead:
    _require_write(current_user)
    monitor = Monitor(**payload.model_dump())
    db.add(monitor)
    write_audit(
        db,
        action="monitor.created",
        actor_user_id=current_user.id,
        detail=f"name={payload.name} url={payload.url}",
    )
    db.commit()
    db.refresh(monitor)
    return _build_reads(db, [monitor])[0]


@router.patch("/{monitor_id}", response_model=MonitorRead)
def update_monitor(
    monitor_id: int,
    payload: MonitorUpdate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MonitorRead:
    _require_write(current_user)
    monitor = db.get(Monitor, monitor_id)
    if monitor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Monitor not found")
    updates = payload.model_dump(exclude_unset=True)
    for key, value in updates.items():
        setattr(monitor, key, value)
    write_audit(
        db,
        action="monitor.updated",
        actor_user_id=current_user.id,
        target=f"monitor:{monitor.id}",
    )
    db.commit()
    db.refresh(monitor)
    return _build_reads(db, [monitor])[0]


@router.delete("/{monitor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_monitor(
    monitor_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    _require_write(current_user)
    monitor = db.get(Monitor, monitor_id)
    if monitor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Monitor not found")
    write_audit(
        db,
        action="monitor.deleted",
        actor_user_id=current_user.id,
        target=f"monitor:{monitor.id}",
        detail=monitor.name,
    )
    db.delete(monitor)
    db.commit()


@router.get("/{monitor_id}/history", response_model=list[MonitorCheckHistoryRead])
def get_monitor_history(
    monitor_id: int,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    hours: Annotated[int, Query(ge=1, le=720)] = 24,
) -> list[MonitorCheckHistoryRead]:
    if db.get(Monitor, monitor_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Monitor not found")
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = db.scalars(
        select(MonitorCheckHistory)
        .where(MonitorCheckHistory.monitor_id == monitor_id, MonitorCheckHistory.checked_at >= cutoff)
        .order_by(MonitorCheckHistory.checked_at.asc())
        .limit(2000),
    ).all()
    return [MonitorCheckHistoryRead.model_validate(row) for row in rows]

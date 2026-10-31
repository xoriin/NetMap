from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_super_admin
from app.db.session import get_db
from app.models.notice_dismissal import NoticeDismissal
from app.models.user import User, UserRole
from app.services import notices as feed
from app.services.audit.service import write_audit

router = APIRouter(tags=["notices"])
NoticeId = Annotated[str, Path(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]


class NoticeRead(BaseModel):
    id: str
    severity: Literal["info", "warning", "breaking"]
    title: str
    message: str
    link: str | None = None
    can_dismiss: bool
    can_acknowledge: bool


class AdminNoticeRead(NoticeRead):
    acknowledged_count: int = 0


class NoticeFeedRead(BaseModel):
    enabled: bool
    url: str
    checked_at: str | None = None
    error: str | None = None
    notices: list[AdminNoticeRead]


def _seen(db: Session, user: User) -> set[str]:
    return set(db.scalars(select(NoticeDismissal.notice_id).where(NoticeDismissal.user_id == user.id)))


def _record(db: Session, user: User, notice_id: str) -> bool:
    if notice_id in _seen(db, user):
        return False
    db.add(NoticeDismissal(user_id=user.id, notice_id=notice_id))
    return True


def _active(db: Session, notice_id: str) -> feed.Notice:
    notice = next((n for n in feed.active_notices(db) if n.id == notice_id), None)
    if notice is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notice not found")
    return notice


@router.get("/notices", response_model=list[NoticeRead])
def list_notices(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[NoticeRead]:
    """Info and warning notices until this user dismisses them; breaking notices
    for each SuperAdmin until that SuperAdmin acknowledges them."""
    seen = _seen(db, current_user)
    admin = current_user.role == UserRole.SUPER_ADMIN
    shown: list[NoticeRead] = []
    for notice in feed.active_notices(db):
        if notice.id in seen or (notice.severity == "breaking" and not admin):
            continue
        shown.append(NoticeRead(
            **notice.model_dump(include={"id", "severity", "title", "message", "link"}),
            can_dismiss=notice.severity != "breaking",
            can_acknowledge=notice.severity == "breaking",
        ))
    return shown


@router.post("/notices/{notice_id}/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_notice(
    notice_id: NoticeId,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    notice = _active(db, notice_id)
    if notice.severity == "breaking":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Breaking notices are acknowledged, not dismissed")
    if _record(db, current_user, notice_id):
        db.commit()


@router.post("/notices/{notice_id}/acknowledge", status_code=status.HTTP_204_NO_CONTENT)
def acknowledge_notice(
    notice_id: NoticeId,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    notice = _active(db, notice_id)
    if notice.severity != "breaking":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only breaking notices need acknowledging")
    if _record(db, current_user, notice_id):
        write_audit(db, action="notice.acknowledged", actor_user_id=current_user.id, target=f"notice:{notice_id}")
        db.commit()


def _feed_read(db: Session, user: User) -> NoticeFeedRead:
    seen = _seen(db, user)
    counts = dict(db.execute(
        select(NoticeDismissal.notice_id, func.count()).group_by(NoticeDismissal.notice_id)
    ).all())
    return NoticeFeedRead(
        **feed.feed_status(db),
        notices=[
            AdminNoticeRead(
                **notice.model_dump(include={"id", "severity", "title", "message", "link"}),
                can_dismiss=notice.severity != "breaking",
                can_acknowledge=notice.severity == "breaking" and notice.id not in seen,
                acknowledged_count=counts.get(notice.id, 0) if notice.severity == "breaking" else 0,
            )
            for notice in feed.active_notices(db)
        ],
    )


@router.get("/admin/notices", response_model=NoticeFeedRead)
def admin_notice_feed(
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> NoticeFeedRead:
    return _feed_read(db, current_user)


@router.post("/admin/notices/refresh", response_model=NoticeFeedRead)
def refresh_notice_feed(
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> NoticeFeedRead:
    feed.refresh(db)
    return _feed_read(db, current_user)

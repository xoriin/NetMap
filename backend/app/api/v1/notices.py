from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel
from sqlalchemy import select
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
    acknowledged_by: str | None = None
    acknowledged_at: str | None = None


class NoticeFeedRead(BaseModel):
    enabled: bool
    url: str
    checked_at: str | None = None
    error: str | None = None
    notices: list[AdminNoticeRead]


def _is_super_admin(user: User) -> bool:
    return user.role == UserRole.SUPER_ADMIN


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
    """Notices for this user: info and warning until they dismiss them; breaking
    notices only for SuperAdmins, until one of them acknowledges it."""
    dismissed = set(db.scalars(select(NoticeDismissal.notice_id).where(NoticeDismissal.user_id == current_user.id)))
    acks = feed.acknowledgements(db)
    admin = _is_super_admin(current_user)
    shown: list[NoticeRead] = []
    for notice in feed.active_notices(db):
        if notice.severity == "breaking":
            if not admin or notice.id in acks:
                continue
        elif notice.id in dismissed:
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
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Breaking notices are acknowledged by a SuperAdmin")
    exists = db.scalar(select(NoticeDismissal.id).where(NoticeDismissal.user_id == current_user.id, NoticeDismissal.notice_id == notice_id))
    if exists is None:
        db.add(NoticeDismissal(user_id=current_user.id, notice_id=notice_id))
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
    feed.acknowledge(db, notice_id, current_user.username)
    write_audit(db, action="notice.acknowledged", actor_user_id=current_user.id, target=f"notice:{notice_id}")
    db.commit()


def _feed_read(db: Session) -> NoticeFeedRead:
    acks = feed.acknowledgements(db)
    return NoticeFeedRead(
        **feed.feed_status(db),
        notices=[
            AdminNoticeRead(
                **notice.model_dump(include={"id", "severity", "title", "message", "link"}),
                can_dismiss=notice.severity != "breaking",
                can_acknowledge=notice.severity == "breaking" and notice.id not in acks,
                acknowledged_by=acks.get(notice.id, {}).get("by"),
                acknowledged_at=acks.get(notice.id, {}).get("at"),
            )
            for notice in feed.active_notices(db)
        ],
    )


@router.get("/admin/notices", response_model=NoticeFeedRead)
def admin_notice_feed(
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> NoticeFeedRead:
    return _feed_read(db)


@router.post("/admin/notices/refresh", response_model=NoticeFeedRead)
def refresh_notice_feed(
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> NoticeFeedRead:
    feed.refresh(db)
    return _feed_read(db)

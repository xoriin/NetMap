from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.status_page import StatusNotice, StatusPage
from app.services.status_pages.incidents import (
    Actor,
    IncidentError,
    IncidentNotFound,
    PersonActor,
    TokenActor,
    actor_label,
    audit,
    clean_http_url,
    clean_text,
    commit_and_notify,
    now_or_utc,
)
from app.services.status_pages.sources import _utc

LEVELS = ("info", "warning", "critical")
TITLE_MAX = 200
BODY_MAX = 2000


def _slot(owner: Actor) -> tuple[str, int]:
    if isinstance(owner, PersonActor):
        return "user", owner.user.id
    if isinstance(owner, TokenActor):
        return "token", owner.token.id
    raise IncidentError("Only a person or an integration token can own a notice")


def _find_slot(db: Session, page_id: int, kind: str, owner_id: int) -> StatusNotice | None:
    return db.scalar(select(StatusNotice).where(
        StatusNotice.page_id == page_id, StatusNotice.owner_kind == kind, StatusNotice.owner_id == owner_id,
    ))


def live_notices(db: Session, page_id: int, now: datetime) -> list[StatusNotice]:
    now = _utc(now)
    rows = db.scalars(select(StatusNotice).where(StatusNotice.page_id == page_id).order_by(StatusNotice.id))
    return [n for n in rows if n.expires_at is None or _utc(n.expires_at) > now]


def set_notice(
    db: Session, owner: Actor, page_id: int, level: str, title: str, body: str | None, link: str | None,
    expires_at: datetime | None, *, now: datetime | None = None,
) -> StatusNotice:
    now = now_or_utc(now)
    kind, owner_id = _slot(owner)
    if db.get(StatusPage, page_id) is None:
        raise IncidentNotFound("Status page not found")
    if level not in LEVELS:
        raise IncidentError("Level must be info, warning or critical")
    title = clean_text(title, "Title", TITLE_MAX, required=True)
    body = clean_text(body, "Text", BODY_MAX)
    link = clean_http_url(link)
    expires_at = _utc(expires_at)
    if expires_at is not None and expires_at <= now:
        raise IncidentError("Expiry must be in the future")
    notice = _find_slot(db, page_id, kind, owner_id)
    if notice is None:
        try:
            with db.begin_nested():
                notice = StatusNotice(
                    page_id=page_id, owner_kind=kind, owner_id=owner_id, created_at=now, level=level, title=title,
                )
                db.add(notice)
                db.flush()
        except IntegrityError:
            notice = _find_slot(db, page_id, kind, owner_id)
            if notice is None:
                raise
    notice.level, notice.title, notice.body, notice.link = level, title, body, link
    notice.expires_at, notice.author = expires_at, actor_label(owner)
    db.flush()
    audit(db, owner, "status_notice.set", f"status_page:{page_id}", f"notice={notice.id} level={level}")
    commit_and_notify(db, [page_id])
    return notice


def _delete(db: Session, actor: Actor, notice: StatusNotice) -> None:
    page_id = notice.page_id
    audit(db, actor, "status_notice.cleared", f"status_page:{page_id}", f"notice={notice.id}")
    db.delete(notice)
    commit_and_notify(db, [page_id])


def clear_notice(db: Session, actor: Actor, notice_id: int) -> None:
    notice = db.get(StatusNotice, notice_id)
    if notice is None or (isinstance(actor, TokenActor) and _slot(actor) != (notice.owner_kind, notice.owner_id)):
        raise IncidentNotFound("Notice not found")
    _delete(db, actor, notice)


def clear_own_notice(db: Session, owner: Actor, page_id: int) -> None:
    kind, owner_id = _slot(owner)
    notice = _find_slot(db, page_id, kind, owner_id)
    if notice is None:
        raise IncidentNotFound("Notice not found")
    _delete(db, owner, notice)

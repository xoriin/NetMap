import re
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_audit_view
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.user import User
from app.schemas.audit import AuditActionCount, AuditActorCount, AuditDay, AuditLogList, AuditLogRead, AuditSummary
from app.services.audit.service import write_audit

router = APIRouter(prefix="/audit", tags=["audit"])

LOGIN_HISTORY_ACTIONS = (
    "auth.login_success",
    "auth.login_failed",
    "auth.mfa_failed",
    "auth.login_blocked",
    "auth.login_blocked_sso_required",
    "auth.logout",
)

LOGIN_RESULT_LABELS = {
    "auth.login_success": "Success",
    "auth.logout": "Logout",
    "auth.login_failed": "Failed",
    "auth.mfa_failed": "Failed (2FA code)",
    "auth.login_blocked": "Blocked (rate limit)",
    "auth.login_blocked_sso_required": "Blocked (SSO required)",
}

FAILED_SIGN_IN_ACTIONS = (
    "auth.login_failed",
    "auth.mfa_failed",
    "auth.login_blocked",
    "auth.login_blocked_sso_required",
)

_IP_DETAIL_RE = re.compile(r"ip=(\S+)")


@router.get("/summary", response_model=AuditSummary)
def audit_summary(
    _current_user: Annotated[User, Depends(require_audit_view)],
    db: Annotated[Session, Depends(get_db)],
    days: Annotated[int, Query(ge=1, le=90)] = 14,
) -> AuditSummary:
    today = datetime.now(timezone.utc).date()
    first = today - timedelta(days=days - 1)
    since = datetime.combine(first, datetime.min.time(), tzinfo=timezone.utc)
    rows = db.execute(
        select(func.date(AuditLog.created_at), AuditLog.action, func.count())
        .where(AuditLog.created_at >= since)
        .group_by(func.date(AuditLog.created_at), AuditLog.action)
    ).all()
    per_day = {(first + timedelta(days=i)).isoformat(): AuditDay(date=(first + timedelta(days=i)).isoformat()) for i in range(days)}
    by_action: dict[str, int] = {}
    for day, action, count in rows:
        by_action[action] = by_action.get(action, 0) + count
        bucket = per_day.get(str(day))
        if bucket is None:
            continue
        if action == "auth.login_success":
            bucket.signed_in += count
        elif action in FAILED_SIGN_IN_ACTIONS:
            bucket.failed += count
    actors = db.execute(
        select(AuditLog.actor_user_id, User.username, func.count())
        .join(User, User.id == AuditLog.actor_user_id)
        .where(AuditLog.created_at >= since)
        .group_by(AuditLog.actor_user_id, User.username)
    ).all()
    return AuditSummary(
        days=list(per_day.values()),
        by_action=[AuditActionCount(action=a, count=c) for a, c in sorted(by_action.items(), key=lambda kv: (-kv[1], kv[0]))[:8]],
        by_actor=[AuditActorCount(actor_user_id=i, username=u, count=c) for i, u, c in sorted(actors, key=lambda r: (-r[2], r[1]))[:5]],
        total=sum(by_action.values()),
        failed_total=sum(c for a, c in by_action.items() if a in FAILED_SIGN_IN_ACTIONS),
    )


@router.get("/logs", response_model=AuditLogList)
def list_audit_logs(
    _current_user: Annotated[User, Depends(require_audit_view)],
    db: Annotated[Session, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    actor_user_id: Annotated[int | None, Query()] = None,
    category: Annotated[str | None, Query()] = None,
) -> AuditLogList:
    base_q = select(AuditLog)
    count_q = select(func.count()).select_from(AuditLog)
    if actor_user_id is not None:
        base_q = base_q.where(AuditLog.actor_user_id == actor_user_id)
        count_q = count_q.where(AuditLog.actor_user_id == actor_user_id)
    if category == "login":
        base_q = base_q.where(AuditLog.action.in_(LOGIN_HISTORY_ACTIONS))
        count_q = count_q.where(AuditLog.action.in_(LOGIN_HISTORY_ACTIONS))
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


@router.get("/logs/export")
def export_login_history(
    current_user: Annotated[User, Depends(require_audit_view)],
    db: Annotated[Session, Depends(get_db)],
    actor_user_id: Annotated[int | None, Query()] = None,
) -> Response:
    from app.services.exports.service import encode_csv, utc_timestamp

    query = select(AuditLog).where(AuditLog.action.in_(LOGIN_HISTORY_ACTIONS))
    if actor_user_id is not None:
        query = query.where(AuditLog.actor_user_id == actor_user_id)
    records = db.scalars(
        query.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(5000),
    ).all()

    actor_ids = {r.actor_user_id for r in records if r.actor_user_id is not None}
    usernames = {}
    if actor_ids:
        usernames = {u.id: u.username for u in db.scalars(select(User).where(User.id.in_(actor_ids))).all()}

    rows = []
    for record in records:
        ip = "—"
        if record.detail:
            match = _IP_DETAIL_RE.search(record.detail)
            if match:
                ip = match.group(1)
        if record.actor_user_id is not None:
            username = usernames.get(record.actor_user_id, f"#{record.actor_user_id}")
        elif record.target and record.target.startswith("user:"):
            username = record.target[5:]
        else:
            username = "—"
        rows.append({
            "time": record.created_at,
            "user": username,
            "result": LOGIN_RESULT_LABELS.get(record.action, record.action),
            "ip_address": ip,
        })

    payload = encode_csv(rows, fieldnames=["time", "user", "result", "ip_address"])
    write_audit(db, action="export.login_history", actor_user_id=current_user.id, detail=f"rows={len(rows)}")
    db.commit()

    filename = f"netmap-login-history-{utc_timestamp()}.csv"
    return Response(
        content=payload,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

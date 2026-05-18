from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog


def write_audit(
    db: Session,
    action: str,
    actor_user_id: int | None = None,
    target: str | None = None,
    detail: str | None = None,
) -> AuditLog:
    event = AuditLog(
        actor_user_id=actor_user_id,
        action=action,
        target=target,
        detail=detail,
    )
    db.add(event)
    return event

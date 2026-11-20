import logging

from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog

logger = logging.getLogger(__name__)


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
    # Tools → Logs shows configuration changes alongside service events (#47). The
    # detail stays in the audit log only; the action and target carry no secrets.
    logger.info("Audit: %s%s (user %s)", action, f" {target}" if target else "", actor_user_id or "system")
    return event

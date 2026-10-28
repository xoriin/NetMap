"""The last active SuperAdmin guard, shared by user management and SSO role sync."""

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models.user import User, UserRole


def demote_super_admin_unless_last(db: Session, user: User, *, role: str, is_active: bool) -> bool:
    """Demote or disable an active SuperAdmin in one conditional UPDATE, so two
    concurrent requests can never remove the last one between them.

    Returns False, changing nothing, when no other active SuperAdmin exists.
    """
    others = (
        select(func.count())
        .select_from(User)
        .where(User.role == UserRole.SUPER_ADMIN, User.is_active.is_(True), User.id != user.id)
        .scalar_subquery()
    )
    result = db.execute(
        update(User)
        .where(User.id == user.id, others > 0)
        .values(role=role, is_active=is_active)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1

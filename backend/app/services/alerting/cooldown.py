"""UTC-safe cooldown arithmetic shared by device and endpoint alert workers."""
from datetime import datetime, timezone

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.models.alert_rule import AlertRule


def cooldown_ok(rule: AlertRule, now: datetime) -> bool:
    if rule.last_triggered_at is None:
        return True

    def as_utc(value: datetime) -> datetime:
        # SQLite drops timezone information from stored UTC timestamps.
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

    elapsed = (as_utc(now) - as_utc(rule.last_triggered_at)).total_seconds()
    return elapsed >= rule.cooldown_minutes * 60


def stamp_triggered(db: Session, rule_id: int, at: datetime) -> None:
    """Record a notification without touching updated_at, which versions the rule for status page streaks."""
    db.execute(
        update(AlertRule)
        .where(AlertRule.id == rule_id)
        .values(last_triggered_at=at, updated_at=AlertRule.updated_at)
        .execution_options(synchronize_session=False)
    )

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.api_key import ApiKeyThrottleState


def _as_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _get_or_create(db: Session, subject: str) -> ApiKeyThrottleState:
    state = db.scalar(select(ApiKeyThrottleState).where(ApiKeyThrottleState.subject == subject))
    if state is None:
        state = ApiKeyThrottleState(subject=subject, request_count=0, failed_attempts=0)
        db.add(state)
        db.flush()
    return state


def check_and_record(db: Session, api_key_id: int) -> bool:
    """Fixed-window per-key request counter. Returns False when the cap is exceeded."""
    max_calls = max(1, settings.api_key_rate_limit_max_calls)
    window = timedelta(seconds=max(1, settings.api_key_rate_limit_window_seconds))
    now = datetime.now(timezone.utc)
    state = _get_or_create(db, f"apikey:{api_key_id}:calls")
    window_start = _as_aware_utc(state.window_started_at) if state.window_started_at else None
    if window_start is None or now - window_start >= window:
        state.window_started_at = now
        state.request_count = 1
        state.updated_at = now
        return True
    if state.request_count >= max_calls:
        state.updated_at = now
        return False
    state.request_count += 1
    state.updated_at = now
    return True


def is_lookup_locked(db: Session, ip: str | None) -> bool:
    if not ip:
        return False
    state = db.scalar(select(ApiKeyThrottleState).where(ApiKeyThrottleState.subject == f"apikey_ip:{ip}:fail"))
    if state is None or state.locked_until is None:
        return False
    return _as_aware_utc(state.locked_until) > datetime.now(timezone.utc)


def record_lookup_failure(db: Session, ip: str | None) -> bool:
    """Record an invalid-key attempt from an IP. Returns True when this crosses the lockout threshold."""
    if not ip:
        return False
    max_failed = max(1, settings.api_key_max_failed_lookups)
    lockout = timedelta(minutes=max(1, settings.api_key_lookup_lockout_minutes))
    now = datetime.now(timezone.utc)
    state = _get_or_create(db, f"apikey_ip:{ip}:fail")
    state.failed_attempts += 1
    state.updated_at = now
    if state.failed_attempts >= max_failed:
        crossed = state.locked_until is None or _as_aware_utc(state.locked_until) <= now
        state.locked_until = now + lockout
        return crossed
    return False


def clear_lookup_failures(db: Session, ip: str | None) -> None:
    if not ip:
        return
    state = db.scalar(select(ApiKeyThrottleState).where(ApiKeyThrottleState.subject == f"apikey_ip:{ip}:fail"))
    if state is None:
        return
    state.failed_attempts = 0
    state.locked_until = None
    state.updated_at = datetime.now(timezone.utc)

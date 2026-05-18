from __future__ import annotations

from datetime import datetime, timedelta, timezone
from time import sleep

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.auth_session import LoginThrottleState


def throttle_subjects(username: str, ip_address: str | None) -> list[str]:
    subjects = [f"user:{username.lower()}"]
    if settings.auth_ip_lockout_enabled and ip_address:
        subjects.append(f"ip:{ip_address}")
    return subjects


def is_locked(db: Session, subjects: list[str]) -> tuple[bool, int]:
    now = datetime.now(timezone.utc)
    longest_wait = 0
    for subject in subjects:
        state = db.scalar(select(LoginThrottleState).where(LoginThrottleState.subject == subject))
        if state is None or state.locked_until is None or state.locked_until <= now:
            continue
        wait_seconds = int((state.locked_until - now).total_seconds())
        if wait_seconds > longest_wait:
            longest_wait = wait_seconds
    return longest_wait > 0, longest_wait


def record_login_failure(db: Session, subjects: list[str]) -> int:
    now = datetime.now(timezone.utc)
    max_attempts = max(1, settings.auth_max_failed_attempts)
    lockout_window = timedelta(minutes=max(1, settings.auth_lockout_minutes))
    observed_attempts = 1
    for subject in subjects:
        state = db.scalar(select(LoginThrottleState).where(LoginThrottleState.subject == subject))
        if state is None:
            state = LoginThrottleState(subject=subject, failed_attempts=0)
            db.add(state)
        state.failed_attempts += 1
        state.last_failed_at = now
        state.updated_at = now
        if state.failed_attempts >= max_attempts:
            state.locked_until = now + lockout_window
        observed_attempts = max(observed_attempts, state.failed_attempts)
    return observed_attempts


def clear_login_failures(db: Session, subjects: list[str]) -> None:
    now = datetime.now(timezone.utc)
    for subject in subjects:
        state = db.scalar(select(LoginThrottleState).where(LoginThrottleState.subject == subject))
        if state is None:
            continue
        state.failed_attempts = 0
        state.last_failed_at = None
        state.locked_until = None
        state.updated_at = now


def apply_progressive_delay(attempts: int) -> None:
    step_seconds = settings.auth_progressive_delay_seconds
    if step_seconds <= 0:
        return
    delay_seconds = min(float(attempts) * float(step_seconds), 8.0)
    sleep(delay_seconds)

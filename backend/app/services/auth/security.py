from __future__ import annotations

import math
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


def is_locked(db: Session, subjects: list[str], *, now: datetime | None = None) -> tuple[bool, int]:
    now = now or datetime.now(timezone.utc)
    longest_wait = 0
    for subject in subjects:
        state = db.scalar(select(LoginThrottleState).where(LoginThrottleState.subject == subject))
        locked_until = _as_aware_utc(state.locked_until) if state and state.locked_until else None
        if state is None or locked_until is None or locked_until <= now:
            continue
        # Round up: truncating would report "unlocked" in the final second, and
        # the next failure would then re-lock for a whole window.
        wait_seconds = math.ceil((locked_until - now).total_seconds())
        if wait_seconds > longest_wait:
            longest_wait = wait_seconds
    return longest_wait > 0, longest_wait


def record_login_failure(db: Session, subjects: list[str], *, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    lockout_window = timedelta(minutes=max(1, settings.auth_lockout_minutes))
    observed_attempts = 1
    for subject in subjects:
        max_attempts = max(
            1,
            settings.auth_ip_max_failed_attempts
            if subject.startswith("ip:")
            else settings.auth_max_failed_attempts,
        )
        state = db.scalar(select(LoginThrottleState).where(LoginThrottleState.subject == subject))
        if state is None:
            state = LoginThrottleState(subject=subject, failed_attempts=0)
            db.add(state)
        elif _failures_expired(state, now, lockout_window):
            # Failures older than the lockout window (or an expired lockout) no
            # longer count towards the next lockout.
            state.failed_attempts = 0
            state.locked_until = None
        state.failed_attempts += 1
        state.last_failed_at = now
        state.updated_at = now
        if state.failed_attempts >= max_attempts:
            state.locked_until = now + lockout_window
        observed_attempts = max(observed_attempts, state.failed_attempts)
    return observed_attempts


def _failures_expired(state: LoginThrottleState, now: datetime, window: timedelta) -> bool:
    if state.locked_until is not None and _as_aware_utc(state.locked_until) <= now:
        return True
    if state.last_failed_at is None:
        return False
    return now - _as_aware_utc(state.last_failed_at) >= window


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


def clear_user_login_lockout(db: Session, username: str) -> bool:
    subject = f"user:{username.lower()}"
    state = db.scalar(select(LoginThrottleState).where(LoginThrottleState.subject == subject))
    if state is None:
        return False
    clear_login_failures(db, [subject])
    return True


def apply_progressive_delay(attempts: int) -> None:
    step_seconds = settings.auth_progressive_delay_seconds
    if step_seconds <= 0:
        return
    delay_seconds = min(float(attempts) * float(step_seconds), 8.0)
    sleep(delay_seconds)


def _as_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


_RESET_MAX_ATTEMPTS = 5
_RESET_LOCKOUT_MINUTES = 60


_RESET_ACCOUNT_MAX_ATTEMPTS = 5
# Shared bucket for requests whose client address is unknown, so a missing
# address never disables the limit.
_RESET_UNKNOWN_IP_MAX_ATTEMPTS = 20


def _check_reset_rate_limit(db: Session, ip_address: str | None, account: str | None = None) -> bool:
    """Return True if the request should be silently dropped due to rate limiting."""
    limits = [(f"reset:ip:{ip_address}", _RESET_MAX_ATTEMPTS) if ip_address else ("reset:ip:unknown", _RESET_UNKNOWN_IP_MAX_ATTEMPTS)]
    account_key = (account or "").strip().lower()[:254]
    if account_key:
        limits.append((f"reset:account:{account_key}", _RESET_ACCOUNT_MAX_ATTEMPTS))
    now = datetime.now(timezone.utc)
    states = []
    for subject, max_attempts in limits:
        state = db.scalar(select(LoginThrottleState).where(LoginThrottleState.subject == subject))
        if state and state.locked_until and _as_aware_utc(state.locked_until) > now:
            return True
        states.append((subject, max_attempts, state))
    for subject, max_attempts, state in states:
        if state is None:
            state = LoginThrottleState(subject=subject, failed_attempts=0)
            db.add(state)
        elif state.locked_until or (
            state.last_failed_at
            and now - _as_aware_utc(state.last_failed_at) > timedelta(minutes=_RESET_LOCKOUT_MINUTES)
        ):
            state.failed_attempts = 0
            state.locked_until = None
        state.failed_attempts += 1
        state.last_failed_at = now
        state.updated_at = now
        if state.failed_attempts >= max_attempts:
            state.locked_until = now + timedelta(minutes=_RESET_LOCKOUT_MINUTES)
    db.commit()
    return False


_SSO_EMAIL_MAX_REQUESTS = 5
_SSO_EMAIL_WINDOW_MINUTES = 15


def sso_email_change_wait_seconds(db: Session, user_id: int) -> int:
    """Count a per-user SSO email-change request. Returns 0 when it may go
    ahead, otherwise the seconds until the user may try again. Uses the same
    throttle table as sign-in and password reset, and commits the count before
    the caller contacts the provider."""
    subject = f"sso_email:user:{user_id}"
    now = datetime.now(timezone.utc)
    locked, wait_seconds = is_locked(db, [subject], now=now)
    if locked:
        return wait_seconds
    window = timedelta(minutes=_SSO_EMAIL_WINDOW_MINUTES)
    state = db.scalar(select(LoginThrottleState).where(LoginThrottleState.subject == subject))
    if state is None:
        state = LoginThrottleState(subject=subject, failed_attempts=0)
        db.add(state)
    elif _failures_expired(state, now, window):
        state.failed_attempts = 0
        state.locked_until = None
    state.failed_attempts += 1
    state.last_failed_at = now
    state.updated_at = now
    if state.failed_attempts >= _SSO_EMAIL_MAX_REQUESTS:
        state.locked_until = now + window
    db.commit()
    return 0

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.security import create_access_token, create_refresh_token, decode_token
from app.models.auth_session import AuthSession, RefreshTokenState
from app.models.user import User


def get_token_jti(token: str, token_type: str) -> str:
    payload = decode_token(token, token_type)
    if payload is None or not payload.get("jti"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return str(payload["jti"])


def register_refresh_token(
    db: Session,
    *,
    user_id: int,
    refresh_token: str,
    client_ip: str | None,
    session_id: str | None = None,
) -> None:
    payload = decode_token(refresh_token, "refresh")
    if payload is None or payload.get("jti") is None or payload.get("exp") is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    expires_at = datetime.fromtimestamp(int(payload["exp"]), tz=timezone.utc)
    state = RefreshTokenState(
        user_id=user_id,
        jti=str(payload["jti"]),
        expires_at=expires_at,
        created_ip=client_ip,
        session_id=session_id,
    )
    db.add(state)


def validate_refresh_token_state(
    db: Session,
    *,
    user: User,
    refresh_token: str,
) -> RefreshTokenState:
    payload = decode_token(refresh_token, "refresh")
    if payload is None or payload.get("sub") is None or payload.get("jti") is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    if int(payload["sub"]) != user.id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    jti = str(payload["jti"])
    state = db.scalar(select(RefreshTokenState).where(RefreshTokenState.jti == jti))
    now = datetime.utcnow()
    expires_at = state.expires_at.replace(tzinfo=None) if state and state.expires_at else None
    if state is not None and state.user_id == user.id and state.revoked_reason == "rotated":
        _handle_rotated_refresh_replay(db, state)
    if (
        state is None
        or state.user_id != user.id
        or state.revoked_at is not None
        or expires_at is None
        or expires_at <= now
        or not _session_row_active(db, state.session_id, user.id)
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    return state


# Two tabs refreshing at the same moment both present the same token; only
# a replay after this grace period is treated as theft.
ROTATION_REPLAY_GRACE = timedelta(seconds=10)


def _handle_rotated_refresh_replay(db: Session, state: RefreshTokenState) -> None:
    """A refresh token that was already rotated is being used again: whoever holds
    it is not the legitimate client, so end the whole family it belongs to."""
    revoked_at = state.revoked_at
    if revoked_at is not None:
        if revoked_at.tzinfo is None:
            revoked_at = revoked_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - revoked_at < ROTATION_REPLAY_GRACE:
            return
    now = datetime.now(timezone.utc)
    session_ids: set[str] = set()
    current: RefreshTokenState | None = state
    seen: set[str] = set()
    # Walk the rotation chain so tokens from before sessions existed are covered too.
    while current is not None and current.jti not in seen:
        seen.add(current.jti)
        if current.session_id:
            session_ids.add(current.session_id)
        if current.revoked_at is None:
            current.revoked_at = now
            current.revoked_reason = "replay_detected"
        nxt = current.replaced_by_jti
        current = db.scalar(select(RefreshTokenState).where(RefreshTokenState.jti == nxt)) if nxt else None
    if session_ids:
        db.execute(
            update(RefreshTokenState)
            .where(RefreshTokenState.session_id.in_(session_ids), RefreshTokenState.revoked_at.is_(None))
            .values(revoked_at=now, revoked_reason="replay_detected")
            .execution_options(synchronize_session=False)
        )
        db.execute(
            update(AuthSession)
            .where(AuthSession.id.in_(session_ids), AuthSession.revoked_at.is_(None))
            .values(revoked_at=now, revoked_reason="replay_detected")
            .execution_options(synchronize_session=False)
        )
    from app.services.audit.service import write_audit

    write_audit(
        db,
        action="auth.refresh_replay_detected",
        actor_user_id=state.user_id,
        target=f"user_id:{state.user_id}",
        detail=f"jti={state.jti} sessions={len(session_ids)}",
    )
    # Persist the revocation even though the request itself is refused.
    db.commit()
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")


def _session_row_active(db: Session, session_id: str | None, user_id: int) -> bool:
    if session_id is None:
        return True
    row = db.get(AuthSession, session_id)
    return row is not None and row.user_id == user_id and row.revoked_at is None


def session_claim_active(db: Session, payload: dict, user_id: int) -> bool:
    """Tokens from before sessions existed have no sid and are accepted; a
    present sid must name a live session of this user; anything else fails closed."""
    if "sid" not in payload:
        return True
    sid = payload["sid"]
    if not isinstance(sid, str) or not sid:
        return False
    return _session_row_active(db, sid, user_id)


def start_auth_session(db: Session, *, user_id: int) -> str:
    session_id = token_urlsafe(32)
    db.add(AuthSession(id=session_id, user_id=user_id))
    return session_id


def revoke_auth_session(db: Session, *, session_id: str | None, user_id: int, reason: str) -> None:
    if not session_id:
        return
    now = datetime.now(timezone.utc)
    db.execute(
        update(AuthSession)
        .where(AuthSession.id == session_id, AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=now, revoked_reason=reason)
        .execution_options(synchronize_session=False)
    )
    db.execute(
        update(RefreshTokenState)
        .where(RefreshTokenState.session_id == session_id, RefreshTokenState.revoked_at.is_(None))
        .values(revoked_at=now, revoked_reason=reason)
        .execution_options(synchronize_session=False)
    )


def revoke_refresh_token_state(
    state: RefreshTokenState,
    *,
    reason: str,
    replaced_by_jti: str | None = None,
) -> None:
    state.revoked_at = datetime.now(timezone.utc)
    state.revoked_reason = reason
    state.replaced_by_jti = replaced_by_jti


def issue_token_pair(db: Session, user: User, *, client_ip: str | None) -> tuple[str, str]:
    """Access and refresh tokens stamped with the user's current session version."""
    session_id = start_auth_session(db, user_id=user.id)
    claims = {"sv": int(user.token_version or 0), "sid": session_id}
    access_token = create_access_token(user.id, claims)
    refresh_token = create_refresh_token(user.id, claims)
    register_refresh_token(db, user_id=user.id, refresh_token=refresh_token, client_ip=client_ip, session_id=session_id)
    return access_token, refresh_token


def bump_token_version(db: Session, *, user_id: int) -> None:
    """End every access and refresh token the user holds, in the caller's transaction."""
    db.execute(
        update(User)
        .where(User.id == user_id)
        .values(token_version=User.token_version + 1)
        .execution_options(synchronize_session="evaluate")
    )


def revoke_all_user_refresh_tokens(db: Session, *, user_id: int, reason: str) -> int:
    """Sign the user out everywhere: bump the session version (so access tokens
    stop working at once) and revoke every refresh token, atomically."""
    bump_token_version(db, user_id=user_id)
    now = datetime.now(timezone.utc)
    active = db.scalars(
        select(RefreshTokenState).where(
            RefreshTokenState.user_id == user_id,
            RefreshTokenState.revoked_at.is_(None),
        )
    ).all()
    for state in active:
        state.revoked_at = now
        state.revoked_reason = reason
    db.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=now, revoked_reason=reason)
        .execution_options(synchronize_session=False)
    )
    return len(active)


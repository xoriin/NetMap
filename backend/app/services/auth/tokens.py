from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import decode_token
from app.models.auth_session import RefreshTokenState
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
    now = datetime.now(timezone.utc)
    if (
        state is None
        or state.user_id != user.id
        or state.revoked_at is not None
        or state.expires_at <= now
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    return state


def revoke_refresh_token_state(
    state: RefreshTokenState,
    *,
    reason: str,
    replaced_by_jti: str | None = None,
) -> None:
    state.revoked_at = datetime.now(timezone.utc)
    state.revoked_reason = reason
    state.replaced_by_jti = replaced_by_jti


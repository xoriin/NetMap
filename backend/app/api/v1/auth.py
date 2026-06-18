from datetime import datetime, timezone
from secrets import token_urlsafe
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_super_admin
from app.core.config import settings
from app.core.network import request_client_ip
from app.core.security import (
    create_access_token,
    create_password_reset_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.db.session import get_db
from app.middleware.csrf import CSRF_COOKIE_NAME
from app.models.password_reset_token import PasswordResetToken
from app.models.user import User, UserRole
from app.schemas.auth import (
    AdminCreate,
    ForgotPasswordRequest,
    LoginRequest,
    LogoutRequest,
    PasswordChangeRequest,
    ProfileUpdateRequest,
    RefreshRequest,
    ResetPasswordRequest,
    SetupStatus,
    TokenPair,
    UserCreateRequest,
    UserRead,
    UserUpdateRequest,
)
from app.services.auth import (
    apply_progressive_delay,
    clear_login_failures,
    clear_user_login_lockout,
    is_locked,
    record_login_failure,
    register_refresh_token,
    revoke_all_user_refresh_tokens,
    revoke_refresh_token_state,
    throttle_subjects,
    validate_refresh_token_state,
)
from app.services.auth.security import _check_reset_rate_limit
from app.schemas.admin import AdminPasswordResetRequest
from app.services.audit.service import write_audit
from app.services.notifications import (
    send_password_reset_email,
    send_self_service_password_reset_email,
    send_welcome_email,
)

router = APIRouter(tags=["auth"])


@router.get("/setup/status", response_model=SetupStatus)
def setup_status(db: Annotated[Session, Depends(get_db)]) -> SetupStatus:
    user_count = db.scalar(select(func.count()).select_from(User)) or 0
    return SetupStatus(needs_setup=user_count == 0)


@router.post("/setup/admin", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_initial_admin(
    payload: AdminCreate,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    user_count = db.scalar(select(func.count()).select_from(User)) or 0
    if user_count > 0:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Initial setup is complete")

    existing_user = db.scalar(select(User).where(User.username == payload.username))
    if existing_user is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username is unavailable")

    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=UserRole.SUPER_ADMIN,
    )
    db.add(user)
    db.flush()
    write_audit(
        db,
        action="setup.initial_admin_created",
        actor_user_id=user.id,
        target=f"user:{user.username}",
    )
    db.commit()
    db.refresh(user)
    return user


def _set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    secure = settings.auth_cookie_secure
    csrf_token = token_urlsafe(32)
    response.set_cookie(
        key="netmap_access",
        value=access_token,
        httponly=True,
        secure=secure,
        samesite="strict",
        path="/api/",
        max_age=settings.access_token_minutes * 60,
    )
    response.set_cookie(
        key="netmap_refresh",
        value=refresh_token,
        httponly=True,
        secure=secure,
        samesite="strict",
        path="/api/v1/auth/",
        max_age=settings.refresh_token_days * 86400,
    )
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=csrf_token,
        httponly=False,
        secure=secure,
        samesite="strict",
        path="/",
        max_age=settings.refresh_token_days * 86400,
    )


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(key="netmap_access", path="/api/")
    response.delete_cookie(key="netmap_refresh", path="/api/v1/auth/")
    response.delete_cookie(key=CSRF_COOKIE_NAME, path="/")
    response.delete_cookie(key=CSRF_COOKIE_NAME, path="/api/")


@router.post("/auth/login", response_model=TokenPair)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> TokenPair:
    client_ip = client_ip_from_request(request)
    subjects = throttle_subjects(payload.username, client_ip)
    locked, wait_seconds = is_locked(db, subjects)
    if locked:
        write_audit(
            db,
            action="auth.login_blocked",
            target=f"user:{payload.username}",
            detail=f"wait_seconds={wait_seconds} ip={client_ip or '-'}",
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many login attempts. Retry in {wait_seconds} seconds.",
        )

    user = db.scalar(select(User).where(User.username == payload.username))
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        attempts = record_login_failure(db, subjects)
        write_audit(
            db,
            action="auth.login_failed",
            target=f"user:{payload.username}",
            detail=f"attempts={attempts} ip={client_ip or '-'}",
        )
        db.commit()
        apply_progressive_delay(attempts)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    clear_login_failures(db, subjects)
    access_token = create_access_token(user.id)
    refresh_token = create_refresh_token(user.id)
    register_refresh_token(db, user_id=user.id, refresh_token=refresh_token, client_ip=client_ip)
    write_audit(
        db,
        action="auth.login_success",
        actor_user_id=user.id,
        target=f"user:{user.username}",
        detail=f"ip={client_ip or '-'}",
    )
    db.commit()
    _set_auth_cookies(response, access_token, refresh_token)
    return TokenPair(access_token=access_token)


@router.post("/auth/refresh", response_model=TokenPair)
def refresh(
    payload: RefreshRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> TokenPair:
    refresh_token_value = (payload.refresh_token if payload else None) or request.cookies.get("netmap_refresh")
    if not refresh_token_value:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token required")

    token_payload = validate_refresh_claims(refresh_token_value)
    user = db.get(User, int(token_payload["sub"]))
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    prior_state = validate_refresh_token_state(db, user=user, refresh_token=refresh_token_value)
    next_refresh_token = create_refresh_token(user.id)
    next_claims = validate_refresh_claims(next_refresh_token)
    next_jti = str(next_claims["jti"])
    revoke_refresh_token_state(
        prior_state,
        reason="rotated",
        replaced_by_jti=next_jti,
    )
    register_refresh_token(
        db,
        user_id=user.id,
        refresh_token=next_refresh_token,
        client_ip=client_ip_from_request(request),
    )

    write_audit(
        db,
        action="auth.refresh_rotated",
        actor_user_id=user.id,
        target=f"user:{user.username}",
        detail=f"old_jti={prior_state.jti}",
    )
    db.commit()
    next_access_token = create_access_token(user.id)
    _set_auth_cookies(response, next_access_token, next_refresh_token)
    return TokenPair(access_token=next_access_token)


@router.get("/auth/me", response_model=UserRead)
def me(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return current_user


@router.patch("/auth/me", response_model=UserRead)
def update_profile(
    payload: ProfileUpdateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    updates = payload.model_dump(exclude_unset=True)
    if "display_name" in updates:
        current_user.display_name = updates["display_name"]
    if "avatar_data" in updates:
        avatar = updates["avatar_data"]
        if avatar is not None and len(avatar) > 2_097_152:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Avatar image too large (2 MB max)")
        current_user.avatar_data = avatar
    if "email" in updates:
        current_user.email = updates["email"] or None
    write_audit(
        db,
        action="auth.profile_updated",
        actor_user_id=current_user.id,
        target=f"user:{current_user.username}",
    )
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    payload: LogoutRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    refresh_token_value = (payload.refresh_token if payload else None) or request.cookies.get("netmap_refresh")
    current_user: User | None = None
    if refresh_token_value:
        try:
            claims = validate_refresh_claims(refresh_token_value)
            current_user = db.get(User, int(claims["sub"]))
            if current_user is None:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
            token_state = validate_refresh_token_state(db, user=current_user, refresh_token=refresh_token_value)
            revoke_refresh_token_state(token_state, reason="logout")
        except HTTPException:
            pass
    if current_user is not None:
        write_audit(
            db,
            action="auth.logout",
            actor_user_id=current_user.id,
            target=f"user:{current_user.username}",
        )
    db.commit()
    _clear_auth_cookies(response)


@router.post("/auth/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChangeRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    if not verify_password(payload.current_password, current_user.password_hash):
        write_audit(
            db,
            action="auth.password_change_failed",
            actor_user_id=current_user.id,
            target=f"user:{current_user.username}",
        )
        db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Current password is invalid")

    current_user.password_hash = hash_password(payload.new_password)
    revoke_all_user_refresh_tokens(db, user_id=current_user.id, reason="password_changed")
    write_audit(
        db,
        action="auth.password_changed",
        actor_user_id=current_user.id,
        target=f"user:{current_user.username}",
    )
    db.commit()


@router.get("/auth/users", response_model=list[UserRead])
def list_users(
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> list[User]:
    return db.scalars(select(User).order_by(User.username)).all()


@router.post("/auth/users", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreateRequest,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    existing_user = db.scalar(select(User).where(User.username == payload.username))
    if existing_user is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username is unavailable")

    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
        is_active=payload.is_active,
        email=payload.email or None,
    )
    db.add(user)
    db.flush()
    write_audit(
        db,
        action="auth.user_created",
        actor_user_id=current_user.id,
        target=f"user:{user.username}",
        detail=f"role={user.role} active={user.is_active}",
    )
    db.commit()
    db.refresh(user)
    if user.email:
        try:
            send_welcome_email(
                db,
                username=user.username,
                display_name=user.display_name,
                email=user.email,
                role=str(user.role),
            )
        except Exception:
            pass
    return user


@router.patch("/auth/users/{user_id}", response_model=UserRead)
def update_user(
    user_id: int,
    payload: UserUpdateRequest,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    updates = payload.model_dump(exclude_unset=True)
    if "role" in updates and updates["role"] is not None:
        user.role = updates["role"]
    if "is_active" in updates and updates["is_active"] is not None:
        user.is_active = updates["is_active"]
    if "email" in updates:
        user.email = updates["email"] or None
    if "avatar_data" in updates:
        avatar = updates["avatar_data"]
        if avatar is not None and len(avatar) > 2_097_152:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Avatar image too large (max 2 MB)")
        user.avatar_data = avatar

    write_audit(
        db,
        action="auth.user_updated",
        actor_user_id=current_user.id,
        target=f"user:{user.username}",
        detail=f"role={user.role} active={user.is_active} email={'set' if user.email else 'cleared'}",
    )
    db.commit()
    db.refresh(user)
    return user


@router.post("/auth/users/{user_id}/unlock-login", status_code=status.HTTP_204_NO_CONTENT)
def unlock_user_login(
    user_id: int,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    cleared = clear_user_login_lockout(db, user.username)
    write_audit(
        db,
        action="auth.user_login_unlocked",
        actor_user_id=current_user.id,
        target=f"user:{user.username}",
        detail=f"cleared={cleared}",
    )
    db.commit()


@router.post("/auth/users/{user_id}/reset-password", status_code=status.HTTP_204_NO_CONTENT)
def admin_reset_password(
    user_id: int,
    payload: AdminPasswordResetRequest,
    current_user: Annotated[User, Depends(require_super_admin)],
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user.password_hash = hash_password(payload.new_password)
    _invalidate_pending_reset_tokens(db, user.id)
    revoke_all_user_refresh_tokens(db, user_id=user.id, reason="admin_password_reset")
    write_audit(
        db,
        action="auth.admin_password_reset",
        actor_user_id=current_user.id,
        target=f"user:{user.username}",
    )
    db.commit()
    if user.email and settings.app_url:
        try:
            token = create_password_reset_token(user.id)
            _store_reset_token(db, token, user.id)
            db.commit()
            reset_link = f"{settings.app_url.rstrip('/')}?reset_token={token}"
            send_password_reset_email(
                db,
                username=user.username,
                display_name=user.display_name,
                email=user.email,
                reset_link=reset_link,
            )
        except Exception:
            pass


@router.delete("/auth/users/{user_id}/sessions", status_code=status.HTTP_204_NO_CONTENT)
def force_logout_user(
    user_id: int,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    from app.models.auth_session import RefreshTokenState
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    now = datetime.now(timezone.utc)
    active_sessions = db.scalars(
        select(RefreshTokenState).where(
            RefreshTokenState.user_id == user_id,
            RefreshTokenState.revoked_at.is_(None),
        )
    ).all()
    for session in active_sessions:
        session.revoked_at = now
        session.revoked_reason = "admin_force_logout"
    write_audit(
        db,
        action="auth.admin_force_logout",
        actor_user_id=current_user.id,
        target=f"user:{user.username}",
        detail=f"sessions={len(active_sessions)}",
    )
    db.commit()


def validate_refresh_claims(refresh_token: str) -> dict:
    claims = decode_token(refresh_token, "refresh")
    if claims is None or claims.get("sub") is None or claims.get("jti") is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    return claims


def client_ip_from_request(request: Request) -> str | None:
    return request_client_ip(request)


def _store_reset_token(db: Session, token: str, user_id: int) -> None:
    claims = decode_token(token, "password_reset")
    if claims is None:
        return
    jti = str(claims["jti"])
    expires_at = datetime.fromtimestamp(int(claims["exp"]), tz=timezone.utc)
    db.add(PasswordResetToken(jti=jti, user_id=user_id, expires_at=expires_at))


def _invalidate_pending_reset_tokens(db: Session, user_id: int) -> None:
    now = datetime.now(timezone.utc)
    pending = db.scalars(
        select(PasswordResetToken).where(
            PasswordResetToken.user_id == user_id,
            PasswordResetToken.used_at.is_(None),
        )
    ).all()
    for t in pending:
        t.used_at = now


@router.post("/auth/forgot-password", status_code=status.HTTP_204_NO_CONTENT)
def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    # Always return 204 regardless of outcome to prevent user enumeration and timing attacks.
    client_ip = request_client_ip(request)
    if _check_reset_rate_limit(db, client_ip):
        return
    user = db.scalar(
        select(User).where(
            or_(
                User.username == payload.username_or_email,
                User.email == payload.username_or_email,
            )
        )
    )
    if user is None or not user.is_active or not user.email or not settings.app_url:
        return

    _invalidate_pending_reset_tokens(db, user.id)
    token = create_password_reset_token(user.id)
    _store_reset_token(db, token, user.id)
    reset_link = f"{settings.app_url.rstrip('/')}?reset_token={token}"

    try:
        send_self_service_password_reset_email(
            db,
            username=user.username,
            display_name=user.display_name,
            email=user.email,
            reset_link=reset_link,
        )
        write_audit(
            db,
            action="auth.password_reset_requested",
            actor_user_id=user.id,
            target=f"user:{user.username}",
        )
        db.commit()
    except Exception:
        pass


@router.post("/auth/reset-password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password_with_token(
    payload: ResetPasswordRequest,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    _invalid = HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Invalid or expired password reset link",
    )
    claims = decode_token(payload.reset_token, "password_reset")
    if claims is None:
        raise _invalid

    jti = str(claims.get("jti", ""))
    token_row = db.scalar(select(PasswordResetToken).where(PasswordResetToken.jti == jti)) if jti else None
    if token_row is None or token_row.used_at is not None:
        raise _invalid

    user_id = int(claims["sub"])
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise _invalid

    _invalidate_pending_reset_tokens(db, user.id)
    user.password_hash = hash_password(payload.new_password)
    revoke_all_user_refresh_tokens(db, user_id=user.id, reason="password_reset")
    write_audit(
        db,
        action="auth.password_reset_self_service",
        actor_user_id=user.id,
        target=f"user:{user.username}",
    )
    db.commit()

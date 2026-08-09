from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.network import request_client_ip
from app.core.security import decode_token
from app.db.session import get_db
from app.models.user import User, UserRole
from app.services.api_keys.service import touch_last_used, verify_and_load
from app.services.api_keys.throttle import (
    check_and_record,
    clear_lookup_failures,
    is_lookup_locked,
    record_lookup_failure,
)
from app.services.audit.service import write_audit
from app.services.rbac.permissions import has_permission

bearer_scheme = HTTPBearer(
    auto_error=False,
    scheme_name="BearerAuth",
    description="A NetMap access token. External integrations should normally use ApiKeyAuth.",
)

API_KEY_HEADER = "x-api-key"


def _authenticate_api_key(raw_key: str, request: Request, db: Session) -> User:
    client_ip = request_client_ip(request)
    if is_lookup_locked(db, client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed API key attempts; try again later",
        )
    key = verify_and_load(db, raw_key)
    if key is None:
        crossed_threshold = record_lookup_failure(db, client_ip)
        if crossed_threshold:
            write_audit(
                db,
                action="apikey.auth_failed",
                target=f"ip:{client_ip or '-'}",
                detail="failed API key lookups exceeded threshold; source locked out",
            )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid, expired, or revoked API key",
        )
    if not check_and_record(db, key.id):
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="API key rate limit exceeded",
        )
    user = db.get(User, key.user_id)
    if user is None or not user.is_active:
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or inactive user",
        )
    clear_lookup_failures(db, client_ip)
    touch_last_used(db, key, client_ip)
    db.commit()
    request.state.api_key_id = key.id
    return user


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    api_key_header = request.headers.get(API_KEY_HEADER)
    if api_key_header:
        return _authenticate_api_key(api_key_header, request, db)

    raw_token: str | None = None
    if credentials is not None:
        raw_token = credentials.credentials
    else:
        raw_token = request.cookies.get("netmap_access")

    if not raw_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    payload = decode_token(raw_token, "access")
    if payload is None or payload.get("sub") is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    user = db.get(User, int(payload["sub"]))
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or inactive user",
        )
    return user


def _check(user: User, permission: str, detail: str) -> User:
    if user.role == UserRole.SUPER_ADMIN:
        return user
    if not has_permission(user.role, permission):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)
    return user


def require_topology_write(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return _check(
        current_user, "topology_write", "Topology write access is not permitted for your role"
    )


def require_super_admin(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    if current_user.role != UserRole.SUPER_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="This action requires SuperAdmin"
        )
    return current_user


def require_security_view(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return _check(
        current_user, "security_view", "Security event access is not permitted for your role"
    )


def require_tools_passive(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return _check(
        current_user, "tools_passive", "Network tools access is not permitted for your role"
    )


def require_tools_active(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return _check(current_user, "tools_active", "Active scanning is not permitted for your role")


def require_inventory_export(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return _check(
        current_user, "inventory_export", "Inventory export is not permitted for your role"
    )


def require_firewall_export(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return _check(
        current_user, "firewall_export", "Firewall log export is not permitted for your role"
    )


def require_report_export(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return _check(current_user, "report_export", "Report export is not permitted for your role")


def require_alert_write(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return _check(current_user, "alert_write", "Alert management is not permitted for your role")


def require_ipam_write(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    return _check(current_user, "ipam_write", "IPAM write access is not permitted for your role")

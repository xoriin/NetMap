from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import require_super_admin
from app.core.config import settings
from app.db.session import get_db
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.schemas.admin import (
    NotificationSettings,
    NotificationSettingsUpdate,
    PermissionMeta,
    RoleCreate,
    RolePermissionsResponse,
    RolePermissionsUpdate,
    SystemSettingsRead,
    SystemSettingsUpdate,
    TestNotificationRequest,
)
from app.services.notifications import (
    NOTIFICATION_DEFAULTS,
    _REDACTED,
    _SECRET_FIELDS,
    load_notification_settings,
    load_notification_settings_redacted,
    save_notification_setting,
    send_notification,
)
from app.services.rbac.permissions import (
    BUILT_IN_ROLES,
    PERMISSION_KEYS,
    PERMISSION_META,
    ROLE_DEFAULTS,
    add_role,
    delete_role,
    dump_to_json,
    get_all_permissions,
    set_role_permissions,
)

router = APIRouter(prefix="/admin", tags=["admin"])

DEFAULTS: dict[str, str] = {
    "app_name": "NetMap",
    "login_message": "",
    "announcement": "",
    "live_ping_enabled": "true",
    "monitor_interval_seconds": "300",
    "idle_timeout_minutes": "15",
    "active_network_public_targets_enabled": str(settings.active_network_public_targets_enabled).lower(),
}


def _load(db: Session, defaults: dict[str, str]) -> dict[str, str]:
    rows = db.scalars(select(SystemSetting)).all()
    result = dict(defaults)
    for row in rows:
        if row.key in result:
            result[row.key] = row.value
    return result


def _save(db: Session, defaults: dict[str, str], updates: dict[str, str | None]) -> None:
    now = datetime.now(timezone.utc)
    for key, value in updates.items():
        if key not in defaults:
            continue
        str_value = "" if value is None else str(value)
        existing = db.get(SystemSetting, key)
        if existing:
            existing.value = str_value
            existing.updated_at = now
        else:
            db.add(SystemSetting(key=key, value=str_value, updated_at=now))
    db.commit()


def load_settings(db: Session) -> dict[str, str]:
    return _load(db, DEFAULTS)


@router.get("/settings/public", response_model=SystemSettingsRead)
def get_public_settings(db: Annotated[Session, Depends(get_db)]) -> SystemSettingsRead:
    return SystemSettingsRead(**load_settings(db))


@router.get("/settings", response_model=SystemSettingsRead)
def get_settings(
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> SystemSettingsRead:
    return SystemSettingsRead(**load_settings(db))


@router.put("/settings", response_model=SystemSettingsRead)
def update_settings(
    payload: SystemSettingsUpdate,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> SystemSettingsRead:
    _save(db, DEFAULTS, payload.model_dump(exclude_unset=True))
    return SystemSettingsRead(**load_settings(db))


@router.get("/notification-settings", response_model=NotificationSettings)
def get_notification_settings(
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> NotificationSettings:
    return NotificationSettings(**load_notification_settings_redacted(db))


@router.put("/notification-settings", response_model=NotificationSettings)
def update_notification_settings(
    payload: NotificationSettingsUpdate,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> NotificationSettings:
    updates = payload.model_dump(exclude_unset=True)
    secret_updates = {k: v for k, v in updates.items() if k in _SECRET_FIELDS and v is not None and v != _REDACTED}
    non_secret_updates = {k: v for k, v in updates.items() if k not in _SECRET_FIELDS}
    _save(db, NOTIFICATION_DEFAULTS, non_secret_updates)
    for key, value in secret_updates.items():
        save_notification_setting(db, key, value)
    db.commit()
    return NotificationSettings(**load_notification_settings_redacted(db))


@router.post("/notifications/test")
def test_notification(
    payload: TestNotificationRequest,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, str]:
    result = send_notification(payload.channel, payload.message, load_notification_settings(db))
    return {"status": result}


@router.get("/role-permissions", response_model=RolePermissionsResponse)
def get_role_permissions(
    _current_user: Annotated[User, Depends(require_super_admin)],
) -> RolePermissionsResponse:
    return RolePermissionsResponse(
        permissions=[
            PermissionMeta(key=k, **PERMISSION_META[k])
            for k in PERMISSION_KEYS
        ],
        roles=get_all_permissions(),
    )


@router.put("/role-permissions", response_model=RolePermissionsResponse)
def update_role_permissions(
    payload: RolePermissionsUpdate,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> RolePermissionsResponse:
    for role, perms in payload.roles.items():
        if role in ROLE_DEFAULTS:
            set_role_permissions(role, perms)
    now = datetime.now(timezone.utc)
    existing = db.get(SystemSetting, "role_permissions")
    if existing:
        existing.value = dump_to_json()
        existing.updated_at = now
    else:
        db.add(SystemSetting(key="role_permissions", value=dump_to_json(), updated_at=now))
    db.commit()
    return RolePermissionsResponse(
        permissions=[
            PermissionMeta(key=k, **PERMISSION_META[k])
            for k in PERMISSION_KEYS
        ],
        roles=get_all_permissions(),
    )


def _persist_roles(db: Session) -> None:
    now = datetime.now(timezone.utc)
    existing = db.get(SystemSetting, "role_permissions")
    if existing:
        existing.value = dump_to_json()
        existing.updated_at = now
    else:
        db.add(SystemSetting(key="role_permissions", value=dump_to_json(), updated_at=now))
    db.commit()


def _role_permissions_response() -> RolePermissionsResponse:
    return RolePermissionsResponse(
        permissions=[PermissionMeta(key=k, **PERMISSION_META[k]) for k in PERMISSION_KEYS],
        roles=get_all_permissions(),
    )


@router.post("/roles", response_model=RolePermissionsResponse, status_code=status.HTTP_201_CREATED)
def create_role(
    payload: RoleCreate,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> RolePermissionsResponse:
    if payload.name in BUILT_IN_ROLES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Cannot create a built-in role")
    add_role(payload.name)
    _persist_roles(db)
    return _role_permissions_response()


@router.delete("/roles/{name}", response_model=RolePermissionsResponse)
def delete_role_endpoint(
    name: str,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> RolePermissionsResponse:
    if name == "SuperAdmin":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete the SuperAdmin role")
    delete_role(name)
    # Reassign any users with this role to Viewer
    from app.models.user import User as UserModel
    from sqlalchemy import update as sa_update
    db.execute(sa_update(UserModel).where(UserModel.role == name).values(role="Viewer"))
    _persist_roles(db)
    return _role_permissions_response()

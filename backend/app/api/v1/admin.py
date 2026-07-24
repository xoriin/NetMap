from datetime import datetime, timezone
import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_super_admin
from app.core.config import settings
from app.db.session import get_db
from app.models.device import Device
from app.models.device_type import DeviceType
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.schemas.admin import (
    DeviceTypeCreate,
    DeviceTypeRead,
    DeviceTypeUpdate,
    NotificationSettings,
    NotificationSettingsUpdate,
    PermissionMeta,
    RoleCreate,
    RolePermissionsResponse,
    RolePermissionsUpdate,
    SystemSettingsRead,
    SystemSettingsUpdate,
    TestNotificationRequest,
    normalize_device_type_value,
)
from app.schemas.notification import (
    NotificationProfileCreate,
    NotificationProfileRead,
    NotificationProfileUpdate,
)
from app.services.notifications import (
    NOTIFICATION_DEFAULTS,
    _REDACTED,
    _SECRET_FIELDS,
    create_notification_profile,
    get_notification_profile,
    list_notification_profiles,
    load_notification_settings,
    load_notification_settings_redacted,
    save_notification_setting,
    send_notification,
    send_notification_profile,
    update_notification_profile,
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
    "support_email": "",
    "support_url": "",
    "live_ping_enabled": "true",
    "monitor_interval_seconds": "300",
    "idle_timeout_minutes": "15",
    "active_network_public_targets_enabled": str(settings.active_network_public_targets_enabled).lower(),
    "ip_reservation_default_expiry_enabled": "true",
    "ip_reservation_reminder_enabled": "false",
    "ip_reservation_reminder_days": "3",
    "ip_reservation_reminder_channels": "[]",
    "backup_schedule_enabled": "false",
    "backup_schedule_interval_hours": "24",
    "backup_retention_count": "7",
}

BUILT_IN_DEVICE_TYPES: tuple[DeviceTypeRead, ...] = (
    DeviceTypeRead(value="router", label="Router", icon="router", is_builtin=True),
    DeviceTypeRead(value="switch", label="Switch", icon="switch", is_builtin=True),
    DeviceTypeRead(value="firewall", label="Firewall", icon="firewall", is_builtin=True),
    DeviceTypeRead(value="server", label="Server", icon="server", is_builtin=True),
    DeviceTypeRead(value="wireless", label="Wireless", icon="wireless", is_builtin=True),
    DeviceTypeRead(value="workstation", label="Workstation", icon="workstation", is_builtin=True),
    DeviceTypeRead(value="database", label="Database", icon="database", is_builtin=True),
    DeviceTypeRead(value="nas", label="NAS", icon="nas", is_builtin=True),
    DeviceTypeRead(value="camera", label="Camera", icon="camera", is_builtin=True),
    DeviceTypeRead(value="printer", label="Printer", icon="printer", is_builtin=True),
    DeviceTypeRead(value="iot", label="IoT", icon="iot", is_builtin=True),
    DeviceTypeRead(value="hypervisor", label="Hypervisor", icon="hypervisor", is_builtin=True),
    DeviceTypeRead(value="phone", label="Phone", icon="phone", is_builtin=True),
    DeviceTypeRead(value="vpn", label="VPN", icon="vpn", is_builtin=True),
    DeviceTypeRead(value="cloud", label="Cloud", icon="cloud", is_builtin=True),
    DeviceTypeRead(value="other", label="Other", icon="device", is_builtin=True),
    DeviceTypeRead(value="unknown", label="Unknown", icon="unknown", is_builtin=True),
)
BUILT_IN_DEVICE_TYPE_VALUES = {row.value for row in BUILT_IN_DEVICE_TYPES}


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


def _device_type_read(row: DeviceType) -> DeviceTypeRead:
    return DeviceTypeRead(
        id=row.id,
        value=row.value,
        label=row.label,
        icon=row.icon or "device",
        is_builtin=row.is_builtin,
    )


def _list_device_types(db: Session) -> list[DeviceTypeRead]:
    custom = [_device_type_read(row) for row in db.scalars(select(DeviceType).order_by(DeviceType.label)).all()]
    custom_by_value = {row.value: row for row in custom}
    return [*BUILT_IN_DEVICE_TYPES, *[row for row in custom if row.value not in BUILT_IN_DEVICE_TYPE_VALUES and row.value in custom_by_value]]


@router.get("/device-types", response_model=list[DeviceTypeRead])
def list_device_types(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[DeviceTypeRead]:
    return _list_device_types(db)


@router.post("/device-types", response_model=DeviceTypeRead, status_code=status.HTTP_201_CREATED)
def create_device_type(
    payload: DeviceTypeCreate,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceTypeRead:
    value = payload.value or normalize_device_type_value(payload.label)
    if value in BUILT_IN_DEVICE_TYPE_VALUES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device type already exists")
    existing = db.scalar(select(DeviceType).where(DeviceType.value == value))
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device type already exists")
    row = DeviceType(value=value, label=payload.label, icon=payload.icon or "device", is_builtin=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _device_type_read(row)


@router.put("/device-types/{value}", response_model=DeviceTypeRead)
@router.patch("/device-types/{value}", response_model=DeviceTypeRead)
def update_device_type(
    value: str,
    payload: DeviceTypeUpdate,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceTypeRead:
    normalized = normalize_device_type_value(value)
    if normalized in BUILT_IN_DEVICE_TYPE_VALUES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Built-in device types cannot be edited")
    row = db.scalar(select(DeviceType).where(DeviceType.value == normalized))
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device type not found")

    updates = payload.model_dump(exclude_unset=True)
    next_value = updates.get("value") or row.value
    if next_value in BUILT_IN_DEVICE_TYPE_VALUES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device type already exists")
    if next_value != row.value:
        existing = db.scalar(select(DeviceType.id).where(DeviceType.value == next_value).limit(1))
        if existing is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device type already exists")
        db.execute(update(Device).where(Device.device_type == row.value).values(device_type=next_value))
        row.value = next_value

    if "label" in updates and updates["label"] is not None:
        row.label = updates["label"]
    if "icon" in updates and updates["icon"] is not None:
        row.icon = updates["icon"]
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _device_type_read(row)


@router.delete("/device-types/{value}", status_code=status.HTTP_204_NO_CONTENT)
def delete_device_type(
    value: str,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    normalized = normalize_device_type_value(value)
    if normalized in BUILT_IN_DEVICE_TYPE_VALUES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Built-in device types cannot be deleted")
    row = db.scalar(select(DeviceType).where(DeviceType.value == normalized))
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device type not found")
    in_use = db.scalar(select(Device.id).where(Device.device_type == normalized).limit(1))
    if in_use is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device type is in use")
    db.delete(row)
    db.commit()


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
    updates = payload.model_dump(exclude_unset=True)
    if "ip_reservation_reminder_channels" in updates and updates["ip_reservation_reminder_channels"] is not None:
        updates["ip_reservation_reminder_channels"] = json.dumps(updates["ip_reservation_reminder_channels"])
    _save(db, DEFAULTS, updates)
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


@router.get("/notification-profiles", response_model=list[NotificationProfileRead])
def list_notification_profiles_endpoint(
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> list[NotificationProfileRead]:
    return [NotificationProfileRead(**profile) for profile in list_notification_profiles(db, redacted=True)]


@router.post("/notification-profiles", response_model=NotificationProfileRead, status_code=status.HTTP_201_CREATED)
def create_notification_profile_endpoint(
    payload: NotificationProfileCreate,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> NotificationProfileRead:
    profile = create_notification_profile(
        db,
        name=payload.name,
        provider=payload.provider,
        enabled=payload.enabled,
        config=payload.config,
    )
    return NotificationProfileRead(**get_notification_profile(db, profile.id, redacted=True))


@router.patch("/notification-profiles/{profile_id}", response_model=NotificationProfileRead)
def update_notification_profile_endpoint(
    profile_id: int,
    payload: NotificationProfileUpdate,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> NotificationProfileRead:
    from app.models.notification_profile import NotificationProfile

    profile = db.get(NotificationProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Notification profile not found")
    update_notification_profile(db, profile, payload.model_dump(exclude_unset=True))
    return NotificationProfileRead(**get_notification_profile(db, profile_id, redacted=True))


@router.delete("/notification-profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_notification_profile_endpoint(
    profile_id: int,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    from app.models.notification_profile import NotificationProfile

    profile = db.get(NotificationProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Notification profile not found")
    db.delete(profile)
    db.commit()


@router.post("/notification-profiles/{profile_id}/test")
def test_notification_profile_endpoint(
    profile_id: int,
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, str]:
    profile = get_notification_profile(db, profile_id, redacted=False)
    if not profile:
        raise HTTPException(status_code=404, detail="Notification profile not found")
    result = send_notification_profile(profile, "NetMap test notification")
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

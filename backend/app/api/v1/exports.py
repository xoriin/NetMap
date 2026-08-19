import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.api.deps import (
    get_current_user,
    require_backup_manage,
    require_firewall_export,
    require_inventory_export,
    require_report_export,
    require_super_admin,
)
from app.core.validation import normalize_ip, validate_port, validate_syslog_field
from app.db.firewall_session import get_firewall_db
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.user import User, UserRole
from app.services.audit.service import write_audit
from app.services.exports import (
    backup_database_bytes,
    build_firewall_export,
    build_inventory_export,
    build_network_report_pdf,
    restore_database_bytes,
    validate_restore_bytes,
)
from app.services.exports.backup_schedule import (
    backup_filename_path,
    list_scheduled_backups,
)
from app.services.rbac.permissions import has_permission
from app.services.syslog.storage import count_events

router = APIRouter(prefix="/exports", tags=["exports"])


class RestoreValidationResult(BaseModel):
    valid: bool
    size_bytes: int
    table_count: int
    devices: int | None = None
    users: int | None = None
    subnets: int | None = None


class ScheduledBackupRead(BaseModel):
    filename: str
    size_bytes: int
    created_at: datetime


class ExportSummaryRead(BaseModel):
    inventory_rows: int | None = None
    firewall_events: int | None = None
    exports_last_30_days: int
    last_export_at: datetime | None = None
    last_export_type: str | None = None
    last_export_detail: str | None = None


EXPORT_ACTION_LABELS = {
    "export.inventory": "Inventory",
    "export.firewall": "Firewall events",
    "export.report_pdf": "Network report",
}


def _can_export(user: User, permission: str) -> bool:
    return user.role == UserRole.SUPER_ADMIN or has_permission(user.role, permission)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


@router.get("/summary", response_model=ExportSummaryRead)
def export_summary(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> ExportSummaryRead:
    actions = tuple(EXPORT_ACTION_LABELS)
    base = select(AuditLog).where(
        AuditLog.actor_user_id == current_user.id,
        AuditLog.action.in_(actions),
    )
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    recent_count = int(db.scalar(
        select(func.count()).select_from(AuditLog).where(
            AuditLog.actor_user_id == current_user.id,
            AuditLog.action.in_(actions),
            AuditLog.created_at >= cutoff,
        )
    ) or 0)
    last_export = db.scalar(base.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(1))
    return ExportSummaryRead(
        inventory_rows=int(db.scalar(select(func.count()).select_from(Device)) or 0)
        if _can_export(current_user, "inventory_export") else None,
        firewall_events=count_events() if _can_export(current_user, "firewall_export") else None,
        exports_last_30_days=recent_count,
        last_export_at=_as_utc(last_export.created_at) if last_export else None,
        last_export_type=EXPORT_ACTION_LABELS.get(last_export.action) if last_export else None,
        last_export_detail=last_export.detail if last_export else None,
    )


@router.get("/inventory")
def export_inventory(
    format: Literal["csv", "json"] = "csv",
    current_user: Annotated[User, Depends(require_inventory_export)] = None,
    db: Annotated[Session, Depends(get_db)] = None,
) -> Response:
    media_type, filename, payload = build_inventory_export(db, format)
    write_audit(
        db,
        action="export.inventory",
        actor_user_id=current_user.id,
        detail=f"format={format}",
    )
    db.commit()
    return download_response(payload, media_type=media_type, filename=filename)


@router.get("/firewall")
def export_firewall_events(
    current_user: Annotated[User, Depends(require_firewall_export)],
    db: Annotated[Session, Depends(get_db)],
    firewall_db: Annotated[Session, Depends(get_firewall_db)],
    format: Literal["csv", "json"] = "csv",
    limit: Annotated[int, Query(ge=1, le=10000)] = 5000,
    q: Annotated[str | None, Query(max_length=120)] = None,
    src_ip: Annotated[str | None, Query(max_length=64)] = None,
    dst_ip: Annotated[str | None, Query(max_length=64)] = None,
    src_port: Annotated[int | None, Query(ge=0, le=65535)] = None,
    dst_port: Annotated[int | None, Query(ge=0, le=65535)] = None,
    action: Annotated[str | None, Query(max_length=40)] = None,
    protocol: Annotated[str | None, Query(max_length=40)] = None,
    interface: Annotated[str | None, Query(max_length=80)] = None,
    start_time: str | None = None,
    end_time: str | None = None,
) -> Response:
    try:
        if src_ip:
            src_ip = normalize_ip(src_ip)
        if dst_ip:
            dst_ip = normalize_ip(dst_ip)
        if src_port is not None:
            src_port = validate_port(src_port)
        if dst_port is not None:
            dst_port = validate_port(dst_port)
        if action:
            action = validate_syslog_field(action, max_length=40).lower()
        if protocol:
            protocol = validate_syslog_field(protocol, max_length=40).lower()
        if interface:
            interface = validate_syslog_field(interface, max_length=80)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    parsed_start = parse_optional_datetime(start_time)
    parsed_end = parse_optional_datetime(end_time)
    media_type, filename, payload, exported_rows = build_firewall_export(
        firewall_db,
        format,
        q=q,
        src_ip=src_ip,
        dst_ip=dst_ip,
        src_port=src_port,
        dst_port=dst_port,
        action=action,
        protocol=protocol,
        interface=interface,
        start_time=parsed_start,
        end_time=parsed_end,
        limit=limit,
    )
    write_audit(
        db,
        action="export.firewall",
        actor_user_id=current_user.id,
        detail=f"format={format} rows={exported_rows}",
    )
    db.commit()
    return download_response(payload, media_type=media_type, filename=filename)


@router.get("/report.pdf")
def export_network_report(
    current_user: Annotated[User, Depends(require_report_export)],
    db: Annotated[Session, Depends(get_db)],
    firewall_db: Annotated[Session, Depends(get_firewall_db)],
) -> Response:
    payload = build_network_report_pdf(db, firewall_db)
    write_audit(
        db,
        action="export.report_pdf",
        actor_user_id=current_user.id,
    )
    db.commit()
    return download_response(
        payload,
        media_type="application/pdf",
        filename="netmap-network-report.pdf",
    )


@router.get("/backup")
def export_database_backup(
    current_user: Annotated[User, Depends(require_backup_manage)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    try:
        filename, payload = backup_database_bytes()
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=str(exc)) from exc
    except (OSError, sqlite3.Error, DBAPIError) as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Database backup failed") from exc
    write_audit(
        db,
        action="backup.database_exported",
        actor_user_id=current_user.id,
        detail=filename,
    )
    db.commit()
    return download_response(
        payload,
        media_type="application/octet-stream",
        filename=filename,
    )


MAX_BACKUP_SIZE = 500 * 1024 * 1024  # 500 MB


async def _read_backup_payload(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_BACKUP_SIZE:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Backup file too large (500 MB max)")

    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup payload is empty")
    if len(payload) > MAX_BACKUP_SIZE:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Backup file too large (500 MB max)")

    # Validate SQLite magic bytes
    if not payload.startswith(b"SQLite format 3\x00"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File does not appear to be a valid SQLite database")
    return payload


@router.post("/restore/validate", response_model=RestoreValidationResult)
async def validate_database_restore(
    request: Request,
    _current_user: Annotated[User, Depends(require_super_admin)],
) -> RestoreValidationResult:
    payload = await _read_backup_payload(request)
    try:
        result = validate_restore_bytes(payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup validation failed") from exc
    return RestoreValidationResult(**result)


@router.post("/restore", status_code=status.HTTP_204_NO_CONTENT)
async def restore_database_backup(
    request: Request,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    payload = await _read_backup_payload(request)

    try:
        db.close()
        restore_database_bytes(payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=str(exc)) from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup restore failed") from exc
    write_audit(
        db,
        action="backup.database_restored",
        actor_user_id=current_user.id,
        detail=f"bytes={len(payload)}",
    )
    db.commit()


@router.get("/scheduled-backups", response_model=list[ScheduledBackupRead])
def list_scheduled_backup_files(
    _current_user: Annotated[User, Depends(require_backup_manage)],
) -> list[ScheduledBackupRead]:
    return [ScheduledBackupRead(**entry) for entry in list_scheduled_backups()]


@router.get("/scheduled-backups/{filename}")
def download_scheduled_backup(
    filename: str,
    current_user: Annotated[User, Depends(require_backup_manage)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    path = backup_filename_path(filename)
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup not found")
    write_audit(
        db,
        action="backup.scheduled_downloaded",
        actor_user_id=current_user.id,
        detail=filename,
    )
    db.commit()
    return download_response(path.read_bytes(), media_type="application/octet-stream", filename=filename)


@router.delete("/scheduled-backups/{filename}", status_code=status.HTTP_204_NO_CONTENT)
def delete_scheduled_backup(
    filename: str,
    current_user: Annotated[User, Depends(require_backup_manage)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    path = backup_filename_path(filename)
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup not found")
    path.unlink(missing_ok=True)
    write_audit(
        db,
        action="backup.scheduled_deleted",
        actor_user_id=current_user.id,
        detail=filename,
    )
    db.commit()


def download_response(payload: bytes, *, media_type: str, filename: str) -> Response:
    return Response(
        content=payload,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def parse_optional_datetime(value: str | None):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid datetime filter") from exc

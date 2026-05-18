import sqlite3
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.api.deps import (
    require_firewall_export,
    require_inventory_export,
    require_report_export,
    require_super_admin,
)
from app.core.validation import normalize_ip, validate_port, validate_syslog_field
from app.db.session import get_db
from app.models.user import User
from app.services.audit.service import write_audit
from app.services.exports import (
    backup_database_bytes,
    build_firewall_export,
    build_inventory_export,
    build_network_report_pdf,
    restore_database_bytes,
)

router = APIRouter(prefix="/exports", tags=["exports"])


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
        db,
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
) -> Response:
    payload = build_network_report_pdf(db)
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
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    try:
        filename, payload = backup_database_bytes()
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=str(exc)) from exc
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


@router.post("/restore", status_code=status.HTTP_204_NO_CONTENT)
async def restore_database_backup(
    request: Request,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup payload is empty")
    try:
        db.close()
        restore_database_bytes(payload)
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

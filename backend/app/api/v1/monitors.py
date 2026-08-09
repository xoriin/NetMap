from datetime import datetime, timedelta, timezone
import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.user import User
from app.schemas.monitor import (
    MonitorCheckHistoryRead,
    MonitorCreate,
    MonitorRead,
    MonitorUpdate,
)
from app.services.audit.service import write_audit
from app.core.secrets import encrypt_secret

router = APIRouter(prefix="/monitors", tags=["monitors"])


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _as_utc_required(value: datetime) -> datetime:
    normalized = _as_utc(value)
    assert normalized is not None
    return normalized


def _require_write(current_user: User) -> None:
    if current_user.role not in ("SuperAdmin", "NetworkAdmin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


def _build_reads(db: Session, monitors: list[Monitor]) -> list[MonitorRead]:
    if not monitors:
        return []
    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d = now - timedelta(days=7)
    ids = [m.id for m in monitors]

    def _uptime_map(cutoff: datetime) -> dict[int, float]:
        rows = db.execute(
            select(
                MonitorCheckHistory.monitor_id,
                func.count(MonitorCheckHistory.id),
                func.sum(case((MonitorCheckHistory.status == "online", 1), else_=0)),
            ).where(MonitorCheckHistory.monitor_id.in_(ids), MonitorCheckHistory.checked_at >= cutoff)
            .group_by(MonitorCheckHistory.monitor_id),
        ).all()
        return {row[0]: (row[2] or 0) / row[1] * 100 for row in rows if row[1]}

    uptime_24h_map = _uptime_map(cutoff_24h)
    uptime_7d_map = _uptime_map(cutoff_7d)

    avg_rows = db.execute(
        select(
            MonitorCheckHistory.monitor_id,
            func.avg(MonitorCheckHistory.response_time_ms),
        )
        .where(
            MonitorCheckHistory.monitor_id.in_(ids),
            MonitorCheckHistory.checked_at >= cutoff_24h,
            MonitorCheckHistory.response_time_ms.is_not(None),
        )
        .group_by(MonitorCheckHistory.monitor_id),
    ).all()
    avg_rtt_map = {row[0]: round(row[1], 2) for row in avg_rows if row[1] is not None}

    heartbeat_subq = (
        select(
            MonitorCheckHistory.monitor_id,
            MonitorCheckHistory.status,
            func.row_number().over(
                partition_by=MonitorCheckHistory.monitor_id,
                order_by=MonitorCheckHistory.checked_at.desc(),
            ).label("rn"),
        )
        .where(
            MonitorCheckHistory.monitor_id.in_(ids),
            MonitorCheckHistory.checked_at >= cutoff_24h,
        )
        .subquery()
    )
    heartbeat_rows = db.execute(
        select(heartbeat_subq.c.monitor_id, heartbeat_subq.c.status)
        .where(heartbeat_subq.c.rn <= 30)
        .order_by(heartbeat_subq.c.monitor_id.asc(), heartbeat_subq.c.rn.desc())
    ).all()
    heartbeat_map: dict[int, list[str]] = {monitor_id: [] for monitor_id in ids}
    for monitor_id, check_status in heartbeat_rows:
        heartbeat_map[monitor_id].append(check_status)

    reads = []
    for monitor in monitors:
        read = MonitorRead.model_validate(monitor)
        # SQLite drops timezone information even for DateTime(timezone=True).
        # Restore the UTC offset before Pydantic serializes these values so the
        # browser converts them to local time instead of treating UTC as local.
        read.last_checked_at = _as_utc(read.last_checked_at)
        read.last_cert_expires_at = _as_utc(read.last_cert_expires_at)
        read.created_at = _as_utc_required(read.created_at)
        read.updated_at = _as_utc_required(read.updated_at)
        try:
            read.tags = json.loads(monitor.tags_json or "[]")
        except (TypeError, ValueError):
            read.tags = []
        read.has_request_headers = bool(monitor.request_headers_encrypted)
        read.has_request_body = bool(monitor.request_body_encrypted)
        read.has_auth_password = bool(monitor.auth_password_encrypted)
        read.has_bearer_token = bool(monitor.bearer_token_encrypted)
        read.has_oauth_client_secret = bool(monitor.oauth_client_secret_encrypted)
        read.has_proxy_url = bool(monitor.proxy_url_encrypted)
        read.has_tls_ca = bool(monitor.tls_ca_encrypted)
        read.has_tls_cert = bool(monitor.tls_cert_encrypted)
        read.has_tls_key = bool(monitor.tls_key_encrypted)
        read.uptime_24h = round(uptime_24h_map[monitor.id], 1) if monitor.id in uptime_24h_map else None
        read.uptime_7d = round(uptime_7d_map[monitor.id], 1) if monitor.id in uptime_7d_map else None
        read.avg_response_time_24h = avg_rtt_map.get(monitor.id)
        read.heartbeat = heartbeat_map[monitor.id]
        reads.append(read)
    return reads


@router.get("", response_model=list[MonitorRead])
def list_monitors(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[MonitorRead]:
    monitors = list(db.scalars(select(Monitor).order_by(Monitor.name)))
    return _build_reads(db, monitors)


@router.post("", response_model=MonitorRead, status_code=status.HTTP_201_CREATED)
def create_monitor(
    payload: MonitorCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MonitorRead:
    _require_write(current_user)
    values = payload.model_dump(exclude={
        "tags", "request_headers", "request_body", "auth_password", "bearer_token",
        "oauth_client_secret", "proxy_url", "tls_ca", "tls_cert", "tls_key",
    })
    if "accepted_status_codes" not in payload.model_fields_set and (
        payload.expected_status_min != 200 or payload.expected_status_max != 399
    ):
        values["accepted_status_codes"] = f"{payload.expected_status_min}-{payload.expected_status_max}"
    values["tags_json"] = json.dumps(payload.tags)
    _set_encrypted(values, "request_headers_encrypted", json.dumps(payload.request_headers) if payload.request_headers else None)
    _set_encrypted(values, "request_body_encrypted", payload.request_body)
    _set_encrypted(values, "auth_password_encrypted", payload.auth_password)
    _set_encrypted(values, "bearer_token_encrypted", payload.bearer_token)
    _set_encrypted(values, "oauth_client_secret_encrypted", payload.oauth_client_secret)
    _set_encrypted(values, "proxy_url_encrypted", payload.proxy_url)
    _set_encrypted(values, "tls_ca_encrypted", payload.tls_ca)
    _set_encrypted(values, "tls_cert_encrypted", payload.tls_cert)
    _set_encrypted(values, "tls_key_encrypted", payload.tls_key)
    monitor = Monitor(**values)
    db.add(monitor)
    write_audit(
        db,
        action="monitor.created",
        actor_user_id=current_user.id,
        detail=f"name={payload.name} url={payload.url}",
    )
    db.commit()
    db.refresh(monitor)
    return _build_reads(db, [monitor])[0]


@router.patch("/{monitor_id}", response_model=MonitorRead)
def update_monitor(
    monitor_id: int,
    payload: MonitorUpdate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MonitorRead:
    _require_write(current_user)
    monitor = db.get(Monitor, monitor_id)
    if monitor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Monitor not found")
    updates = payload.model_dump(exclude_unset=True, exclude={
        "tags", "request_headers", "request_body", "auth_password", "bearer_token",
        "oauth_client_secret", "proxy_url", "tls_ca", "tls_cert", "tls_key",
    })
    if "tags" in payload.model_fields_set and payload.tags is not None:
        updates["tags_json"] = json.dumps(payload.tags)
    secret_updates = {
        "request_headers_encrypted": json.dumps(payload.request_headers) if payload.request_headers is not None else None,
        "request_body_encrypted": payload.request_body,
        "auth_password_encrypted": payload.auth_password,
        "bearer_token_encrypted": payload.bearer_token,
        "oauth_client_secret_encrypted": payload.oauth_client_secret,
        "proxy_url_encrypted": payload.proxy_url,
        "tls_ca_encrypted": payload.tls_ca,
        "tls_cert_encrypted": payload.tls_cert,
        "tls_key_encrypted": payload.tls_key,
    }
    source_names = {
        "request_headers_encrypted": "request_headers", "request_body_encrypted": "request_body",
        "auth_password_encrypted": "auth_password", "bearer_token_encrypted": "bearer_token",
        "oauth_client_secret_encrypted": "oauth_client_secret", "proxy_url_encrypted": "proxy_url",
        "tls_ca_encrypted": "tls_ca", "tls_cert_encrypted": "tls_cert", "tls_key_encrypted": "tls_key",
    }
    for target, value in secret_updates.items():
        if source_names[target] in payload.model_fields_set and value is not None:
            _set_encrypted(updates, target, value)
    merged_min = updates.get("expected_status_min", monitor.expected_status_min)
    merged_max = updates.get("expected_status_max", monitor.expected_status_max)
    if merged_min > merged_max:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="expected_status_min must be <= expected_status_max")
    if "accepted_status_codes" not in updates and (
        "expected_status_min" in updates or "expected_status_max" in updates
    ):
        updates["accepted_status_codes"] = f"{merged_min}-{merged_max}"
    for key, value in updates.items():
        setattr(monitor, key, value)
    write_audit(
        db,
        action="monitor.updated",
        actor_user_id=current_user.id,
        target=f"monitor:{monitor.id}",
    )
    db.commit()
    db.refresh(monitor)
    return _build_reads(db, [monitor])[0]


def _set_encrypted(values: dict, key: str, value: str | None) -> None:
    if value:
        values[key] = encrypt_secret(value)


@router.delete("/{monitor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_monitor(
    monitor_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    _require_write(current_user)
    monitor = db.get(Monitor, monitor_id)
    if monitor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Monitor not found")
    write_audit(
        db,
        action="monitor.deleted",
        actor_user_id=current_user.id,
        target=f"monitor:{monitor.id}",
        detail=monitor.name,
    )
    db.delete(monitor)
    db.commit()


@router.get("/{monitor_id}/history", response_model=list[MonitorCheckHistoryRead])
def get_monitor_history(
    monitor_id: int,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    hours: Annotated[int, Query(ge=1, le=720)] = 24,
) -> list[MonitorCheckHistoryRead]:
    if db.get(Monitor, monitor_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Monitor not found")
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = db.scalars(
        select(MonitorCheckHistory)
        .where(MonitorCheckHistory.monitor_id == monitor_id, MonitorCheckHistory.checked_at >= cutoff)
        .order_by(MonitorCheckHistory.checked_at.asc())
        .limit(2000),
    ).all()
    reads = [MonitorCheckHistoryRead.model_validate(row) for row in rows]
    for read in reads:
        read.checked_at = _as_utc_required(read.checked_at)
        read.cert_expires_at = _as_utc(read.cert_expires_at)
    return reads

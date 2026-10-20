from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.retention import DEFAULT_BATCH_SIZE, MAX_ROWS_PER_RUN
from app.models.alert_rule import AlertRule
from app.models.device import Device
from app.models.monitor import Monitor
from app.models.port_target import DevicePortTarget
from app.models.status_page import (
    StatusBreachStreak,
    StatusIdempotencyKey,
    StatusIncident,
    StatusIncidentAlias,
    StatusIncidentPage,
    StatusIncidentSource,
    StatusIncidentUpdate,
    StatusMaintenance,
    StatusMaintenanceExit,
    StatusMaintenanceItem,
    StatusMaintenancePage,
    StatusNotice,
)
from app.services.status_pages.sources import SourceRef

logger = logging.getLogger(__name__)

RETENTION = timedelta(days=365)
IDEMPOTENCY_RETENTION = timedelta(hours=24)
EXIT_RETENTION = timedelta(days=30)

_INCIDENT_CHILDREN = (StatusIncidentUpdate, StatusIncidentSource, StatusIncidentPage, StatusIncidentAlias)
_MAINTENANCE_CHILDREN = (StatusMaintenanceItem, StatusMaintenancePage)


def _batches(db_factory: Callable[[], Session], select_ids, delete_batch, batch_size: int) -> int:
    total = 0
    while total < MAX_ROWS_PER_RUN:
        with db_factory() as db:
            ids = list(db.scalars(select_ids.limit(batch_size)))
            if not ids:
                return total
            delete_batch(db, ids)
            db.commit()
        total += len(ids)
        if len(ids) < batch_size:
            break
    return total


def _prune_incidents(db: Session, ids: list[int]) -> None:
    for model in _INCIDENT_CHILDREN:
        db.execute(delete(model).where(model.incident_id.in_(ids)))
    db.execute(delete(StatusIncident).where(StatusIncident.id.in_(ids)))


def _prune_maintenance(db: Session, ids: list[int]) -> None:
    for model in _MAINTENANCE_CHILDREN:
        db.execute(delete(model).where(model.maintenance_id.in_(ids)))
    db.execute(delete(StatusMaintenance).where(StatusMaintenance.id.in_(ids)))


def _simple(model):
    return lambda db, ids: db.execute(delete(model).where(model.id.in_(ids)))


def _orphan_exits(db: Session, rows) -> list[int]:
    refs: dict[int, SourceRef | None] = {}
    for row in rows:
        try:
            refs[row.id] = SourceRef.from_key(row.source_key)
        except ValueError:
            refs[row.id] = None
    valid = [r for r in refs.values() if r is not None]
    device_ids = {r.device_id for r in valid if r.device_id is not None}
    monitor_ids = {r.monitor_id for r in valid if r.monitor_id is not None}
    target_ids = {r.port_target_id for r in valid if r.port_target_id is not None}
    devices = set(db.scalars(select(Device.id).where(Device.id.in_(device_ids)))) if device_ids else set()
    monitors = set(db.scalars(select(Monitor.id).where(Monitor.id.in_(monitor_ids)))) if monitor_ids else set()
    targets = {
        row.id: row.device_id for row in db.execute(
            select(DevicePortTarget.id, DevicePortTarget.device_id).where(DevicePortTarget.id.in_(target_ids))
        )
    } if target_ids else {}

    def exists(ref: SourceRef | None) -> bool:
        if ref is None:
            return False
        if ref.kind == "monitor":
            return ref.monitor_id in monitors
        if ref.device_id not in devices:
            return False
        if ref.kind == "device":
            return True
        return ref.port_target_id in targets and targets[ref.port_target_id] in (None, ref.device_id)

    return [exit_id for exit_id, ref in refs.items() if not exists(ref)]


def _prune_exits(db_factory: Callable[[], Session], now: datetime, batch_size: int) -> int:
    total, scanned, after = 0, 0, 0
    while scanned < MAX_ROWS_PER_RUN:
        with db_factory() as db:
            rows = list(db.execute(
                select(StatusMaintenanceExit.id, StatusMaintenanceExit.source_key)
                .where(StatusMaintenanceExit.id > after).order_by(StatusMaintenanceExit.id)
                .limit(min(batch_size, MAX_ROWS_PER_RUN - scanned))
            ))
            if not rows:
                break
            orphans = _orphan_exits(db, rows)
            if orphans:
                db.execute(delete(StatusMaintenanceExit).where(StatusMaintenanceExit.id.in_(orphans)))
                db.commit()
        total += len(orphans)
        scanned += len(rows)
        after = rows[-1].id
    return total + _batches(
        db_factory,
        select(StatusMaintenanceExit.id).where(StatusMaintenanceExit.created_at < now - EXIT_RETENTION),
        _simple(StatusMaintenanceExit), batch_size,
    )


def prune(db_factory: Callable[[], Session], now: datetime, batch_size: int = DEFAULT_BATCH_SIZE) -> dict[str, int]:
    cutoff = now - RETENTION
    counts = {
        "incidents": _batches(
            db_factory,
            select(StatusIncident.id).where(
                StatusIncident.status == "resolved", StatusIncident.resolved_at.is_not(None),
                StatusIncident.resolved_at < cutoff,
            ),
            _prune_incidents, batch_size,
        ),
        "notices": _batches(
            db_factory,
            select(StatusNotice.id).where(StatusNotice.expires_at.is_not(None), StatusNotice.expires_at < cutoff),
            _simple(StatusNotice), batch_size,
        ),
        "maintenance": _batches(
            db_factory, select(StatusMaintenance.id).where(StatusMaintenance.ends_at < cutoff),
            _prune_maintenance, batch_size,
        ),
        "idempotency_keys": _batches(
            db_factory,
            select(StatusIdempotencyKey.id).where(StatusIdempotencyKey.created_at < now - IDEMPOTENCY_RETENTION),
            _simple(StatusIdempotencyKey), batch_size,
        ),
        "breach_streaks": _batches(
            db_factory,
            select(StatusBreachStreak.id).where(StatusBreachStreak.rule_id.not_in(select(AlertRule.id))),
            _simple(StatusBreachStreak), batch_size,
        ),
        "maintenance_exits": _prune_exits(db_factory, now, batch_size),
    }
    if any(counts.values()):
        logger.info("Status page retention pruned %s", counts)
    return counts

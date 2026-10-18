from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.retention import DEFAULT_BATCH_SIZE, MAX_ROWS_PER_RUN
from app.models.alert_rule import AlertRule
from app.models.status_page import (
    StatusBreachStreak,
    StatusIdempotencyKey,
    StatusIncident,
    StatusIncidentAlias,
    StatusIncidentPage,
    StatusIncidentSource,
    StatusIncidentUpdate,
    StatusMaintenance,
    StatusMaintenanceItem,
    StatusMaintenancePage,
    StatusNotice,
)

logger = logging.getLogger(__name__)

RETENTION = timedelta(days=365)
IDEMPOTENCY_RETENTION = timedelta(hours=24)

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
    }
    if any(counts.values()):
        logger.info("Status page retention pruned %s", counts)
    return counts

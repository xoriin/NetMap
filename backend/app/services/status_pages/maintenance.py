from __future__ import annotations

import threading
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.models.status_page import StatusMaintenance, StatusMaintenanceItem, StatusMaintenancePage, StatusPage, StatusPageItem
from app.models.user import UserRole
from app.services.rbac.permissions import has_permission
from app.services.status_pages.incidents import (
    Actor,
    IncidentError,
    IncidentNotFound,
    PersonActor,
    TokenActor,
    audit,
    clean_text,
    commit_and_notify,
    now_or_utc,
)
from app.services.status_pages.sources import SourceRef, _utc

UPCOMING_LEAD = timedelta(days=7)
TITLE_MAX = 200
DESCRIPTION_MAX = 5000
SUPPRESS_DETAIL = "Suppressing monitoring alerts also requires Manage alert rules"
TOKEN_SUPPRESS_DETAIL = "Integration tokens cannot suppress monitoring alerts"

Span = tuple[datetime, datetime]
_KIND_PREFIX = {"device": "device:", "service_check": "service:", "monitor": "monitor:"}

_pending_lock = threading.Lock()
_pending_exits: set[str] = set()


class MaintenanceForbidden(PermissionError):
    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass
class LoadedWindow:
    window: StatusMaintenance
    keys: list[str] = field(default_factory=list)
    page_ids: set[int] = field(default_factory=set)

    @property
    def start(self) -> datetime:
        return _utc(self.window.starts_at)

    @property
    def end(self) -> datetime:
        return _utc(self.window.ends_at)

    def active(self, now: datetime) -> bool:
        return self.start <= now < self.end


def reset_pending_exits() -> None:
    with _pending_lock:
        _pending_exits.clear()


def _queue_exits(keys: Iterable[str]) -> None:
    with _pending_lock:
        _pending_exits.update(keys)


def _take_pending(kinds: Iterable[str] | None) -> set[str]:
    prefixes = tuple(_KIND_PREFIX[k] for k in kinds) if kinds is not None else tuple(_KIND_PREFIX.values())
    with _pending_lock:
        taken = {key for key in _pending_exits if key.startswith(prefixes)}
        _pending_exits.difference_update(taken)
    return taken


def may_suppress(actor: Actor) -> bool:
    if not isinstance(actor, PersonActor):
        return False
    role = actor.user.role
    return role == UserRole.SUPER_ADMIN or (
        has_permission(role, "status_page_manage") and has_permission(role, "alert_write")
    )


def _require_suppress(actor: Actor) -> None:
    if not may_suppress(actor):
        raise MaintenanceForbidden(TOKEN_SUPPRESS_DETAIL if isinstance(actor, TokenActor) else SUPPRESS_DETAIL)


def _instant(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise IncidentError(f"{name} must include a UTC offset")
    return _utc(value)


def _item_row(window_id: int, ref: SourceRef) -> StatusMaintenanceItem:
    return StatusMaintenanceItem(
        maintenance_id=window_id, kind=ref.kind, device_id=ref.device_id, monitor_id=ref.monitor_id,
        port_target_id=ref.port_target_id,
    )


def _key(row) -> str:
    return SourceRef(row.kind, row.device_id, row.monitor_id, row.port_target_id).key


def pages_showing(db: Session, keys: Iterable[str]) -> dict[str, set[int]]:
    keys = set(keys)
    refs = [SourceRef.from_key(k) for k in keys]
    device_ids = {r.device_id for r in refs if r.device_id is not None}
    monitor_ids = {r.monitor_id for r in refs if r.monitor_id is not None}
    found: dict[str, set[int]] = defaultdict(set)
    if not refs:
        return found
    for item in db.scalars(select(StatusPageItem).where(or_(
        StatusPageItem.device_id.in_(device_ids), StatusPageItem.monitor_id.in_(monitor_ids),
    ))):
        key = SourceRef.from_item(item).key
        if key in keys:
            found[key].add(item.page_id)
    return found


def _audience(db: Session, keys: list[str], page_ids: list[int] | None, suppress: bool) -> list[int]:
    showing = pages_showing(db, keys)
    if page_ids is None:
        pages = sorted(set().union(*showing.values())) if showing else []
        if not pages and not suppress:
            raise IncidentError("None of these items is shown on a status page")
        return pages
    pages = list(dict.fromkeys(page_ids))
    if not pages and not suppress:
        raise IncidentError("Choose at least one status page")
    found = set(db.scalars(select(StatusPage.id).where(StatusPage.id.in_(pages)))) if pages else set()
    missing = [p for p in pages if p not in found]
    if missing:
        raise IncidentError(f"Status page {missing[0]} does not exist")
    if not suppress:
        for key in keys:
            if not showing.get(key, set()) & set(pages):
                raise IncidentError(f"{key} is not shown on any selected status page")
    return sorted(pages)


def _validated(title, description, starts_at, ends_at) -> tuple[str, str | None, datetime, datetime]:
    title = clean_text(title, "Title", TITLE_MAX, required=True)
    description = clean_text(description, "Description", DESCRIPTION_MAX)
    starts_at, ends_at = _instant(starts_at, "Start"), _instant(ends_at, "End")
    if ends_at <= starts_at:
        raise IncidentError("End must be after start")
    return title, description, starts_at, ends_at


def _keys(items: Iterable[SourceRef]) -> list[str]:
    keys = list(dict.fromkeys(ref.key for ref in items))
    if not keys:
        raise IncidentError("Choose at least one affected item")
    return keys


def load_windows(db: Session, ids: Iterable[int] | None = None) -> list[LoadedWindow]:
    query = select(StatusMaintenance).order_by(StatusMaintenance.starts_at, StatusMaintenance.id)
    if ids is not None:
        ids = list(set(ids))
        if not ids:
            return []
        query = query.where(StatusMaintenance.id.in_(ids))
    found = {w.id: LoadedWindow(w) for w in db.scalars(query)}
    if not found:
        return []
    for row in db.scalars(select(StatusMaintenanceItem).where(StatusMaintenanceItem.maintenance_id.in_(list(found)))
                          .order_by(StatusMaintenanceItem.id)):
        found[row.maintenance_id].keys.append(_key(row))
    for row in db.scalars(select(StatusMaintenancePage).where(StatusMaintenancePage.maintenance_id.in_(list(found)))):
        found[row.maintenance_id].page_ids.add(row.page_id)
    return list(found.values())


def get_window(db: Session, window_id: int) -> LoadedWindow:
    loaded = load_windows(db, [window_id])
    if not loaded:
        raise IncidentNotFound("Maintenance window not found")
    return loaded[0]


def _touched_pages(db: Session, loaded: LoadedWindow) -> set[int]:
    pages = set(loaded.page_ids)
    if loaded.window.suppress_alerts:
        for found in pages_showing(db, loaded.keys).values():
            pages |= found
    return pages


def _store_links(db: Session, window_id: int, keys: list[str], pages: list[int]) -> None:
    db.execute(delete(StatusMaintenanceItem).where(StatusMaintenanceItem.maintenance_id == window_id))
    db.execute(delete(StatusMaintenancePage).where(StatusMaintenancePage.maintenance_id == window_id))
    for key in keys:
        db.add(_item_row(window_id, SourceRef.from_key(key)))
    for page_id in pages:
        db.add(StatusMaintenancePage(maintenance_id=window_id, page_id=page_id))
    db.flush()


def create_window(
    db: Session, actor: Actor, title: str, description: str | None, starts_at: datetime, ends_at: datetime,
    items: list[SourceRef], page_ids: list[int] | None, suppress_alerts: bool, *, now: datetime | None = None,
) -> StatusMaintenance:
    now = now_or_utc(now)
    if suppress_alerts:
        _require_suppress(actor)
    title, description, starts_at, ends_at = _validated(title, description, starts_at, ends_at)
    if ends_at <= now:
        raise IncidentError("End must be in the future")
    keys = _keys(items)
    pages = _audience(db, keys, page_ids, suppress_alerts)
    window = StatusMaintenance(
        title=title, description=description, starts_at=starts_at, ends_at=ends_at, suppress_alerts=bool(suppress_alerts),
        exit_processed=False, created_at=now,
        created_by_user_id=actor.user.id if isinstance(actor, PersonActor) else None,
        created_by_token_id=actor.token.id if isinstance(actor, TokenActor) else None,
    )
    db.add(window)
    db.flush()
    _store_links(db, window.id, keys, pages)
    audit(db, actor, "status_maintenance.created", f"status_maintenance:{window.id}",
          f"pages={','.join(map(str, pages)) or '-'} items={len(keys)} suppress={window.suppress_alerts}")
    commit_and_notify(db, _touched_pages(db, get_window(db, window.id)))
    return window


def update_window(db: Session, actor: Actor, window_id: int, changes: dict, *, now: datetime | None = None) -> StatusMaintenance:
    now = now_or_utc(now)
    loaded = get_window(db, window_id)
    window = loaded.window
    if window.suppress_alerts or changes.get("suppress_alerts"):
        _require_suppress(actor)
    before_pages = _touched_pages(db, loaded)
    before_suppressed = globally_suppressed(db, now)
    was_active = loaded.active(now)

    title, description, starts_at, ends_at = _validated(
        changes.get("title", window.title),
        changes["description"] if "description" in changes else window.description,
        changes["starts_at"] if "starts_at" in changes else _utc(window.starts_at),
        changes["ends_at"] if "ends_at" in changes else _utc(window.ends_at),
    )
    if "ends_at" in changes and ends_at <= now:
        raise IncidentError("End must be in the future")
    suppress = bool(changes.get("suppress_alerts", window.suppress_alerts))
    keys = _keys(changes["items"]) if "items" in changes else loaded.keys
    if {"page_ids", "items", "suppress_alerts"} & set(changes):
        pages = _audience(db, keys, changes["page_ids"] if "page_ids" in changes else sorted(loaded.page_ids), suppress)
    else:
        pages = sorted(loaded.page_ids)

    window.title, window.description, window.starts_at, window.ends_at = title, description, starts_at, ends_at
    window.suppress_alerts = suppress
    _store_links(db, window.id, keys, pages)
    if ends_at > now:
        window.exit_processed = False
    elif was_active:
        window.exit_processed = True
    db.flush()
    _queue_exits(before_suppressed - globally_suppressed(db, now))
    fields = ",".join(sorted(changes)) or "none"
    audit(db, actor, "status_maintenance.updated", f"status_maintenance:{window.id}", f"fields={fields} suppress={suppress}")
    commit_and_notify(db, before_pages | _touched_pages(db, get_window(db, window.id)))
    return window


def delete_window(db: Session, actor: Actor, window_id: int, *, now: datetime | None = None) -> None:
    now = now_or_utc(now)
    loaded = get_window(db, window_id)
    if loaded.window.suppress_alerts:
        _require_suppress(actor)
    pages = _touched_pages(db, loaded)
    before = globally_suppressed(db, now)
    _store_links(db, window_id, [], [])
    db.delete(loaded.window)
    db.flush()
    _queue_exits(before - globally_suppressed(db, now))
    audit(db, actor, "status_maintenance.deleted", f"status_maintenance:{window_id}", f"suppress={loaded.window.suppress_alerts}")
    commit_and_notify(db, pages)


def _active_windows(db: Session, now: datetime, *, suppress_only: bool = False) -> list[LoadedWindow]:
    query = select(StatusMaintenance.id).where(StatusMaintenance.starts_at <= now, StatusMaintenance.ends_at > now)
    if suppress_only:
        query = query.where(StatusMaintenance.suppress_alerts == True)  # noqa: E712
    return [w for w in load_windows(db, db.scalars(query)) if w.active(now)]


def globally_suppressed(db: Session, now: datetime) -> set[str]:
    now = _utc(now)
    return {key for w in _active_windows(db, now, suppress_only=True) for key in w.keys}


def take_exit_reevaluations(db: Session, now: datetime, kinds: Iterable[str] | None = None) -> set[str]:
    """Queue keys whose last suppressing window has ended and mark those windows processed; the caller commits."""
    now = _utc(now)
    ended = list(db.scalars(select(StatusMaintenance.id).where(
        StatusMaintenance.suppress_alerts == True, StatusMaintenance.exit_processed == False,  # noqa: E712
        StatusMaintenance.ends_at <= now,
    )))
    windows = [w for w in load_windows(db, ended) if w.end <= now]
    if windows:
        still = globally_suppressed(db, now)
        for loaded in windows:
            loaded.window.exit_processed = True
        db.flush()
        _queue_exits({key for w in windows for key in w.keys} - still)
    return _take_pending(kinds)


def page_windows(db: Session, page_id: int, keys: Iterable[str]) -> list[LoadedWindow]:
    """Windows announced on this page plus globally suppressing windows covering one of its items."""
    keys = set(keys)
    announced = set(db.scalars(select(StatusMaintenancePage.maintenance_id).where(StatusMaintenancePage.page_id == page_id)))
    refs = [SourceRef.from_key(k) for k in keys]
    device_ids = {r.device_id for r in refs if r.device_id is not None}
    monitor_ids = {r.monitor_id for r in refs if r.monitor_id is not None}
    covering = set()
    if refs:
        for row in db.execute(
            select(StatusMaintenanceItem, StatusMaintenance.suppress_alerts)
            .join(StatusMaintenance, StatusMaintenance.id == StatusMaintenanceItem.maintenance_id)
            .where(StatusMaintenance.suppress_alerts == True, or_(  # noqa: E712
                StatusMaintenanceItem.device_id.in_(device_ids), StatusMaintenanceItem.monitor_id.in_(monitor_ids),
            ))
        ):
            if _key(row[0]) in keys:
                covering.add(row[0].maintenance_id)
    return load_windows(db, announced | covering)


def covers(loaded: LoadedWindow, page_id: int, key: str) -> bool:
    return key in loaded.keys and (page_id in loaded.page_ids or loaded.window.suppress_alerts)


def spans_for_page(windows: list[LoadedWindow], page_id: int, keys: Iterable[str]) -> dict[str, list[Span]]:
    found: dict[str, list[Span]] = {}
    for key in keys:
        spans = [(w.start, w.end) for w in windows if covers(w, page_id, key)]
        if spans:
            found[key] = spans
    return found


def active_page_maintenance(db: Session, page_id: int, now: datetime) -> dict[str, list[Span]]:
    now = _utc(now)
    keys = {SourceRef.from_item(i).key for i in db.scalars(select(StatusPageItem).where(StatusPageItem.page_id == page_id))}
    windows = [w for w in page_windows(db, page_id, keys) if w.active(now)]
    return spans_for_page(windows, page_id, keys)


def pages_in_maintenance(db: Session, refs: Iterable[SourceRef], now: datetime) -> set[tuple[str, int]]:
    now = _utc(now)
    keys = {ref.key for ref in refs}
    found: set[tuple[str, int]] = set()
    showing = None
    for loaded in _active_windows(db, now):
        for key in keys.intersection(loaded.keys):
            if loaded.window.suppress_alerts:
                showing = showing if showing is not None else pages_showing(db, keys)
                found |= {(key, page_id) for page_id in showing.get(key, set())}
            found |= {(key, page_id) for page_id in loaded.page_ids}
    return found

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import case, delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.alert_rule import AlertRule
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.monitor_history import DeviceMonitorHistory
from app.models.status_page import (
    StatusBreachStreak,
    StatusIncident,
    StatusIncidentAlias,
    StatusIncidentPage,
    StatusIncidentSource,
    StatusIncidentUpdate,
    StatusPageItem,
)
from app.services.alerting.service import DEFAULT_LOSS_WINDOW_MINUTES, FLAP_MIN_TRANSITIONS, FLAP_WINDOW_SECONDS
from app.services.monitoring.health import observed_health
from app.services.status_pages import copy, incidents, maintenance, sources
from app.services.status_pages.sources import (
    Health,
    SourceRef,
    _utc,
    freshness_deadline,
    load_current_states,
    pages_showing,
)

CONDITION_FAMILY: dict[str, str] = {
    "device_offline": "availability",
    "device_unexpected_state": "availability",
    "service_down": "availability",
    "monitor_down": "availability",
    "rtt_above": "latency",
    "service_slow": "latency",
    "monitor_slow": "latency",
    "ping_loss_above": "loss",
    "device_flapping": "flapping",
    "monitor_certificate_expiry": "certificate",
    "device_warning": "warning",
}

DEVICE_EVENTS = {"device_offline", "device_unexpected_state", "device_warning", "device_flapping", "rtt_above", "ping_loss_above"}
SERVICE_EVENTS = {"service_down", "service_slow"}
MONITOR_EVENTS = {"monitor_down", "monitor_slow", "monitor_certificate_expiry"}

GROUP_WINDOW = timedelta(minutes=5)
OWNED_SOURCES = ("person", "token")
OBSERVED_EVENTS = ("source_failing", "source_recovered", "rebreached")
SCAN_ROWS = 50
NETMAP = incidents.NetmapActor()


@dataclass(frozen=True)
class Observation:
    at: datetime
    status: str | None = None
    health: Health = "unknown"
    response_ms: float | None = None
    cert_expires_at: datetime | None = None
    cert_days: int | None = None
    loss: dict[int, tuple[int, int]] = field(default_factory=dict)
    flaps: int | None = None


def applies(rule: AlertRule, ref: SourceRef) -> bool:
    if rule.event_type in DEVICE_EVENTS:
        return ref.kind == "device" and rule.device_id in (None, ref.device_id)
    if rule.event_type in SERVICE_EVENTS:
        return (
            ref.kind == "service_check"
            and rule.device_id in (None, ref.device_id)
            and rule.port_target_id in (None, ref.port_target_id)
        )
    if rule.event_type in MONITOR_EVENTS:
        return ref.kind == "monitor" and rule.monitor_id in (None, ref.monitor_id)
    return False


def _loss_window(rule: AlertRule) -> int:
    return rule.loss_window_minutes or DEFAULT_LOSS_WINDOW_MINUTES


def _same_kind(rule: AlertRule, ref: SourceRef) -> bool:
    kinds = {"device": DEVICE_EVENTS, "service_check": SERVICE_EVENTS, "monitor": MONITOR_EVENTS}
    return rule.event_type in kinds.get(ref.kind, set())


def predicate(rule: AlertRule, ref: SourceRef, observation: Observation) -> bool | None:
    if not applies(rule, ref):
        return None
    return _condition(rule, ref, observation)


def _condition(rule: AlertRule, ref: SourceRef, observation: Observation) -> bool | None:
    event, obs = rule.event_type, observation
    known_status = obs.status not in (None, "unknown")
    if event in ("device_offline", "device_unexpected_state", "service_down"):
        return None if obs.health == "unknown" else obs.health == "unhealthy"
    if event == "monitor_down":
        return obs.status != "online" if known_status else None
    if event == "device_warning":
        return obs.status == "warning" if known_status else None
    if event == "device_flapping":
        return None if obs.flaps is None else obs.flaps >= FLAP_MIN_TRANSITIONS
    if event == "rtt_above":
        return sources.rtt_above(rule, obs.response_ms) if known_status else None
    if event == "ping_loss_above":
        counts = obs.loss.get(_loss_window(rule))
        return None if counts is None else sources.ping_loss_above(rule, *counts)
    if event == "service_slow":
        return None if obs.health == "unknown" else sources.service_slow(rule, obs.response_ms)
    if event == "monitor_slow":
        return sources.monitor_slow(rule, obs.response_ms if obs.status == "online" else None) if known_status else None
    if event == "monitor_certificate_expiry":
        if obs.cert_days is None or obs.cert_expires_at is None:
            return None
        return _utc(obs.cert_expires_at) <= obs.at + timedelta(days=obs.cert_days)
    return None


def threshold(rule: AlertRule, monitor: Monitor | None = None) -> int:
    base = max(1, rule.incident_min_failures or 1)
    if rule.event_type == "monitor_down" and monitor is not None:
        return max(base, monitor.max_retries + 1)
    return base


VERSION_FIELDS = (
    "event_type", "enabled", "open_incident", "incident_min_failures", "device_id", "port_target_id", "monitor_id",
    "threshold_ms", "loss_pct_threshold", "loss_window_minutes",
)


def rule_version(rule: AlertRule) -> str:
    fields = [getattr(rule, name) for name in VERSION_FIELDS]
    return hashlib.sha256(json.dumps(fields, default=str).encode()).hexdigest()[:40]


def _history(db: Session, model, column, value, since: datetime | None, limit: int) -> list:
    query = select(model).where(column == value).order_by(model.checked_at.desc(), model.id.desc()).limit(limit)
    if since is not None:
        query = query.where(model.checked_at > since)
    return list(reversed(db.scalars(query).all()))


def _loss_counts(db: Session, device_id: int, at: datetime, minutes: int) -> tuple[int, int]:
    total, offline = db.execute(
        select(
            func.count(DeviceMonitorHistory.id),
            func.sum(case((DeviceMonitorHistory.status == "offline", 1), else_=0)),
        ).where(
            DeviceMonitorHistory.device_id == device_id,
            DeviceMonitorHistory.checked_at >= at - timedelta(minutes=minutes),
            DeviceMonitorHistory.checked_at <= at,
        )
    ).one()
    return total or 0, offline or 0


def _flap_count(db: Session, device_id: int, at: datetime) -> int:
    start = at - timedelta(seconds=FLAP_WINDOW_SECONDS)
    statuses = list(db.scalars(
        select(DeviceMonitorHistory.status).where(
            DeviceMonitorHistory.device_id == device_id,
            DeviceMonitorHistory.checked_at >= start,
            DeviceMonitorHistory.checked_at <= at,
        ).order_by(DeviceMonitorHistory.checked_at, DeviceMonitorHistory.id)
    ))
    before = db.scalar(
        select(DeviceMonitorHistory.status).where(
            DeviceMonitorHistory.device_id == device_id, DeviceMonitorHistory.checked_at < start,
        ).order_by(DeviceMonitorHistory.checked_at.desc(), DeviceMonitorHistory.id.desc()).limit(1)
    )
    if before is not None:
        statuses.insert(0, before)
    return sum(1 for old, new in zip(statuses, statuses[1:]) if old != new)


def _observations(
    db: Session, ref: SourceRef, rules: list[AlertRule], monitor: Monitor | None, since: datetime | None, limit: int,
) -> list[Observation]:
    if ref.kind == "monitor":
        cert_days = monitor.certificate_expiry_days if monitor is not None and monitor.certificate_expiry_alert else None
        return [
            Observation(
                at=_utc(row.checked_at), status=row.status,
                health={"online": "healthy", "offline": "unhealthy"}.get(row.status, "unknown"),
                response_ms=row.response_time_ms, cert_expires_at=row.cert_expires_at, cert_days=cert_days,
            )
            for row in _history(db, MonitorCheckHistory, MonitorCheckHistory.monitor_id, ref.monitor_id, since, limit)
        ]
    rows = _history(db, DeviceMonitorHistory, DeviceMonitorHistory.device_id, ref.device_id, since, limit)
    if ref.kind == "service_check":
        found = []
        for row in rows:
            entry = sources._port_entry(row, ref.port_target_id)
            if entry is None:
                continue
            response = entry.get("response_time_ms")
            found.append(Observation(
                at=_utc(row.checked_at), status="open" if entry.get("open") else "closed",
                health="healthy" if entry.get("open") else "unhealthy",
                response_ms=response if isinstance(response, (int, float)) else None,
            ))
        return found
    windows = {_loss_window(r) for r in rules if r.event_type == "ping_loss_above"}
    flapping = any(r.event_type == "device_flapping" for r in rules)
    found = []
    for row in rows:
        at = _utc(row.checked_at)
        found.append(Observation(
            at=at, status=row.status, health=observed_health(row.status, row.expected_status), response_ms=row.rtt_ms,
            loss={w: _loss_counts(db, ref.device_id, at, w) for w in windows},
            flaps=_flap_count(db, ref.device_id, at) if flapping else None,
        ))
    return found


def latest_observation(db: Session, ref: SourceRef, rules: list[AlertRule], monitor: Monitor | None = None) -> Observation | None:
    found = _observations(db, ref, rules, monitor, None, 1)
    return found[-1] if found else None


def _audience(db: Session, incident_ids: Iterable[int]) -> dict[int, set[int]]:
    found: dict[int, set[int]] = defaultdict(set)
    ids = list(set(incident_ids))
    if ids:
        for row in db.execute(
            select(StatusIncidentPage.incident_id, StatusIncidentPage.page_id).where(StatusIncidentPage.incident_id.in_(ids))
        ):
            found[row.incident_id].add(row.page_id)
    return found


def retire_sources(db: Session, pairs: set[tuple[str, int]], now: datetime) -> set[int]:
    if not pairs:
        return set()
    keys = {key for key, _ in pairs}
    removed: dict[tuple[int, int], list[str]] = defaultdict(list)
    for row in db.scalars(
        select(StatusIncidentSource).where(StatusIncidentSource.active == True, StatusIncidentSource.source_key.in_(keys))  # noqa: E712
        .order_by(StatusIncidentSource.id)
    ):
        if (row.source_key, row.page_id) in pairs:
            row.active = False
            removed[(row.incident_id, row.page_id)].append(row.source_key)
    for (incident_id, page_id), found in sorted(removed.items()):
        db.add(incidents._update_row(
            incident_id, NETMAP, now, page_id=page_id, event_code="source_removed",
            event_data={"sources": found, "count": len(found)},
        ))
    stale = [
        row.id for row in db.scalars(select(StatusBreachStreak).where(StatusBreachStreak.source_key.in_(keys)))
        if (row.source_key, row.page_id) in pairs
    ]
    if stale:
        db.execute(delete(StatusBreachStreak).where(StatusBreachStreak.id.in_(stale)))
    affected: set[int] = set()
    for pages in _audience(db, {incident_id for incident_id, _ in removed}).values():
        affected |= pages
    return affected


def remove_items_where(db: Session, *conditions, now: datetime | None = None) -> set[int]:
    """Delete matching status page items and retire their automatic incident sources; the caller commits."""
    now = incidents.now_or_utc(now)
    items = list(db.scalars(select(StatusPageItem).where(*conditions)))
    pairs = {(SourceRef.from_item(item).key, item.page_id) for item in items}
    for item in items:
        db.delete(item)
    db.flush()
    return retire_sources(db, pairs, now) | {page_id for _, page_id in pairs}


def release_resolved(db: Session, incident: StatusIncident) -> None:
    rows = list(db.scalars(select(StatusIncidentSource).where(
        StatusIncidentSource.incident_id == incident.id, StatusIncidentSource.active == True,  # noqa: E712
    )))
    if not rows:
        return
    family_rules: dict[str, list[int]] = defaultdict(list)
    for rule_id, event_type in db.execute(select(AlertRule.id, AlertRule.event_type)):
        if event_type in CONDITION_FAMILY:
            family_rules[CONDITION_FAMILY[event_type]].append(rule_id)
    for row in rows:
        row.active = False
        rule_ids = family_rules.get(row.condition_family)
        if row.cleared or not rule_ids:
            continue
        db.execute(
            update(StatusBreachStreak)
            .where(
                StatusBreachStreak.source_key == row.source_key, StatusBreachStreak.page_id == row.page_id,
                StatusBreachStreak.rule_id.in_(rule_ids),
            )
            .values(resolution_latched=True, streak=0)
            .execution_options(synchronize_session="fetch")
        )


class _Evaluation:
    def __init__(self, db: Session, now: datetime) -> None:
        self.db = db
        self.now = now
        self.changed: set[int] = set()
        self.cleared: set[int] = set()
        self.rebreached: dict[int, set[str]] = defaultdict(set)
        self.failing: set[int] = set()
        self.candidates: list[tuple[AlertRule, str, int, int]] = []
        self.aliases_cache: dict[int, dict[str, str]] = {}

    def aliases(self, page_ids: Iterable[int]) -> dict[int, dict[str, str]]:
        missing = [p for p in page_ids if p not in self.aliases_cache]
        if missing:
            found = incidents._page_aliases(self.db, missing)
            for page_id in missing:
                self.aliases_cache[page_id] = found.get(page_id, {})
        return self.aliases_cache

    def run(self, refs: list[SourceRef]) -> set[int]:
        db, now = self.db, self.now
        rules = list(db.scalars(select(AlertRule).order_by(AlertRule.id)))
        active = [r for r in rules if r.enabled and r.open_incident and r.event_type in CONDITION_FAMILY]
        idle = [r.id for r in rules if r not in active]
        if idle:
            db.execute(
                update(StatusBreachStreak).where(StatusBreachStreak.rule_id.in_(idle), StatusBreachStreak.streak != 0)
                .values(streak=0).execution_options(synchronize_session="fetch")
            )

        keys = [r.key for r in refs]
        showing = pages_showing(db, [r.key for r in refs])
        orphaned = {
            (row.source_key, row.page_id)
            for row in db.scalars(select(StatusIncidentSource).where(
                StatusIncidentSource.active == True, StatusIncidentSource.source_key.in_(keys),  # noqa: E712
            ))
            if row.page_id not in showing.get(row.source_key, set())
        } | {
            (row.source_key, row.page_id)
            for row in db.scalars(select(StatusBreachStreak).where(StatusBreachStreak.source_key.in_(keys)))
            if row.page_id not in showing.get(row.source_key, set())
        }
        affected = retire_sources(db, orphaned, now)

        streaks = {
            (row.rule_id, row.source_key, row.page_id): row
            for row in db.scalars(select(StatusBreachStreak).where(StatusBreachStreak.source_key.in_(keys)))
        }
        self.associations = {
            (row.source_key, row.condition_family, row.page_id): row
            for row in db.scalars(select(StatusIncidentSource).where(
                StatusIncidentSource.active == True, StatusIncidentSource.source_key.in_(keys),  # noqa: E712
            ))
        }
        in_maintenance = maintenance.pages_in_maintenance(db, refs, now)
        states = load_current_states(db, refs, now)
        monitor_ids = {r.monitor_id for r in refs if r.kind == "monitor"}
        monitors = {m.id: m for m in db.scalars(select(Monitor).where(Monitor.id.in_(monitor_ids)))} if monitor_ids else {}

        by_id = {r.id: r for r in rules}
        for ref in refs:
            pages = showing.get(ref.key, set())
            ref_rules = [r for r in active if applies(r, ref)]
            self.clear_orphaned_rules(ref, pages - {p for k, p in in_maintenance if k == ref.key}, ref_rules, by_id,
                                      states[ref], monitors.get(ref.monitor_id))
            if not pages or not ref_rules:
                continue
            for page_id in pages:
                if (ref.key, page_id) in in_maintenance:
                    for rule in ref_rules:
                        if (row := streaks.get((rule.id, ref.key, page_id))) is not None:
                            row.streak, row.last_observed_at = 0, now
            eligible = sorted(p for p in pages if (ref.key, p) not in in_maintenance)
            if eligible:
                self.evaluate_ref(ref, ref_rules, eligible, states[ref], monitors.get(ref.monitor_id), streaks)

        self.open_candidates()
        self.apply_status_changes()
        for pages in _audience(db, self.changed).values():
            affected |= pages
        return affected

    def usable(self, state) -> bool:
        return state.observed_at is not None and state.fresh_until is not None and self.now <= state.fresh_until

    def clear_orphaned_rules(self, ref, pages, ref_rules, by_id, state, monitor) -> None:
        """Clear and re-breach detection for associations whose rule no longer opens incidents for this source."""
        families = {CONDITION_FAMILY[r.event_type] for r in ref_rules}
        latest: list[Observation] | None = None
        for (key, family, page_id), assoc in self.associations.items():
            if key != ref.key or page_id not in pages or family in families:
                continue
            rule = by_id.get(assoc.rule_id)
            if rule is None or CONDITION_FAMILY.get(rule.event_type) != family or not _same_kind(rule, ref):
                continue
            if latest is None:
                latest = _observations(self.db, ref, [rule], monitor, None, 1) if self.usable(state) else []
            result = _condition(rule, ref, latest[-1]) if latest else None
            assoc.cleared = result is False
            if result is False:
                self.cleared.add(assoc.incident_id)
            elif result is True:
                self.rebreached[assoc.incident_id].add(key)
                self.failing.add(assoc.id)

    def evaluate_ref(self, ref, rules, pages, state, monitor, streaks) -> None:
        db = self.db
        if not self.usable(state):
            for rule in rules:
                for page_id in pages:
                    if (row := streaks.get((rule.id, ref.key, page_id))) is not None:
                        row.streak = 0
            for (key, _, page_id), assoc in self.associations.items():
                if key == ref.key and page_id in pages:
                    assoc.cleared = False
            return

        interval = max(monitor.check_interval_seconds, monitor.retry_interval_seconds) if monitor else state.interval_seconds
        rows: list[tuple[AlertRule, int, StatusBreachStreak]] = []
        for rule in rules:
            for page_id in pages:
                row = streaks.get((rule.id, ref.key, page_id))
                if row is None:
                    row = StatusBreachStreak(
                        rule_id=rule.id, source_key=ref.key, page_id=page_id, streak=0, rule_version=rule_version(rule),
                        resolution_latched=False,
                    )
                    db.add(row)
                    streaks[(rule.id, ref.key, page_id)] = row
                rows.append((rule, page_id, row))
        seen = [_utc(row.last_observed_at) for _, _, row in rows if row.last_observed_at is not None]
        since = min(seen) if seen else None
        samples = _observations(db, ref, rules, monitor, since, SCAN_ROWS if since else 1)

        outcomes: dict[tuple[str, int], list[bool | None]] = defaultdict(list)
        for rule, page_id, row in rows:
            version = rule_version(rule)
            if row.rule_version != version:
                row.streak, row.rule_version = 0, version
            last = _utc(row.last_observed_at)
            new = [s for s in samples if last is None or s.at > last]
            if last is None:
                new = new[-1:]
            if not new:
                continue
            if last is not None and len(samples) == SCAN_ROWS and samples[0].at > last:
                row.streak = 0
            result = None
            for sample in new:
                if last is not None and sample.at > freshness_deadline(last, interval):
                    row.streak = 0
                result = predicate(rule, ref, sample)
                if result is True:
                    if not row.resolution_latched:
                        row.streak += 1
                elif result is False:
                    row.streak, row.resolution_latched = 0, False
                else:
                    row.streak = 0
                last = sample.at
            row.last_observed_at = last
            family = CONDITION_FAMILY[rule.event_type]
            outcomes[(family, page_id)].append(result)
            if result is True and not row.resolution_latched and row.streak >= threshold(rule, monitor):
                self.candidates.append((rule, ref.key, page_id, row.streak))

        for (family, page_id), results in outcomes.items():
            assoc = self.associations.get((ref.key, family, page_id))
            if assoc is None:
                continue
            if any(r is True for r in results):
                assoc.cleared = False
                self.rebreached[assoc.incident_id].add(ref.key)
                self.failing.add(assoc.id)
            elif all(r is False for r in results):
                if not assoc.cleared:
                    assoc.cleared = True
                self.cleared.add(assoc.incident_id)
            else:
                assoc.cleared = False

    def open_candidates(self) -> None:
        wanted: dict[tuple[int, str], tuple[AlertRule, set[int], int]] = {}
        for rule, key, page_id, streak in self.candidates:
            family = CONDITION_FAMILY[rule.event_type]
            if (key, family, page_id) in self.associations:
                continue
            owner = self.owned_incident(key, page_id)
            if owner is not None:
                if self.attach(owner, [key], [page_id], rule.id, family):
                    self.add_event(owner, "source_failing", [key], count=streak, page_id=page_id, family=family)
                continue
            entry = wanted.setdefault((rule.id, key), (rule, set(), 0))
            entry[1].add(page_id)
            wanted[(rule.id, key)] = (rule, entry[1], max(entry[2], streak))

        groups: dict[tuple[int, str, frozenset[int]], list[tuple[str, int]]] = defaultdict(list)
        rules: dict[int, AlertRule] = {}
        for (rule_id, key), (rule, pages, streak) in sorted(wanted.items(), key=lambda kv: kv[0]):
            family = CONDITION_FAMILY[rule.event_type]
            rules[rule_id] = rule
            groups[(rule_id, family, frozenset(pages))].append((key, streak))

        for (rule_id, family, pages), members in sorted(groups.items(), key=lambda kv: (kv[0][0], kv[0][1], sorted(kv[0][2]))):
            incident = self.group_target(rule_id, family, pages)
            keys = [key for key, _ in members]
            if incident is not None:
                attached = self.attach(incident.id, keys, sorted(pages), rule_id, family)
                if attached:
                    self.add_event(incident.id, "source_added", attached)
                    self.rebreached[incident.id].update(attached)
            else:
                self.create(rules[rule_id], family, sorted(pages), keys, max(s for _, s in members))

    def owned_incident(self, key: str, page_id: int) -> int | None:
        return self.db.scalar(
            select(StatusIncident.id)
            .join(StatusIncidentSource, StatusIncidentSource.incident_id == StatusIncident.id)
            .join(StatusIncidentPage, (StatusIncidentPage.incident_id == StatusIncident.id) & (StatusIncidentPage.page_id == page_id))
            .where(
                StatusIncident.source.in_(OWNED_SOURCES), StatusIncident.status != "resolved",
                StatusIncidentSource.source_key == key, StatusIncidentSource.page_id == page_id,
                StatusIncidentSource.condition_family == incidents.MANUAL_FAMILY,
            )
            .order_by(StatusIncident.opened_at.desc(), StatusIncident.id.desc()).limit(1)
        )

    def group_target(self, rule_id: int, family: str, pages: frozenset[int]) -> StatusIncident | None:
        candidates = list(self.db.scalars(
            select(StatusIncident).where(
                StatusIncident.source == "netmap", StatusIncident.status != "resolved",
                StatusIncident.opened_by_rule_id == rule_id, StatusIncident.condition_family == family,
            ).order_by(StatusIncident.opened_at.desc(), StatusIncident.id.desc())
        ))
        candidates = [i for i in candidates if _utc(i.opened_at) >= self.now - GROUP_WINDOW]
        audiences = _audience(self.db, [i.id for i in candidates])
        return next((i for i in candidates if audiences.get(i.id, set()) == set(pages)), None)

    def attach(self, incident_id: int, keys: list[str], pages: list[int], rule_id: int, family: str) -> list[str]:
        db = self.db
        aliases = self.aliases(pages)
        attached: list[str] = []
        for page_id in pages:
            for key in keys:
                if key not in aliases[page_id]:
                    continue
                row = StatusIncidentSource(
                    incident_id=incident_id, source_key=key, condition_family=family, page_id=page_id,
                    rule_id=rule_id, active=True, cleared=False,
                )
                try:
                    with db.begin_nested():
                        db.add(row)
                        db.flush()
                except IntegrityError:
                    continue
                self.associations[(key, family, page_id)] = row
                if db.scalar(select(StatusIncidentAlias.id).where(
                    StatusIncidentAlias.incident_id == incident_id, StatusIncidentAlias.page_id == page_id,
                    StatusIncidentAlias.source_key == key,
                )) is None:
                    db.add(StatusIncidentAlias(
                        incident_id=incident_id, page_id=page_id, source_key=key, display_name=aliases[page_id][key],
                    ))
                if key not in attached:
                    attached.append(key)
        if attached:
            self.changed.add(incident_id)
        return attached

    def create(self, rule: AlertRule, family: str, pages: list[int], keys: list[str], streak: int) -> None:
        db = self.db
        savepoint = db.begin_nested()
        incident = StatusIncident(
            title=copy.neutral_title(family, len(set(keys)))[: incidents.TITLE_MAX],
            severity="partial" if family == "availability" else "performance",
            status="investigating", source="netmap", condition_family=family, opened_by_rule_id=rule.id,
            opened_at=self.now,
        )
        db.add(incident)
        db.flush()
        for page_id in pages:
            db.add(StatusIncidentPage(incident_id=incident.id, page_id=page_id))
        attached = self.attach(incident.id, keys, pages, rule.id, family)
        if not attached:
            savepoint.rollback()
            self.changed.discard(incident.id)
            return
        savepoint.commit()
        self.add_event(incident.id, "opened", attached, count=streak)

    def add_event(
        self, incident_id: int, code: str, keys: list[str], *, count: int | None = None, page_id: int | None = None,
        status: str | None = None, family: str | None = None,
    ) -> None:
        data = {"sources": list(keys), "count": len(keys) if count is None else count}
        if family is not None:
            data["family"] = family
        self.db.add(incidents._update_row(
            incident_id, NETMAP, self.now, page_id=page_id, status_change=status, event_code=code, event_data=data,
        ))
        self.db.flush()
        self.changed.add(incident_id)

    def last_observed(self, incident_id: int, page_id: int, key: str, family: str) -> str | None:
        for row in self.db.scalars(select(StatusIncidentUpdate).where(
            StatusIncidentUpdate.incident_id == incident_id, StatusIncidentUpdate.page_id == page_id,
            StatusIncidentUpdate.event_code.in_(OBSERVED_EVENTS),
        ).order_by(StatusIncidentUpdate.id.desc())):
            data = row.event_data or {}
            if data.get("family") == family and key in (data.get("sources") or []):
                return row.event_code
        return None

    def report_to_owners(self) -> None:
        db = self.db
        for (key, family, page_id), assoc in sorted(self.associations.items()):
            incident = db.get(StatusIncident, assoc.incident_id)
            if incident is None or incident.source not in OWNED_SOURCES or incident.status == "resolved":
                continue
            last = self.last_observed(incident.id, page_id, key, family)
            if assoc.id in self.failing and last == "source_recovered":
                self.add_event(incident.id, "rebreached", [key], page_id=page_id, family=family)
            elif assoc.cleared and last in ("source_failing", "rebreached"):
                self.add_event(incident.id, "source_recovered", [key], page_id=page_id, family=family)

    def apply_status_changes(self) -> None:
        db = self.db
        db.flush()
        self.report_to_owners()
        for incident_id, keys in sorted(self.rebreached.items()):
            incident = db.get(StatusIncident, incident_id)
            if incident is not None and incident.source == "netmap" and incident.status == "monitoring":
                incident.status = "investigating"
                self.add_event(incident_id, "rebreached", sorted(keys), status="investigating")
        for incident_id in sorted(self.cleared):
            incident = db.get(StatusIncident, incident_id)
            if incident is None or incident.source != "netmap" or incident.status not in ("investigating", "identified"):
                continue
            rows = list(db.execute(select(StatusIncidentSource.active, StatusIncidentSource.cleared).where(
                StatusIncidentSource.incident_id == incident_id,
                StatusIncidentSource.condition_family != incidents.MANUAL_FAMILY,
            )))
            if any(row.active for row in rows) and all(row.cleared for row in rows):
                incident.status = "monitoring"
                db.add(incidents._update_row(
                    incident_id, NETMAP, self.now, status_change="monitoring", event_code="recovered", event_data={},
                ))
                self.changed.add(incident_id)


def evaluate(db: Session, refs: list[SourceRef], now: datetime) -> set[int]:
    refs = sorted(set(refs), key=lambda r: r.key)
    if not refs:
        return set()
    try:
        affected = _Evaluation(db, _utc(now)).run(refs)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return affected

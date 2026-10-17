from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models.alert_rule import AlertRule
from app.models.device import Device
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.monitor_history import DeviceMonitorHistory
from app.models.port_target import DevicePortTarget
from app.models.status_page import StatusPageItem
from app.models.system_setting import SystemSetting
from app.services.alerting.service import (
    DEFAULT_INTERVAL_SECONDS,
    DEFAULT_LOSS_WINDOW_MINUTES,
    MIN_LOSS_SAMPLE_SIZE,
)
from app.services.monitoring.health import observed_health

Kind = Literal["device", "monitor", "service_check"]
Health = Literal["healthy", "unhealthy", "unknown"]
ItemState = Literal["operational", "degraded", "down", "maintenance", "unknown"]

FRESHNESS_FLOOR_SECONDS = 60
SERVICE_SCAN_ROWS = 20
THRESHOLD_EVENTS = ("rtt_above", "ping_loss_above", "service_slow", "monitor_slow")


@dataclass(frozen=True)
class SourceRef:
    kind: Kind
    device_id: int | None = None
    monitor_id: int | None = None
    port_target_id: int | None = None

    @property
    def key(self) -> str:
        if self.kind == "device":
            return f"device:{self.device_id}"
        if self.kind == "monitor":
            return f"monitor:{self.monitor_id}"
        return f"service:{self.device_id}:{self.port_target_id}"

    @classmethod
    def from_key(cls, key: str) -> SourceRef:
        parts = key.split(":") if isinstance(key, str) else []
        if not all(p.isascii() and p.isdigit() and int(p) > 0 and p == str(int(p)) for p in parts[1:]):
            raise ValueError(f"Invalid source key: {key!r}")
        ids = [int(p) for p in parts[1:]]
        if parts[:1] == ["device"] and len(ids) == 1:
            return cls("device", device_id=ids[0])
        if parts[:1] == ["monitor"] and len(ids) == 1:
            return cls("monitor", monitor_id=ids[0])
        if parts[:1] == ["service"] and len(ids) == 2:
            return cls("service_check", device_id=ids[0], port_target_id=ids[1])
        raise ValueError(f"Invalid source key: {key!r}")

    @classmethod
    def from_item(cls, item: StatusPageItem) -> SourceRef:
        return cls(item.kind, item.device_id, item.monitor_id, item.port_target_id)


@dataclass(frozen=True)
class CurrentState:
    ref: SourceRef
    health: Health
    observed_at: datetime | None
    fresh_until: datetime | None
    response_ms: float | None
    interval_seconds: int


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def freshness_deadline(observed_at: datetime, interval_seconds: int) -> datetime:
    return _utc(observed_at) + timedelta(seconds=max(2 * interval_seconds, FRESHNESS_FLOOR_SECONDS))


def _device_interval(db: Session) -> int:
    try:
        row = db.scalar(select(SystemSetting).where(SystemSetting.key == "monitor_interval_seconds"))
        if row:
            return min(3600, max(30, int(row.value)))
    except (TypeError, ValueError):
        pass
    return DEFAULT_INTERVAL_SECONDS


def _state(ref: SourceRef, health: Health, observed_at: datetime | None, response_ms: float | None, interval: int) -> CurrentState:
    observed_at = _utc(observed_at)
    if observed_at is None:
        return CurrentState(ref, "unknown", None, None, None, interval)
    return CurrentState(ref, health, observed_at, freshness_deadline(observed_at, interval), response_ms, interval)


def _device_usable(device: Device | None) -> bool:
    return (
        device is not None
        and device.status != "disabled"
        and not device.monitoring_paused
        and device.lifecycle == "active"
        and bool((device.ip_address or "").strip())
    )


def _latest_history(db: Session, device_id: int, limit: int) -> list[DeviceMonitorHistory]:
    return list(db.scalars(
        select(DeviceMonitorHistory)
        .where(DeviceMonitorHistory.device_id == device_id)
        .order_by(DeviceMonitorHistory.checked_at.desc(), DeviceMonitorHistory.id.desc())
        .limit(limit)
    ))


def _port_entry(row: DeviceMonitorHistory, target_id: int) -> dict | None:
    try:
        results = json.loads(row.port_results or "[]")
    except ValueError:
        return None
    for entry in results if isinstance(results, list) else []:
        if isinstance(entry, dict) and entry.get("target_id") == target_id:
            return entry
    return None


def load_current_states(db: Session, refs: Iterable[SourceRef], now: datetime) -> dict[SourceRef, CurrentState]:
    refs = set(refs)
    interval = _device_interval(db)
    states: dict[SourceRef, CurrentState] = {}

    device_ids = {r.device_id for r in refs if r.kind in ("device", "service_check")}
    devices = {d.id: d for d in db.scalars(select(Device).where(Device.id.in_(device_ids)))} if device_ids else {}

    for ref in (r for r in refs if r.kind == "device"):
        device = devices.get(ref.device_id)
        if not _device_usable(device):
            states[ref] = _state(ref, "unknown", None, None, interval)
            continue
        rows = _latest_history(db, device.id, 1)
        rtt = rows[0].rtt_ms if rows else None
        health = observed_health(device.monitor_status, device.expected_status)
        states[ref] = _state(ref, health, device.last_monitored_at, rtt, interval)

    service_refs = [r for r in refs if r.kind == "service_check"]
    if service_refs:
        target_ids = {r.port_target_id for r in service_refs}
        targets = {t.id: t for t in db.scalars(select(DevicePortTarget).where(DevicePortTarget.id.in_(target_ids)))}
        history_by_device: dict[int, list[DeviceMonitorHistory]] = {}
        for ref in service_refs:
            target = targets.get(ref.port_target_id)
            valid = (
                _device_usable(devices.get(ref.device_id))
                and target is not None
                and target.enabled
                and target.device_id in (None, ref.device_id)
            )
            if not valid:
                states[ref] = _state(ref, "unknown", None, None, interval)
                continue
            if ref.device_id not in history_by_device:
                history_by_device[ref.device_id] = _latest_history(db, ref.device_id, SERVICE_SCAN_ROWS)
            states[ref] = _service_state(ref, history_by_device[ref.device_id], interval)

    monitor_refs = [r for r in refs if r.kind == "monitor"]
    if monitor_refs:
        monitors = {m.id: m for m in db.scalars(select(Monitor).where(Monitor.id.in_({r.monitor_id for r in monitor_refs})))}
        for ref in monitor_refs:
            monitor = monitors.get(ref.monitor_id)
            if monitor is None or not monitor.enabled:
                states[ref] = _state(ref, "unknown", None, None, 60)
                continue
            monitor_interval = monitor.retry_interval_seconds if monitor.consecutive_failures > 0 else monitor.check_interval_seconds
            health: Health = {"online": "healthy", "offline": "unhealthy"}.get(monitor.last_status, "unknown")
            latest = db.scalar(
                select(MonitorCheckHistory)
                .where(MonitorCheckHistory.monitor_id == monitor.id)
                .order_by(MonitorCheckHistory.checked_at.desc(), MonitorCheckHistory.id.desc())
                .limit(1)
            )
            response_ms = latest.response_time_ms if latest is not None and latest.status == "online" else None
            states[ref] = _state(ref, health, monitor.last_checked_at, response_ms, monitor_interval)

    return states


def _service_state(ref: SourceRef, rows: list[DeviceMonitorHistory], interval: int) -> CurrentState:
    for row in rows:
        entry = _port_entry(row, ref.port_target_id)
        if entry is None:
            continue
        health: Health = "healthy" if entry.get("open") else "unhealthy"
        response = entry.get("response_time_ms")
        return _state(ref, health, row.checked_at, response if isinstance(response, (int, float)) else None, interval)
    return _state(ref, "unknown", None, None, interval)


def rtt_above(rule: AlertRule, rtt_ms: float | None) -> bool:
    return rule.threshold_ms is not None and rtt_ms is not None and rtt_ms > rule.threshold_ms


def service_slow(rule: AlertRule, response_ms: float | None) -> bool:
    return rule.threshold_ms is not None and response_ms is not None and response_ms > rule.threshold_ms


def monitor_slow(rule: AlertRule, response_ms: float | None) -> bool:
    return rule.threshold_ms is not None and response_ms is not None and response_ms > rule.threshold_ms


def ping_loss_above(rule: AlertRule, total_probes: int, offline_probes: int) -> bool:
    if rule.loss_pct_threshold is None or total_probes < MIN_LOSS_SAMPLE_SIZE:
        return False
    return offline_probes / total_probes * 100 >= rule.loss_pct_threshold


def threshold_breaching_sources(db: Session, refs: Iterable[SourceRef], now: datetime) -> set[SourceRef]:
    now = _utc(now)
    refs = set(refs)
    rules = list(db.scalars(
        select(AlertRule).where(AlertRule.enabled == True, AlertRule.event_type.in_(THRESHOLD_EVENTS))  # noqa: E712
    ))
    if not refs or not rules:
        return set()
    states = load_current_states(db, refs, now)
    breaching: set[SourceRef] = set()

    def fresh(state: CurrentState) -> bool:
        return state.fresh_until is not None and now <= state.fresh_until

    for rule in rules:
        for ref, state in states.items():
            if not fresh(state):
                continue
            if rule.event_type == "rtt_above" and ref.kind == "device":
                hit = rule.device_id in (None, ref.device_id) and rtt_above(rule, state.response_ms)
            elif rule.event_type == "service_slow" and ref.kind == "service_check":
                hit = (
                    rule.device_id in (None, ref.device_id)
                    and rule.port_target_id in (None, ref.port_target_id)
                    and service_slow(rule, state.response_ms)
                )
            elif rule.event_type == "monitor_slow" and ref.kind == "monitor":
                hit = rule.monitor_id in (None, ref.monitor_id) and monitor_slow(rule, state.response_ms)
            else:
                hit = False
            if hit:
                breaching.add(ref)

    device_refs = {ref: s for ref, s in states.items() if ref.kind == "device" and fresh(s)}
    for rule in (r for r in rules if r.event_type == "ping_loss_above"):
        wanted = {ref.device_id: ref for ref in device_refs if rule.device_id in (None, ref.device_id)}
        if not wanted:
            continue
        cutoff = now - timedelta(minutes=rule.loss_window_minutes or DEFAULT_LOSS_WINDOW_MINUTES)
        query = (
            select(
                DeviceMonitorHistory.device_id,
                func.count(DeviceMonitorHistory.id),
                func.sum(case((DeviceMonitorHistory.status == "offline", 1), else_=0)),
            )
            .where(DeviceMonitorHistory.checked_at >= cutoff, DeviceMonitorHistory.device_id.in_(wanted))
            .group_by(DeviceMonitorHistory.device_id)
        )
        for device_id, total, offline in db.execute(query).all():
            if ping_loss_above(rule, total, offline or 0):
                breaching.add(wanted[device_id])
    return breaching


def item_state(state: CurrentState, degraded: bool, in_maintenance: bool, now: datetime) -> ItemState:
    if in_maintenance:
        return "maintenance"
    if state.health == "unknown" or state.fresh_until is None or _utc(now) > state.fresh_until:
        return "unknown"
    if state.health == "unhealthy":
        return "down"
    return "degraded" if degraded else "operational"

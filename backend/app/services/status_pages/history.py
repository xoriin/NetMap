from __future__ import annotations

import json
import math
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import DateTime, func, literal, select
from sqlalchemy.orm import Session, aliased, defer

from app.models.device import Device
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.monitor_history import DeviceMonitorHistory
from app.services.status_pages.sources import SERVICE_SCAN_ROWS, SourceRef, _utc, freshness_deadline

Health = Literal["healthy", "unhealthy", "unknown"]
SpanHealth = Literal["healthy", "unhealthy", "unknown", "maintenance"]
AvailabilityLabel = Literal["ok", "insufficient", "no_data"]

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
MIN_COVERAGE = 0.9
DEFAULT_SLOTS = 60

Interval = tuple[datetime, datetime]


@dataclass(frozen=True)
class Sample:
    at: datetime
    health: Health
    response_ms: float | None
    ok: bool


@dataclass(frozen=True)
class Span:
    start: datetime
    end: datetime
    health: SpanHealth


@dataclass(frozen=True)
class Availability:
    percent: float | None
    coverage: float
    label: AvailabilityLabel


def _valid_response(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and value >= 0 else None


def _device_sample(row: DeviceMonitorHistory) -> Sample:
    health: Health = "unknown" if row.is_healthy is None else ("healthy" if row.is_healthy else "unhealthy")
    return Sample(_utc(row.checked_at), health, _valid_response(row.rtt_ms), health == "healthy")


def _monitor_sample(row: MonitorCheckHistory) -> Sample:
    health: Health = {"online": "healthy", "offline": "unhealthy"}.get(row.status, "unknown")
    response = _valid_response(row.response_time_ms) if health == "healthy" else None
    return Sample(_utc(row.checked_at), health, response, health == "healthy")


def _port_map(row: DeviceMonitorHistory) -> dict[int, dict]:
    try:
        results = json.loads(row.port_results or "[]")
    except ValueError:
        return {}
    entries: dict[int, dict] = {}
    for entry in results if isinstance(results, list) else []:
        if isinstance(entry, dict) and isinstance(entry.get("target_id"), int):
            entries.setdefault(entry["target_id"], entry)
    return entries


def _service_sample(at: datetime, entry: dict) -> Sample:
    healthy = bool(entry.get("open"))
    response = _valid_response(entry.get("response_time_ms")) if healthy else None
    return Sample(at, "healthy" if healthy else "unhealthy", response, healthy)


def _fetch(db: Session, model, owner_model, owner_col, ids: set[int], start: datetime, end: datetime, preceding: int, *, light: bool):
    options = [defer(model.port_results)] if light else []
    rows = list(db.scalars(
        select(model).options(*options)
        .where(owner_col.in_(ids), model.checked_at >= start, model.checked_at < end)
        .order_by(owner_col, model.checked_at, model.id)
    ))
    earlier = aliased(model)
    bound = (
        select(earlier.checked_at)
        .where(getattr(earlier, owner_col.key) == owner_model.id, earlier.checked_at < start)
        .order_by(earlier.checked_at.desc())
        .offset(preceding - 1)
        .limit(1)
        .correlate(owner_model)
        .scalar_subquery()
    )
    bound = func.coalesce(bound, literal(_EPOCH, type_=DateTime(timezone=True)))
    bounds = select(owner_model.id.label("owner_id"), bound.label("bound")).where(owner_model.id.in_(ids)).subquery()
    before = list(db.scalars(
        select(model).options(*options)
        .join(bounds, bounds.c.owner_id == owner_col)
        .where(model.checked_at < start, model.checked_at >= bounds.c.bound)
        .order_by(owner_col, model.checked_at, model.id)
    ))
    return before + rows


def _last_preceding(samples: list[Sample], start: datetime) -> list[Sample]:
    inside = [s for s in samples if s.at >= start]
    return [s for s in samples if s.at < start][-1:] + inside


def load_samples(db: Session, refs: Iterable[SourceRef], start: datetime, end: datetime) -> dict[SourceRef, list[Sample]]:
    refs = set(refs)
    start, end = _utc(start), _utc(end)
    out: dict[SourceRef, list[Sample]] = {ref: [] for ref in refs}

    device_refs = {r.device_id: r for r in refs if r.kind == "device"}
    if device_refs:
        for row in _fetch(db, DeviceMonitorHistory, Device, DeviceMonitorHistory.device_id, set(device_refs), start, end, 1, light=True):
            out[device_refs[row.device_id]].append(_device_sample(row))
        for ref in device_refs.values():
            out[ref] = _last_preceding(out[ref], start)

    monitor_refs = {r.monitor_id: r for r in refs if r.kind == "monitor"}
    if monitor_refs:
        for row in _fetch(db, MonitorCheckHistory, Monitor, MonitorCheckHistory.monitor_id, set(monitor_refs), start, end, 1, light=False):
            out[monitor_refs[row.monitor_id]].append(_monitor_sample(row))
        for ref in monitor_refs.values():
            out[ref] = _last_preceding(out[ref], start)

    service_by_device: dict[int, list[SourceRef]] = defaultdict(list)
    for ref in refs:
        if ref.kind == "service_check":
            service_by_device[ref.device_id].append(ref)
    if service_by_device:
        parsed: dict[int, list[tuple[datetime, dict[int, dict]]]] = defaultdict(list)
        for row in _fetch(db, DeviceMonitorHistory, Device, DeviceMonitorHistory.device_id, set(service_by_device),
                          start, end, SERVICE_SCAN_ROWS, light=False):
            parsed[row.device_id].append((_utc(row.checked_at), _port_map(row)))
        for device_id, device_refs_list in service_by_device.items():
            for ref in device_refs_list:
                samples = [_service_sample(at, entries[ref.port_target_id])
                           for at, entries in parsed[device_id] if ref.port_target_id in entries]
                out[ref] = _last_preceding(samples, start)
    return out


def _merge_intervals(intervals: Iterable[Interval], start: datetime, end: datetime) -> list[Interval]:
    clipped = sorted(
        (max(_utc(a), start), min(_utc(b), end)) for a, b in intervals if _utc(b) > start and _utc(a) < end
    )
    merged: list[Interval] = []
    for a, b in clipped:
        if b <= a:
            continue
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def _coalesce(spans: list[Span]) -> list[Span]:
    out: list[Span] = []
    for span in spans:
        if span.end <= span.start:
            continue
        if out and out[-1].health == span.health and out[-1].end == span.start:
            out[-1] = Span(out[-1].start, span.end, span.health)
        else:
            out.append(span)
    return out


def build_spans(
    samples: Sequence[Sample], start: datetime, end: datetime, interval_seconds: int,
    maintenance: Sequence[Interval],
) -> list[Span]:
    start, end = _utc(start), _utc(end)
    ordered = sorted(samples, key=lambda s: s.at)
    base: list[Span] = []
    cursor = start
    for index, sample in enumerate(ordered):
        if sample.at >= end:
            break
        next_at = ordered[index + 1].at if index + 1 < len(ordered) else end
        holds_until = min(next_at, freshness_deadline(sample.at, interval_seconds), end)
        a = max(sample.at, start)
        if holds_until <= a:
            continue
        if a > cursor:
            base.append(Span(cursor, a, "unknown"))
        base.append(Span(a, holds_until, sample.health))
        cursor = holds_until
    if cursor < end:
        base.append(Span(cursor, end, "unknown"))

    spans: list[Span] = []
    windows = _merge_intervals(maintenance, start, end)
    for span in base:
        pos = span.start
        for a, b in windows:
            if b <= pos or a >= span.end:
                continue
            if a > pos:
                spans.append(Span(pos, a, span.health))
            spans.append(Span(max(a, pos), min(b, span.end), "maintenance"))
            pos = min(b, span.end)
        if pos < span.end:
            spans.append(Span(pos, span.end, span.health))
    return _coalesce(spans)


def _duration(spans: Iterable[Span], health: str) -> float:
    return sum((s.end - s.start).total_seconds() for s in spans if s.health == health)


def availability(spans: Sequence[Span], start: datetime, end: datetime) -> Availability:
    window = (_utc(end) - _utc(start)).total_seconds()
    eligible = window - _duration(spans, "maintenance")
    healthy, unhealthy = _duration(spans, "healthy"), _duration(spans, "unhealthy")
    known = healthy + unhealthy
    if eligible <= 0 or known <= 0:
        return Availability(None, 0.0, "no_data")
    coverage = min(1.0, known / eligible)
    if coverage < MIN_COVERAGE:
        return Availability(None, coverage, "insufficient")
    return Availability(healthy / known, coverage, "ok")


def _slot_bounds(start: datetime, end: datetime, slots: int) -> list[Interval]:
    start, end = _utc(start), _utc(end)
    width = (end - start) / slots
    return [(start + width * i, start + width * (i + 1) if i < slots - 1 else end) for i in range(slots)]


def heartbeat_slots(spans: Sequence[Span], start: datetime, end: datetime, slots: int = DEFAULT_SLOTS) -> list[SpanHealth]:
    result: list[SpanHealth] = []
    for a, b in _slot_bounds(start, end, slots):
        seen = {s.health for s in spans if s.start < b and s.end > a and min(s.end, b) > max(s.start, a)}
        if "unhealthy" in seen:
            result.append("unhealthy")
        elif "healthy" in seen:
            result.append("healthy")
        elif "unknown" in seen or not seen:
            result.append("unknown")
        else:
            result.append("maintenance")
    return result


def _in_maintenance(at: datetime, windows: list[Interval]) -> bool:
    return any(a <= at < b for a, b in windows)


def window_samples(samples: Iterable[Sample], start: datetime, end: datetime, maintenance: Sequence[Interval]) -> list[Sample]:
    start, end = _utc(start), _utc(end)
    windows = _merge_intervals(maintenance, start, end)
    return [s for s in samples if start <= s.at < end and not _in_maintenance(s.at, windows)]


def response_slots(
    samples: Sequence[Sample], start: datetime, end: datetime, maintenance: Sequence[Interval],
    slots: int = DEFAULT_SLOTS,
) -> list[float | None]:
    bounds = _slot_bounds(start, end, slots)
    buckets: list[list[float]] = [[] for _ in bounds]
    for sample in window_samples(samples, start, end, maintenance):
        value = _valid_response(sample.response_ms)
        if not sample.ok or value is None:
            continue
        for index, (a, b) in enumerate(bounds):
            if a <= sample.at < b:
                buckets[index].append(value)
                break
    return [sum(b) / len(b) if b else None for b in buckets]


def p95(values: Sequence[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[math.ceil(0.95 * len(ordered)) - 1]


def failure_rate(samples: Sequence[Sample], start: datetime, end: datetime, maintenance: Sequence[Interval]) -> float | None:
    known = [s for s in window_samples(samples, start, end, maintenance) if s.health != "unknown"]
    if not known:
        return None
    return sum(1 for s in known if not s.ok) / len(known)

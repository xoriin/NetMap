from __future__ import annotations

import json
import math
from bisect import bisect_right
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from operator import itemgetter
from typing import Literal

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, aliased

from app.models.device import Device
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.monitor_history import DeviceMonitorHistory
from app.services.status_pages.sources import SERVICE_SCAN_ROWS, SourceRef, _utc, freshness_deadline

Health = Literal["healthy", "unhealthy", "unknown"]
SpanHealth = Literal["healthy", "unhealthy", "unknown", "maintenance"]
AvailabilityLabel = Literal["ok", "insufficient", "no_data"]

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


def _health(is_healthy) -> Health:
    return "unknown" if is_healthy is None else ("healthy" if is_healthy else "unhealthy")


def _device_sample(row) -> Sample:
    health = _health(row.is_healthy)
    return Sample(_utc(row.checked_at), health, _valid_response(row.rtt_ms), health == "healthy")


def _monitor_sample(row) -> Sample:
    health: Health = {"online": "healthy", "offline": "unhealthy"}.get(row.status, "unknown")
    response = _valid_response(row.response_time_ms) if health == "healthy" else None
    return Sample(_utc(row.checked_at), health, response, health == "healthy")


def _port_map(row) -> dict[int, dict]:
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


_DEVICE_COLUMNS = (DeviceMonitorHistory.device_id.label("owner"), DeviceMonitorHistory.checked_at,
                   DeviceMonitorHistory.is_healthy, DeviceMonitorHistory.rtt_ms)
_DEVICE_HEALTH_COLUMNS = (DeviceMonitorHistory.device_id.label("owner"), DeviceMonitorHistory.checked_at,
                          DeviceMonitorHistory.is_healthy)
_MONITOR_COLUMNS = (MonitorCheckHistory.monitor_id.label("owner"), MonitorCheckHistory.checked_at,
                    MonitorCheckHistory.status, MonitorCheckHistory.response_time_ms)
_SERVICE_COLUMNS = (DeviceMonitorHistory.device_id.label("owner"), DeviceMonitorHistory.checked_at,
                    DeviceMonitorHistory.port_results)


PRECEDING_CHUNK = 200


def _fetch(db: Session, model, owner_model, owner_col, columns, ids: set[int], start: datetime, end: datetime, preceding: int):
    rows = db.execute(
        select(*columns)
        .where(owner_col.in_(ids), model.checked_at >= start, model.checked_at < end)
        .order_by(owner_col, model.checked_at, model.id)
    ).all()
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
    bounds = db.execute(select(owner_model.id, bound).where(owner_model.id.in_(ids))).all()
    ranges = [
        and_(owner_col == owner, model.checked_at < start, *([model.checked_at >= since] if since is not None else []))
        for owner, since in sorted(bounds)
    ]
    before = []
    for index in range(0, len(ranges), PRECEDING_CHUNK):
        before += db.execute(
            select(*columns).where(or_(*ranges[index:index + PRECEDING_CHUNK]))
            .order_by(owner_col, model.checked_at, model.id)
        ).all()
    return before + rows


@dataclass
class RawHistory:
    """History rows for one [start, end) range, fetched with column selects and converted after the session closes."""

    start: datetime
    end: datetime
    device: dict[int, list] = field(default_factory=dict)
    monitor: dict[int, list] = field(default_factory=dict)
    service: dict[int, list] = field(default_factory=dict)
    rows: int = 0

    def has(self, ref: SourceRef) -> bool:
        if ref.kind == "device":
            return ref.device_id in self.device
        if ref.kind == "monitor":
            return ref.monitor_id in self.monitor
        return ref.device_id in self.service


def _group(rows, ids: Iterable[int]) -> dict[int, list]:
    out: dict[int, list] = {i: [] for i in ids}
    for row in rows:
        out[row.owner].append(row)
    return out


def fetch_history(
    db: Session, refs: Iterable[SourceRef], start: datetime, end: datetime, *, raw: RawHistory | None = None,
    health_only: bool = False,
) -> RawHistory:
    start, end = _utc(start), _utc(end)
    raw = raw if raw is not None else RawHistory(start, end)
    missing = [r for r in set(refs) if not raw.has(r)]
    device_ids = {r.device_id for r in missing if r.kind == "device"}
    monitor_ids = {r.monitor_id for r in missing if r.kind == "monitor"}
    service_ids = {r.device_id for r in missing if r.kind == "service_check"}
    if device_ids:
        columns = _DEVICE_HEALTH_COLUMNS if health_only else _DEVICE_COLUMNS
        rows = _fetch(db, DeviceMonitorHistory, Device, DeviceMonitorHistory.device_id, columns, device_ids, start, end, 1)
        raw.device.update(_group(rows, device_ids))
        raw.rows += len(rows)
    if monitor_ids:
        rows = _fetch(db, MonitorCheckHistory, Monitor, MonitorCheckHistory.monitor_id, _MONITOR_COLUMNS,
                      monitor_ids, start, end, 1)
        raw.monitor.update(_group(rows, monitor_ids))
        raw.rows += len(rows)
    if service_ids:
        rows = _fetch(db, DeviceMonitorHistory, Device, DeviceMonitorHistory.device_id, _SERVICE_COLUMNS,
                      service_ids, start, end, SERVICE_SCAN_ROWS)
        raw.service.update(_group(rows, service_ids))
        raw.rows += len(rows)
    return raw


def _last_preceding(samples: list, start: datetime) -> list:
    inside = [s for s in samples if s.at >= start]
    return [s for s in samples if s.at < start][-1:] + inside


class SampleConverter:
    """Turns one RawHistory into samples, parsing each service row's JSON once however many targets read it."""

    def __init__(self, raw: RawHistory) -> None:
        self.raw = raw
        self._parsed: dict[int, list[tuple[datetime, dict[int, dict]]]] = {}

    def samples(self, ref: SourceRef) -> list[Sample]:
        raw = self.raw
        if ref.kind == "device":
            found = [_device_sample(row) for row in raw.device.get(ref.device_id, ())]
        elif ref.kind == "monitor":
            found = [_monitor_sample(row) for row in raw.monitor.get(ref.monitor_id, ())]
        else:
            if ref.device_id not in self._parsed:
                self._parsed[ref.device_id] = [(_utc(row.checked_at), _port_map(row)) for row in raw.service.get(ref.device_id, ())]
            found = [_service_sample(at, entries[ref.port_target_id])
                     for at, entries in self._parsed[ref.device_id] if ref.port_target_id in entries]
        return _last_preceding(found, raw.start)

    def points(self, ref: SourceRef) -> list[tuple[datetime, Health]]:
        if ref.kind != "device":
            return [(s.at, s.health) for s in self.samples(ref)]
        start, utc = self.raw.start, timezone.utc
        found = [
            (at if at.tzinfo is not None else at.replace(tzinfo=utc), _health(healthy))
            for _, at, healthy, *_ in self.raw.device.get(ref.device_id, ())
        ]
        before = 0
        while before < len(found) and found[before][0] < start:
            before += 1
        return found[max(0, before - 1):] if before else found


def load_samples(db: Session, refs: Iterable[SourceRef], start: datetime, end: datetime) -> dict[SourceRef, list[Sample]]:
    refs = set(refs)
    converter = SampleConverter(fetch_history(db, refs, start, end))
    return {ref: converter.samples(ref) for ref in refs}


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
    return sum((s.end - s.start for s in spans if s.health == health), timedelta()).total_seconds()


def availability(spans: Sequence[Span], start: datetime, end: datetime) -> Availability:
    return _availability(
        (_utc(end) - _utc(start)).total_seconds(), _duration(spans, "maintenance"),
        _duration(spans, "healthy"), _duration(spans, "unhealthy"),
    )


def _availability(window: float, maintenance: float, healthy: float, unhealthy: float) -> Availability:
    eligible = window - maintenance
    known = healthy + unhealthy
    if eligible <= 0 or known <= 0:
        return Availability(None, 0.0, "no_data")
    coverage = min(1.0, known / eligible)
    if coverage < MIN_COVERAGE:
        return Availability(None, coverage, "insufficient")
    return Availability(healthy / known, coverage, "ok")


def period_availability(
    points: Sequence[tuple[datetime, Health]], start: datetime, end: datetime, interval_seconds: int,
    maintenance: Sequence[Interval],
) -> Availability:
    """availability(build_spans(...)) for long periods, summed in one pass without building spans."""
    start, end = _utc(start), _utc(end)
    ordered = sorted(points, key=itemgetter(0))
    windows = _merge_intervals(maintenance, start, end)
    hold = freshness_deadline(start, interval_seconds) - start
    totals = {"healthy": timedelta(), "unhealthy": timedelta()}
    count, w = len(ordered), 0
    for index in range(count):
        at, health = ordered[index]
        if at >= end:
            break
        if health == "unknown":
            continue
        next_at = ordered[index + 1][0] if index + 1 < count else end
        until = min(next_at, at + hold, end)
        a = at if at > start else start
        if until <= a:
            continue
        length = until - a
        while w < len(windows) and windows[w][1] <= a:
            w += 1
        k = w
        while k < len(windows) and windows[k][0] < until:
            length -= min(until, windows[k][1]) - max(a, windows[k][0])
            k += 1
        totals[health] += length
    maintained = sum((b - a for a, b in windows), timedelta())
    return _availability(
        (end - start).total_seconds(), maintained.total_seconds(),
        totals["healthy"].total_seconds(), totals["unhealthy"].total_seconds(),
    )


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
    starts = [a for a, _ in bounds]
    buckets: list[list[float]] = [[] for _ in bounds]
    for sample in window_samples(samples, start, end, maintenance):
        value = _valid_response(sample.response_ms)
        if not sample.ok or value is None:
            continue
        index = bisect_right(starts, sample.at) - 1
        if index >= 0 and sample.at < bounds[index][1]:
            buckets[index].append(value)
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

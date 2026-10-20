from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal, TypedDict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.status_page import StatusPage, StatusPageGroup, StatusPageItem
from app.services.status_pages import maintenance
from app.services.status_pages.css import validate_css
from app.services.status_pages.incidents import PAST_WINDOW, PageLocal, load_page_incidents, project_incident
from app.services.status_pages.notices import live_notices
from app.services.status_pages.aggregates import BuildCycle, LongKey, SourceHistory
from app.services.status_pages.history import (
    Availability,
    RawHistory,
    Sample,
    SampleConverter,
    availability,
    build_spans,
    failure_rate,
    heartbeat_slots,
    p95,
    period_availability,
    response_slots,
    window_samples,
)
from app.services.status_pages.sources import (
    CurrentState,
    ItemState,
    SourceRef,
    _utc,
    item_state,
)

Audience = Literal["public", "private"]
SummaryState = Literal["empty", "major", "affected", "unknown", "maintenance", "operational"]

WINDOWS = {"1h": timedelta(hours=1), "24h": timedelta(hours=24)}
PERIODS = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}
LONG_PERIODS = ("7d", "30d")
SLOTS = 60
MAX_VALIDITY = timedelta(seconds=30)

LABELS: dict[SummaryState, str] = {
    "empty": "No systems configured",
    "major": "Major outage",
    "affected": "Some systems are affected",
    "unknown": "Status unavailable for some systems",
    "maintenance": "Maintenance in progress",
    "operational": "All systems operational",
}


class PagePayload(TypedDict):
    slug: str
    title: str
    accent: str | None
    logo: str | None
    heartbeat_window: str
    custom_css: str | None
    generated_at: str
    valid_until: str
    summary: dict
    notices: list
    incidents: list
    maintenance: list
    past: list
    groups: list[dict]


def summarize(states: list[ItemState], critical_notice: bool) -> tuple[SummaryState, str]:
    if not states:
        state: SummaryState = "empty"
    elif sum(s == "down" for s in states) * 2 > len(states):
        state = "major"
    elif critical_notice or any(s in ("down", "degraded") for s in states):
        state = "affected"
    elif "unknown" in states:
        state = "unknown"
    elif "maintenance" in states:
        state = "maintenance"
    else:
        state = "operational"
    return state, LABELS[state]


def _slot_width(page: StatusPage) -> timedelta:
    return WINDOWS[page.heartbeat_window] / SLOTS


def slot_end(page: StatusPage, now: datetime) -> datetime:
    width = _slot_width(page).total_seconds()
    return datetime.fromtimestamp((now.timestamp() // width + 1) * width, tz=timezone.utc)


def next_deadline(
    page: StatusPage,
    now: datetime,
    states: Iterable[CurrentState],
    notice_expiries: Iterable[datetime] = (),
    maintenance_edges: Iterable[datetime] = (),
) -> datetime:
    now = _utc(now)
    candidates = [now + MAX_VALIDITY, slot_end(page, now)]
    candidates += [s.fresh_until for s in states if s.fresh_until is not None]
    candidates += [_utc(d) for d in (*notice_expiries, *maintenance_edges)]
    return min(c for c in candidates if c > now)


def _round(value: float | None, digits: int | None = None) -> float | None:
    return None if value is None else round(value, digits) if digits is not None else float(round(value))


def _metrics(
    extras: dict, samples: list[Sample], start: datetime, now: datetime, state: CurrentState,
    period: Availability | None, spans_out: list,
) -> dict | None:
    metrics: dict = {}
    window = window_samples(samples, start, now, spans_out)
    values = [s.response_ms for s in window if s.ok and s.response_ms is not None]
    if extras.get("avg_response"):
        metrics["avg_response"] = _round(sum(values) / len(values)) if values else None
    if extras.get("p95_response"):
        metrics["p95_response"] = _round(p95(values))
    if extras.get("failure_rate"):
        metrics["failure_rate"] = _round(failure_rate(samples, start, now, spans_out), 4)
    if extras.get("last_check"):
        metrics["last_check"] = state.observed_at.isoformat() if state.observed_at else None
    if period is not None:
        metrics["uptime_period"] = {
            "period": extras["uptime_period"], "percent": _round(period.percent, 4), "label": period.label,
            "coverage": _round(period.coverage, 4),
        }
    return metrics or None


def _window_entry(loaded: maintenance.LoadedWindow, now: datetime) -> dict:
    window = loaded.window
    return {
        "id": window.id, "title": window.title, "description": window.description,
        "starts_at": loaded.start.isoformat(), "ends_at": loaded.end.isoformat(), "active": loaded.active(now),
    }


def _past_window(loaded: maintenance.LoadedWindow) -> dict:
    window = loaded.window
    return {
        "kind": "maintenance", "id": window.id, "title": window.title, "description": window.description,
        "starts_at": loaded.start.isoformat(), "ends_at": loaded.end.isoformat(),
    }


@dataclass
class PageInputs:
    """Everything a page build reads from the database; projecting it needs no session."""

    page: StatusPage
    now: datetime
    groups: list[StatusPageGroup]
    items: list[StatusPageItem]
    refs: dict[int, SourceRef]
    states: dict[SourceRef, CurrentState]
    degraded: set[SourceRef]
    windows: list[maintenance.LoadedWindow]
    excluded: dict[str, list]
    incidents: list
    notices: list
    long_rows: dict[str, RawHistory] = field(default_factory=dict)
    long_hits: dict[tuple[SourceRef, str], Availability] = field(default_factory=dict)


def _long_key(ref: SourceRef, period: str, state: CurrentState, excluded: list) -> LongKey:
    return ref.key, period, state.interval_seconds, tuple(sorted((_utc(a), _utc(b)) for a, b in excluded))


def _bounds(page: StatusPage, now: datetime) -> tuple[datetime, datetime]:
    end = slot_end(page, now)
    return end - WINDOWS[page.heartbeat_window], end


def load_page(db: Session, page: StatusPage, now: datetime, cycle: BuildCycle) -> PageInputs:
    now = _utc(now)
    start, end = _bounds(page, now)
    groups = list(db.scalars(
        select(StatusPageGroup).where(StatusPageGroup.page_id == page.id).order_by(StatusPageGroup.sort_order, StatusPageGroup.id)
    ))
    items = list(db.scalars(
        select(StatusPageItem).where(StatusPageItem.page_id == page.id).order_by(StatusPageItem.sort_order, StatusPageItem.id)
    ))
    refs = {item.id: SourceRef.from_item(item) for item in items}
    states = cycle.states(db, refs.values(), now)
    degraded = cycle.degraded(db, refs.values(), now)
    keys = [ref.key for ref in refs.values()]
    windows = maintenance.page_windows(db, page.id, keys, ending_after=now - max(*PERIODS.values(), PAST_WINDOW))
    excluded = maintenance.spans_for_page(windows, page.id, keys)

    fresh: dict[datetime, set[SourceRef]] = defaultdict(set)
    long: dict[str, set[SourceRef]] = defaultdict(set)
    long_hits: dict[tuple[SourceRef, str], Availability] = {}
    for item in items:
        ref = refs[item.id]
        fresh[start].add(ref)
        period = (item.extras or {}).get("uptime_period")
        if period in LONG_PERIODS:
            hit = cycle.shared.long(_long_key(ref, period, states[ref], excluded.get(ref.key, [])), now)
            if hit is None:
                long[period].add(ref)
            else:
                long_hits[(ref, period)] = hit
        elif period in PERIODS:
            fresh[end - PERIODS[period]].add(ref)
    for since, group_refs in fresh.items():
        cycle.fetch(db, group_refs, since, now)
    long_rows = {period: cycle.fetch_long(db, group_refs, now - PERIODS[period], now) for period, group_refs in long.items()}
    return PageInputs(
        page=page, now=now, groups=groups, items=items, refs=refs, states=states, degraded=degraded,
        windows=windows, excluded=excluded, incidents=load_page_incidents(db, page.id, now),
        notices=live_notices(db, page.id, now), long_rows=long_rows, long_hits=long_hits,
    )


def _period(inputs: PageInputs, cycle: BuildCycle, ref: SourceRef, period, end: datetime, converters: dict) -> Availability | None:
    if period not in PERIODS:
        return None
    now, state, own_excluded = inputs.now, inputs.states[ref], inputs.excluded.get(ref.key, [])
    if period not in LONG_PERIODS:
        since = end - PERIODS[period]
        return cycle.memo(("period", ref, since, now, state.interval_seconds, tuple(own_excluded)), lambda: availability(
            build_spans(cycle.samples(ref, since, now), since, now, state.interval_seconds, own_excluded), since, now,
        ))
    if (ref, period) in inputs.long_hits:
        return inputs.long_hits[(ref, period)]
    key = _long_key(ref, period, state, own_excluded)
    found = cycle.shared.long(key, now)
    if found is None:
        converter = converters.setdefault(period, SampleConverter(inputs.long_rows[period]))
        since = now - PERIODS[period]
        found = period_availability(converter.points(ref), since, now, state.interval_seconds, own_excluded)
        cycle.shared.store_long(key, now, found)
    return found


def project_page(inputs: PageInputs, audience: Audience, cycle: BuildCycle) -> PagePayload:
    page, now, refs, states = inputs.page, inputs.now, inputs.refs, inputs.states
    start, end = _bounds(page, now)
    windows, excluded = inputs.windows, inputs.excluded
    converters: dict = {}

    by_group: dict[int, list[dict]] = defaultdict(list)
    item_states: dict[int, ItemState] = {}
    for item in inputs.items:
        ref, extras, state = refs[item.id], item.extras or {}, states[refs[item.id]]
        own = cycle.samples(ref, start, now)
        own_excluded = excluded.get(ref.key, [])
        memo_key = (ref, start, now, state.interval_seconds, tuple(own_excluded))
        spans, found, heartbeats = cycle.memo(("window", *memo_key), lambda: _window(own, start, end, now, state, own_excluded))
        item_states[item.id] = item_state(state, ref in inputs.degraded, any(a <= now < b for a, b in own_excluded), now)
        by_group[item.group_id].append({
            "id": item.id,
            "name": item.display_name,
            "state": item_states[item.id],
            "availability": {
                "percent": _round(found.percent, 4), "label": found.label, "coverage": _round(found.coverage, 4),
            },
            "heartbeats": list(heartbeats),
            "response": (
                list(cycle.memo(("response", *memo_key), lambda: [_round(v) for v in response_slots(own, start, end, own_excluded, SLOTS)]))
                if extras.get("rtt_graph") else None
            ),
            "metrics": _metrics(
                extras, own, start, now, state, _period(inputs, cycle, ref, extras.get("uptime_period"), end, converters),
                own_excluded,
            ),
            "incident_ids": [],
        })

    local = PageLocal({refs[item.id].key: item_states[item.id] for item in inputs.items}, len(inputs.items))
    open_incidents, past = [], []
    by_source: dict[str, list[int]] = defaultdict(list)
    for loaded in inputs.incidents:
        projected = project_incident(loaded, page, audience, local)
        if projected is None:
            continue
        if projected["status"] == "resolved":
            past.append({"kind": "incident", **projected})
            continue
        open_incidents.append(projected)
        for key in loaded.sources.get(page.id, []):
            by_source[key].append(projected["id"])
    announced = [w for w in windows if page.id in w.page_ids]
    listed = [w for w in announced if w.start - maintenance.UPCOMING_LEAD <= now < w.end]
    finished = [w for w in announced if now - PAST_WINDOW < w.end <= now]
    past += [_past_window(w) for w in finished]
    past.sort(key=lambda p: p["resolved_at"] if p["kind"] == "incident" else p["ends_at"], reverse=True)
    edges = [edge for w in windows for edge in (w.start, w.end)]
    edges += [edge for w in announced for edge in (w.start - maintenance.UPCOMING_LEAD, w.end + PAST_WINDOW)]
    for group_items in by_group.values():
        for entry in group_items:
            entry["incident_ids"] = sorted(by_source.get(refs[entry["id"]].key, []))
    notices = inputs.notices
    critical = any(n.level == "critical" for n in notices)
    age_outs = [datetime.fromisoformat(p["resolved_at"]) + PAST_WINDOW for p in past if p["kind"] == "incident"]

    counts = {"operational": 0, "degraded": 0, "down": 0, "maintenance": 0, "unknown": 0}
    for value in item_states.values():
        counts[value] += 1
    state, label = summarize(list(item_states.values()), critical)
    return {
        "slug": page.slug,
        "title": page.title or page.name,
        "accent": page.accent,
        "logo": page.logo,
        "heartbeat_window": page.heartbeat_window,
        "custom_css": (validate_css(page.custom_css).css or None) if page.custom_css else None,
        "generated_at": now.isoformat(),
        "valid_until": next_deadline(
            page, now, states.values(), [*(n.expires_at for n in notices if n.expires_at), *age_outs], edges,
        ).isoformat(),
        "summary": {"state": state, "label": label, "counts": counts},
        "notices": [
            {
                "id": n.id, "level": n.level, "title": n.title, "body": n.body, "link": n.link,
                "expires_at": _utc(n.expires_at).isoformat() if n.expires_at else None,
            }
            for n in notices
        ],
        "incidents": open_incidents,
        "maintenance": [_window_entry(w, now) for w in sorted(listed, key=lambda w: (w.start, w.window.id))],
        "past": past,
        "groups": [
            {
                "id": group.id,
                "name": group.name,
                "state": summarize([i["state"] for i in by_group[group.id]], False)[0],
                "collapsed": group.collapsed_by_default,
                "items": by_group[group.id],
            }
            for group in inputs.groups
        ],
    }


def _window(samples: list[Sample], start: datetime, end: datetime, now: datetime, state: CurrentState, excluded: list):
    spans = build_spans(samples, start, now, state.interval_seconds, excluded)
    return spans, availability(spans, start, now), tuple(heartbeat_slots(spans, start, end, SLOTS))


def build_page_payload(
    db: Session, page: StatusPage, audience: Audience, now: datetime, cycle: BuildCycle | None = None,
) -> PagePayload:
    cycle = cycle or SourceHistory().cycle()
    return project_page(load_page(db, page, now, cycle), audience, cycle)

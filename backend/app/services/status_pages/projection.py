from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Literal, TypedDict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.status_page import StatusPage, StatusPageGroup, StatusPageItem
from app.services.status_pages.history import (
    availability,
    build_spans,
    failure_rate,
    heartbeat_slots,
    load_samples,
    p95,
    response_slots,
    window_samples,
)
from app.services.status_pages.sources import (
    CurrentState,
    ItemState,
    SourceRef,
    _utc,
    item_state,
    load_current_states,
    threshold_breaching_sources,
)

Audience = Literal["public", "private"]
SummaryState = Literal["empty", "major", "affected", "unknown", "maintenance", "operational"]

WINDOWS = {"1h": timedelta(hours=1), "24h": timedelta(hours=24)}
PERIODS = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}
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


def next_deadline(
    page: StatusPage,
    now: datetime,
    states: Iterable[CurrentState],
    notice_expiries: Iterable[datetime] = (),
    maintenance_edges: Iterable[datetime] = (),
) -> datetime:
    now = _utc(now)
    width = _slot_width(page).total_seconds()
    elapsed = now.timestamp()
    boundary = now + timedelta(seconds=width - elapsed % width)
    candidates = [now + MAX_VALIDITY, boundary]
    candidates += [s.fresh_until for s in states if s.fresh_until is not None]
    candidates += [_utc(d) for d in (*notice_expiries, *maintenance_edges)]
    return min(c for c in candidates if c > now)


def _metrics(extras: dict, samples, start, now, state: CurrentState, period_samples) -> dict | None:
    metrics: dict = {}
    window = window_samples(samples, start, now, [])
    values = [s.response_ms for s in window if s.ok and s.response_ms is not None]
    if extras.get("avg_response"):
        metrics["avg_response"] = sum(values) / len(values) if values else None
    if extras.get("p95_response"):
        metrics["p95_response"] = p95(values)
    if extras.get("failure_rate"):
        metrics["failure_rate"] = failure_rate(samples, start, now, [])
    if extras.get("last_check"):
        metrics["last_check"] = state.observed_at.isoformat() if state.observed_at else None
    period = extras.get("uptime_period")
    if period in PERIODS:
        p_start = now - PERIODS[period]
        spans = build_spans(period_samples, p_start, now, state.interval_seconds, [])
        found = availability(spans, p_start, now)
        metrics["uptime_period"] = {
            "period": period, "percent": found.percent, "label": found.label, "coverage": found.coverage,
        }
    return metrics or None


def build_page_payload(db: Session, page: StatusPage, audience: Audience, now: datetime) -> PagePayload:
    now = _utc(now)
    window = WINDOWS[page.heartbeat_window]
    start = now - window
    groups = list(db.scalars(
        select(StatusPageGroup).where(StatusPageGroup.page_id == page.id).order_by(StatusPageGroup.sort_order, StatusPageGroup.id)
    ))
    items = list(db.scalars(
        select(StatusPageItem).where(StatusPageItem.page_id == page.id).order_by(StatusPageItem.sort_order, StatusPageItem.id)
    ))
    refs = {item.id: SourceRef.from_item(item) for item in items}
    states = load_current_states(db, refs.values(), now)
    degraded = threshold_breaching_sources(db, refs.values(), now)

    lengths: dict[timedelta, set[SourceRef]] = defaultdict(set)
    for item in items:
        lengths[window].add(refs[item.id])
        period = (item.extras or {}).get("uptime_period")
        if period in PERIODS:
            lengths[PERIODS[period]].add(refs[item.id])
    samples = {length: load_samples(db, group_refs, now - length, now) for length, group_refs in lengths.items()}

    by_group: dict[int, list[dict]] = defaultdict(list)
    item_states: dict[int, ItemState] = {}
    for item in items:
        ref, extras, state = refs[item.id], item.extras or {}, states[refs[item.id]]
        own = samples[window][ref]
        spans = build_spans(own, start, now, state.interval_seconds, [])
        found = availability(spans, start, now)
        period = extras.get("uptime_period")
        period_samples = samples[PERIODS[period]][ref] if period in PERIODS else []
        item_states[item.id] = item_state(state, ref in degraded, False, now)
        by_group[item.group_id].append({
            "id": item.id,
            "name": item.display_name,
            "state": item_states[item.id],
            "availability": {"percent": found.percent, "label": found.label, "coverage": found.coverage},
            "heartbeats": heartbeat_slots(spans, start, now, SLOTS),
            "response": response_slots(own, start, now, [], SLOTS) if extras.get("rtt_graph") else None,
            "metrics": _metrics(extras, own, start, now, state, period_samples),
            "incident_ids": [],
        })

    counts = {"operational": 0, "degraded": 0, "down": 0, "maintenance": 0, "unknown": 0}
    for value in item_states.values():
        counts[value] += 1
    state, label = summarize(list(item_states.values()), False)
    return {
        "slug": page.slug,
        "title": page.title or page.name,
        "accent": page.accent,
        "logo": page.logo,
        "heartbeat_window": page.heartbeat_window,
        "custom_css": None,
        "generated_at": now.isoformat(),
        "valid_until": next_deadline(page, now, states.values()).isoformat(),
        "summary": {"state": state, "label": label, "counts": counts},
        "notices": [],
        "incidents": [],
        "maintenance": [],
        "past": [],
        "groups": [
            {
                "id": group.id,
                "name": group.name,
                "state": summarize([i["state"] for i in by_group[group.id]], False)[0],
                "collapsed": group.collapsed_by_default,
                "items": by_group[group.id],
            }
            for group in groups
        ],
    }

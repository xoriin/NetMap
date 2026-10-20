import json
import random
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event, insert, update
from sqlalchemy.orm import Session, sessionmaker

from app.models.monitor_history import DeviceMonitorHistory
from app.models.status_page import StatusPage, StatusPageItem
from app.models.system_setting import SystemSetting
from app.services.status_pages import aggregates
from app.services.status_pages import cache as cache_module
from app.services.status_pages.cache import StatusSnapshotCache
from app.services.status_pages.history import Sample, availability, build_spans, period_availability
from app.services.status_pages.projection import build_page_payload
from app.services.status_pages.sources import SourceRef
from tests.status_page_helpers import make_engine, seed_device, seed_page

NOW = datetime(2026, 10, 17, 12, 0, 30, tzinfo=timezone.utc)
DAYS = 30


@pytest.fixture
def factory():
    return sessionmaker(bind=make_engine(), autoflush=False, expire_on_commit=False)


@pytest.fixture
def cache(factory, monkeypatch):
    monkeypatch.setattr(cache_module, "SessionLocal", factory)
    instance = StatusSnapshotCache()
    yield instance
    instance.stop()


def _devices(factory, count, minutes=DAYS * 1440):
    with factory() as db:
        db.add(SystemSetting(key="monitor_interval_seconds", value="60"))
        db.commit()
        ids = [seed_device(db, monitor_status="online", last_monitored_at=NOW - timedelta(seconds=20)).id for _ in range(count)]
    with factory() as db:
        for device_id in ids:
            db.execute(insert(DeviceMonitorHistory), [
                dict(device_id=device_id, checked_at=NOW - timedelta(minutes=minutes - k), status="online",
                     expected_status="online", is_healthy=k % 13 != 0, rtt_ms=1.0 + k % 5, port_results="[]")
                for k in range(minutes)
            ])
        db.commit()
    return ids


def _page(factory, slug, ids, period="30d", window="24h"):
    with factory() as db:
        page = seed_page(db, slug, items=[(SourceRef("device", device_id=i), f"D{n}") for n, i in enumerate(ids)])
        page.heartbeat_window = window
        for item in db.query(StatusPageItem).filter_by(page_id=page.id):
            item.extras = {"rtt_graph": True, "avg_response": True, "uptime_period": period}
        db.commit()
        return page.id


class _Counter:
    def __init__(self, engine):
        self.statements: list[str] = []
        event.listen(engine, "before_cursor_execute", self._record)

    def _record(self, conn, cursor, statement, *args):
        self.statements.append(statement)

    @property
    def history(self) -> int:
        return sum("device_monitor_history" in s or "monitor_check_history" in s for s in self.statements)

    def reset(self) -> None:
        self.statements.clear()


def _rows(monkeypatch):
    fetched = []
    real = aggregates.fetch_history

    def counted(db, refs, start, end, **kw):
        before = kw["raw"].rows if kw.get("raw") is not None else 0
        raw = real(db, refs, start, end, **kw)
        fetched.append((end - start, raw.rows - before))
        return raw

    monkeypatch.setattr(aggregates, "fetch_history", counted)
    return fetched


def _build(cache, page_ids, now=NOW):
    cache.load_registry()
    cache._queue.clear()
    for page_id in page_ids:
        cache._queue[page_id] = None
    cache.drain(now=now)
    return {page_id: json.loads(cache.get(page_id, "public", now).body) for page_id in page_ids}


def test_pages_sharing_sources_scan_their_history_once_per_build_cycle(cache, factory, monkeypatch):
    ids = _devices(factory, 4)
    one = _page(factory, "one", ids)
    two = _page(factory, "two", ids)
    counter = _Counter(factory.kw["bind"])
    fetched = _rows(monkeypatch)
    _build(cache, [one])
    single, single_rows = counter.history, sum(rows for _, rows in fetched)

    shared = StatusSnapshotCache()
    counter.reset()
    fetched.clear()
    _build(shared, [one, two])
    assert counter.history == single
    assert sum(rows for _, rows in fetched) == single_rows
    assert single_rows <= 4 * (DAYS * 1440 + 24 * 60 + 4)


def test_statement_count_does_not_grow_with_item_count(cache, factory):
    ids = _devices(factory, 12, minutes=90)
    small = _page(factory, "small", ids[:2])
    large = _page(factory, "large", ids)
    counter = _Counter(factory.kw["bind"])
    _build(cache, [small])
    few = len(counter.statements)
    counter.reset()
    _build(StatusSnapshotCache(), [large])
    assert len(counter.statements) == few


def test_long_period_reused_for_five_minutes_then_refreshed(cache, factory, monkeypatch):
    ids = _devices(factory, 2)
    page_id = _page(factory, "media", ids)
    fetched = _rows(monkeypatch)
    _build(cache, [page_id])
    assert sorted(length > timedelta(days=29) for length, _ in fetched) == [False, True]

    fetched.clear()
    _build(cache, [page_id], NOW + timedelta(minutes=4))
    assert all(length < timedelta(days=2) for length, _ in fetched)

    fetched.clear()
    _build(cache, [page_id], NOW + aggregates.LONG_REFRESH + aggregates.LONG_JITTER)
    assert any(length > timedelta(days=29) and rows for length, rows in fetched)


def test_maintenance_change_invalidates_long_period(cache, factory, monkeypatch):
    from app.models.status_page import StatusMaintenance, StatusMaintenanceItem

    ids = _devices(factory, 1)
    with factory() as db:
        db.execute(
            update(DeviceMonitorHistory)
            .where(DeviceMonitorHistory.checked_at >= NOW - timedelta(days=3), DeviceMonitorHistory.checked_at < NOW - timedelta(days=2))
            .values(is_healthy=False, status="offline")
        )
        db.commit()
    page_id = _page(factory, "media", ids)
    first = _build(cache, [page_id])[page_id]
    with factory() as db:
        window = StatusMaintenance(
            title="Swap", starts_at=NOW - timedelta(days=3), ends_at=NOW - timedelta(days=2), suppress_alerts=True,
        )
        db.add(window)
        db.flush()
        db.add(StatusMaintenanceItem(maintenance_id=window.id, kind="device", device_id=ids[0]))
        db.commit()
    fetched = _rows(monkeypatch)
    second = _build(cache, [page_id], NOW + timedelta(minutes=1))[page_id]
    assert any(length > timedelta(days=29) for length, _ in fetched)
    before = first["groups"][0]["items"][0]["metrics"]["uptime_period"]
    after = second["groups"][0]["items"][0]["metrics"]["uptime_period"]
    assert after["percent"] > before["percent"]


def test_cached_and_fresh_aggregates_give_identical_payloads(cache, factory):
    ids = _devices(factory, 3)
    one = _page(factory, "one", ids)
    two = _page(factory, "two", ids[::-1], period="7d", window="1h")
    three = _page(factory, "three", ids, period="7d")
    built = _build(cache, [one, two, three])
    rebuilt = _build(cache, [three, two, one])
    with factory() as db:
        for page_id in (one, two, three):
            fresh = build_page_payload(db, db.get(StatusPage, page_id), "public", NOW)
            assert built[page_id] == rebuilt[page_id] == json.loads(json.dumps(fresh))


def _uptimes(payload):
    return [item["metrics"]["uptime_period"] for group in payload["groups"] for item in group["items"]]


def test_long_periods_do_not_depend_on_heartbeat_window_or_build_order(cache, factory):
    ids = _devices(factory, 2, minutes=8 * 1440)
    with factory() as db:
        db.execute(
            update(DeviceMonitorHistory)
            .where(DeviceMonitorHistory.checked_at >= NOW - timedelta(days=7, minutes=30),
                   DeviceMonitorHistory.checked_at < NOW - timedelta(days=7) + timedelta(minutes=5))
            .values(is_healthy=False, status="offline")
        )
        db.commit()
    hour = _page(factory, "hour", ids, period="7d", window="1h")
    day = _page(factory, "day", ids, period="7d", window="24h")
    for builder, order in ((cache, [hour, day]), (StatusSnapshotCache(), [day, hour])):
        built = _build(builder, order)
        with factory() as db:
            for page_id in order:
                fresh = build_page_payload(db, db.get(StatusPage, page_id), "public", NOW)
                assert _uptimes(built[page_id]) == _uptimes(json.loads(json.dumps(fresh)))
        assert _uptimes(built[hour]) == _uptimes(built[day])


def test_page_session_is_closed_before_projection(cache, factory, monkeypatch):
    ids = _devices(factory, 1, minutes=60)
    page_id = _page(factory, "media", ids)
    opened = [0]

    class Counted(Session):
        def __enter__(self):
            opened[0] += 1
            return super().__enter__()

        def __exit__(self, *exc):
            opened[0] -= 1
            return super().__exit__(*exc)

    monkeypatch.setattr(cache_module, "SessionLocal", sessionmaker(bind=factory.kw["bind"], class_=Counted, autoflush=False))
    seen = []
    real = cache_module.project_page
    monkeypatch.setattr(cache_module, "project_page", lambda *a: (seen.append(opened[0]), real(*a))[1])
    _build(cache, [page_id])
    assert seen == [0]


def _random_points(rng, start, end):
    at, points = start - timedelta(minutes=rng.randint(0, 30)), []
    while at < end + timedelta(minutes=5):
        points.append((at, rng.choice(["healthy", "healthy", "healthy", "unhealthy", "unknown"])))
        at += timedelta(seconds=rng.choice([1, 30, 60, 60, 61, 90, 400, 3600]), microseconds=rng.randint(0, 999999))
    return points


def test_long_period_maths_match_span_maths_exactly():
    rng = random.Random(7)
    end = NOW
    for _ in range(40):
        start = end - timedelta(days=rng.choice([1, 7]))
        points = _random_points(rng, start, end)
        windows = []
        for _ in range(rng.randint(0, 4)):
            a = start + timedelta(seconds=rng.randint(-3600, int((end - start).total_seconds())))
            windows.append((a, a + timedelta(seconds=rng.randint(1, 40000))))
        interval = rng.choice([30, 60, 300])
        samples = [Sample(at, health, None, health == "healthy") for at, health in points]
        assert period_availability(points, start, end, interval, windows) == availability(
            build_spans(samples, start, end, interval, windows), start, end,
        )


def _long_fetches(monkeypatch):
    refreshed = []
    real = aggregates.BuildCycle.fetch_long

    def counted(self, db, refs, start, end):
        refs = list(refs)
        refreshed.append(len(refs))
        return real(self, db, refs, start, end)

    monkeypatch.setattr(aggregates.BuildCycle, "fetch_long", counted)
    return refreshed


def _stale_at():
    return NOW + aggregates.LONG_REFRESH + aggregates.LONG_JITTER


def test_stale_long_period_is_served_while_its_refresh_waits_for_budget(cache, factory, monkeypatch):
    ids = _devices(factory, 1)
    page_id = _page(factory, "media", ids)
    first = _uptimes(_build(cache, [page_id])[page_id])
    with factory() as db:
        db.execute(update(DeviceMonitorHistory).values(is_healthy=False, status="offline"))
        db.commit()
    monkeypatch.setattr(aggregates, "REFRESH_SOURCES_PER_CYCLE", 0)
    refreshed = _long_fetches(monkeypatch)
    assert _uptimes(_build(cache, [page_id], _stale_at())[page_id]) == first
    assert refreshed == []
    monkeypatch.setattr(aggregates, "REFRESH_SOURCES_PER_CYCLE", 4)
    assert _uptimes(_build(cache, [page_id], _stale_at())[page_id]) != first
    assert refreshed == [1]


def test_stale_refreshes_respect_the_per_cycle_source_and_time_budget(cache, factory, monkeypatch):
    ids = _devices(factory, 6, minutes=8 * 1440)
    page_id = _page(factory, "media", ids, period="7d")
    _build(cache, [page_id])
    refreshed = _long_fetches(monkeypatch)
    _build(cache, [page_id], _stale_at())
    assert refreshed == [aggregates.REFRESH_SOURCES_PER_CYCLE]
    _build(cache, [page_id], _stale_at() + timedelta(seconds=1))
    assert refreshed == [aggregates.REFRESH_SOURCES_PER_CYCLE, 6 - aggregates.REFRESH_SOURCES_PER_CYCLE]

    cycle = aggregates.SourceHistory().cycle()
    monkeypatch.setattr(aggregates, "REFRESH_SECONDS_PER_CYCLE", 0.25)
    cycle.refresh_seconds = 0.25
    assert cycle.claim_refresh(("device:1", "30d", 60, ())) is False


def test_hard_cap_forces_a_recompute_even_without_budget(cache, factory, monkeypatch):
    ids = _devices(factory, 1)
    page_id = _page(factory, "media", ids)
    _build(cache, [page_id])
    monkeypatch.setattr(aggregates, "REFRESH_SOURCES_PER_CYCLE", 0)
    refreshed = _long_fetches(monkeypatch)
    _build(cache, [page_id], NOW + aggregates.LONG_HARD_CAP - timedelta(seconds=1))
    assert refreshed == []
    _build(cache, [page_id], NOW + aggregates.LONG_HARD_CAP)
    assert refreshed == [1]


def test_refresh_deadlines_are_jittered_deterministically():
    keys = [(f"device:{n}", "30d", 60, ()) for n in range(50)]
    history = aggregates.SourceHistory(seed=7)
    jitters = [history.jitter(key) for key in keys]
    assert all(timedelta(0) <= j < aggregates.LONG_JITTER for j in jitters)
    assert len(set(jitters)) > 40
    assert max(jitters) - min(jitters) > aggregates.LONG_JITTER / 2
    assert jitters == [aggregates.SourceHistory(seed=7).jitter(key) for key in keys]
    assert jitters != [aggregates.SourceHistory(seed=8).jitter(key) for key in keys]
    for key in keys[:3]:
        history.store_long(key, NOW, None)
        assert history.long(key, NOW).refresh_at == NOW + aggregates.LONG_REFRESH + history.jitter(key)

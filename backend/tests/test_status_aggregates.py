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


@pytest.fixture(autouse=True)
def count_only_inline_budget(monkeypatch):
    monkeypatch.setattr(aggregates, "FIRST_BUILD_SECONDS_PER_CYCLE", 600.0)


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


def _settle(cache, now=NOW):
    while cache.refresh_long(now):
        pass


def _built(cache, page_ids, now=NOW):
    _build(cache, page_ids, now)
    _settle(cache, now)
    return _build(cache, page_ids, now)


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
    small = _page(factory, "small", ids[:2], period="24h")
    large = _page(factory, "large", ids, period="24h")
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
    assert sorted(length > timedelta(days=29) for length, _ in fetched) == [False, True, True]

    fetched.clear()
    _build(cache, [page_id], NOW + timedelta(minutes=4))
    assert all(length < timedelta(days=2) for length, _ in fetched)

    stale = NOW + aggregates.LONG_REFRESH + aggregates.LONG_JITTER
    fetched.clear()
    _build(cache, [page_id], stale)
    assert all(length < timedelta(days=2) for length, _ in fetched)
    _settle(cache, stale)
    assert sorted(length > timedelta(days=29) and rows > 0 for length, rows in fetched).count(True) == 2


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
    built = _built(cache, [one, two, three])
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
        built = _built(builder, order)
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
    real = aggregates.fetch_history

    def counted(db, refs, start, end, **kw):
        refs = list(refs)
        if kw.get("health_only"):
            refreshed.append([r.device_id for r in refs])
        return real(db, refs, start, end, **kw)

    monkeypatch.setattr(aggregates, "fetch_history", counted)
    return refreshed


def _stale_at():
    return NOW + aggregates.LONG_REFRESH + aggregates.LONG_JITTER


def test_builds_compute_only_capped_first_build_work_and_never_refresh_inline(cache, factory, monkeypatch):
    ids = _devices(factory, 10, minutes=8 * 1440)
    page_id = _page(factory, "media", ids, period="7d")
    refreshed = _long_fetches(monkeypatch)
    first = _build(cache, [page_id])[page_id]
    assert len(refreshed) == aggregates.FIRST_BUILD_SOURCES_PER_CYCLE
    labels = [u["label"] for u in _uptimes(first)]
    assert labels.count("no_data") == 10 - aggregates.FIRST_BUILD_SOURCES_PER_CYCLE

    refreshed.clear()
    _build(cache, [page_id])
    assert len(refreshed) == aggregates.FIRST_BUILD_SOURCES_PER_CYCLE
    _settle(cache)
    refreshed.clear()
    for later in (NOW, _stale_at(), NOW + aggregates.LONG_HARD_CAP + timedelta(minutes=1)):
        _build(cache, [page_id], later)
        assert refreshed == []


def test_deferred_first_build_values_are_filled_by_the_refresher_and_the_page_rebuilt(cache, factory, monkeypatch):
    ids = _devices(factory, 6, minutes=8 * 1440)
    page_id = _page(factory, "media", ids, period="7d")
    _build(cache, [page_id])
    assert cache.pending() == []
    _settle(cache)
    assert cache.pending() == [page_id]
    rebuilt = _build(cache, [page_id])[page_id]
    assert all(u["label"] != "no_data" for u in _uptimes(rebuilt))


def test_stale_long_period_is_served_until_the_refresher_replaces_it(cache, factory, monkeypatch):
    ids = _devices(factory, 1)
    page_id = _page(factory, "media", ids)
    first = _uptimes(_build(cache, [page_id])[page_id])
    with factory() as db:
        db.execute(update(DeviceMonitorHistory).values(is_healthy=False, status="offline"))
        db.commit()
    refreshed = _long_fetches(monkeypatch)
    assert _uptimes(_build(cache, [page_id], _stale_at())[page_id]) == first
    assert refreshed == []
    assert cache.refresh_long(_stale_at()) is True
    assert refreshed == [ids]
    assert cache.pending() == [page_id]
    assert _uptimes(_build(cache, [page_id], _stale_at())[page_id]) != first


def test_refresh_that_changes_nothing_rebuilds_no_page(cache, factory, monkeypatch):
    ids = _devices(factory, 2, minutes=8 * 1440)
    one = _page(factory, "one", ids[:1], period="7d")
    two = _page(factory, "two", ids[1:], period="7d")
    _build(cache, [one, two])

    def compute(fetch, ref, key, length, now):
        if ref.device_id == ids[1]:
            return cache.history.long(key, now).value
        return aggregates.PENDING

    monkeypatch.setattr(aggregates, "compute_long", compute)
    _settle(cache, _stale_at())
    assert cache.pending() == [one]


def _recording_compute(mp, order, failing=()):
    def compute(fetch, ref, key, length, now):
        order.append(ref.device_id)
        if ref.device_id in failing:
            raise RuntimeError("boom")
        return aggregates.PENDING

    mp.setattr(aggregates, "compute_long", compute)


def test_refresher_drains_never_computed_first_then_oldest_due_with_jitter(monkeypatch):
    history = aggregates.SourceHistory(seed=3)
    week = timedelta(days=7)
    refs = [SourceRef("device", device_id=n) for n in range(1, 9)]
    keys = {ref: (ref.key, "7d", 60, ()) for ref in refs}
    for n, ref in enumerate(refs):
        at = NOW + timedelta(minutes=2 * (n % 4))
        history.long(keys[ref], at, ref, week)
        history.store_long(keys[ref], at, aggregates.PENDING)
    later = NOW + timedelta(minutes=20)
    history.long(("device:99", "7d", 60, ()), later, SourceRef("device", device_id=99), week)
    due = {ref.device_id: history.long(keys[ref], later).refresh_at for ref in refs}
    assert len(set(due.values())) == 8
    order = []
    _recording_compute(monkeypatch, order)
    while history.refresh_once(later, lambda: None):
        pass
    assert order == [99, *sorted(due, key=due.get)]


def test_failing_refresh_is_retried_later_without_blocking_the_rest(monkeypatch):
    history = aggregates.SourceHistory()
    for n in (1, 2):
        history.long((f"device:{n}", "7d", 60, ()), NOW, SourceRef("device", device_id=n), timedelta(days=7))
    order = []
    _recording_compute(monkeypatch, order, failing={1})
    with pytest.raises(RuntimeError):
        history.refresh_once(NOW, lambda: None)
    assert history.refresh_once(NOW, lambda: None) is True
    assert history.refresh_once(NOW, lambda: None) is False
    with pytest.raises(RuntimeError):
        history.refresh_once(NOW + aggregates.LONG_RETRY, lambda: None)
    assert order == [1, 2, 1]


def test_value_past_the_hard_cap_is_served_flagged_and_warned(cache, factory, monkeypatch, caplog):
    ids = _devices(factory, 1)
    page_id = _page(factory, "media", ids)
    first = _uptimes(_build(cache, [page_id])[page_id])
    refreshed = _long_fetches(monkeypatch)
    capped = NOW + aggregates.LONG_HARD_CAP + timedelta(seconds=1)
    with factory() as db:
        before = cache.history.cycle()
        build_page_payload(db, db.get(StatusPage, page_id), "public", NOW + timedelta(minutes=1), before)
        cycle = cache.history.cycle()
        payload = json.loads(json.dumps(build_page_payload(db, db.get(StatusPage, page_id), "public", capped, cycle)))
    assert before.overdue == set()
    assert _uptimes(payload) == first
    assert len(cycle.overdue) == 1 and refreshed == []
    caplog.set_level("WARNING")
    assert cache.refresh_long(capped)
    assert "refresh is behind" in caplog.text and "1 past the 15-minute cap" in caplog.text


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


def test_long_period_rows_are_fetched_one_source_at_a_time_in_short_sessions(cache, factory, monkeypatch):
    ids = _devices(factory, 5, minutes=8 * 1440)
    page_id = _page(factory, "media", ids, period="7d")
    fetched = _rows(monkeypatch)
    opened = []
    real = factory

    def counting():
        opened.append(1)
        return real()

    monkeypatch.setattr(cache_module, "SessionLocal", counting)
    _build(cache, [page_id])
    _settle(cache)
    long_fetches = [rows for length, rows in fetched if length > timedelta(days=6)]
    assert len(long_fetches) == 5
    assert max(long_fetches) <= 8 * 1440 + 1
    assert len(opened) >= 1 + 5

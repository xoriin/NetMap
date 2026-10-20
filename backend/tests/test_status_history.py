import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import event

from app.models.monitor import MonitorCheckHistory
from app.models.monitor_history import DeviceMonitorHistory
from app.services.status_pages.history import (
    Availability,
    Sample,
    Span,
    availability,
    build_spans,
    failure_rate,
    heartbeat_slots,
    load_samples,
    p95,
    response_slots,
)
from app.services.status_pages.sources import SourceRef
from tests.status_page_helpers import make_session, seed_device, seed_monitor, seed_service_check

START = datetime(2026, 1, 1, 11, 0, tzinfo=timezone.utc)
END = START + timedelta(hours=1)


def _t(minutes=0.0, seconds=0.0):
    return START + timedelta(minutes=minutes, seconds=seconds)


def _s(at, health="healthy", response_ms=None):
    return Sample(at, health, response_ms, health == "healthy")


def _span(a, b, health):
    return Span(_t(a), _t(b), health)


def test_preceding_sample_covers_window_start():
    samples = [_s(_t(-2)), _s(_t(30), "unhealthy")]
    spans = build_spans(samples, START, END, 3600, [])
    assert spans == [Span(START, _t(30), "healthy"), Span(_t(30), END, "unhealthy")]


def test_gap_longer_than_freshness_is_unknown_not_green():
    spans = build_spans([_s(_t(0)), _s(_t(50))], START, END, 60, [])
    assert spans == [
        Span(START, _t(2), "healthy"),
        Span(_t(2), _t(50), "unknown"),
        Span(_t(50), _t(52), "healthy"),
        Span(_t(52), END, "unknown"),
    ]


def test_time_before_first_sample_is_unknown():
    spans = build_spans([_s(_t(10))], START, END, 3600, [])
    assert spans[0] == Span(START, _t(10), "unknown")
    assert spans[1] == Span(_t(10), END, "healthy")


def test_maintenance_overrides_health_and_is_clipped_to_window():
    maintenance = [(_t(-10), _t(10)), (_t(50), _t(70))]
    spans = build_spans([_s(_t(0))], START, END, 3600, maintenance)
    assert spans == [
        Span(START, _t(10), "maintenance"),
        Span(_t(10), _t(50), "healthy"),
        Span(_t(50), END, "maintenance"),
    ]


def test_availability_excludes_unknown_and_maintenance():
    spans = [
        _span(0, 30, "healthy"),
        _span(30, 45, "unhealthy"),
        _span(45, 60, "maintenance"),
    ]
    a = availability(spans, START, END)
    assert round(a.percent, 4) == 0.6667
    assert a.coverage == 1.0
    assert a.label == "ok"


def test_unknown_time_lowers_coverage_not_percent():
    spans = [_span(0, 27, "healthy"), _span(27, 30, "unhealthy"), _span(30, 60, "unknown")]
    a = availability(spans, START, END)
    assert a.coverage == 0.5
    assert a.label == "insufficient"
    assert a.percent is None


def test_coverage_below_90_percent_is_insufficient():
    spans = [_span(0, 53, "healthy"), _span(53, 60, "unknown")]
    a = availability(spans, START, END)
    assert round(a.coverage, 4) == 0.8833
    assert a.label == "insufficient"


def test_coverage_at_exactly_90_percent_is_ok():
    spans = [_span(0, 54, "healthy"), _span(54, 60, "unknown")]
    a = availability(spans, START, END)
    assert a.coverage == 0.9
    assert a.label == "ok"


def test_no_eligible_duration_is_no_data():
    all_maintenance = availability([_span(0, 60, "maintenance")], START, END)
    assert all_maintenance == Availability(None, 0.0, "no_data")
    all_unknown = availability([_span(0, 60, "unknown")], START, END)
    assert all_unknown.percent is None
    assert all_unknown.coverage == 0.0
    assert all_unknown.label == "no_data"
    assert availability([], START, START) == Availability(None, 0.0, "no_data")


def test_percent_is_not_slot_count():
    samples = [_s(_t(0)), _s(_t(30), "unhealthy"), _s(_t(30, 5))]
    spans = build_spans(samples, START, END, 3600, [])
    assert heartbeat_slots(spans, START, END).count("unhealthy") == 1
    a = availability(spans, START, END)
    assert round(a.percent, 5) == 0.99861
    assert a.percent != 59 / 60


def test_thirty_day_window_with_ten_days_history_is_insufficient():
    start = START - timedelta(days=30)
    history_from = START - timedelta(days=10)
    spans = build_spans([_s(history_from)], start, START, 30 * 86400, [])
    a = availability(spans, start, START)
    assert round(a.coverage, 4) == 0.3333
    assert a.percent is None
    assert a.label == "insufficient"


def test_p95_nearest_rank():
    assert p95([float(i) for i in range(1, 21)]) == 19.0
    assert p95([5.0]) == 5.0
    assert p95([3.0, 1.0, 2.0]) == 3.0
    assert p95([]) is None


def test_heartbeat_slots_worst_known_wins_then_unknown_then_maintenance():
    spans = [
        _span(0, 1, "healthy"),
        _span(1, 2, "unhealthy"),
        _span(2, 3, "unknown"),
        _span(3, 4, "healthy"),
        _span(4, 4.5, "maintenance"),
        _span(4.5, 5, "unknown"),
        _span(5, 6, "maintenance"),
        _span(6, 60, "healthy"),
    ]
    slots = heartbeat_slots(spans, START, END)
    assert len(slots) == 60
    assert slots[:6] == ["healthy", "unhealthy", "unknown", "healthy", "unknown", "maintenance"]
    assert set(slots[6:]) == {"healthy"}


def test_heartbeat_slot_with_maintenance_and_known_health_shows_health():
    spans = [Span(START, _t(0, 30), "maintenance"), Span(_t(0, 30), _t(1), "unhealthy"), _span(1, 60, "healthy")]
    assert heartbeat_slots(spans, START, END)[0] == "unhealthy"


def test_mixed_slot_has_red_beat_and_response_value():
    samples = [
        _s(_t(0, 10), "healthy", 20.0),
        _s(_t(0, 20), "unhealthy"),
        _s(_t(0, 30), "healthy", 40.0),
        _s(_t(2, 10), "unhealthy"),
    ]
    spans = build_spans(samples, START, END, 20, [])
    assert heartbeat_slots(spans, START, END)[0] == "unhealthy"
    graph = response_slots(samples, START, END, [])
    assert graph[0] == 30.0
    assert graph[1] is None
    assert graph[2] is None
    assert len(graph) == 60


def test_response_slots_ignore_failed_invalid_and_maintenance_samples():
    samples = [
        _s(_t(0, 5), "healthy", 10.0),
        _s(_t(0, 10), "healthy", float("nan")),
        _s(_t(0, 15), "healthy", -4.0),
        _s(_t(0, 20), "unhealthy", 999.0),
        _s(_t(1, 5), "healthy", 50.0),
        _s(_t(2, 5), "healthy", 70.0),
        _s(_t(70), "healthy", 1.0),
    ]
    graph = response_slots(samples, START, END, [(_t(2), _t(3))])
    assert graph[0] == 10.0
    assert graph[1] == 50.0
    assert graph[2] is None


def test_failure_rate_counts_failed_over_completed_known_checks():
    samples = [
        _s(_t(-5), "unhealthy"),
        _s(_t(1), "healthy"),
        _s(_t(2), "unhealthy"),
        _s(_t(3), "unknown"),
        _s(_t(4), "healthy"),
        _s(_t(5), "unhealthy"),
        _s(_t(6), "healthy"),
        _s(_t(70), "unhealthy"),
    ]
    assert failure_rate(samples, START, END, [(_t(5), _t(5, 30))]) == 0.25
    assert failure_rate([_s(_t(3), "unknown")], START, END, []) is None
    assert failure_rate([], START, END, []) is None


def _count_selects(engine):
    statements = []

    def before(conn, cursor, statement, *a):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", before)
    return statements


def test_load_samples_monitor_uses_raw_status_with_preceding_sample():
    db = make_session()
    monitor = seed_monitor(db)
    for at, status, rt in [
        (_t(-90), "online", 5.0),
        (_t(-2), "offline", None),
        (_t(10), "online", 120.0),
        (_t(20), "weird", None),
        (_t(61), "online", 1.0),
    ]:
        db.add(MonitorCheckHistory(monitor_id=monitor.id, checked_at=at, status=status, response_time_ms=rt))
    db.commit()
    ref = SourceRef("monitor", monitor_id=monitor.id)
    got = load_samples(db, [ref], START, END)[ref]
    assert [(s.at, s.health, s.response_ms, s.ok) for s in got] == [
        (_t(-2), "unhealthy", None, False),
        (_t(10), "healthy", 120.0, True),
        (_t(20), "unknown", None, False),
    ]


def test_device_history_uses_stored_expected_state():
    db = make_session()
    device = seed_device(db, expected_status="online")
    db.add_all([
        DeviceMonitorHistory(device_id=device.id, checked_at=_t(-1), status="offline",
                             expected_status="offline", is_healthy=True, rtt_ms=None),
        DeviceMonitorHistory(device_id=device.id, checked_at=_t(5), status="online",
                             expected_status="offline", is_healthy=False, rtt_ms=3.5),
        DeviceMonitorHistory(device_id=device.id, checked_at=_t(6), status="error",
                             expected_status="online", is_healthy=None, rtt_ms=None),
    ])
    db.commit()
    ref = SourceRef("device", device_id=device.id)
    got = load_samples(db, [ref], START, END)[ref]
    assert [(s.health, s.response_ms) for s in got] == [("healthy", None), ("unhealthy", 3.5), ("unknown", None)]


def test_service_check_samples_come_from_matching_port_result_entry():
    db = make_session()
    device = seed_device(db)
    target = seed_service_check(db, device.id)
    other = seed_service_check(db, device.id, port=22, label="SSH")

    def row(at, results):
        db.add(DeviceMonitorHistory(device_id=device.id, checked_at=at, status="online",
                                    expected_status="online", is_healthy=True, rtt_ms=1.0,
                                    port_results=json.dumps(results)))

    row(_t(-30), [{"target_id": target.id, "open": True, "response_time_ms": 11.0}])
    row(_t(-5), [{"target_id": other.id, "open": False}])
    row(_t(5), [{"target_id": target.id, "open": False, "response_time_ms": None},
                {"target_id": other.id, "open": True, "response_time_ms": 7.0}])
    row(_t(10), [{"target_id": target.id, "open": True, "response_time_ms": 25.5}])
    row(_t(15), [])
    db.add(DeviceMonitorHistory(device_id=device.id, checked_at=_t(16), status="online",
                                expected_status="online", is_healthy=True, port_results="not json"))
    db.commit()
    ref = SourceRef("service_check", device_id=device.id, port_target_id=target.id)
    got = load_samples(db, [ref], START, END)[ref]
    assert [(s.at, s.health, s.response_ms) for s in got] == [
        (_t(-30), "healthy", 11.0),
        (_t(5), "unhealthy", None),
        (_t(10), "healthy", 25.5),
    ]


def test_load_samples_batches_one_query_per_kind_and_returns_empty_lists():
    db = make_session()
    monitors = [seed_monitor(db) for _ in range(3)]
    devices = [seed_device(db) for _ in range(3)]
    for m in monitors[:2]:
        db.add(MonitorCheckHistory(monitor_id=m.id, checked_at=_t(1), status="online", response_time_ms=2.0))
    for d in devices:
        db.add(DeviceMonitorHistory(device_id=d.id, checked_at=_t(1), status="online",
                                    expected_status="online", is_healthy=True, rtt_ms=1.0))
    db.commit()
    refs = [SourceRef("monitor", monitor_id=m.id) for m in monitors] + [SourceRef("device", device_id=d.id) for d in devices]
    statements = _count_selects(db.get_bind())
    out = load_samples(db, refs, START, END)
    history_selects = [s for s in statements if "monitor_check_history" in s or "device_monitor_history" in s]
    assert len(history_selects) <= 4
    assert set(out) == set(refs)
    assert out[refs[2]] == []
    assert len(out[refs[0]]) == 1 and len(out[refs[3]]) == 1


def test_load_samples_with_no_refs_runs_no_queries():
    db = make_session()
    assert load_samples(db, [], START, END) == {}


def test_insufficient_and_no_data_never_expose_a_percent():
    insufficient = availability([_span(0, 30, "healthy"), _span(30, 60, "unknown")], START, END)
    assert (insufficient.percent, insufficient.coverage, insufficient.label) == (None, 0.5, "insufficient")


def test_slots_with_window_not_divisible_by_slot_count():
    end = START + timedelta(seconds=100)
    spans = [Span(START, START + timedelta(seconds=99), "healthy"), Span(START + timedelta(seconds=99), end, "unhealthy")]
    slots = heartbeat_slots(spans, START, end, slots=60)
    assert len(slots) == 60
    assert slots[-1] == "unhealthy"
    assert slots[:-1].count("healthy") == 59
    samples = [_s(START + timedelta(seconds=99.5), "healthy", 9.0), _s(START, "healthy", 1.0)]
    graph = response_slots(samples, START, end, [], slots=60)
    assert graph[0] == 1.0 and graph[59] == 9.0
    assert sum(v is not None for v in graph) == 2


def test_batch_mixing_device_and_service_refs_parses_each_row_once(monkeypatch):
    from app.services.status_pages import history

    db = make_session()
    devices = [seed_device(db) for _ in range(2)]
    targets = {d.id: [seed_service_check(db, d.id, port=p, label=str(p)) for p in (80, 443)] for d in devices}
    rows = 0
    for d in devices:
        for minute in (-3, 5, 15):
            results = [{"target_id": t.id, "open": minute != 5, "response_time_ms": 10.0 + minute} for t in targets[d.id]]
            db.add(DeviceMonitorHistory(device_id=d.id, checked_at=_t(minute), status="online", expected_status="online",
                                        is_healthy=True, rtt_ms=2.0, port_results=json.dumps(results)))
            rows += 1
    db.commit()
    refs = [SourceRef("device", device_id=d.id) for d in devices]
    refs += [SourceRef("service_check", device_id=d.id, port_target_id=t.id) for d in devices for t in targets[d.id]]
    calls = []
    real = history.json.loads
    monkeypatch.setattr(history.json, "loads", lambda raw, *a, **k: calls.append(1) or real(raw, *a, **k))
    out = load_samples(db, refs, START, END)
    assert len(calls) == rows
    for d in devices:
        assert [(s.health, s.response_ms) for s in out[SourceRef("device", device_id=d.id)]] == [("healthy", 2.0)] * 3
        for t in targets[d.id]:
            got = out[SourceRef("service_check", device_id=d.id, port_target_id=t.id)]
            assert [(s.at, s.health, s.response_ms) for s in got] == [
                (_t(-3), "healthy", 7.0), (_t(5), "unhealthy", None), (_t(15), "healthy", 25.0)]


def test_preceding_sample_is_latest_per_source_not_whole_history():
    db = make_session()
    monitors = [seed_monitor(db) for _ in range(2)]
    for m in monitors:
        for minute in (-300, -200, -100, -30):
            db.add(MonitorCheckHistory(monitor_id=m.id, checked_at=_t(minute), status="online", response_time_ms=minute + 1000.0))
    db.commit()
    refs = [SourceRef("monitor", monitor_id=m.id) for m in monitors]
    out = load_samples(db, refs, START, END)
    assert [[s.at for s in out[r]] for r in refs] == [[_t(-30)], [_t(-30)]]


def test_preceding_scan_limit_applies_when_history_is_longer_than_scan_rows():
    db = make_session()
    device = seed_device(db)
    target = seed_service_check(db, device.id)
    for minute in range(-60, -20):
        results = [{"target_id": target.id, "open": True, "response_time_ms": float(-minute)}] if minute in (-60, -21) else []
        db.add(DeviceMonitorHistory(device_id=device.id, checked_at=_t(minute), status="online", expected_status="online",
                                    is_healthy=True, port_results=json.dumps(results)))
    db.commit()
    ref = SourceRef("service_check", device_id=device.id, port_target_id=target.id)
    got = load_samples(db, [ref], START, END)[ref]
    assert [(s.at, s.response_ms) for s in got] == [(_t(-21), 21.0)]

import json
from datetime import datetime, timedelta, timezone

import pytest

from app.models.alert_rule import AlertRule
from app.models.monitor import MonitorCheckHistory
from app.models.monitor_history import DeviceMonitorHistory
from app.models.system_setting import SystemSetting
from app.services.status_pages.sources import (
    CurrentState,
    SourceRef,
    freshness_deadline,
    item_state,
    load_current_states,
    monitor_slow,
    ping_loss_above,
    rtt_above,
    service_slow,
    threshold_breaching_sources,
)
from tests.status_page_helpers import make_session, seed_device, seed_monitor, seed_page, seed_service_check

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


def _device(db, observed="online", ago=30, **kw):
    kw.setdefault("monitor_status", observed)
    kw.setdefault("last_monitored_at", NOW - timedelta(seconds=ago))
    return seed_device(db, **kw)


def _history(db, device, ports=(), status="online", rtt=10.0, ago=30):
    db.add(DeviceMonitorHistory(
        device_id=device.id, checked_at=NOW - timedelta(seconds=ago), status=status,
        rtt_ms=rtt, port_results=json.dumps(list(ports)),
    ))
    db.commit()


def _state(db, ref):
    return load_current_states(db, [ref], NOW)[ref]


def test_freshness_is_twice_interval_with_60s_floor():
    t = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert freshness_deadline(t, 300) == t + timedelta(seconds=600)
    assert freshness_deadline(t, 20) == t + timedelta(seconds=60)


def test_freshness_deadline_restamps_naive_datetimes_as_utc():
    assert freshness_deadline(datetime(2026, 1, 1), 300).tzinfo is not None


def test_source_ref_keys_round_trip():
    for ref in (SourceRef("device", device_id=5), SourceRef("monitor", monitor_id=3), SourceRef("service_check", device_id=5, port_target_id=9)):
        assert SourceRef.from_key(ref.key) == ref
    assert SourceRef("device", device_id=5).key == "device:5"
    assert SourceRef("monitor", monitor_id=3).key == "monitor:3"
    assert SourceRef("service_check", device_id=5, port_target_id=9).key == "service:5:9"


@pytest.mark.parametrize("bad", ["", "device", "device:", "device:x", "device:0", "device:-1", "device:05", "device:1:2",
                                 "monitor:1:2", "service:1", "service:1:2:3", "other:1", "Device:1", "device: 1", "device:1 "])
def test_from_key_rejects_malformed_keys(bad):
    with pytest.raises(ValueError):
        SourceRef.from_key(bad)


def test_from_item_maps_columns():
    db = make_session()
    device = _device(db)
    target = seed_service_check(db, device.id)
    monitor = seed_monitor(db)
    refs = [SourceRef("device", device_id=device.id), SourceRef("monitor", monitor_id=monitor.id),
            SourceRef("service_check", device_id=device.id, port_target_id=target.id)]
    page = seed_page(db, "p", items=[(r, f"n{i}") for i, r in enumerate(refs)])
    from app.models.status_page import StatusPageItem
    items = db.query(StatusPageItem).filter_by(page_id=page.id).order_by(StatusPageItem.sort_order).all()
    assert [SourceRef.from_item(i) for i in items] == refs


def test_expected_offline_device_observed_offline_is_healthy():
    db = make_session()
    device = _device(db, observed="offline", expected_status="offline")
    state = _state(db, SourceRef("device", device_id=device.id))
    assert state.health == "healthy"
    assert item_state(state, False, False, NOW) == "operational"


def test_online_device_observed_offline_is_unhealthy():
    db = make_session()
    device = _device(db, observed="offline")
    state = _state(db, SourceRef("device", device_id=device.id))
    assert state.health == "unhealthy"
    assert item_state(state, False, False, NOW) == "down"


def test_stale_device_observation_is_unknown_not_down():
    db = make_session()
    device = _device(db, observed="offline", ago=601)
    state = _state(db, SourceRef("device", device_id=device.id))
    assert state.health == "unhealthy"
    assert state.interval_seconds == 300
    assert item_state(state, False, False, NOW) == "unknown"
    fresh = _device(db, observed="offline", ago=600)
    assert item_state(_state(db, SourceRef("device", device_id=fresh.id)), False, False, NOW) == "down"


def test_device_interval_follows_setting_clamped():
    db = make_session()
    device = _device(db)
    db.add(SystemSetting(key="monitor_interval_seconds", value="5"))
    db.commit()
    assert _state(db, SourceRef("device", device_id=device.id)).interval_seconds == 30


def test_device_never_monitored_is_unknown():
    db = make_session()
    device = seed_device(db)
    state = _state(db, SourceRef("device", device_id=device.id))
    assert state.health == "unknown" and state.observed_at is None


def test_service_check_uses_its_own_result_not_device_ping():
    db = make_session()
    device = _device(db, observed="online")
    target = seed_service_check(db, device.id)
    _history(db, device, ports=[{"target_id": target.id, "open": False, "response_time_ms": None}])
    ref = SourceRef("service_check", device_id=device.id, port_target_id=target.id)
    state = _state(db, ref)
    assert state.health == "unhealthy"
    assert item_state(state, False, False, NOW) == "down"
    assert _state(db, SourceRef("device", device_id=device.id)).health == "healthy"


def test_service_check_uses_latest_row_holding_the_target():
    db = make_session()
    device = _device(db)
    target = seed_service_check(db, device.id)
    _history(db, device, ports=[{"target_id": target.id, "open": False}], ago=120)
    _history(db, device, ports=[], ago=30)
    state = _state(db, SourceRef("service_check", device_id=device.id, port_target_id=target.id))
    assert state.health == "unhealthy"
    assert state.observed_at == NOW - timedelta(seconds=120)


def test_service_check_without_result_is_unknown():
    db = make_session()
    device = _device(db)
    target = seed_service_check(db, device.id)
    _history(db, device, ports=[])
    assert _state(db, SourceRef("service_check", device_id=device.id, port_target_id=target.id)).health == "unknown"


def test_global_target_applies_but_other_device_target_is_unknown():
    db = make_session()
    a, b = _device(db), _device(db)
    global_target = seed_service_check(db, None)
    b_target = seed_service_check(db, b.id, port=22, label="SSH")
    for d in (a, b):
        _history(db, d, ports=[{"target_id": global_target.id, "open": True}, {"target_id": b_target.id, "open": True}])
    assert _state(db, SourceRef("service_check", device_id=a.id, port_target_id=global_target.id)).health == "healthy"
    assert _state(db, SourceRef("service_check", device_id=b.id, port_target_id=b_target.id)).health == "healthy"
    assert _state(db, SourceRef("service_check", device_id=a.id, port_target_id=b_target.id)).health == "unknown"


def test_disabled_or_missing_target_is_unknown():
    db = make_session()
    device = _device(db)
    target = seed_service_check(db, device.id, enabled=False)
    _history(db, device, ports=[{"target_id": target.id, "open": True}, {"target_id": 999, "open": True}])
    assert _state(db, SourceRef("service_check", device_id=device.id, port_target_id=target.id)).health == "unknown"
    assert _state(db, SourceRef("service_check", device_id=device.id, port_target_id=999)).health == "unknown"


def test_missing_device_and_monitor_are_unknown():
    db = make_session()
    assert _state(db, SourceRef("device", device_id=404)).health == "unknown"
    assert _state(db, SourceRef("monitor", monitor_id=404)).health == "unknown"


@pytest.mark.parametrize("kw", [{"monitoring_paused": True}, {"ip_address": "  "}, {"status": "disabled"}, {"lifecycle": "retired"}])
def test_paused_or_blank_ip_device_is_unknown(kw):
    db = make_session()
    device = _device(db, **kw)
    target = seed_service_check(db, device.id)
    _history(db, device, ports=[{"target_id": target.id, "open": True}])
    assert _state(db, SourceRef("device", device_id=device.id)).health == "unknown"
    assert _state(db, SourceRef("service_check", device_id=device.id, port_target_id=target.id)).health == "unknown"


def test_monitor_health_from_damped_status():
    db = make_session()
    up = seed_monitor(db, last_status="online", last_checked_at=NOW - timedelta(seconds=10))
    down = seed_monitor(db, last_status="offline", last_checked_at=NOW - timedelta(seconds=10))
    never = seed_monitor(db)
    disabled = seed_monitor(db, enabled=False, last_status="online", last_checked_at=NOW)
    assert _state(db, SourceRef("monitor", monitor_id=up.id)).health == "healthy"
    assert _state(db, SourceRef("monitor", monitor_id=down.id)).health == "unhealthy"
    assert _state(db, SourceRef("monitor", monitor_id=never.id)).health == "unknown"
    assert _state(db, SourceRef("monitor", monitor_id=disabled.id)).health == "unknown"


def test_monitor_freshness_uses_retry_interval_while_failing():
    db = make_session()
    ok = seed_monitor(db, check_interval_seconds=300, retry_interval_seconds=20, last_status="online",
                      last_checked_at=NOW - timedelta(seconds=90))
    failing = seed_monitor(db, check_interval_seconds=300, retry_interval_seconds=20, last_status="online",
                           consecutive_failures=1, last_checked_at=NOW - timedelta(seconds=90))
    ok_state = _state(db, SourceRef("monitor", monitor_id=ok.id))
    failing_state = _state(db, SourceRef("monitor", monitor_id=failing.id))
    assert ok_state.interval_seconds == 300
    assert failing_state.interval_seconds == 20
    assert item_state(ok_state, False, False, NOW) == "operational"
    assert item_state(failing_state, False, False, NOW) == "unknown"


def _rule(db, event_type, **kw):
    kw.setdefault("name", event_type)
    kw.setdefault("channels", "[]")
    rule = AlertRule(event_type=event_type, **kw)
    db.add(rule)
    db.commit()
    return rule


def test_rtt_rule_marks_source_degraded_even_without_channels():
    db = make_session()
    device = _device(db)
    _history(db, device, rtt=250.0)
    ref = SourceRef("device", device_id=device.id)
    assert threshold_breaching_sources(db, [ref], NOW) == set()
    _rule(db, "rtt_above", threshold_ms=200, channels="[]", cooldown_minutes=10_000, last_triggered_at=NOW)
    breaching = threshold_breaching_sources(db, [ref], NOW)
    assert breaching == {ref}
    assert item_state(_state(db, ref), ref in breaching, False, NOW) == "degraded"


def test_disabled_rule_and_scoped_rule_do_not_breach():
    db = make_session()
    a, b = _device(db), _device(db)
    for d in (a, b):
        _history(db, d, rtt=250.0)
    _rule(db, "rtt_above", threshold_ms=200, enabled=False)
    _rule(db, "rtt_above", threshold_ms=200, device_id=b.id)
    refs = [SourceRef("device", device_id=a.id), SourceRef("device", device_id=b.id)]
    assert threshold_breaching_sources(db, refs, NOW) == {refs[1]}


def test_stale_observation_does_not_breach():
    db = make_session()
    device = _device(db, ago=700)
    _history(db, device, rtt=250.0, ago=700)
    _rule(db, "rtt_above", threshold_ms=200)
    assert threshold_breaching_sources(db, [SourceRef("device", device_id=device.id)], NOW) == set()


def test_service_slow_and_monitor_slow_and_ping_loss_sources():
    db = make_session()
    device = _device(db)
    target = seed_service_check(db, device.id)
    _history(db, device, ports=[{"target_id": target.id, "open": True, "response_time_ms": 900}], ago=10)
    for ago in (20, 30):
        _history(db, device, status="offline", ago=ago)
    monitor = seed_monitor(db, last_status="online", last_checked_at=NOW - timedelta(seconds=10))
    db.add(MonitorCheckHistory(monitor_id=monitor.id, checked_at=NOW - timedelta(seconds=10), status="online", response_time_ms=900.0))
    db.commit()
    _rule(db, "service_slow", threshold_ms=500)
    _rule(db, "monitor_slow", threshold_ms=500)
    _rule(db, "ping_loss_above", loss_pct_threshold=50.0, loss_window_minutes=60)
    service_ref = SourceRef("service_check", device_id=device.id, port_target_id=target.id)
    monitor_ref = SourceRef("monitor", monitor_id=monitor.id)
    device_ref = SourceRef("device", device_id=device.id)
    assert threshold_breaching_sources(db, [service_ref, monitor_ref, device_ref], NOW) == {service_ref, monitor_ref, device_ref}


def test_threshold_predicates_match_alerting_semantics():
    rule = AlertRule(name="r", event_type="x", channels="[]", threshold_ms=200, loss_pct_threshold=50.0)
    assert not rtt_above(rule, 200) and rtt_above(rule, 200.1) and not rtt_above(rule, None)
    assert not service_slow(rule, 200) and service_slow(rule, 201)
    assert not monitor_slow(rule, 200) and monitor_slow(rule, 201)
    assert ping_loss_above(rule, 4, 2) and not ping_loss_above(rule, 4, 1)
    assert not ping_loss_above(rule, 2, 2)
    assert not rtt_above(AlertRule(name="r", event_type="x", channels="[]"), 9999)


def test_maintenance_overrides_down_in_item_state():
    ref = SourceRef("device", device_id=1)
    state = CurrentState(ref, "unhealthy", NOW, NOW + timedelta(seconds=600), None, 300)
    assert item_state(state, False, True, NOW) == "maintenance"
    assert item_state(state, False, False, NOW) == "down"


def test_item_state_degraded_only_when_healthy():
    ref = SourceRef("device", device_id=1)
    healthy = CurrentState(ref, "healthy", NOW, NOW + timedelta(seconds=600), 1.0, 300)
    unhealthy = CurrentState(ref, "unhealthy", NOW, NOW + timedelta(seconds=600), 1.0, 300)
    assert item_state(healthy, True, False, NOW) == "degraded"
    assert item_state(unhealthy, True, False, NOW) == "down"
    assert item_state(healthy, False, False, NOW + timedelta(seconds=601)) == "unknown"

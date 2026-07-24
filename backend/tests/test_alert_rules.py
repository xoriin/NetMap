from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base
from app.models import device, site, snmp_profile, topology_group  # noqa: F401  (mapper config)
from app.models.alert_rule import AlertRule
from app.models.monitor_history import DeviceMonitorHistory
from app.schemas.alert import AlertRuleCreate
from app.services.alerting import service as alerting_service
from app.services.alerting.service import AlertMonitorService


def _rule(**kwargs) -> AlertRule:
    defaults = dict(
        id=1,
        name="High RTT",
        enabled=True,
        event_type="rtt_above",
        device_id=None,
        port_target_id=None,
        channels='["profile:1"]',
        cooldown_minutes=30,
        threshold_ms=100,
        loss_pct_threshold=None,
        loss_window_minutes=None,
        last_triggered_at=None,
    )
    defaults.update(kwargs)
    return AlertRule(**defaults)


def _loss_rule(**kwargs) -> AlertRule:
    return _rule(
        event_type="ping_loss_above",
        threshold_ms=None,
        loss_pct_threshold=50.0,
        loss_window_minutes=60,
        **kwargs,
    )


def _service_down_rule(**kwargs) -> AlertRule:
    defaults = dict(event_type="service_down", threshold_ms=None, port_target_id=None)
    defaults.update(kwargs)
    return _rule(**defaults)


def _service_slow_rule(**kwargs) -> AlertRule:
    defaults = dict(event_type="service_slow", threshold_ms=1000, port_target_id=None)
    defaults.update(kwargs)
    return _rule(**defaults)


def _port_entry(*, open_: bool, response_time_ms=None, label="HTTPS") -> dict:
    return {"target_id": 1, "port": 443, "label": label, "check_type": "https", "open": open_, "status": "open" if open_ else "closed", "response_time_ms": response_time_ms, "status_code": 200 if open_ else None}


def _history_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[DeviceMonitorHistory.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_rtt_breaches_matches_only_devices_over_threshold():
    now = datetime.now(timezone.utc)
    rtt_map = {1: 250.0, 2: 50.0, 3: None}
    breaches = AlertMonitorService._rtt_breaches([_rule()], rtt_map, now)
    assert [(device_id, rtt) for _, device_id, rtt in breaches] == [(1, 250.0)]


def test_rtt_breaches_respects_device_scope_and_exact_threshold():
    now = datetime.now(timezone.utc)
    rtt_map = {1: 250.0, 2: 300.0, 3: 100.0}
    scoped = _rule(device_id=2)
    breaches = AlertMonitorService._rtt_breaches([scoped], rtt_map, now)
    assert [(device_id, rtt) for _, device_id, rtt in breaches] == [(2, 300.0)]
    # rtt exactly equal to the threshold does not fire
    exact = _rule(device_id=3)
    assert AlertMonitorService._rtt_breaches([exact], rtt_map, now) == []


def test_rtt_breaches_skips_cooldown_and_non_rtt_rules():
    now = datetime.now(timezone.utc)
    rtt_map = {1: 250.0}
    cooling = _rule(last_triggered_at=now - timedelta(minutes=5))
    offline = _rule(id=2, event_type="device_offline", threshold_ms=None)
    missing_threshold = _rule(id=3, threshold_ms=None)
    assert AlertMonitorService._rtt_breaches([cooling, offline, missing_threshold], rtt_map, now) == []
    # after the cooldown elapses the same rule fires again
    expired = _rule(last_triggered_at=now - timedelta(minutes=31))
    assert len(AlertMonitorService._rtt_breaches([expired], rtt_map, now)) == 1


def test_rtt_message_includes_rtt_and_threshold():
    message = AlertMonitorService._build_message(
        "rtt_above", "Core Router", "10.0.0.1", "online", "NetMap",
        rtt_ms=251.4, threshold_ms=100,
    )
    assert "Core Router" in message
    assert "251 ms" in message
    assert "100 ms" in message


def test_rtt_rule_schema_requires_threshold():
    with pytest.raises(ValidationError):
        AlertRuleCreate(name="High RTT", event_type="rtt_above", channels=["profile:1"])
    rule = AlertRuleCreate(name="High RTT", event_type="rtt_above", channels=["profile:1"], threshold_ms=200)
    assert rule.threshold_ms == 200
    # status rules do not need a threshold
    AlertRuleCreate(name="Offline", event_type="device_offline", channels=["profile:1"])


def test_ping_loss_rule_schema_requires_threshold():
    with pytest.raises(ValidationError):
        AlertRuleCreate(name="High loss", event_type="ping_loss_above", channels=["profile:1"])
    rule = AlertRuleCreate(
        name="High loss", event_type="ping_loss_above", channels=["profile:1"], loss_pct_threshold=40,
    )
    assert rule.loss_pct_threshold == 40
    assert rule.loss_window_minutes == 60  # default


def test_ping_loss_message_includes_pct_and_threshold():
    message = AlertMonitorService._build_message(
        "ping_loss_above", "Core Router", "10.0.0.1", "online", "NetMap",
        loss_pct=62.5, loss_pct_threshold=50,
    )
    assert "Core Router" in message
    assert "62%" in message or "63%" in message
    assert "50%" in message


def test_ping_loss_breaches_computes_pct_over_window(monkeypatch):
    db = _history_session()
    now = datetime.now(timezone.utc)
    rows = (
        [{"device_id": 1, "checked_at": now - timedelta(minutes=m), "status": "offline"} for m in (5, 10, 15, 20)]
        + [{"device_id": 1, "checked_at": now - timedelta(minutes=m), "status": "online"} for m in (25, 30)]
        # outside the 60 minute window — should not count
        + [{"device_id": 1, "checked_at": now - timedelta(minutes=120), "status": "offline"}]
    )
    for row in rows:
        db.add(DeviceMonitorHistory(port_results="[]", **row))
    db.commit()

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(alerting_service, "SessionLocal", factory)

    rule = _loss_rule()
    breaches = AlertMonitorService._ping_loss_breaches([rule], {1}, now)
    assert len(breaches) == 1
    _, device_id, loss_pct = breaches[0]
    assert device_id == 1
    assert loss_pct == pytest.approx(4 / 6 * 100)


def test_ping_loss_breaches_skips_below_threshold_unscoped_devices_and_small_samples(monkeypatch):
    db = _history_session()
    now = datetime.now(timezone.utc)
    # device 1: below threshold
    db.add_all([
        DeviceMonitorHistory(device_id=1, checked_at=now - timedelta(minutes=m), status=status, port_results="[]")
        for m, status in [(5, "offline"), (10, "online"), (15, "online"), (20, "online")]
    ])
    # device 2: high loss but too few samples
    db.add_all([
        DeviceMonitorHistory(device_id=2, checked_at=now - timedelta(minutes=5), status="offline", port_results="[]"),
    ])
    # device 3: high loss, enough samples, but not in the active device set
    db.add_all([
        DeviceMonitorHistory(device_id=3, checked_at=now - timedelta(minutes=m), status="offline", port_results="[]")
        for m in (5, 10, 15)
    ])
    db.commit()

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(alerting_service, "SessionLocal", factory)

    rule = _loss_rule()
    assert AlertMonitorService._ping_loss_breaches([rule], {1, 2}, now) == []


def test_ping_loss_breaches_respects_cooldown_and_device_scope(monkeypatch):
    db = _history_session()
    now = datetime.now(timezone.utc)
    db.add_all([
        DeviceMonitorHistory(device_id=1, checked_at=now - timedelta(minutes=m), status="offline", port_results="[]")
        for m in (5, 10, 15)
    ])
    db.commit()

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(alerting_service, "SessionLocal", factory)

    cooling = _loss_rule(last_triggered_at=now - timedelta(minutes=5))
    assert AlertMonitorService._ping_loss_breaches([cooling], {1}, now) == []

    scoped_elsewhere = _loss_rule(device_id=2)
    assert AlertMonitorService._ping_loss_breaches([scoped_elsewhere], {1, 2}, now) == []

    scoped_here = _loss_rule(device_id=1)
    assert len(AlertMonitorService._ping_loss_breaches([scoped_here], {1}, now)) == 1


def test_service_down_breaches_fires_only_on_up_to_down_transition():
    now = datetime.now(timezone.utc)
    rule = _service_down_rule()

    # first sighting of a target (no prior known state) — nothing to compare, no fire
    unknown = {}
    current = {(1, 1): _port_entry(open_=False)}
    assert AlertMonitorService._service_down_breaches([rule], unknown, current, now) == []

    # was up, now down — fires
    known = {(1, 1): True}
    breaches = AlertMonitorService._service_down_breaches([rule], known, current, now)
    assert [(device_id, label) for _, device_id, label in breaches] == [(1, "HTTPS")]

    # was already down — edge already fired, no repeat
    known_down = {(1, 1): False}
    assert AlertMonitorService._service_down_breaches([rule], known_down, current, now) == []

    # still up — no fire
    still_up = {(1, 1): _port_entry(open_=True)}
    assert AlertMonitorService._service_down_breaches([rule], known, still_up, now) == []


def test_service_down_breaches_respects_target_scope_and_cooldown():
    now = datetime.now(timezone.utc)
    known = {(1, 1): True, (1, 2): True}
    current = {(1, 1): _port_entry(open_=False), (1, 2): _port_entry(open_=False, label="DNS")}

    scoped = _service_down_rule(port_target_id=2)
    breaches = AlertMonitorService._service_down_breaches([scoped], known, current, now)
    assert [(device_id, label) for _, device_id, label in breaches] == [(1, "DNS")]

    cooling = _service_down_rule(last_triggered_at=now - timedelta(minutes=5))
    assert AlertMonitorService._service_down_breaches([cooling], known, current, now) == []


def test_service_slow_breaches_computes_threshold_and_scope():
    now = datetime.now(timezone.utc)
    current = {
        (1, 1): _port_entry(open_=True, response_time_ms=1500.0),
        (2, 1): _port_entry(open_=True, response_time_ms=200.0),
    }
    rule = _service_slow_rule()
    breaches = AlertMonitorService._service_slow_breaches([rule], current, now)
    assert [(device_id, response_ms) for _, device_id, response_ms, _ in breaches] == [(1, 1500.0)]

    # missing threshold rule never breaches
    no_threshold = _service_slow_rule(threshold_ms=None)
    assert AlertMonitorService._service_slow_breaches([no_threshold], current, now) == []

    cooling = _service_slow_rule(last_triggered_at=now - timedelta(minutes=5))
    assert AlertMonitorService._service_slow_breaches([cooling], current, now) == []


def test_service_alert_messages_include_label_and_thresholds():
    down_message = AlertMonitorService._build_message(
        "service_down", "Web Server", "10.0.0.5", "offline", "NetMap", service_label="HTTPS",
    )
    assert "HTTPS" in down_message
    assert "Web Server" in down_message
    assert "DOWN" in down_message

    slow_message = AlertMonitorService._build_message(
        "service_slow", "Web Server", "10.0.0.5", "online", "NetMap",
        rtt_ms=1500.0, threshold_ms=1000, service_label="HTTPS",
    )
    assert "HTTPS" in slow_message
    assert "1500 ms" in slow_message
    assert "1000 ms" in slow_message


def test_service_slow_rule_schema_requires_threshold():
    with pytest.raises(ValidationError):
        AlertRuleCreate(name="Slow API", event_type="service_slow", channels=["profile:1"])
    rule = AlertRuleCreate(name="Slow API", event_type="service_slow", channels=["profile:1"], threshold_ms=500)
    assert rule.threshold_ms == 500


def test_service_down_rule_schema_accepts_optional_port_target_scope():
    rule = AlertRuleCreate(name="Down", event_type="service_down", channels=["profile:1"])
    assert rule.port_target_id is None
    scoped = AlertRuleCreate(name="Down", event_type="service_down", channels=["profile:1"], port_target_id=7)
    assert scoped.port_target_id == 7

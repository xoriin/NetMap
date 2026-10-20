import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.api.deps import get_current_user
from app.api.v1 import alerts as alerts_api
from app.api.v1 import monitoring as monitoring_api
from app.api.v1 import monitors as monitors_api
from app.api.v1 import topology as topology_api
from app.db.session import get_db
from app.models.alert_rule import AlertRule
from app.models.monitor import MonitorCheckHistory
from app.models.monitor_history import DeviceMonitorHistory
from app.models.notification_delivery import NotificationDelivery
from app.models.status_page import (
    StatusBreachStreak,
    StatusIncident,
    StatusIncidentPage,
    StatusIncidentSource,
    StatusIncidentUpdate,
    StatusPage,
    StatusPageGroup,
    StatusPageItem,
)
from app.models.system_setting import SystemSetting
from app.models.user import User, UserRole
from app.services.monitoring.health import observed_is_healthy
from app.services.status_pages import cache as cache_module
from app.services.status_pages import evaluator, events, incidents, maintenance, sources
from app.services.status_pages.cache import StatusSnapshotCache
from app.services.status_pages.incidents import PersonActor
from app.services.status_pages.projection import build_page_payload
from app.services.status_pages.sources import SourceRef
from tests.status_page_helpers import make_session, seed_device, seed_monitor, seed_page, seed_service_check

T0 = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)
STEP = timedelta(seconds=60)


@pytest.fixture(autouse=True)
def calls(monkeypatch):
    found: list[list[int]] = []
    monkeypatch.setattr(events, "notify_pages_changed", lambda ids: found.append(sorted(set(ids))))
    return found


@pytest.fixture
def db():
    session = make_session()
    session.add(SystemSetting(key="monitor_interval_seconds", value="60"))
    session.commit()
    yield session
    session.close()


def _rule(db, event_type="device_offline", **kw):
    kw.setdefault("name", event_type)
    kw.setdefault("channels", "[]")
    kw.setdefault("open_incident", True)
    kw.setdefault("incident_min_failures", 3)
    rule = AlertRule(event_type=event_type, **kw)
    db.add(rule)
    db.commit()
    return rule


def _device(db, **kw):
    kw.setdefault("monitor_status", "online")
    kw.setdefault("last_monitored_at", T0 - STEP)
    return seed_device(db, **kw)


def _ref(device):
    return SourceRef("device", device_id=device.id)


def _check(db, device, at, status="offline", rtt=None, ports=None):
    expected = device.expected_status or "online"
    db.add(DeviceMonitorHistory(
        device_id=device.id, checked_at=at, status=status, expected_status=expected,
        is_healthy=observed_is_healthy(status, expected), rtt_ms=rtt, port_results=json.dumps(ports or []),
    ))
    device.monitor_status = status
    device.last_monitored_at = at
    db.commit()


def _cycle(db, at, checks):
    for device, status in checks:
        _check(db, device, at, status)
    return evaluator.evaluate(db, [_ref(d) for d, _ in checks], at)


def _fail(db, device, n, start=T0, status="offline"):
    at = start
    for i in range(n):
        at = start + i * STEP
        _cycle(db, at, [(device, status)])
    return at


def _mcheck(db, monitor, at, ok, response_ms=None):
    db.add(MonitorCheckHistory(
        monitor_id=monitor.id, checked_at=at, status="online" if ok else "offline", response_time_ms=response_ms,
    ))
    monitor.consecutive_failures = 0 if ok else monitor.consecutive_failures + 1
    if ok:
        monitor.last_status = "online"
    elif monitor.consecutive_failures > monitor.max_retries:
        monitor.last_status = "offline"
    monitor.last_checked_at = at
    db.commit()


def _incidents(db):
    return list(db.scalars(select(StatusIncident).order_by(StatusIncident.id)))


def _events(db, incident):
    return [u.event_code for u in db.scalars(
        select(StatusIncidentUpdate).where(StatusIncidentUpdate.incident_id == incident.id).order_by(StatusIncidentUpdate.id)
    )]


def _audience(db, incident):
    return set(db.scalars(select(StatusIncidentPage.page_id).where(StatusIncidentPage.incident_id == incident.id)))


def _sources(db, incident, active=True):
    return sorted(
        (s.source_key, s.page_id) for s in db.scalars(
            select(StatusIncidentSource).where(
                StatusIncidentSource.incident_id == incident.id, StatusIncidentSource.active == active,
            )
        )
    )


def _streak(db, rule, ref, page):
    row = db.scalar(select(StatusBreachStreak).where(
        StatusBreachStreak.rule_id == rule.id, StatusBreachStreak.source_key == ref.key,
        StatusBreachStreak.page_id == page.id,
    ))
    return row


def _shown(db, page, at):
    payload = build_page_payload(db, page, page.visibility, at)
    return [(i["title"], [u["message"] for u in i["updates"]]) for i in payload["incidents"]]


def test_three_breaches_open_one_incident_without_another_transition(db):
    rule = _rule(db)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    assert _cycle(db, T0 - STEP, [(router, "online")]) == set()
    assert _cycle(db, T0, [(router, "offline")]) == set()
    assert _cycle(db, T0 + STEP, [(router, "offline")]) == set()
    assert _incidents(db) == []

    assert _cycle(db, T0 + 2 * STEP, [(router, "offline")]) == {page.id}
    [incident] = _incidents(db)
    assert (incident.source, incident.condition_family, incident.status, incident.opened_by_rule_id) == (
        "netmap", "availability", "investigating", rule.id,
    )
    assert incident.severity == "partial"
    assert _audience(db, incident) == {page.id}
    assert _sources(db, incident) == [(_ref(router).key, page.id)]
    [opened] = db.scalars(select(StatusIncidentUpdate).where(StatusIncidentUpdate.incident_id == incident.id)).all()
    assert (opened.event_code, opened.event_data, opened.author_kind) == (
        "opened", {"sources": [_ref(router).key], "count": 3}, "netmap",
    )
    assert _shown(db, page, T0 + 2 * STEP) == [("Router unavailable", ["Router failing (3 consecutive checks).", ])]

    assert _cycle(db, T0 + 3 * STEP, [(router, "offline")]) == set()
    assert len(_incidents(db)) == 1
    assert _events(db, incident) == ["opened"]


def test_cooldown_and_failed_delivery_do_not_block_incident(db):
    rule = _rule(db, channels='["profile:1"]', cooldown_minutes=1440, last_triggered_at=T0 - timedelta(minutes=5))
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    db.add(NotificationDelivery(
        rule_name=rule.name, device_id=router.id, target="profile:1", status="failed", detail="smtp down", sent_at=T0,
    ))
    db.commit()
    _cycle(db, T0, [(router, "offline")])
    rule.last_triggered_at = T0 + timedelta(seconds=1)
    db.commit()
    _cycle(db, T0 + STEP, [(router, "offline")])
    _cycle(db, T0 + 2 * STEP, [(router, "offline")])

    [incident] = _incidents(db)
    assert _audience(db, incident) == {page.id}
    db.refresh(rule)
    assert rule.last_triggered_at.replace(tzinfo=timezone.utc) == T0 + timedelta(seconds=1)
    assert db.scalar(select(NotificationDelivery.status)) == "failed"


def test_monitor_threshold_is_larger_of_rule_and_retries_not_sum(db):
    monitor = seed_monitor(db, max_retries=4, check_interval_seconds=60, retry_interval_seconds=20)
    second = seed_monitor(db, max_retries=4, check_interval_seconds=60, retry_interval_seconds=20)
    _rule(db, "monitor_down", monitor_id=monitor.id, incident_min_failures=3)
    _rule(db, "monitor_down", monitor_id=second.id, incident_min_failures=6)
    refs = [SourceRef("monitor", monitor_id=m.id) for m in (monitor, second)]
    seed_page(db, "main", items=[(refs[0], "Website"), (refs[1], "API")])
    opened = {}
    for i in range(7):
        at = T0 + i * timedelta(seconds=20)
        _mcheck(db, monitor, at, ok=False)
        _mcheck(db, second, at, ok=False)
        evaluator.evaluate(db, refs, at)
        for incident in _incidents(db):
            for key, _ in _sources(db, incident):
                opened.setdefault(key, i + 1)
    assert opened == {refs[0].key: 5, refs[1].key: 6}


def test_expected_offline_device_coming_online_opens_incident(db):
    _rule(db, "device_unexpected_state")
    lab = _device(db, expected_status="offline", monitor_status="offline")
    quiet = _device(db, expected_status="offline", monitor_status="offline")
    page = seed_page(db, "lab", items=[(_ref(lab), "Lab box"), (_ref(quiet), "Cold spare")])
    for i in range(3):
        _cycle(db, T0 + i * STEP, [(lab, "online"), (quiet, "offline")])
    [incident] = _incidents(db)
    assert _sources(db, incident) == [(_ref(lab).key, page.id)]


def test_duplicate_rules_attach_as_contributors_not_duplicates(db):
    first = _rule(db, "device_offline")
    router = _device(db)
    second = _rule(db, "device_offline", device_id=router.id)
    third = _rule(db, "device_unexpected_state")
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    _fail(db, router, 4)
    [incident] = _incidents(db)
    assert _sources(db, incident) == [(_ref(router).key, page.id)]
    assert db.query(StatusIncidentSource).count() == 1
    for rule in (first, second, third):
        assert _streak(db, rule, _ref(router), page).streak == 4


def test_streak_survives_restart(db):
    rule = _rule(db)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    _fail(db, router, 2)
    engine = db.get_bind()
    db.close()

    restarted = sessionmaker(bind=engine, expire_on_commit=False)()
    assert _streak(restarted, rule, _ref(router), page).streak == 2
    router = restarted.merge(router)
    _cycle(restarted, T0 + 2 * STEP, [(router, "offline")])
    assert len(_incidents(restarted)) == 1
    restarted.close()


def test_same_observation_twice_does_not_advance_streak(db):
    rule = _rule(db)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    _check(db, router, T0)
    for _ in range(3):
        evaluator.evaluate(db, [_ref(router)], T0 + timedelta(seconds=5))
    assert _streak(db, rule, _ref(router), page).streak == 1
    assert _incidents(db) == []

    last = _fail(db, router, 2, start=T0 + STEP)
    [incident] = _incidents(db)
    updates = db.query(StatusIncidentUpdate).count()
    for _ in range(2):
        assert evaluator.evaluate(db, [_ref(router)], last) == set()
    assert len(_incidents(db)) == 1
    assert db.query(StatusIncidentUpdate).count() == updates
    assert _streak(db, rule, _ref(router), page).streak == 3
    assert incident.status == "investigating"


def test_stale_period_resets_streak(db):
    rule = _rule(db)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    _fail(db, router, 2)
    late = T0 + STEP + timedelta(seconds=200)
    _cycle(db, late, [(router, "offline")])
    assert _streak(db, rule, _ref(router), page).streak == 1
    assert _incidents(db) == []

    _cycle(db, late + STEP, [(router, "offline")])
    assert _streak(db, rule, _ref(router), page).streak == 2
    evaluator.evaluate(db, [_ref(router)], late + STEP + timedelta(seconds=121))
    assert _streak(db, rule, _ref(router), page).streak == 0
    _cycle(db, late + 2 * STEP + timedelta(seconds=121), [(router, "offline")])
    assert _streak(db, rule, _ref(router), page).streak == 1
    assert _incidents(db) == []


def test_grouping_requires_identical_page_sets(db):
    rule = _rule(db)
    a, b, c, d = (_device(db) for _ in range(4))
    one = seed_page(db, "one", items=[(_ref(a), "A"), (_ref(b), "B"), (_ref(c), "C"), (_ref(d), "D")])
    two = seed_page(db, "two", items=[(_ref(c), "C on two")])
    _cycle(db, T0, [(a, "offline"), (b, "online"), (c, "offline")])
    _cycle(db, T0 + STEP, [(a, "offline"), (b, "offline"), (c, "offline")])
    _cycle(db, T0 + 2 * STEP, [(a, "offline"), (b, "offline"), (c, "offline")])
    first, second = _incidents(db)
    assert _audience(db, first) == {one.id}
    assert _audience(db, second) == {one.id, two.id}
    assert _sources(db, first) == [(_ref(a).key, one.id)]
    assert _sources(db, second) == sorted([(_ref(c).key, one.id), (_ref(c).key, two.id)])

    _cycle(db, T0 + 3 * STEP, [(a, "offline"), (b, "offline"), (c, "offline")])
    assert len(_incidents(db)) == 2
    assert _sources(db, first) == sorted([(_ref(a).key, one.id), (_ref(b).key, one.id)])
    assert _events(db, first) == ["opened", "source_added"]
    titles = dict(_shown(db, one, T0 + 3 * STEP))
    assert titles["A, B unavailable"] == ["A failing (3 consecutive checks).", "B is also affected."]
    assert _shown(db, two, T0 + 3 * STEP) == [("C on two unavailable", ["C on two failing (3 consecutive checks)."])]

    late = T0 + 3 * STEP + timedelta(minutes=5)
    for i in range(3):
        _cycle(db, late + i * STEP, [(a, "offline"), (b, "offline"), (d, "offline")])
    assert len(_incidents(db)) == 3
    assert _sources(db, _incidents(db)[-1]) == [(_ref(d).key, one.id)]
    assert rule.id == _incidents(db)[-1].opened_by_rule_id


def test_recovery_moves_to_monitoring_and_rebreach_returns_to_investigating(db):
    _rule(db)
    a, b = _device(db), _device(db)
    page = seed_page(db, "main", items=[(_ref(a), "A"), (_ref(b), "B")])
    for i in range(3):
        _cycle(db, T0 + i * STEP, [(a, "offline"), (b, "offline")])
    [incident] = _incidents(db)
    assert _events(db, incident) == ["opened"]

    at = T0 + 3 * STEP
    _cycle(db, at, [(a, "online"), (b, "offline")])
    assert incident.status == "investigating"
    _cycle(db, at + STEP, [(a, "online")])
    stale_now = at + STEP + timedelta(seconds=125)
    evaluator.evaluate(db, [_ref(a), _ref(b)], stale_now)
    assert incident.status == "investigating"

    assert _cycle(db, stale_now, [(a, "online"), (b, "online")]) == {page.id}
    assert incident.status == "monitoring"
    assert _events(db, incident) == ["opened", "recovered"]
    _cycle(db, stale_now + STEP, [(a, "online"), (b, "online")])
    assert _events(db, incident) == ["opened", "recovered"]

    assert _cycle(db, stale_now + 2 * STEP, [(a, "offline"), (b, "online")]) == {page.id}
    assert incident.status == "investigating"
    assert _events(db, incident) == ["opened", "recovered", "rebreached"]
    [(_, messages)] = _shown(db, page, stale_now + 2 * STEP)
    assert messages[-2:] == ["All affected systems have recovered. Monitoring.", "A is failing again."]
    statuses = [u.status_change for u in db.scalars(
        select(StatusIncidentUpdate).where(StatusIncidentUpdate.incident_id == incident.id).order_by(StatusIncidentUpdate.id)
    )]
    assert statuses == [None, "monitoring", "investigating"]
    assert len(_incidents(db)) == 1


def test_manual_resolve_latches_until_clear_then_new_streak(db):
    rule = _rule(db)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    user = User(username="ops", password_hash="x", role=UserRole.SUPER_ADMIN, is_active=True)
    db.add(user)
    db.commit()
    last = _fail(db, router, 3)
    [first] = _incidents(db)
    incidents.resolve(db, PersonActor(user), first.id, "Known ISP outage", now=last + timedelta(seconds=5))
    assert _sources(db, first) == []
    assert _streak(db, rule, _ref(router), page).resolution_latched is True

    last = _fail(db, router, 4, start=last + STEP)
    assert len(_incidents(db)) == 1
    assert _streak(db, rule, _ref(router), page).streak == 0

    _cycle(db, last + STEP, [(router, "online")])
    assert _streak(db, rule, _ref(router), page).resolution_latched is False
    last = _fail(db, router, 2, start=last + 2 * STEP)
    assert len(_incidents(db)) == 1
    _cycle(db, last + STEP, [(router, "offline")])
    old, new = _incidents(db)
    assert (old.status, new.status) == ("resolved", "investigating")
    assert _sources(db, new) == [(_ref(router).key, page.id)]


def test_resolving_a_recovered_incident_does_not_latch(db):
    rule = _rule(db)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    user = User(username="ops", password_hash="x", role=UserRole.SUPER_ADMIN, is_active=True)
    db.add(user)
    db.commit()
    last = _fail(db, router, 3)
    _cycle(db, last + STEP, [(router, "online")])
    [incident] = _incidents(db)
    incidents.resolve(db, PersonActor(user), incident.id, None, now=last + 2 * STEP)
    assert _streak(db, rule, _ref(router), page).resolution_latched is False
    _fail(db, router, 3, start=last + 3 * STEP)
    assert len(_incidents(db)) == 2


def test_rule_edit_resets_streak(db):
    rule = _rule(db)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    last = _fail(db, router, 2)
    rule.name, rule.channels, rule.cooldown_minutes = "Router down", '["profile:2"]', 5
    db.commit()
    last = _fail(db, router, 1, start=last + STEP)
    [incident] = _incidents(db)
    assert _streak(db, rule, _ref(router), page).streak == 3

    other = _device(db)
    seed_page(db, "other", items=[(_ref(other), "Other")])
    other_page = db.scalar(select(StatusPage).where(StatusPage.slug == "other"))
    last = _fail(db, other, 2, start=last + STEP)
    rule.incident_min_failures = 4
    db.commit()
    _cycle(db, last + STEP, [(other, "offline")])
    assert _streak(db, rule, _ref(other), other_page).streak == 1
    assert len(_incidents(db)) == 1

    rule.enabled = False
    db.commit()
    last = _fail(db, router, 4, start=last + 2 * STEP)
    assert _streak(db, rule, _ref(router), page).streak == 0

    rule.enabled, rule.open_incident = True, False
    db.commit()
    _fail(db, other, 4, start=last + STEP)
    assert _streak(db, rule, _ref(other), other_page).streak == 0
    assert len(_incidents(db)) == 1


def test_rule_version_tracks_only_breach_defining_fields(db):
    rule = _rule(db, "rtt_above", threshold_ms=100)
    version = evaluator.rule_version(rule)
    rule.name, rule.channels, rule.cooldown_minutes, rule.last_triggered_at = "x", '["smtp"]', 9, T0
    assert evaluator.rule_version(rule) == version
    for field, value in (("threshold_ms", 200), ("device_id", 5), ("enabled", False), ("open_incident", False),
                         ("incident_min_failures", 4), ("event_type", "service_slow"), ("port_target_id", 3),
                         ("monitor_id", 4), ("loss_pct_threshold", 25.0), ("loss_window_minutes", 30)):
        before = getattr(rule, field)
        setattr(rule, field, value)
        assert evaluator.rule_version(rule) != version, field
        setattr(rule, field, before)
    assert evaluator.rule_version(rule) == version


def test_threshold_predicates_reuse_the_source_functions(db, monkeypatch):
    seen = []
    for name in ("rtt_above", "service_slow", "monitor_slow", "ping_loss_above"):
        monkeypatch.setattr(sources, name, lambda rule, *args, _name=name: seen.append(_name) or True)
    obs = evaluator.Observation(at=T0, status="online", health="healthy", response_ms=5.0, loss={60: (10, 0)})
    device = SourceRef("device", device_id=1)
    service = SourceRef("service_check", device_id=1, port_target_id=2)
    monitor = SourceRef("monitor", monitor_id=3)
    assert evaluator.predicate(AlertRule(event_type="rtt_above", threshold_ms=500), device, obs) is True
    assert evaluator.predicate(AlertRule(event_type="ping_loss_above", loss_pct_threshold=50,
                                         loss_window_minutes=60), device, obs) is True
    assert evaluator.predicate(AlertRule(event_type="service_slow", threshold_ms=500), service, obs) is True
    assert evaluator.predicate(AlertRule(event_type="monitor_slow", threshold_ms=500), monitor, obs) is True
    assert seen == ["rtt_above", "ping_loss_above", "service_slow", "monitor_slow"]
    assert evaluator.predicate(AlertRule(event_type="rtt_above", threshold_ms=500), monitor, obs) is None
    assert evaluator.predicate(AlertRule(event_type="device_online"), device, obs) is None


def test_service_and_latency_rules_open_their_own_families(db):
    _rule(db, "service_down")
    _rule(db, "rtt_above", threshold_ms=100, open_incident=True)
    host = _device(db)
    target = seed_service_check(db, None)
    service = SourceRef("service_check", device_id=host.id, port_target_id=target.id)
    page = seed_page(db, "main", items=[(_ref(host), "Mail host"), (service, "Mail")])
    for i in range(3):
        at = T0 + i * STEP
        _check(db, host, at, "online", rtt=250.0, ports=[{"target_id": target.id, "open": False}])
        evaluator.evaluate(db, [_ref(host), service], at)
    families = {i.condition_family: i for i in _incidents(db)}
    assert set(families) == {"availability", "latency"}
    assert _sources(db, families["availability"]) == [(service.key, page.id)]
    payload = build_page_payload(db, page, "public", T0 + 2 * STEP)
    assert {(i["title"], i["severity"]) for i in payload["incidents"]} == {
        ("Mail unavailable", "partial"), ("Slow responses: Mail host", "performance"),
    }


def test_later_page_gets_its_own_incident_not_audience_growth(db):
    _rule(db)
    router = _device(db)
    one = seed_page(db, "one", visibility="private", items=[(_ref(router), "Router")])
    last = _fail(db, router, 3)
    [first] = _incidents(db)

    two = seed_page(db, "two", visibility="private")
    group = db.scalar(select(StatusPageGroup).where(StatusPageGroup.page_id == two.id))
    db.add(StatusPageItem(page_id=two.id, group_id=group.id, kind="device", device_id=router.id, display_name="Core"))
    db.commit()
    last = _fail(db, router, 3, start=last + STEP)
    old, new = _incidents(db)
    assert old.id == first.id
    assert (_audience(db, old), _audience(db, new)) == ({one.id}, {two.id})
    assert _events(db, old) == ["opened"]
    assert _sources(db, old) == [(_ref(router).key, one.id)]
    assert _sources(db, new) == [(_ref(router).key, two.id)]
    assert [t for t, _ in _shown(db, one, last)] == ["Router unavailable"]
    assert _shown(db, two, last) == [("Core unavailable", ["Core failing (3 consecutive checks).", ])]


def test_source_joining_a_monitoring_incident_returns_it_to_investigating(db):
    _rule(db)
    a, b = _device(db), _device(db)
    page = seed_page(db, "main", items=[(_ref(a), "A"), (_ref(b), "B")])
    for i in range(3):
        _cycle(db, T0 + i * STEP, [(a, "offline"), (b, "online")])
    _cycle(db, T0 + 3 * STEP, [(a, "online"), (b, "offline")])
    [incident] = _incidents(db)
    assert incident.status == "monitoring"
    _cycle(db, T0 + 4 * STEP, [(a, "online"), (b, "offline")])
    assert _cycle(db, T0 + 5 * STEP, [(a, "online"), (b, "offline")]) == {page.id}
    assert len(_incidents(db)) == 1
    assert incident.status == "investigating"
    assert _events(db, incident) == ["opened", "recovered", "source_added", "rebreached"]
    [(_, messages)] = _shown(db, page, T0 + 5 * STEP)
    assert messages[-2:] == ["B is also affected.", "B is failing again."]


def test_removed_breaching_source_blocks_automatic_recovery(db):
    _rule(db)
    a, b = _device(db), _device(db)
    page = seed_page(db, "main", items=[(_ref(a), "A"), (_ref(b), "B")])
    for i in range(3):
        _cycle(db, T0 + i * STEP, [(a, "offline"), (b, "offline")])
    _cycle(db, T0 + 3 * STEP, [(a, "online"), (b, "offline")])
    [incident] = _incidents(db)
    evaluator.remove_items_where(db, StatusPageItem.device_id == b.id)
    db.commit()
    _cycle(db, T0 + 4 * STEP, [(a, "online")])
    _cycle(db, T0 + 5 * STEP, [(a, "online")])
    assert incident.status == "investigating"
    assert _events(db, incident) == ["opened", "source_removed"]
    assert page.id in _audience(db, incident)


def test_removed_cleared_source_does_not_block_recovery(db):
    _rule(db)
    a, b = _device(db), _device(db)
    seed_page(db, "main", items=[(_ref(a), "A"), (_ref(b), "B")])
    for i in range(3):
        _cycle(db, T0 + i * STEP, [(a, "offline"), (b, "offline")])
    _cycle(db, T0 + 3 * STEP, [(a, "offline"), (b, "online")])
    evaluator.remove_items_where(db, StatusPageItem.device_id == b.id)
    db.commit()
    _cycle(db, T0 + 4 * STEP, [(a, "online")])
    [incident] = _incidents(db)
    assert incident.status == "monitoring"


def test_truncation_is_decided_per_streak_row(db):
    behind = _rule(db, incident_min_failures=20)
    current = _rule(db, incident_min_failures=20)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    for i in range(60):
        _check(db, router, T0 + i * STEP)
    behind_last = T0 + 9 * STEP - timedelta(seconds=30)
    for rule, last, streak in ((behind, behind_last, 7), (current, T0 + 57 * STEP, 2)):
        db.add(StatusBreachStreak(rule_id=rule.id, source_key=_ref(router).key, page_id=page.id, streak=streak,
                                  last_observed_at=last, rule_version=evaluator.rule_version(rule)))
    db.commit()
    evaluator.evaluate(db, [_ref(router)], T0 + 59 * STEP)
    assert _streak(db, current, _ref(router), page).streak == 4
    assert _streak(db, behind, _ref(router), page).streak == 50


def test_disabled_rule_still_lets_its_incident_recover(db):
    rule = _rule(db)
    router = _device(db)
    seed_page(db, "main", items=[(_ref(router), "Router")])
    last = _fail(db, router, 3)
    [incident] = _incidents(db)
    rule.enabled = False
    db.commit()
    _fail(db, router, 1, start=last + STEP)
    assert incident.status == "investigating"
    _cycle(db, last + 2 * STEP, [(router, "online")])
    assert incident.status == "monitoring"
    assert _events(db, incident) == ["opened", "recovered"]
    assert len(_incidents(db)) == 1


def test_disabled_rule_breach_returns_monitoring_incident_to_investigating(db):
    rule = _rule(db)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    last = _fail(db, router, 3)
    _cycle(db, last + STEP, [(router, "online")])
    [incident] = _incidents(db)
    assert incident.status == "monitoring"
    rule.enabled = False
    db.commit()
    assert _cycle(db, last + 2 * STEP, [(router, "offline")]) == {page.id}
    assert incident.status == "investigating"
    assert _events(db, incident) == ["opened", "recovered", "rebreached"]
    _fail(db, router, 4, start=last + 3 * STEP)
    assert len(_incidents(db)) == 1
    assert _events(db, incident) == ["opened", "recovered", "rebreached"]
    assert _streak(db, rule, _ref(router), page).streak == 0


def test_published_automatic_incident_still_recovers(db):
    _rule(db)
    router = _device(db)
    seed_page(db, "one", items=[(_ref(router), "Router")])
    user = User(username="ops", password_hash="x", role=UserRole.SUPER_ADMIN, is_active=True)
    db.add(user)
    db.commit()
    last = _fail(db, router, 3)
    [incident] = _incidents(db)
    other = seed_page(db, "other", items=[(_ref(router), "Core")])
    incidents.publish_to_pages(db, PersonActor(user), incident.id, [other.id], now=last)
    families = {s.condition_family for s in db.scalars(
        select(StatusIncidentSource).where(StatusIncidentSource.incident_id == incident.id)
    )}
    assert families == {"availability", "manual"}
    _cycle(db, last + STEP, [(router, "online")])
    assert incident.status == "monitoring"
    assert len(_incidents(db)) == 1


def test_deleted_rule_leaves_its_incident_for_a_person(db):
    rule = _rule(db)
    router = _device(db)
    seed_page(db, "main", items=[(_ref(router), "Router")])
    last = _fail(db, router, 3)
    [incident] = _incidents(db)
    db.delete(rule)
    db.commit()
    _cycle(db, last + STEP, [(router, "online")])
    assert incident.status == "investigating"


def test_maintenance_seam_resets_only_that_page(db, monkeypatch):
    rule = _rule(db)
    router = _device(db)
    one = seed_page(db, "one", items=[(_ref(router), "Router")])
    two = seed_page(db, "two", items=[(_ref(router), "Router")])
    assert maintenance.pages_in_maintenance(db, [_ref(router)], T0) == set()
    monkeypatch.setattr(maintenance, "pages_in_maintenance", lambda db, refs, now: {(_ref(router).key, one.id)})
    _fail(db, router, 3)
    assert _streak(db, rule, _ref(router), two).streak == 3
    assert _streak(db, rule, _ref(router), one) is None or _streak(db, rule, _ref(router), one).streak == 0
    [incident] = _incidents(db)
    assert _audience(db, incident) == {two.id}


def test_worker_evaluates_before_rebuilding_pages(monkeypatch):
    db = make_session()
    factory = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(cache_module, "SessionLocal", factory)
    instance = StatusSnapshotCache()
    monkeypatch.setattr(cache_module, "status_cache", instance)
    _rule(db)
    router = _device(db)
    ref = _ref(router)
    page = seed_page(db, "main", items=[(ref, "Router")])
    instance.load_registry()
    instance.drain(now=T0)
    for i in range(3):
        _check(db, router, T0 + i * STEP)
        events.notify_sources_checked([ref])
        assert instance.pending() == [page.id]
        instance.drain(now=T0 + i * STEP)
    assert len(_incidents(db)) == 1
    snap = instance.get(page.id, "public", T0 + 2 * STEP)
    body = json.loads(snap.body)
    assert [i["title"] for i in body["incidents"]] == ["Router unavailable"]
    db.close()


def test_item_removed_from_page_records_source_removed(db):
    _rule(db)
    router = _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    last = _fail(db, router, 3)
    [incident] = _incidents(db)
    db.query(StatusPageItem).delete()
    db.commit()
    assert _cycle(db, last + STEP, [(router, "offline")]) == {page.id}
    assert _events(db, incident) == ["opened", "source_removed"]
    assert incident.status == "investigating"
    assert _sources(db, incident, active=False) == [(_ref(router).key, page.id)]
    assert db.query(StatusBreachStreak).count() == 0


# --- source deletion through the API (Ruling H) ---------------------------------------------------


@pytest.fixture
def api(db, calls):
    Session = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
    admin = User(username="admin", password_hash="x", role=UserRole.SUPER_ADMIN, is_active=True)
    db.add(admin)
    db.commit()
    app = FastAPI()
    for module in (alerts_api, monitoring_api, monitors_api, topology_api):
        app.include_router(module.router, prefix="/api/v1")

    def override_db():
        session = Session()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: admin
    client = TestClient(app)
    client.calls = calls
    return client


def _removed(db, incident, page):
    assert incident.status == "investigating"
    assert _sources(db, incident) == []
    assert _events(db, incident)[-1] == "source_removed"
    [(_, messages)] = _shown(db, page, T0 + 10 * STEP)
    assert messages[-1] == "Monitoring source removed"


def test_deleted_source_records_removed_and_keeps_incident_open(api, db):
    _rule(db)
    router, other = _device(db), _device(db)
    page = seed_page(db, "main", items=[(_ref(router), "Router"), (_ref(other), "Other")])
    target = seed_service_check(db, None)
    service = SourceRef("service_check", device_id=router.id, port_target_id=target.id)
    group = db.scalar(select(StatusPageGroup).where(StatusPageGroup.page_id == page.id))
    db.add(StatusPageItem(page_id=page.id, group_id=group.id, kind="service_check", device_id=router.id,
                          port_target_id=target.id, display_name="Router web"))
    db.commit()
    _fail(db, router, 3)
    [incident] = _incidents(db)
    api.calls.clear()
    router_key, router_id = _ref(router).key, router.id

    assert api.delete(f"/api/v1/topology/devices/{router_id}").status_code == 204
    db.expire_all()
    keys = {SourceRef.from_item(i).key for i in db.scalars(select(StatusPageItem))}
    assert keys == {_ref(other).key}
    assert service.key not in keys
    assert page.id in api.calls[-1]
    _removed(db, incident, page)
    assert db.query(StatusBreachStreak).filter(StatusBreachStreak.source_key == router_key).count() == 0


def test_deleted_monitor_records_removed(api, db):
    _rule(db, "monitor_down", incident_min_failures=1)
    monitor = seed_monitor(db, check_interval_seconds=60)
    ref = SourceRef("monitor", monitor_id=monitor.id)
    page = seed_page(db, "main", items=[(ref, "Website")])
    _mcheck(db, monitor, T0, ok=False)
    evaluator.evaluate(db, [ref], T0)
    [incident] = _incidents(db)
    api.calls.clear()
    assert api.delete(f"/api/v1/monitors/{monitor.id}").status_code == 204
    db.expire_all()
    assert db.query(StatusPageItem).count() == 0
    assert page.id in api.calls[-1]
    _removed(db, incident, page)


def test_deleted_service_check_records_removed(api, db):
    _rule(db, "service_down", incident_min_failures=1)
    host = _device(db)
    target = seed_service_check(db, host.id)
    ref = SourceRef("service_check", device_id=host.id, port_target_id=target.id)
    page = seed_page(db, "main", items=[(ref, "Mail"), (_ref(host), "Host")])
    _check(db, host, T0, "online", ports=[{"target_id": target.id, "open": False}])
    evaluator.evaluate(db, [ref], T0)
    [incident] = _incidents(db)
    api.calls.clear()
    assert api.delete(f"/api/v1/monitoring/port-targets/{target.id}").status_code == 204
    db.expire_all()
    assert [i.kind for i in db.scalars(select(StatusPageItem))] == ["device"]
    assert page.id in api.calls[-1]
    _removed(db, incident, page)


def test_global_check_no_longer_applying_removes_other_devices_items(api, db):
    _rule(db, "service_down", incident_min_failures=1)
    keep, lose = _device(db), _device(db)
    target = seed_service_check(db, None)
    keep_ref = SourceRef("service_check", device_id=keep.id, port_target_id=target.id)
    lose_ref = SourceRef("service_check", device_id=lose.id, port_target_id=target.id)
    page = seed_page(db, "main", items=[(keep_ref, "Keep web"), (lose_ref, "Lose web")])
    _check(db, lose, T0, "online", ports=[{"target_id": target.id, "open": False}])
    evaluator.evaluate(db, [lose_ref], T0)
    [incident] = _incidents(db)
    api.calls.clear()
    response = api.put(f"/api/v1/monitoring/port-targets/{target.id}",
                       json={"device_id": keep.id, "port": 443, "label": "HTTPS"})
    assert response.status_code == 200
    db.expire_all()
    assert [SourceRef.from_item(i).key for i in db.scalars(select(StatusPageItem))] == [keep_ref.key]
    assert page.id in api.calls[-1]
    _removed(db, incident, page)


# --- alert rule API ------------------------------------------------------------------------------


def test_noisy_rule_types_default_off_and_status_change_rules_forced_off(api, db):
    def create(event_type, **extra):
        body = {"name": event_type, "event_type": event_type, **extra}
        if event_type in ("rtt_above", "service_slow", "monitor_slow"):
            body.setdefault("threshold_ms", 100)
        if event_type == "ping_loss_above":
            body.setdefault("loss_pct_threshold", 20)
        response = api.post("/api/v1/alerts/rules", json=body)
        assert response.status_code == 201, response.text
        return response.json()

    defaults = {}
    for event_type in ("device_offline", "device_unexpected_state", "service_down", "monitor_down",
                       "rtt_above", "ping_loss_above", "service_slow", "monitor_slow", "device_flapping",
                       "device_warning", "monitor_certificate_expiry"):
        made = create(event_type)
        defaults[event_type] = made["open_incident"]
        assert made["incident_min_failures"] == 3
    assert {k for k, v in defaults.items() if v} == {"device_offline", "device_unexpected_state", "service_down",
                                                      "monitor_down"}
    assert create("rtt_above", open_incident=True, incident_min_failures=20)["open_incident"] is True
    assert create("device_offline", open_incident=False)["open_incident"] is False
    for event_type in ("device_online", "any_status_change", "device_expected_state_restored"):
        assert create(event_type, open_incident=True)["open_incident"] is False

    rule = create("any_status_change")
    patched = api.patch(f"/api/v1/alerts/rules/{rule['id']}", json={"open_incident": True})
    assert patched.status_code == 200 and patched.json()["open_incident"] is False
    rule = create("device_offline")
    patched = api.patch(f"/api/v1/alerts/rules/{rule['id']}", json={"event_type": "device_online"})
    assert patched.json()["open_incident"] is False
    rule = create("rtt_above")
    patched = api.patch(f"/api/v1/alerts/rules/{rule['id']}", json={"open_incident": True, "incident_min_failures": 5})
    assert (patched.json()["open_incident"], patched.json()["incident_min_failures"]) == (True, 5)

    for bad in (0, 21):
        assert api.post("/api/v1/alerts/rules", json={
            "name": "x", "event_type": "device_offline", "incident_min_failures": bad,
        }).status_code == 422
        assert api.patch(f"/api/v1/alerts/rules/{rule['id']}", json={"incident_min_failures": bad}).status_code == 422
    listed = api.get("/api/v1/alerts/rules").json()
    assert all({"open_incident", "incident_min_failures"} <= set(r) for r in listed)


def test_deleting_a_rule_removes_its_streaks(api, db):
    rule = _rule(db)
    router = _device(db)
    seed_page(db, "main", items=[(_ref(router), "Router")])
    _fail(db, router, 1)
    assert db.query(StatusBreachStreak).count() == 1
    assert api.delete(f"/api/v1/alerts/rules/{rule.id}").status_code == 204
    db.expire_all()
    assert db.query(StatusBreachStreak).count() == 0


def test_resolving_while_still_breaching_requires_a_reason(db):
    from app.api.v1.status_pages import _incident_detail

    _rule(db)
    router = _device(db)
    seed_page(db, "main", items=[(_ref(router), "Router")])
    user = User(username="ops", password_hash="x", role=UserRole.SUPER_ADMIN, is_active=True)
    db.add(user)
    db.commit()
    last = _fail(db, router, 3)
    [incident] = _incidents(db)
    assert _incident_detail(db, [incident])[0]["breaching"] is True
    with pytest.raises(incidents.IncidentError, match="reason"):
        incidents.resolve(db, PersonActor(user), incident.id, None, now=last + timedelta(seconds=5))
    with pytest.raises(incidents.IncidentError, match="reason"):
        incidents.add_update(db, PersonActor(user), incident.id, None, True, None, "resolved", None, now=last + timedelta(seconds=5))
    db.rollback()
    assert incident.status == "investigating"

    _cycle(db, last + STEP, [(router, "online")])
    assert _incident_detail(db, [incident])[0]["breaching"] is False
    incidents.resolve(db, PersonActor(user), incident.id, None, now=last + 2 * STEP)
    assert incident.status == "resolved"
    assert _incident_detail(db, [incident])[0]["breaching"] is False


def test_stored_automatic_title_is_neutral_and_never_an_alias(db):
    _rule(db)
    router, switch = _device(db), _device(db)
    secret = seed_page(db, "secret", "private", items=[
        (_ref(router), "core-sw-01 (10.9.9.9) rack B"), (_ref(switch), "edge-sw-02 (10.9.9.10)"),
    ])
    public = seed_page(db, "public", items=[(_ref(router), "Network"), (_ref(switch), "Wifi")])
    for i in range(3):
        _cycle(db, T0 + i * STEP, [(router, "offline"), (switch, "offline")])
    [incident] = _incidents(db)
    assert incident.title == "2 systems unavailable"
    for alias in ("core-sw-01", "10.9.9.9", "edge-sw-02", "Network", "Wifi"):
        assert alias not in incident.title
    assert [t for t, _ in _shown(db, secret, T0 + 2 * STEP)] == ["core-sw-01 (10.9.9.9) rack B, edge-sw-02 (10.9.9.10) unavailable"]
    assert [t for t, _ in _shown(db, public, T0 + 2 * STEP)] == ["Network, Wifi unavailable"]


def test_neutral_titles_name_the_family_and_count():
    from app.services.status_pages import copy

    assert copy.neutral_title("availability", 1) == "1 system unavailable"
    assert copy.neutral_title("latency", 3) == "Slow responses: 3 systems"
    assert copy.neutral_title("unknown-family", 2) == "Warning: 2 systems"


def test_device_monitoring_changes_refresh_the_pages_showing_it(api, db):
    router, other = _device(db), _device(db)
    target = seed_service_check(db, router.id)
    page = seed_page(db, "main", items=[(SourceRef("service_check", device_id=router.id, port_target_id=target.id), "Web")])
    seed_page(db, "other", items=[(_ref(other), "Other")])
    for change in ({"monitoring_paused": True}, {"expected_status": "offline"}, {"ip_address": "10.1.1.1"}):
        api.calls.clear()
        assert api.patch(f"/api/v1/topology/devices/{router.id}", json=change).status_code == 200
        assert api.calls == [[page.id]]
    api.calls.clear()
    assert api.patch(f"/api/v1/topology/devices/{router.id}", json={"hostname": "renamed"}).status_code == 200
    assert api.calls == []


def test_monitor_enable_and_disable_refresh_the_pages_showing_it(api, db):
    monitor = seed_monitor(db, check_interval_seconds=60)
    page = seed_page(db, "main", items=[(SourceRef("monitor", monitor_id=monitor.id), "Website")])
    seed_page(db, "other")
    for enabled in (False, True):
        api.calls.clear()
        assert api.patch(f"/api/v1/monitors/{monitor.id}", json={"enabled": enabled}).status_code == 200
        assert api.calls == [[page.id]]
    api.calls.clear()
    assert api.patch(f"/api/v1/monitors/{monitor.id}", json={"name": "Renamed"}).status_code == 200
    assert api.calls == []


def test_alert_rule_changes_refresh_every_page(api, db):
    pages = sorted(seed_page(db, slug).id for slug in ("one", "two"))
    api.calls.clear()
    created = api.post("/api/v1/alerts/rules", json={
        "name": "Slow", "event_type": "rtt_above", "threshold_ms": 100, "channels": [],
    })
    assert created.status_code == 201, created.text
    assert api.calls == [pages]
    api.calls.clear()
    assert api.patch(f"/api/v1/alerts/rules/{created.json()['id']}", json={"threshold_ms": 50}).status_code == 200
    assert api.calls == [pages]
    api.calls.clear()
    assert api.delete(f"/api/v1/alerts/rules/{created.json()['id']}").status_code == 204
    assert api.calls == [pages]


def test_service_check_enable_and_disable_refresh_the_pages_showing_it(api, db):
    host = _device(db)
    target = seed_service_check(db, host.id, port=443, label="HTTPS")
    page = seed_page(db, "main", items=[(SourceRef("service_check", device_id=host.id, port_target_id=target.id), "Web")])
    seed_page(db, "other", items=[(_ref(_device(db)), "Other")])
    body = {"device_id": host.id, "port": 443, "label": "HTTPS", "check_type": "tcp"}
    for enabled in (False, True):
        api.calls.clear()
        assert api.put(f"/api/v1/monitoring/service-checks/{target.id}", json={**body, "enabled": enabled}).status_code == 200
        assert page.id in sum(api.calls, [])
    api.calls.clear()
    assert api.put(f"/api/v1/monitoring/service-checks/{target.id}", json={**body, "label": "Web"}).status_code == 200
    assert page.id not in sum(api.calls, [])

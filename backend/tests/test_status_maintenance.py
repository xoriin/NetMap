import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1 import status_pages as status_pages_api
from app.db.session import Base, get_db, import_all_models
from app.models.alert_event import AlertEvent
from app.models.alert_rule import AlertRule
from app.models.device import Device
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.monitor_history import DeviceMonitorHistory
from app.models.status_page import StatusIncident, StatusMaintenance
from app.models.system_setting import SystemSetting
from app.models.user import User, UserRole
from app.services.alerting import service as alerting_service
from app.services.monitoring.health import observed_is_healthy
from app.services.monitoring.port_checker import CheckResult
from app.services.monitors import service as monitors_service
from app.services.rbac import permissions
from app.services.status_pages import cache as cache_module
from app.services.status_pages import evaluator, events, maintenance
from app.services.status_pages.cache import StatusSnapshotCache
from app.services.status_pages.incidents import IncidentError, PersonActor
from app.services.status_pages.projection import build_page_payload
from app.services.status_pages.sources import SourceRef
from tests.status_page_helpers import seed_page

T0 = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)
STEP = timedelta(seconds=60)
SUPPRESS_DETAIL = {"detail": "Suppressing monitoring alerts also requires Manage alert rules"}


@pytest.fixture
def factory():
    import_all_models()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture
def db(factory):
    session = factory()
    session.add(SystemSetting(key="monitor_interval_seconds", value="60"))
    session.commit()
    yield session
    session.close()


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    changed: list[list[int]] = []
    monkeypatch.setattr(events, "notify_pages_changed", lambda ids: changed.append(sorted(set(ids))))
    maintenance.reset_pending_exits()
    yield changed
    maintenance.reset_pending_exits()
    permissions._cache.pop("PageManager", None)


def _user(db, name, role=UserRole.NETWORK_ADMIN):
    user = User(username=name, password_hash="x", role=role, is_active=True, display_name=name.title())
    db.add(user)
    db.commit()
    return user


def _admin(db):
    return PersonActor(_user(db, "admin"))


def _device(db, status="online", at=T0, **kw):
    n = db.query(Device).count() + 1
    device = Device(
        ip_address=f"10.0.0.{n}", hostname=f"host{n}", monitor_status=status, last_monitored_at=at, **kw,
    )
    db.add(device)
    db.commit()
    return device


def _ref(device):
    return SourceRef("device", device_id=device.id)


def _check(db, device, at, status="offline"):
    expected = device.expected_status or "online"
    db.add(DeviceMonitorHistory(
        device_id=device.id, checked_at=at, status=status, expected_status=expected,
        is_healthy=observed_is_healthy(status, expected), rtt_ms=None, port_results="[]",
    ))
    device.monitor_status = status
    device.last_monitored_at = at
    db.commit()


def _window(db, actor, items, start, end, pages=None, suppress=False, now=None, title="Core switch upgrade"):
    return maintenance.create_window(
        db, actor, title, "Firmware", start, end, items, pages, suppress, now=now or start - STEP,
    )


def _item(payload, index=0):
    return payload["groups"][0]["items"][index]


def _rule(db, event_type="device_offline", **kw):
    kw.setdefault("name", event_type)
    kw.setdefault("channels", '["ops"]')
    kw.setdefault("open_incident", True)
    kw.setdefault("incident_min_failures", 3)
    rule = AlertRule(event_type=event_type, **kw)
    db.add(rule)
    db.commit()
    return rule


@pytest.fixture
def api(factory, db, monkeypatch):
    app = FastAPI()
    app.include_router(status_pages_api.router, prefix="/api/v1")
    current = {}

    def override_db():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    permissions.set_role_permissions("PageManager", ["status_page_manage"])
    admin = _user(db, "admin")
    manager = _user(db, "manager", "PageManager")
    device = _device(db)
    page = seed_page(db, "main", items=[(_ref(device), "Router")])
    return SimpleNamespace(
        client=TestClient(app), current=current, admin=admin, manager=manager, device=device, page=page,
    )


def _as(api, user):
    api.current["user"] = user
    return api.client


def _body(api, **kw):
    start = datetime.now(timezone.utc) + timedelta(days=1)
    body = {
        "title": "Core switch upgrade", "description": "Firmware",
        "starts_at": start.isoformat(), "ends_at": (start + timedelta(minutes=30)).isoformat(),
        "items": [{"device": api.device.id}], "page_ids": [api.page.id],
    }
    body.update(kw)
    return body


def test_window_input_with_offset_is_stored_as_utc_instant(api, db):
    client = _as(api, api.admin)
    response = client.post("/api/v1/status-pages/maintenance", json=_body(
        api, starts_at="2030-10-18T22:00:00+10:00", ends_at="2030-10-18T22:30:00+10:00",
    ))
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["starts_at"] == "2030-10-18T12:00:00+00:00"
    assert body["ends_at"] == "2030-10-18T12:30:00+00:00"
    db.expire_all()
    stored = db.get(StatusMaintenance, body["id"])
    assert stored.starts_at.replace(tzinfo=timezone.utc) == datetime(2030, 10, 18, 12, 0, tzinfo=timezone.utc)

    naive = client.post("/api/v1/status-pages/maintenance", json=_body(
        api, starts_at="2030-10-18T22:00:00", ends_at="2030-10-18T22:30:00",
    ))
    assert naive.status_code == 422
    with pytest.raises(IncidentError):
        maintenance.create_window(
            db, PersonActor(api.admin), "t", None, datetime(2030, 1, 1), datetime(2030, 1, 2),
            [_ref(api.device)], None, False,
        )
    assert len(db.scalars(select(StatusMaintenance)).all()) == 1


def test_end_before_start_is_rejected(api, db):
    client = _as(api, api.admin)
    start = datetime.now(timezone.utc) + timedelta(days=1)
    for end in (start, start - timedelta(minutes=5)):
        response = client.post("/api/v1/status-pages/maintenance", json=_body(
            api, starts_at=start.isoformat(), ends_at=end.isoformat(),
        ))
        assert response.status_code == 422, response.text
    with pytest.raises(IncidentError):
        _window(db, PersonActor(api.admin), [_ref(api.device)], T0, T0, now=T0 - STEP)
    assert db.scalars(select(StatusMaintenance)).all() == []

    created = client.post("/api/v1/status-pages/maintenance", json=_body(api)).json()
    moved = client.patch(f"/api/v1/status-pages/maintenance/{created['id']}", json={"ends_at": created["starts_at"]})
    assert moved.status_code == 422


def test_page_maintenance_only_affects_that_page(db):
    router = _device(db, status="offline")
    one = seed_page(db, "one", items=[(_ref(router), "Router")])
    two = seed_page(db, "two", items=[(_ref(router), "Router")])
    window = _window(db, _admin(db), [_ref(router)], T0 - STEP, T0 + timedelta(minutes=30), pages=[one.id])

    first = build_page_payload(db, one, "public", T0)
    second = build_page_payload(db, two, "public", T0)
    assert _item(first)["state"] == "maintenance"
    assert first["summary"]["state"] == "maintenance"
    assert [(m["id"], m["active"]) for m in first["maintenance"]] == [(window.id, True)]
    assert _item(second)["state"] == "down"
    assert second["maintenance"] == []
    assert maintenance.active_page_maintenance(db, two.id, T0) == {}
    assert set(maintenance.active_page_maintenance(db, one.id, T0)) == {_ref(router).key}
    assert evaluator.pages_in_maintenance(db, [_ref(router)], T0) == {(_ref(router).key, one.id)}
    assert maintenance.globally_suppressed(db, T0) == set()


def test_global_suppression_shows_maintenance_on_all_pages(db):
    router = _device(db, status="offline")
    one = seed_page(db, "one", items=[(_ref(router), "Router")])
    two = seed_page(db, "two", items=[(_ref(router), "Router")])
    _window(db, _admin(db), [_ref(router)], T0 - STEP, T0 + timedelta(minutes=30), pages=[one.id], suppress=True)

    assert maintenance.globally_suppressed(db, T0) == {_ref(router).key}
    for page in (one, two):
        payload = build_page_payload(db, page, "public", T0)
        assert _item(payload)["state"] == "maintenance"
        assert payload["summary"]["state"] == "maintenance"
    assert evaluator.pages_in_maintenance(db, [_ref(router)], T0) == {(_ref(router).key, one.id), (_ref(router).key, two.id)}
    assert maintenance.globally_suppressed(db, T0 + timedelta(minutes=30)) == set()


def test_suppression_requires_alert_write_even_for_title_edit(api, db):
    manager = _as(api, api.manager)
    refused = manager.post("/api/v1/status-pages/maintenance", json=_body(api, suppress_alerts=True))
    assert refused.status_code == 403 and refused.json() == SUPPRESS_DETAIL
    assert db.scalars(select(StatusMaintenance)).all() == []

    own = manager.post("/api/v1/status-pages/maintenance", json=_body(api))
    assert own.status_code == 201, own.text
    assert manager.patch(f"/api/v1/status-pages/maintenance/{own.json()['id']}", json={"title": "Renamed"}).status_code == 200
    escalate = manager.patch(f"/api/v1/status-pages/maintenance/{own.json()['id']}", json={"suppress_alerts": True})
    assert escalate.status_code == 403 and escalate.json() == SUPPRESS_DETAIL

    admin = _as(api, api.admin)
    silenced = admin.post("/api/v1/status-pages/maintenance", json=_body(api, suppress_alerts=True))
    assert silenced.status_code == 201, silenced.text
    window_id = silenced.json()["id"]
    assert silenced.json()["suppress_alerts"] is True

    manager = _as(api, api.manager)
    for method, body in (("PATCH", {"title": "Renamed"}), ("PATCH", {"suppress_alerts": False}), ("DELETE", None)):
        response = manager.request(method, f"/api/v1/status-pages/maintenance/{window_id}", json=body)
        assert response.status_code == 403 and response.json() == SUPPRESS_DETAIL, (method, body)
    db.expire_all()
    stored = db.get(StatusMaintenance, window_id)
    assert (stored.title, stored.suppress_alerts) == ("Core switch upgrade", True)
    assert [w["id"] for w in manager.get("/api/v1/status-pages/maintenance").json()] == [own.json()["id"], window_id]

    admin = _as(api, api.admin)
    assert admin.patch(f"/api/v1/status-pages/maintenance/{window_id}", json={"title": "Renamed"}).status_code == 200
    assert admin.delete(f"/api/v1/status-pages/maintenance/{window_id}").status_code == 204


def _worker_env(factory, monkeypatch):
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(alerting_service, "SessionLocal", factory)
    monkeypatch.setattr(alerting_service, "load_notification_settings", lambda db: {})
    monkeypatch.setattr(alerting_service, "list_notification_profiles", lambda *a, **kw: [])
    monkeypatch.setattr(alerting_service, "send_notification_target", lambda channel, message, *a: sent.append((channel, message)) or "ok")
    monkeypatch.setattr(events, "notify_sources_checked", lambda refs: None)
    worker = alerting_service.AlertMonitorService()
    monkeypatch.setattr(worker, "_prune_history", lambda: None)
    monkeypatch.setattr(worker, "_get_app_name", lambda db: "NetMap")
    monkeypatch.setattr(worker, "_probe_device_status", lambda d: ("offline", None))
    return worker, sent


def _monitor_env(factory, monkeypatch):
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(monitors_service, "SessionLocal", factory)
    monkeypatch.setattr(monitors_service, "load_notification_settings", lambda db: {})
    monkeypatch.setattr(monitors_service, "list_notification_profiles", lambda *a, **kw: [])
    monkeypatch.setattr(monitors_service, "send_notification_target", lambda channel, message, *a: sent.append((channel, message)) or "ok")
    monkeypatch.setattr(monitors_service, "check_url", lambda *a, **k: CheckResult(open=False, response_time_ms=None, status_code=500, error="HTTP 500"))
    monkeypatch.setattr(events, "notify_sources_checked", lambda refs: None)
    service = monitors_service.StandaloneMonitorService()
    monkeypatch.setattr(service, "_prune_history", lambda: None)
    return service, sent


def _monitor(db, **kw):
    kw.setdefault("consecutive_failures", 0)
    monitor = Monitor(name="Site", url="https://example.test/", check_interval_seconds=30, max_retries=0, enabled=True, **kw)
    db.add(monitor)
    db.commit()
    return monitor


def test_suppressed_notification_does_not_advance_cooldown(factory, db, monkeypatch):
    now = datetime.now(timezone.utc)
    router = _device(db, at=now - STEP)
    rule = _rule(db, cooldown_minutes=30)
    site = _monitor(db, last_status="online")
    monitor_rule = _rule(db, "monitor_down", cooldown_minutes=30)
    _window(
        db, _admin(db), [_ref(router), SourceRef("monitor", monitor_id=site.id)], now - STEP, now + timedelta(hours=1),
        suppress=True, now=now - STEP,
    )
    worker, sent = _worker_env(factory, monkeypatch)
    worker._known, worker._known_health, worker._initialized = {router.id: "online"}, {router.id: "healthy"}, True
    assert worker._check()
    service, monitor_sent = _monitor_env(factory, monkeypatch)
    service._tick()

    assert sent == [] and monitor_sent == []
    db.expire_all()
    assert db.get(AlertRule, rule.id).last_triggered_at is None
    assert db.get(AlertRule, monitor_rule.id).last_triggered_at is None
    assert db.scalars(select(AlertEvent)).all() == []
    assert db.get(Monitor, site.id).last_status == "offline"


def test_exit_renotifies_once_when_still_breaching_without_transition(factory, db, monkeypatch):
    now = datetime.now(timezone.utc)
    router = _device(db, status="offline", at=now - STEP)
    cooling = _device(db, status="offline", at=now - STEP)
    rule = _rule(db, cooldown_minutes=30, device_id=router.id)
    recent = _rule(db, name="recent", cooldown_minutes=30, device_id=cooling.id, last_triggered_at=now - timedelta(minutes=5))
    site = _monitor(db, last_status="offline", consecutive_failures=3, last_checked_at=now - timedelta(minutes=5))
    monitor_rule = _rule(db, "monitor_down", cooldown_minutes=30)
    _window(
        db, _admin(db), [_ref(router), _ref(cooling), SourceRef("monitor", monitor_id=site.id)],
        now - timedelta(hours=2), now - timedelta(seconds=5), suppress=True, now=now - timedelta(hours=3),
    )
    worker, sent = _worker_env(factory, monkeypatch)
    worker._known = {router.id: "offline", cooling.id: "offline"}
    worker._known_health = {router.id: "unhealthy", cooling.id: "unhealthy"}
    worker._initialized = True
    assert worker._check()
    service, monitor_sent = _monitor_env(factory, monkeypatch)
    service._tick()

    assert len(sent) == 1 and "OFFLINE" in sent[0][1] and router.hostname in sent[0][1]
    assert len(monitor_sent) == 1 and "DOWN" in monitor_sent[0][1]
    db.expire_all()
    assert db.get(AlertRule, rule.id).last_triggered_at is not None
    assert db.get(AlertRule, monitor_rule.id).last_triggered_at is not None
    assert db.get(AlertRule, recent.id).last_triggered_at.replace(tzinfo=timezone.utc) < now
    assert [e.alert_rule_id for e in db.scalars(select(AlertEvent).order_by(AlertEvent.id))] == [rule.id, monitor_rule.id]

    db.execute(AlertRule.__table__.update().values(last_triggered_at=None))
    db.execute(Monitor.__table__.update().values(last_checked_at=now - timedelta(minutes=5)))
    db.commit()
    assert worker._check()
    service._tick()
    assert len(sent) == 1 and len(monitor_sent) == 1


def test_overlapping_windows_suppress_until_last_ends(db):
    router, switch = _device(db), _device(db)
    seed_page(db, "main", items=[(_ref(router), "Router"), (_ref(switch), "Switch")])
    actor = _admin(db)
    _window(db, actor, [_ref(router)], T0, T0 + timedelta(hours=1), suppress=True)
    _window(db, actor, [_ref(router)], T0 + timedelta(minutes=30), T0 + timedelta(hours=2), suppress=True)
    _window(db, actor, [_ref(switch)], T0, T0 + timedelta(hours=1), suppress=True)
    _window(db, actor, [_ref(switch)], T0, T0 + timedelta(minutes=10), title="presentation only")

    middle = T0 + timedelta(minutes=90)
    assert maintenance.globally_suppressed(db, middle) == {_ref(router).key}
    assert maintenance.take_exit_reevaluations(db, middle, kinds={"monitor"}) == set()
    assert maintenance.take_exit_reevaluations(db, middle) == {_ref(switch).key}
    db.commit()
    assert maintenance.take_exit_reevaluations(db, middle) == set()

    after = T0 + timedelta(hours=2)
    assert maintenance.globally_suppressed(db, after) == set()
    assert maintenance.take_exit_reevaluations(db, after) == {_ref(router).key}
    db.commit()
    assert maintenance.take_exit_reevaluations(db, after + STEP) == set()
    assert all(w.exit_processed for w in db.scalars(select(StatusMaintenance).where(StatusMaintenance.suppress_alerts == True)))  # noqa: E712


def test_no_auto_incident_or_streak_during_maintenance_and_restart_after(db):
    rule = _rule(db)
    router = _device(db, at=T0 - 2 * STEP)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    other = seed_page(db, "other", items=[(_ref(router), "Router")])
    _window(db, _admin(db), [_ref(router)], T0, T0 + 5 * STEP, pages=[page.id], now=T0 - 2 * STEP)
    _check(db, router, T0 - STEP, "online")
    evaluator.evaluate(db, [_ref(router)], T0 - STEP)

    for i in range(5):
        _check(db, router, T0 + i * STEP)
        evaluator.evaluate(db, [_ref(router)], T0 + i * STEP)
    on_page = [i for i in db.scalars(select(StatusIncident))]
    assert len(on_page) == 1
    assert evaluator._audience(db, [on_page[0].id])[on_page[0].id] == {other.id}

    from app.models.status_page import StatusBreachStreak

    def streak():
        row = db.scalar(select(StatusBreachStreak).where(
            StatusBreachStreak.rule_id == rule.id, StatusBreachStreak.page_id == page.id,
        ))
        return row.streak if row else 0

    assert streak() == 0
    for i, expected in ((5, 1), (6, 2)):
        _check(db, router, T0 + i * STEP)
        evaluator.evaluate(db, [_ref(router)], T0 + i * STEP)
        assert streak() == expected
        assert len(db.scalars(select(StatusIncident)).all()) == 1
    _check(db, router, T0 + 7 * STEP)
    evaluator.evaluate(db, [_ref(router)], T0 + 7 * STEP)
    assert streak() == 3
    incidents = db.scalars(select(StatusIncident).order_by(StatusIncident.id)).all()
    assert len(incidents) == 2
    assert evaluator._audience(db, [incidents[1].id])[incidents[1].id] == {page.id}


def test_existing_incident_not_resolved_by_maintenance(db):
    _rule(db)
    router = _device(db, at=T0 - STEP)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    for i in range(3):
        _check(db, router, T0 + i * STEP)
        evaluator.evaluate(db, [_ref(router)], T0 + i * STEP)
    (incident,) = db.scalars(select(StatusIncident)).all()
    start = T0 + 3 * STEP
    _window(db, _admin(db), [_ref(router)], start, start + 3 * STEP, suppress=True, now=start - timedelta(seconds=1))

    for i in range(3):
        _check(db, router, start + i * STEP, "online")
        evaluator.evaluate(db, [_ref(router)], start + i * STEP)
    db.refresh(incident)
    assert incident.status == "investigating" and incident.resolved_at is None
    payload = build_page_payload(db, page, "public", start + 2 * STEP)
    assert [i["id"] for i in payload["incidents"]] == [incident.id]
    assert _item(payload)["state"] == "maintenance"

    _check(db, router, start + 3 * STEP, "online")
    evaluator.evaluate(db, [_ref(router)], start + 3 * STEP)
    db.refresh(incident)
    assert incident.status == "monitoring"


def test_maintenance_excluded_from_availability_denominator(db):
    now = T0
    router = _device(db, at=now)
    one = seed_page(db, "one", items=[(_ref(router), "Router")])
    two = seed_page(db, "two", items=[(_ref(router), "Router")])
    _window(db, _admin(db), [_ref(router)], now - timedelta(minutes=40), now - timedelta(minutes=20), pages=[one.id],
            now=now - timedelta(hours=2))
    for minute in range(70, -1, -1):
        at = now - timedelta(minutes=minute)
        _check(db, router, at, "offline" if now - timedelta(minutes=40) <= at < now - timedelta(minutes=20) else "online")

    first = build_page_payload(db, one, "public", now)
    second = build_page_payload(db, two, "public", now)
    assert _item(first)["state"] == "operational"
    assert _item(first)["availability"] == {"percent": 1.0, "label": "ok", "coverage": 1.0}
    assert "maintenance" in _item(first)["heartbeats"] and "unhealthy" not in _item(first)["heartbeats"]
    assert _item(second)["availability"]["percent"] == pytest.approx(39 / 59, abs=0.001)
    assert "maintenance" not in _item(second)["heartbeats"]
    assert [(p["kind"], p["title"]) for p in first["past"]] == [("maintenance", "Core switch upgrade")]
    assert set(first["past"][0]) == {"kind", "id", "title", "description", "starts_at", "ends_at"}
    assert second["past"] == []


def test_upcoming_shown_within_seven_days_only(db):
    router = _device(db, at=T0)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    actor = _admin(db)
    soon = _window(db, actor, [_ref(router)], T0 + timedelta(days=6), T0 + timedelta(days=6, minutes=30), now=T0, title="Soon")
    later = _window(
        db, actor, [_ref(router)], T0 + timedelta(days=7, seconds=10), T0 + timedelta(days=7, minutes=30), now=T0,
        title="Later",
    )

    payload = build_page_payload(db, page, "public", T0)
    assert [(m["title"], m["active"]) for m in payload["maintenance"]] == [("Soon", False)]
    (entry,) = payload["maintenance"]
    assert entry == {
        "id": soon.id, "title": "Soon", "description": "Firmware", "active": False,
        "starts_at": (T0 + timedelta(days=6)).isoformat(), "ends_at": (T0 + timedelta(days=6, minutes=30)).isoformat(),
    }
    assert payload["valid_until"] == (T0 + timedelta(seconds=10)).isoformat()
    assert _item(payload)["state"] == "operational"

    lead = build_page_payload(db, page, "public", T0 + timedelta(seconds=10))
    assert [m["id"] for m in lead["maintenance"]] == [soon.id, later.id]


def test_window_edges_rebuild_pages_when_probes_stop(factory, db, monkeypatch):
    monkeypatch.setattr(cache_module, "SessionLocal", factory)
    cache = StatusSnapshotCache()
    router = _device(db, at=T0)
    page = seed_page(db, "main", items=[(_ref(router), "Router")])
    start, end = T0 + timedelta(seconds=10), T0 + timedelta(seconds=70)
    _window(db, _admin(db), [_ref(router)], start, end, now=T0)

    cache.load_registry()
    cache.drain(now=T0)
    first = cache.get(page.id, "public", T0)
    assert first.valid_until == start
    assert json.loads(first.body)["groups"][0]["items"][0]["state"] == "operational"

    assert cache.run_timer_once(start) == [page.id]
    cache.drain(now=start)
    during = json.loads(cache.get(page.id, "public", start).body)
    assert during["groups"][0]["items"][0]["state"] == "maintenance"
    assert [m["active"] for m in during["maintenance"]] == [True]

    at = start
    while (snap := cache.get(page.id, "public", at)) is not None and snap.valid_until <= end:
        at = snap.valid_until
        assert cache.run_timer_once(at) == [page.id]
        cache.drain(now=at)
    assert at == end
    after = json.loads(cache.get(page.id, "public", end).body)
    assert after["maintenance"] == []
    assert [p["kind"] for p in after["past"]] == ["maintenance"]
    assert after["groups"][0]["items"][0]["state"] == "operational"
    cache.stop()


def test_monitor_history_rows_are_unaffected_by_suppression(factory, db, monkeypatch):
    now = datetime.now(timezone.utc)
    site = _monitor(db, last_status="online")
    _rule(db, "monitor_down", cooldown_minutes=30)
    _window(db, _admin(db), [SourceRef("monitor", monitor_id=site.id)], now - STEP, now + timedelta(hours=1),
            suppress=True, now=now - STEP)
    service, sent = _monitor_env(factory, monkeypatch)
    service._tick()
    assert sent == []
    assert len(db.scalars(select(MonitorCheckHistory)).all()) == 1

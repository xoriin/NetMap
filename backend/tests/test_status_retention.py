import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.models.alert_rule import AlertRule
from app.models.monitor import Monitor
from app.models.port_target import DevicePortTarget
from app.models.status_page import (
    StatusBreachStreak,
    StatusIdempotencyKey,
    StatusIncident,
    StatusIncidentAlias,
    StatusIncidentPage,
    StatusIncidentSource,
    StatusIncidentUpdate,
    StatusIntegrationToken,
    StatusMaintenance,
    StatusMaintenanceExit,
    StatusMaintenanceItem,
    StatusMaintenancePage,
    StatusNotice,
)
from app.services.status_pages import cache as cache_module
from app.services.status_pages import retention
from app.services.status_pages.cache import StatusSnapshotCache
from tests.status_page_helpers import seed_device, seed_page
from tests.test_status_cache import factory  # noqa: F401

NOW = datetime(2026, 10, 17, 12, 0, 0, tzinfo=timezone.utc)
OLD = NOW - timedelta(days=366)
RECENT = NOW - timedelta(days=364)


def count(db, model) -> int:
    return db.scalar(select(func.count()).select_from(model))


def add_incident(db, page_id, status="resolved", resolved_at=OLD, updates=3):
    incident = StatusIncident(
        title="x", source="netmap", status=status, opened_at=OLD - timedelta(days=1), resolved_at=resolved_at,
    )
    db.add(incident)
    db.flush()
    db.add(StatusIncidentPage(incident_id=incident.id, page_id=page_id))
    db.add(StatusIncidentSource(incident_id=incident.id, source_key=f"device:{incident.id}", condition_family="down", page_id=page_id))
    db.add(StatusIncidentAlias(incident_id=incident.id, page_id=page_id, source_key="device:1", display_name="d"))
    db.add(StatusIncidentUpdate(incident_id=incident.id, page_id=None, author_kind="netmap", event_code="published"))
    for _ in range(updates - 1):
        db.add(StatusIncidentUpdate(incident_id=incident.id, page_id=page_id, author_kind="netmap", message="m"))
    db.commit()
    return incident


def add_maintenance(db, page_id, ends_at, starts_at=None):
    window = StatusMaintenance(title="m", starts_at=starts_at or ends_at - timedelta(hours=2), ends_at=ends_at)
    db.add(window)
    db.flush()
    db.add(StatusMaintenanceItem(maintenance_id=window.id, kind="device", device_id=1))
    db.add(StatusMaintenancePage(maintenance_id=window.id, page_id=page_id))
    db.commit()
    return window


def test_active_incident_never_pruned(factory):  # noqa: F811
    with factory() as db:
        page = seed_page(db, "p")
        ancient = NOW - timedelta(days=4000)
        active = add_incident(db, page.id, status="investigating", resolved_at=None)
        active.opened_at = ancient
        stale_resolved_at = add_incident(db, page.id, status="monitoring", resolved_at=ancient)
        db.commit()
        ids = {active.id, stale_resolved_at.id}
        updates_before = count(db, StatusIncidentUpdate)
    result = retention.prune(factory, NOW)
    with factory() as db:
        assert {i.id for i in db.scalars(select(StatusIncident))} == ids
        assert count(db, StatusIncidentUpdate) == updates_before
    assert result["incidents"] == 0


def test_closed_records_pruned_after_365_days(factory):  # noqa: F811
    with factory() as db:
        page = seed_page(db, "p")
        rule = AlertRule(name="r", event_type="device_down")
        db.add(rule)
        token = StatusIntegrationToken(name="t", prefix="p", hash="h")
        db.add(token)
        db.flush()
        old = add_incident(db, page.id)
        recent = add_incident(db, page.id, resolved_at=RECENT)
        db.add(StatusNotice(page_id=page.id, owner_kind="user", owner_id=1, title="old", expires_at=OLD))
        db.add(StatusNotice(page_id=page.id, owner_kind="user", owner_id=2, title="recent", expires_at=RECENT))
        db.add(StatusNotice(page_id=page.id, owner_kind="user", owner_id=3, title="never", expires_at=None))
        old_window = add_maintenance(db, page.id, OLD)
        recent_window = add_maintenance(db, page.id, RECENT)
        db.add(StatusIdempotencyKey(token_id=token.id, operation="o", key="old", created_at=NOW - timedelta(hours=25)))
        db.add(StatusIdempotencyKey(token_id=token.id, operation="o", key="new", created_at=NOW - timedelta(hours=23)))
        db.add(StatusBreachStreak(rule_id=rule.id, source_key="device:1", page_id=page.id))
        db.add(StatusBreachStreak(rule_id=rule.id + 99, source_key="device:2", page_id=page.id))
        live = seed_device(db)
        db.add(StatusMaintenanceExit(source_key=f"device:{live.id}", maintenance_id=old_window.id, created_at=NOW))
        db.commit()
        old_id, recent_id = old.id, recent.id
        old_window_id, recent_window_id = old_window.id, recent_window.id

    result = retention.prune(factory, NOW)

    with factory() as db:
        assert [i.id for i in db.scalars(select(StatusIncident))] == [recent_id]
        for model in (StatusIncidentUpdate, StatusIncidentSource, StatusIncidentPage, StatusIncidentAlias):
            assert {r.incident_id for r in db.scalars(select(model))} == {recent_id}
        assert count(db, StatusIncidentUpdate) == 3
        assert {n.title for n in db.scalars(select(StatusNotice))} == {"recent", "never"}
        assert [w.id for w in db.scalars(select(StatusMaintenance))] == [recent_window_id]
        assert {r.maintenance_id for r in db.scalars(select(StatusMaintenanceItem))} == {recent_window_id}
        assert {r.maintenance_id for r in db.scalars(select(StatusMaintenancePage))} == {recent_window_id}
        assert [k.key for k in db.scalars(select(StatusIdempotencyKey))] == ["new"]
        assert [s.source_key for s in db.scalars(select(StatusBreachStreak))] == ["device:1"]
        assert count(db, StatusMaintenanceExit) == 1
    assert old_id != recent_id and old_window_id != recent_window_id
    assert result == {
        "incidents": 1, "notices": 1, "maintenance": 1, "idempotency_keys": 1, "breach_streaks": 1,
        "maintenance_exits": 0,
    }


def test_maintenance_retention_uses_end_time(factory):  # noqa: F811
    with factory() as db:
        page = seed_page(db, "p")
        long_running = add_maintenance(db, page.id, RECENT, starts_at=NOW - timedelta(days=800))
        short_old = add_maintenance(db, page.id, OLD, starts_at=OLD - timedelta(hours=1))
        keep_id = long_running.id
        assert short_old.id != keep_id
    retention.prune(factory, NOW)
    with factory() as db:
        assert [w.id for w in db.scalars(select(StatusMaintenance))] == [keep_id]


def test_prune_is_batched(factory, monkeypatch):  # noqa: F811
    with factory() as db:
        page = seed_page(db, "p")
        for _ in range(7):
            add_incident(db, page.id, updates=1)
        for _ in range(7):
            add_maintenance(db, page.id, OLD)
    commits = []

    class Counting:
        def __init__(self, session):
            self.session = session

        def __enter__(self):
            self.session.__enter__()
            real = self.session.commit
            self.session.commit = lambda: (commits.append(1), real())[1]
            return self.session

        def __exit__(self, *args):
            return self.session.__exit__(*args)

    counting = lambda: Counting(factory())  # noqa: E731
    result = retention.prune(counting, NOW, batch_size=3)
    assert result["incidents"] == 7 and result["maintenance"] == 7
    assert len(commits) >= 6
    with factory() as db:
        assert count(db, StatusIncident) == 0 and count(db, StatusIncidentUpdate) == 0
        assert count(db, StatusMaintenance) == 0 and count(db, StatusMaintenanceItem) == 0


def test_published_marker_deleted_only_with_incident(factory):  # noqa: F811
    with factory() as db:
        page = seed_page(db, "p")
        incident = add_incident(db, page.id, resolved_at=RECENT)
        marker_id = db.scalar(select(StatusIncidentUpdate.id).where(StatusIncidentUpdate.event_code == "published"))
        old_update = db.scalars(select(StatusIncidentUpdate).where(StatusIncidentUpdate.page_id == page.id)).first()
        old_update.created_at = OLD
        db.commit()
        updates = count(db, StatusIncidentUpdate)
    retention.prune(factory, NOW)
    with factory() as db:
        assert count(db, StatusIncidentUpdate) == updates
        assert db.get(StatusIncidentUpdate, marker_id) is not None
        assert db.get(StatusIncident, incident.id) is not None


def test_timer_prunes_at_most_once_per_day_and_survives_errors(factory, monkeypatch, caplog):  # noqa: F811
    monkeypatch.setattr(cache_module, "SessionLocal", factory)
    calls = []

    def fake_prune(db_factory, now):
        calls.append(now)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return {}

    monkeypatch.setattr(cache_module.retention, "prune", fake_prune)
    cache = StatusSnapshotCache()
    cache.ready = True
    with caplog.at_level(logging.ERROR):
        cache.maybe_prune(NOW)
        cache.maybe_prune(NOW + timedelta(hours=1))
        assert len(calls) == 1
        cache.maybe_prune(NOW + timedelta(hours=23, minutes=59))
        assert len(calls) == 1
        cache.maybe_prune(NOW + timedelta(hours=24, minutes=1))
        assert len(calls) == 2
    assert "Status page retention" in caplog.text


def test_maintenance_exits_pruned_when_source_is_gone_or_older_than_30_days(factory):  # noqa: F811
    with factory() as db:
        device, gone = seed_device(db), seed_device(db)
        monitor = Monitor(name="m", url="https://example.test")
        target = DevicePortTarget(device_id=device.id, port=443, label="https")
        shared = DevicePortTarget(device_id=None, port=22, label="ssh")
        db.add_all([monitor, target, shared])
        db.flush()
        fresh = NOW - timedelta(days=1)
        keep = {
            f"device:{device.id}": fresh,
            f"monitor:{monitor.id}": fresh,
            f"service:{device.id}:{target.id}": fresh,
            f"service:{device.id}:{shared.id}": NOW - timedelta(days=29),
        }
        drop = {
            f"device:{gone.id}": fresh,
            f"monitor:{monitor.id + 50}": fresh,
            f"service:{device.id}:{target.id + 50}": fresh,
            f"service:{gone.id}:{shared.id}": fresh,
            f"service:{gone.id}:{target.id}": fresh,
            "bogus": fresh,
        }
        db.delete(gone)
        db.commit()
        for key, at in {**keep, **drop}.items():
            db.add(StatusMaintenanceExit(source_key=key, maintenance_id=None, created_at=at))
        db.commit()
        db.execute(StatusMaintenanceExit.__table__.update().where(
            StatusMaintenanceExit.source_key == f"device:{device.id}"
        ).values(created_at=NOW - timedelta(days=31)))
        db.commit()
        keep.pop(f"device:{device.id}")

    result = retention.prune(factory, NOW)

    with factory() as db:
        assert set(db.scalars(select(StatusMaintenanceExit.source_key))) == set(keep)
    assert result["maintenance_exits"] == len(drop) + 1

import fcntl
import hashlib
import json
import logging
import subprocess
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1 import status_pages as status_pages_api
from app.db.session import Base, get_db, import_all_models
from app.models.device import Device
from app.models.monitor import Monitor
from app.models.port_target import DevicePortTarget
from app.models.user import User, UserRole
from app.services.alerting import service as alerting_service
from app.services.monitoring.port_checker import CheckResult
from app.services.monitors import service as monitors_service
from app.services.status_pages import cache as cache_module
from app.services.status_pages import events, worker_lock
from app.services.status_pages.cache import RegistryEntry, StatusSnapshotCache
from app.services.status_pages.sources import SourceRef
from tests.status_page_helpers import seed_device, seed_page

T0 = datetime(2026, 10, 17, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def factory():
    import_all_models()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture
def cache(factory, monkeypatch):
    monkeypatch.setattr(cache_module, "SessionLocal", factory)
    instance = StatusSnapshotCache()
    yield instance
    instance.stop()


def _seed(factory, slug="media", visibility="public", items=()):
    with factory() as db:
        return seed_page(db, slug, visibility, items).id


def test_unknown_slug_lookup_never_touches_db(cache, factory, monkeypatch):
    page_id = _seed(factory)
    cache.load_registry()
    cache.drain(now=T0)

    def explode(*a, **kw):
        raise AssertionError("database touched")

    monkeypatch.setattr(cache_module, "SessionLocal", explode)
    monkeypatch.setattr(cache_module, "load_page", explode)
    for slug in ("nope", "../media", "", "x" * 200, "MEDIA"):
        assert cache.lookup(slug) is None
    assert cache.pending() == []
    assert cache.lookup("media") == RegistryEntry(page_id, "media", "public", 0)
    assert cache.get(page_id, "public", T0) is not None
    assert cache.get(999, "public", T0) is None
    cache.drain(now=T0)


def test_expired_snapshot_is_not_served(cache, factory):
    page_id = _seed(factory)
    cache.load_registry()
    assert cache.build_now(page_id, now=T0)
    snap = cache.get(page_id, "public", T0)
    assert snap is not None
    assert T0 < snap.valid_until <= T0 + timedelta(seconds=30)
    assert cache.get(page_id, "public", snap.valid_until - timedelta(microseconds=1)) is snap
    assert cache.get(page_id, "public", snap.valid_until) is None
    assert cache.get(page_id, "public", snap.valid_until + timedelta(hours=1)) is None


def test_snapshot_body_and_etag(cache, factory):
    page_id = _seed(factory)
    cache.load_registry()
    cache.build_now(page_id, now=T0)
    snap = cache.get(page_id, "public", T0)
    payload = json.loads(snap.body)
    assert payload["slug"] == "media"
    assert snap.body == json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    assert snap.generated_at == T0
    assert snap.etag == '"' + hashlib.sha256(b"public" + b"0" + snap.body).hexdigest()[:32] + '"'
    assert cache.get(page_id, "private", T0) is None


def test_private_page_has_only_a_private_snapshot(cache, factory):
    page_id = _seed(factory, visibility="private")
    cache.load_registry()
    cache.build_now(page_id, now=T0)
    assert cache.get(page_id, "public", T0) is None
    assert cache.get(page_id, "private", T0) is not None


@pytest.fixture
def api(factory, cache, monkeypatch):
    with factory() as db:
        db.add(User(username="admin", password_hash="x", role=UserRole.NETWORK_ADMIN, is_active=True))
        db.commit()
    app = FastAPI()
    app.include_router(status_pages_api.router, prefix="/api/v1")

    def override_db():
        with factory() as db:
            yield db

    def override_user():
        with factory() as db:
            return db.scalar(select(User))

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    monkeypatch.setattr(status_pages_api, "status_cache", cache)
    monkeypatch.setattr(cache_module, "status_cache", cache)
    return TestClient(app)


def test_switching_to_private_removes_public_snapshot_before_return(api, cache, factory, monkeypatch):
    page_id = _seed(factory)
    cache.load_registry()
    cache.build_now(page_id, now=T0)
    assert cache.get(page_id, "public", T0) is not None
    monkeypatch.setattr(events, "notify_pages_changed", lambda ids: None)

    response = api.patch(f"/api/v1/status-pages/{page_id}", json={"visibility": "private"})

    assert response.status_code == 200
    assert cache.get(page_id, "public", T0) is None
    assert cache.lookup("media") == RegistryEntry(page_id, "media", "private", 1)


def test_slug_change_and_delete_remove_snapshot_before_return(api, cache, factory, monkeypatch):
    page_id = _seed(factory)
    cache.load_registry()
    cache.build_now(page_id, now=T0)
    monkeypatch.setattr(events, "notify_pages_changed", lambda ids: None)

    assert api.patch(f"/api/v1/status-pages/{page_id}", json={"slug": "renamed"}).status_code == 200
    assert cache.lookup("media") is None
    assert cache.lookup("renamed") == RegistryEntry(page_id, "renamed", "public", 1)
    assert cache.get(page_id, "public", T0) is None

    cache.build_now(page_id, now=T0)
    assert cache.get(page_id, "public", T0).generation == 1
    assert api.delete(f"/api/v1/status-pages/{page_id}").status_code == 204
    assert cache.lookup("renamed") is None
    assert cache.get(page_id, "public", T0) is None
    assert cache.build_now(page_id, now=T0) is False


def test_title_change_keeps_registry_and_schedules_rebuild(api, cache, factory):
    page_id = _seed(factory)
    cache.load_registry()
    cache.drain(now=T0)
    assert api.patch(f"/api/v1/status-pages/{page_id}", json={"title": "Media status"}).status_code == 200
    assert cache.lookup("media") == RegistryEntry(page_id, "media", "public", 0)
    assert cache.pending() == [page_id]
    cache.drain(now=T0)
    assert json.loads(cache.get(page_id, "public", T0).body)["title"] == "Media status"


def test_created_page_is_registered(api, cache):
    cache.load_registry()
    body = api.post("/api/v1/status-pages", json={"name": "New", "slug": "fresh"}).json()
    assert cache.lookup("fresh") == RegistryEntry(body["id"], "fresh", "public", 0)
    assert cache.pending() == [body["id"]]


def test_stale_generation_build_is_discarded(cache, factory, monkeypatch):
    page_id = _seed(factory)
    cache.load_registry()
    entered, release = threading.Event(), threading.Event()
    real = cache_module.load_page

    def slow(db, page, now, cycle):
        inputs = real(db, page, now, cycle)
        entered.set()
        assert release.wait(5)
        return inputs

    monkeypatch.setattr(cache_module, "load_page", slow)
    result = {}
    worker = threading.Thread(target=lambda: result.update(ok=cache.build_now(page_id, now=T0)))
    worker.start()
    assert entered.wait(5)
    cache.remove_page_sync(page_id, replacement=RegistryEntry(page_id, "media", "private", 1))
    release.set()
    worker.join(5)

    assert result == {"ok": False}
    assert cache.get(page_id, "public", T0) is None
    assert cache.get(page_id, "private", T0) is None


def test_older_mutation_cannot_overwrite_newer_registry_entry(cache, factory):
    page_id = _seed(factory)
    cache.load_registry()
    cache.remove_page_sync(page_id, replacement=RegistryEntry(page_id, "media", "private", 2))
    cache.remove_page_sync(page_id, replacement=RegistryEntry(page_id, "media", "public", 1))
    assert cache.lookup("media") == RegistryEntry(page_id, "media", "private", 2)


def test_concurrent_requests_trigger_one_build(cache, factory, monkeypatch, tmp_path):
    page_id = _seed(factory)
    calls, entered, release = [], threading.Event(), threading.Event()
    real = cache_module.load_page

    def counted(db, page, now, cycle):
        calls.append(page.id)
        entered.set()
        assert release.wait(5)
        return real(db, page, now, cycle)

    monkeypatch.setattr(cache_module, "load_page", counted)
    cache.start(data_dir=str(tmp_path), timer=False)
    assert cache.ready
    assert entered.wait(5)

    barrier = threading.Barrier(20)

    def hammer():
        barrier.wait(5)
        cache.request_build(page_id)

    threads = [threading.Thread(target=hammer) for _ in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    release.set()
    assert cache.wait_idle(5)
    assert calls == [page_id]
    assert cache.get(page_id, "public", datetime.now(timezone.utc)) is not None


def test_notification_during_build_rebuilds_once_after(cache, factory, monkeypatch):
    with factory() as db:
        device = seed_device(db)
    ref = SourceRef("device", device_id=device.id)
    page_id = _seed(factory, items=[(ref, "Router")])
    cache.load_registry()
    calls, entered, release = [], threading.Event(), threading.Event()
    real = cache_module.load_page

    def counted(db, page, now, cycle):
        calls.append(page.id)
        if len(calls) == 1:
            entered.set()
            assert release.wait(5)
        return real(db, page, now, cycle)

    monkeypatch.setattr(cache_module, "load_page", counted)
    worker = threading.Thread(target=lambda: cache.drain(now=T0))
    worker.start()
    assert entered.wait(5)
    cache.invalidate_sources([ref.key, "device:999"])
    cache.invalidate_sources([ref.key])
    release.set()
    worker.join(5)
    assert calls == [page_id, page_id]
    assert cache.pending() == []


def test_sources_map_to_their_pages_only(cache, factory):
    with factory() as db:
        a, b = seed_device(db), seed_device(db)
    page_a = _seed(factory, "a", items=[(SourceRef("device", device_id=a.id), "A")])
    _seed(factory, "b", items=[(SourceRef("device", device_id=b.id), "B")])
    cache.load_registry()
    cache.drain(now=T0)
    cache.invalidate_sources([SourceRef("device", device_id=a.id).key, "monitor:42"])
    assert cache.pending() == [page_a]


def test_events_enqueue_on_the_singleton_and_return(cache, factory, monkeypatch):
    with factory() as db:
        device = seed_device(db)
    ref = SourceRef("device", device_id=device.id)
    page_id = _seed(factory, items=[(ref, "Router")])
    monkeypatch.setattr(cache_module, "status_cache", cache)
    cache.load_registry()
    cache.drain(now=T0)
    events.notify_sources_checked([ref])
    assert cache.pending() == [page_id]
    cache.drain(now=T0)
    events.notify_pages_changed([page_id, 999])
    assert cache.pending() == [page_id]


def test_unstarted_cache_ignores_notifications(monkeypatch, factory):
    instance = StatusSnapshotCache()
    monkeypatch.setattr(cache_module, "status_cache", instance)
    monkeypatch.setattr(cache_module, "SessionLocal", lambda: (_ for _ in ()).throw(AssertionError("db")))
    events.notify_pages_changed([1])
    events.notify_sources_checked([SourceRef("monitor", monitor_id=1)])
    instance.request_build(1)
    assert instance.pending() == []
    assert instance.ready is False


def test_second_process_cannot_take_worker_lock(tmp_path):
    assert worker_lock.acquire(str(tmp_path))
    try:
        code = (
            "import sys\n"
            "from app.services.status_pages import worker_lock\n"
            "print(worker_lock.acquire(sys.argv[1]))\n"
        )
        backend = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [sys.executable, "-c", code, str(tmp_path)], cwd=backend, capture_output=True, text=True, timeout=60,
        )
        assert result.stdout.strip() == "False", result.stderr
        assert (tmp_path / "status-pages.lock").exists()
    finally:
        worker_lock.release()
    result = subprocess.run(
        [sys.executable, "-c", code, str(tmp_path)], cwd=backend, capture_output=True, text=True, timeout=60,
    )
    assert result.stdout.strip() == "True", result.stderr


def test_lock_held_elsewhere_keeps_cache_disabled_without_failing(cache, factory, tmp_path, caplog):
    _seed(factory)
    caplog.set_level(logging.WARNING)
    with open(tmp_path / "status-pages.lock", "a+") as other:
        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        cache.start(data_dir=str(tmp_path), timer=False)
        assert cache.ready is False
        assert cache.lookup("media") is None
        assert "status-pages.lock" in caplog.text
        assert not [t for t in threading.enumerate() if t.name.startswith("status-pages")]


def test_unwritable_data_dir_keeps_cache_disabled(cache, tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("")
    cache.start(data_dir=str(blocker / "data"), timer=False)
    assert cache.ready is False


def test_stop_joins_background_threads(cache, factory, tmp_path):
    _seed(factory)
    cache.start(data_dir=str(tmp_path), timer=True)
    assert cache.wait_idle(5)
    cache.stop()
    assert not [t for t in threading.enumerate() if t.name.startswith("status-pages")]
    assert cache.ready is False
    assert worker_lock.acquire(str(tmp_path))
    worker_lock.release()


def test_timer_rebuilds_when_probes_stop(cache, factory):
    page_id = _seed(factory)
    cache.load_registry()
    cache.build_now(page_id, now=T0)
    first = cache.get(page_id, "public", T0)
    assert first.valid_until == T0 + timedelta(seconds=30)

    assert cache.run_timer_once(T0 + timedelta(seconds=5)) == []
    assert cache.pending() == []
    due = first.valid_until - cache_module.REFRESH_LEAD
    assert cache.run_timer_once(due) == [page_id]
    cache.drain(now=due)
    second = cache.get(page_id, "public", due)
    assert second.generated_at == due
    assert cache.get(page_id, "public", first.valid_until) is second
    assert cache.timer_delay(due) <= cache_module.TIMER_SECONDS


def test_timer_rebuilds_exactly_at_a_deadline_it_cannot_refresh_early(cache, factory):
    page_id = _seed(factory)
    cache.load_registry()
    late = T0 + timedelta(seconds=40)
    cache.build_now(page_id, now=late)
    snap = cache.get(page_id, "public", late)
    assert snap.valid_until == T0 + timedelta(seconds=60)
    inside = snap.valid_until - timedelta(seconds=1)
    assert cache.run_timer_once(inside) == [page_id]
    cache.drain(now=inside)
    rebuilt = cache.get(page_id, "public", inside)
    assert rebuilt.valid_until == snap.valid_until
    assert cache.run_timer_once(inside + timedelta(milliseconds=500)) == []
    assert cache.timer_delay(inside) == pytest.approx(1.0)
    assert cache.run_timer_once(snap.valid_until) == [page_id]


def test_timer_retries_missing_snapshots_but_not_in_a_tight_loop(cache, factory, monkeypatch):
    page_id = _seed(factory)
    cache.load_registry()
    monkeypatch.setattr(cache_module, "load_page", lambda *a: (_ for _ in ()).throw(RuntimeError("boom")))
    assert cache.build_now(page_id, now=T0) is False
    assert cache.run_timer_once(T0 + timedelta(seconds=1)) == []
    assert cache.timer_delay(T0 + timedelta(seconds=1)) == pytest.approx(cache_module.TIMER_SECONDS - 1)
    assert cache.run_timer_once(T0 + timedelta(seconds=cache_module.TIMER_SECONDS)) == [page_id]


class _RecordingSession(Session):
    log: list = []
    open_count = [0]

    def __enter__(self):
        self.open_count[0] += 1
        return super().__enter__()

    def __exit__(self, *exc):
        self.open_count[0] -= 1
        return super().__exit__(*exc)

    def commit(self):
        super().commit()
        self.log.append(("commit", self.open_count[0]))


def _recording_factory(factory, log):
    _RecordingSession.log = log
    _RecordingSession.open_count = [0]
    return sessionmaker(bind=factory.kw["bind"], class_=_RecordingSession, autoflush=False)


def test_device_loop_calls_notify_after_commit(factory, monkeypatch):
    log = []
    with factory() as db:
        db.add_all([Device(id=n, ip_address=f"10.0.0.{n}", status="online", lifecycle="active", monitoring_paused=False) for n in (1, 2)])
        db.add_all([DevicePortTarget(id=1, port=443, label="Global", enabled=True), DevicePortTarget(id=2, device_id=1, port=22, label="SSH", enabled=True)])
        db.commit()
    monkeypatch.setattr(alerting_service, "SessionLocal", _recording_factory(factory, log))
    monkeypatch.setattr(alerting_service, "load_notification_settings", lambda db: {})
    monkeypatch.setattr(alerting_service, "list_notification_profiles", lambda *a, **kw: [])
    monkeypatch.setattr(
        alerting_service, "check_port",
        lambda *a, **kw: SimpleNamespace(open=True, response_time_ms=1, status_code=None, error=None),
    )
    monkeypatch.setattr(
        events, "notify_sources_checked",
        lambda refs: log.append(("notify", _RecordingSession.open_count[0], sorted(r.key for r in refs))),
    )
    worker = alerting_service.AlertMonitorService()
    monkeypatch.setattr(worker, "_prune_history", lambda: None)
    monkeypatch.setattr(worker, "_get_app_name", lambda db: "NetMap")
    monkeypatch.setattr(worker, "_probe_device_status", lambda d: ("online", 1.0))

    assert worker._check()

    notify = [entry for entry in log if entry[0] == "notify"]
    assert notify == [("notify", 0, ["device:1", "device:2", "service:1:1", "service:1:2", "service:2:1"])]
    assert log.index(notify[0]) > max(i for i, entry in enumerate(log) if entry[0] == "commit")


def test_monitor_loop_calls_notify_after_phase_three_commit(factory, monkeypatch):
    log = []
    with factory() as db:
        db.add(Monitor(
            id=7, name="Site", url="https://example.test/", http_method="GET", expected_status_min=200,
            expected_status_max=399, timeout_seconds=5.0, check_interval_seconds=30, max_retries=0, enabled=True,
            consecutive_failures=0,
        ))
        db.commit()
    monkeypatch.setattr(monitors_service, "SessionLocal", _recording_factory(factory, log))
    monkeypatch.setattr(monitors_service, "check_url", lambda *a, **k: CheckResult(open=True, response_time_ms=5.0, status_code=200))
    monkeypatch.setattr(
        events, "notify_sources_checked",
        lambda refs: log.append(("notify", _RecordingSession.open_count[0], sorted(r.key for r in refs))),
    )
    service = monitors_service.StandaloneMonitorService()
    monkeypatch.setattr(service, "_prune_history", lambda: None)
    service._tick()

    notify = [entry for entry in log if entry[0] == "notify"]
    assert notify == [("notify", 0, ["monitor:7"])]
    assert log.index(notify[0]) > max(i for i, entry in enumerate(log) if entry[0] == "commit")


def test_build_in_flight_across_a_restore_cannot_publish(cache, factory, monkeypatch):
    page_id = _seed(factory)
    cache.load_registry()
    entered, release = threading.Event(), threading.Event()
    real = cache_module.load_page

    def slow(db, page, now, cycle):
        inputs = real(db, page, now, cycle)
        entered.set()
        assert release.wait(5)
        return inputs

    monkeypatch.setattr(cache_module, "load_page", slow)
    result = {}
    worker = threading.Thread(target=lambda: result.update(ok=cache.build_now(page_id, now=T0)))
    worker.start()
    assert entered.wait(5)
    cache.reset_from_db()
    release.set()
    worker.join(5)
    assert result == {"ok": False}
    assert cache.get(page_id, "public", T0) is None
    monkeypatch.setattr(cache_module, "load_page", real)
    cache.drain(now=T0)
    assert cache.get(page_id, "public", T0) is not None


def test_reset_forgets_floors_snapshots_and_pending_work(cache, factory):
    page_id = _seed(factory)
    cache.load_registry()
    cache.drain(now=T0)
    cache.remove_page_sync(page_id)
    assert cache.lookup("media") is None
    cache.reset_from_db()
    assert cache.lookup("media") == RegistryEntry(page_id, "media", "public", 0)
    assert cache.get(page_id, "public", T0) is None
    assert cache.pending() == [page_id]


def test_equal_registry_entries_are_not_interchangeable(cache, factory):
    page_id = _seed(factory)
    cache.load_registry()
    stale = cache.entry(page_id)
    cache.register_page(RegistryEntry(page_id, "media", "public", 0))
    assert cache.entry(page_id) == stale and cache.entry(page_id) is not stale
    cache.remove_page_sync(page_id, only=stale)
    assert cache.lookup("media") is not None
    cache.remove_page_sync(page_id, only=cache.entry(page_id))
    assert cache.lookup("media") is None

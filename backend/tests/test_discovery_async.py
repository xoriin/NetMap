"""Manual discovery scans are queued and run on a background worker; the dialog polls them."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, text

from app.api.v1 import discovery as discovery_api
from app.db import session as db_session
from app.models.discovery import DiscoveryScan
from app.models.user import UserRole
from app.schemas.discovery import DiscoveryHost
from app.services.discovery import manual, scheduled
from tests.app_helpers import add_user, memory_factory, real_app_client


@pytest.fixture
def factory(monkeypatch):
    factory = memory_factory()
    monkeypatch.setattr(manual, "SessionLocal", factory)
    discovery_api.last_scan_by_user.clear()
    yield factory
    discovery_api.last_scan_by_user.clear()


@pytest.fixture
def submitted(monkeypatch):
    jobs: list = []
    monkeypatch.setattr(manual, "submit", jobs.append)
    return jobs


def _admin(factory):
    with factory() as db:
        return add_user(db, "scanner", UserRole.SUPER_ADMIN)


def test_start_scan_queues_and_returns_immediately(factory, submitted) -> None:
    user = _admin(factory)
    with real_app_client(factory, user) as client:
        response = client.post("/api/v1/discovery/scans", json={"target": "192.168.1.0/28", "scan_type": "ping"})
    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "queued"
    assert body["results"] == []
    assert body["started_at"] is None
    assert body["progress"] == {"done": 0, "total": 16}
    assert [job.scan_id for job in submitted] == [body["id"]]


def test_start_scan_while_one_is_active_returns_409_with_scan_id(factory, submitted) -> None:
    user = _admin(factory)
    with real_app_client(factory, user) as client:
        first = client.post("/api/v1/discovery/scans", json={"target": "192.168.1.0/28"}).json()
        discovery_api.last_scan_by_user.clear()
        second = client.post("/api/v1/discovery/scans", json={"target": "192.168.2.0/28"})
    assert second.status_code == 409
    assert second.json()["scan_id"] == first["id"]
    assert "already running" in second.json()["detail"]
    assert len(submitted) == 1


def test_scheduled_scan_does_not_block_a_manual_one(factory, submitted) -> None:
    user = _admin(factory)
    with factory() as db:
        db.add(DiscoveryScan(actor_user_id=user.id, schedule_id=None, target="10.0.0.0/24", scan_type="ping", status="completed", host_count=256))
        db.commit()
    with real_app_client(factory, user) as client:
        response = client.post("/api/v1/discovery/scans", json={"target": "192.168.1.0/28"})
    assert response.status_code == 202


def test_invalid_target_is_refused_before_queueing(factory, submitted) -> None:
    user = _admin(factory)
    with real_app_client(factory, user) as client:
        response = client.post("/api/v1/discovery/scans", json={"target": "8.8.8.8"})
    assert response.status_code == 400
    assert submitted == []
    with factory() as db:
        assert db.query(DiscoveryScan).count() == 0


def test_get_scan_reports_progress_and_404(factory, submitted) -> None:
    user = _admin(factory)
    with real_app_client(factory, user) as client:
        scan_id = client.post("/api/v1/discovery/scans", json={"target": "192.168.1.0/28"}).json()["id"]
        with factory() as db:
            scan = db.get(DiscoveryScan, scan_id)
            scan.status = "running"
            scan.started_at = datetime.now(timezone.utc)
            scan.progress_done = 5
            db.commit()
        running = client.get(f"/api/v1/discovery/scans/{scan_id}")
        missing = client.get("/api/v1/discovery/scans/999")
    assert running.status_code == 200
    assert running.json()["status"] == "running"
    assert running.json()["started_at"].endswith("Z")
    assert running.json()["progress"] == {"done": 5, "total": 16}
    assert missing.status_code == 404


def test_worker_runs_the_queued_scan_and_records_progress(factory, submitted, monkeypatch) -> None:
    user = _admin(factory)

    def fake_nmap(target, scan_type, on_progress=None):
        on_progress(8)
        on_progress(16)
        return [DiscoveryHost(ip_address="192.168.1.5", hostname="printer.lan")]

    monkeypatch.setattr(scheduled, "run_nmap_scan", fake_nmap)
    monkeypatch.setattr(manual, "PROGRESS_WRITE_INTERVAL_SECONDS", 0)
    with real_app_client(factory, user) as client:
        scan_id = client.post("/api/v1/discovery/scans", json={"target": "192.168.1.0/28"}).json()["id"]
        manual.run_manual_scan(submitted[0])
        finished = client.get(f"/api/v1/discovery/scans/{scan_id}").json()
    assert finished["status"] == "completed"
    assert finished["started_at"] is not None
    assert finished["completed_at"] is not None
    assert finished["progress"] == {"done": 16, "total": 16}
    assert [host["hostname"] for host in finished["results"]] == ["printer.lan"]


def test_worker_marks_the_scan_failed_on_an_unexpected_error(factory, submitted, monkeypatch) -> None:
    user = _admin(factory)
    monkeypatch.setattr(manual, "run_discovery_scan", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))
    with real_app_client(factory, user) as client:
        scan_id = client.post("/api/v1/discovery/scans", json={"target": "192.168.1.0/28"}).json()["id"]
        manual.run_manual_scan(submitted[0])
        finished = client.get(f"/api/v1/discovery/scans/{scan_id}").json()
    assert finished["status"] == "failed"
    assert finished["error"] == "boom"


def test_startup_cleanup_fails_queued_and_running_scans(factory, monkeypatch) -> None:
    from app import main

    user = _admin(factory)
    with factory() as db:
        for state in ("queued", "running", "completed"):
            db.add(DiscoveryScan(actor_user_id=user.id, target="10.0.0.0/24", scan_type="ping", status=state, host_count=256))
        db.commit()
    monkeypatch.setattr(main, "SessionLocal", factory)
    main._cleanup_stuck_scans()
    with factory() as db:
        assert sorted(scan.status for scan in db.query(DiscoveryScan).all()) == ["completed", "failed", "failed"]


def test_migration_0090_adds_progress_columns() -> None:
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE discovery_scans (id INTEGER PRIMARY KEY, status VARCHAR(40))"))
        db_session._migrate_discovery_scan_progress(conn, None)
        db_session._migrate_discovery_scan_progress(conn, None)
        columns = db_session._live_columns(conn, "discovery_scans")
    assert {"started_at", "progress_done"} <= columns

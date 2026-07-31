from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import threading
from unittest.mock import Mock

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.monitors import (
    create_monitor,
    delete_monitor,
    get_monitor_history,
    list_monitors,
    update_monitor,
)
from app.db.session import Base
from app.models import device, site, snmp_profile, topology_group  # noqa: F401  (mapper config)
from app.models.alert_event import AlertEvent
from app.models.alert_rule import AlertRule
from app.models.audit_log import AuditLog
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.notification_delivery import NotificationDelivery
from app.models.notification_profile import NotificationProfile
from app.models.system_setting import SystemSetting
from app.schemas.monitor import MonitorCreate, MonitorUpdate
from app.services.monitoring.port_checker import CheckResult, check_url
from app.services.monitors import service as monitors_service_module
from app.services.monitors.service import StandaloneMonitorService


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(
        engine,
        tables=[
            Monitor.__table__, MonitorCheckHistory.__table__, AlertRule.__table__,
            AlertEvent.__table__, NotificationDelivery.__table__, SystemSetting.__table__,
            NotificationProfile.__table__, AuditLog.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def _monitor(**kwargs) -> Monitor:
    defaults = dict(
        name="Example", url="https://example.com/", http_method="GET",
        expected_status_min=200, expected_status_max=399, timeout_seconds=10.0,
        verify_tls=True, follow_redirects=True, check_interval_seconds=60,
        max_retries=0, enabled=True, consecutive_failures=0, last_status=None, last_checked_at=None,
    )
    defaults.update(kwargs)
    return Monitor(**defaults)


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        code = 500 if self.path == "/broken" else 200
        self.send_response(code)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode()
        payload = json.dumps({"status": "healthy", "received": body, "key": self.headers.get("X-Health-Key")}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def _http_server():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


# ---------------------------------------------------------------------------
# check_url
# ---------------------------------------------------------------------------

def test_check_url_up_down_and_invalid_scheme():
    server = _http_server()
    port = server.server_address[1]
    try:
        result = check_url(f"http://127.0.0.1:{port}/", 3.0)
        assert result.open is True
        assert result.status_code == 200
        assert result.response_time_ms is not None

        broken = check_url(f"http://127.0.0.1:{port}/broken", 3.0)
        assert broken.open is False
        assert broken.status_code == 500
    finally:
        server.shutdown()

    assert check_url("ftp://example.com/", 3.0).open is False


def test_check_url_supports_request_options_and_response_assertions():
    server = _http_server()
    port = server.server_address[1]
    try:
        result = check_url(
            f"http://127.0.0.1:{port}/api", 3.0,
            method="POST", accepted_status_codes="200,201,204",
            headers={"X-Health-Key": "secret"}, body='{"probe":true}',
            body_encoding="json", keyword='"healthy"',
            json_path="$.key", json_operator="equals", expected_value="secret",
        )
        assert result.open is True
        assert result.status_code == 201
        assert result.response_size_bytes and result.response_size_bytes > 0
        assert result.assertion_detail == "Response assertions passed"

        failed = check_url(
            f"http://127.0.0.1:{port}/api", 3.0,
            method="POST", accepted_status_codes="201",
            json_path="$.status", json_operator="equals", expected_value="down",
        )
        assert failed.open is False
        assert failed.error == "JSON assertion failed at $.status"

        inverted = check_url(
            f"http://127.0.0.1:{port}/broken", 3.0,
            accepted_status_codes="200-299", upside_down=True,
        )
        assert inverted.open is True
    finally:
        server.shutdown()


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------

def test_monitor_create_validates_url_and_method_and_status_range():
    ok = MonitorCreate(name="Example", url="https://example.com/health")
    assert ok.http_method == "GET"

    with pytest.raises(ValidationError):
        MonitorCreate(name="Bad URL", url="not-a-url")

    with pytest.raises(ValidationError):
        MonitorCreate(name="Bad scheme", url="ftp://example.com")

    with pytest.raises(ValidationError):
        MonitorCreate(name="Bad method", url="https://example.com", http_method="TRACE")

    with pytest.raises(ValidationError):
        MonitorCreate(name="Bad range", url="https://example.com", expected_status_min=500, expected_status_max=200)


def test_monitor_create_defaults_verify_tls_true():
    # standalone monitors default to verifying certs, unlike device LAN checks
    monitor = MonitorCreate(name="Example", url="https://example.com")
    assert monitor.verify_tls is True


# ---------------------------------------------------------------------------
# CRUD endpoints
# ---------------------------------------------------------------------------

def test_monitor_crud_lifecycle():
    db = _session()
    actor = Mock(id=1, role="SuperAdmin")

    created = create_monitor(
        MonitorCreate(name="Example", url="https://example.com/", check_interval_seconds=30),
        actor, db,
    )
    assert created.id is not None
    assert created.last_status is None
    assert created.uptime_24h is None

    listed = list_monitors(actor, db)
    assert len(listed) == 1
    assert listed[0].name == "Example"

    updated = update_monitor(created.id, MonitorUpdate(name="Renamed", check_interval_seconds=45), actor, db)
    assert updated.name == "Renamed"
    assert updated.check_interval_seconds == 45

    delete_monitor(created.id, actor, db)
    assert list_monitors(actor, db) == []


def test_monitor_secrets_are_encrypted_and_redacted_from_reads():
    db = _session()
    actor = Mock(id=1, role="SuperAdmin")
    created = create_monitor(MonitorCreate(
        name="Secured", url="https://example.com/", auth_type="basic",
        auth_username="probe", auth_password="correct horse",
        request_headers={"X-Key": "header secret"}, request_body='{"token":"body secret"}',
        tags=["production", "api"],
    ), actor, db)
    row = db.get(Monitor, created.id)
    assert row.auth_password_encrypted != "correct horse"
    assert "header secret" not in (row.request_headers_encrypted or "")
    assert "body secret" not in (row.request_body_encrypted or "")
    assert created.has_auth_password is True
    assert created.has_request_headers is True
    assert created.has_request_body is True
    assert created.tags == ["production", "api"]
    assert not hasattr(created, "auth_password")

    update_monitor(created.id, MonitorUpdate(description="Health endpoint"), actor, db)
    db.refresh(row)
    assert row.auth_password_encrypted is not None


def test_monitor_crud_requires_write_permission():
    db = _session()
    viewer = Mock(id=2, role="Viewer")
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        create_monitor(MonitorCreate(name="Example", url="https://example.com/"), viewer, db)
    assert exc_info.value.status_code == 403


def test_monitor_history_and_uptime_computation():
    db = _session()
    actor = Mock(id=1, role="SuperAdmin")
    monitor = _monitor()
    db.add(monitor)
    db.commit()
    db.refresh(monitor)

    now = datetime.now(timezone.utc)
    db.add_all([
        MonitorCheckHistory(monitor_id=monitor.id, checked_at=now - timedelta(minutes=1), status="online", response_time_ms=100.0, status_code=200),
        MonitorCheckHistory(monitor_id=monitor.id, checked_at=now - timedelta(minutes=2), status="online", response_time_ms=200.0, status_code=200),
        MonitorCheckHistory(monitor_id=monitor.id, checked_at=now - timedelta(minutes=3), status="offline", response_time_ms=None, status_code=None),
    ])
    db.commit()

    reads = list_monitors(actor, db)
    assert len(reads) == 1
    assert reads[0].uptime_24h == pytest.approx(66.7, abs=0.1)
    assert reads[0].avg_response_time_24h == 150.0

    history = get_monitor_history(monitor.id, actor, db, hours=24)
    assert len(history) == 3


# ---------------------------------------------------------------------------
# StandaloneMonitorService scheduling and retries
# ---------------------------------------------------------------------------

def test_tick_skips_monitors_not_yet_due(monkeypatch):
    db = _session()
    now = datetime.now(timezone.utc)
    monitor = _monitor(check_interval_seconds=300, last_status="online", last_checked_at=now - timedelta(seconds=10))
    db.add(monitor)
    db.commit()

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(monitors_service_module, "SessionLocal", factory)
    monkeypatch.setattr(monitors_service_module, "check_url", lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not check")))

    service = StandaloneMonitorService()
    service._tick()  # should be a no-op — nothing due yet


def test_tick_checks_due_monitor_and_records_history(monkeypatch):
    db = _session()
    monitor = _monitor(check_interval_seconds=30)
    db.add(monitor)
    db.commit()
    db.refresh(monitor)
    monitor_id = monitor.id

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(monitors_service_module, "SessionLocal", factory)
    monkeypatch.setattr(monitors_service_module, "check_url", lambda *a, **k: CheckResult(open=True, response_time_ms=42.0, status_code=200))

    service = StandaloneMonitorService()
    service._tick()

    db.expire_all()
    refreshed = db.get(Monitor, monitor_id)
    assert refreshed.last_status == "online"
    assert refreshed.last_checked_at is not None
    assert refreshed.consecutive_failures == 0

    rows = db.query(MonitorCheckHistory).filter(MonitorCheckHistory.monitor_id == monitor_id).all()
    assert len(rows) == 1
    assert rows[0].status == "online"
    assert rows[0].response_time_ms == 42.0


def test_tick_retries_before_flipping_offline(monkeypatch):
    db = _session()
    monitor = _monitor(check_interval_seconds=0, max_retries=2, last_status="online")
    db.add(monitor)
    db.commit()
    db.refresh(monitor)
    monitor_id = monitor.id

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(monitors_service_module, "SessionLocal", factory)
    monkeypatch.setattr(monitors_service_module, "check_url", lambda *a, **k: CheckResult(open=False))

    service = StandaloneMonitorService()

    service._tick()
    db.expire_all()
    m = db.get(Monitor, monitor_id)
    assert m.consecutive_failures == 1
    assert m.last_status == "online"  # still within retry budget

    service._tick()
    db.expire_all()
    m = db.get(Monitor, monitor_id)
    assert m.consecutive_failures == 2
    assert m.last_status == "online"

    service._tick()
    db.expire_all()
    m = db.get(Monitor, monitor_id)
    assert m.consecutive_failures == 3
    assert m.last_status == "offline"  # exceeded max_retries


def test_tick_recovers_immediately_on_success(monkeypatch):
    db = _session()
    monitor = _monitor(check_interval_seconds=0, last_status="offline", consecutive_failures=5)
    db.add(monitor)
    db.commit()
    db.refresh(monitor)
    monitor_id = monitor.id

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(monitors_service_module, "SessionLocal", factory)
    monkeypatch.setattr(monitors_service_module, "check_url", lambda *a, **k: CheckResult(open=True, response_time_ms=10.0, status_code=200))

    service = StandaloneMonitorService()
    service._tick()

    db.expire_all()
    m = db.get(Monitor, monitor_id)
    assert m.last_status == "online"
    assert m.consecutive_failures == 0


def test_tick_fires_monitor_down_alert_only_on_transition(monkeypatch):
    db = _session()
    monitor = _monitor(check_interval_seconds=0, max_retries=0, last_status="online")
    db.add(monitor)
    db.commit()
    db.refresh(monitor)

    rule = AlertRule(
        name="Monitor down", enabled=True, event_type="monitor_down", channels='["profile:1"]',
        cooldown_minutes=0, monitor_id=None,
    )
    db.add(rule)
    db.commit()

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(monitors_service_module, "SessionLocal", factory)
    monkeypatch.setattr(monitors_service_module, "check_url", lambda *a, **k: CheckResult(open=False))
    monkeypatch.setattr(monitors_service_module, "send_notification_target", lambda *a, **k: "ok")

    service = StandaloneMonitorService()
    service._tick()  # transition online -> offline: should fire
    service._tick()  # already offline: should not fire again

    events = db.query(AlertEvent).filter(AlertEvent.event_type == "monitor_down").all()
    assert len(events) == 1
    assert "Example" in events[0].message
    assert "DOWN" in events[0].message


def test_tick_fires_monitor_slow_alert_above_threshold(monkeypatch):
    db = _session()
    monitor = _monitor(check_interval_seconds=0, last_status="online")
    db.add(monitor)
    db.commit()

    rule = AlertRule(
        name="Monitor slow", enabled=True, event_type="monitor_slow", channels='["profile:1"]',
        cooldown_minutes=0, threshold_ms=500, monitor_id=None,
    )
    db.add(rule)
    db.commit()

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(monitors_service_module, "SessionLocal", factory)
    monkeypatch.setattr(monitors_service_module, "check_url", lambda *a, **k: CheckResult(open=True, response_time_ms=1500.0, status_code=200))
    monkeypatch.setattr(monitors_service_module, "send_notification_target", lambda *a, **k: "ok")

    service = StandaloneMonitorService()
    service._tick()

    events = db.query(AlertEvent).filter(AlertEvent.event_type == "monitor_slow").all()
    assert len(events) == 1
    assert "1500 ms" in events[0].message


def test_build_message_monitor_down_and_slow():
    down = StandaloneMonitorService._build_message("monitor_down", "API", "https://api.example.com", "offline", "NetMap")
    assert "API" in down and "DOWN" in down

    slow = StandaloneMonitorService._build_message(
        "monitor_slow", "API", "https://api.example.com", "online", "NetMap",
        response_time_ms=1234.0, threshold_ms=500,
    )
    assert "1234 ms" in slow and "500 ms" in slow


def test_tick_holds_no_db_session_while_probing(monkeypatch):
    """Network IO must run with every session closed.

    A session held across a slow HTTP check pins a pooled connection (and any
    transaction on it) for the whole timeout, which starved request handlers
    and produced "database is locked" 500s elsewhere in the app.
    """
    db = _session()
    monitor = _monitor(check_interval_seconds=30)
    db.add(monitor)
    db.commit()

    open_sessions = {"count": 0, "max_during_check": 0}
    real_factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)

    def tracking_factory():
        session = real_factory()
        open_sessions["count"] += 1
        original_close = session.close

        def close(*args, **kwargs):
            open_sessions["count"] -= 1
            return original_close(*args, **kwargs)

        session.close = close
        return session

    def probing_check(*_args, **_kwargs):
        open_sessions["max_during_check"] = max(
            open_sessions["max_during_check"], open_sessions["count"],
        )
        return CheckResult(open=True, response_time_ms=10.0, status_code=200)

    monkeypatch.setattr(monitors_service_module, "SessionLocal", tracking_factory)
    monkeypatch.setattr(monitors_service_module, "check_url", probing_check)

    StandaloneMonitorService()._tick()

    assert open_sessions["max_during_check"] == 0
    assert open_sessions["count"] == 0


def test_tick_notifications_are_sent_outside_any_session(monkeypatch):
    """Same invariant for the notification sends, which are also network IO."""
    db = _session()
    monitor = _monitor(check_interval_seconds=30, last_status="online")
    db.add(monitor)
    db.add(AlertRule(
        name="down", event_type="monitor_down", enabled=True,
        channels='["webhook"]', cooldown_minutes=0,
    ))
    db.commit()

    open_sessions = {"count": 0, "max_during_send": 0}
    real_factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)

    def tracking_factory():
        session = real_factory()
        open_sessions["count"] += 1
        original_close = session.close

        def close(*args, **kwargs):
            open_sessions["count"] -= 1
            return original_close(*args, **kwargs)

        session.close = close
        return session

    def sending(*_args, **_kwargs):
        open_sessions["max_during_send"] = max(
            open_sessions["max_during_send"], open_sessions["count"],
        )
        return "ok"

    monkeypatch.setattr(monitors_service_module, "SessionLocal", tracking_factory)
    monkeypatch.setattr(monitors_service_module, "check_url", lambda *a, **k: CheckResult(open=False, response_time_ms=None, status_code=None))
    monkeypatch.setattr(monitors_service_module, "send_notification_target", sending)

    StandaloneMonitorService()._tick()

    assert db.query(AlertEvent).filter(AlertEvent.event_type == "monitor_down").count() == 1
    assert open_sessions["max_during_send"] == 0


def test_tick_skips_history_for_a_monitor_deleted_mid_check(monkeypatch):
    db = _session()
    monitor = _monitor(check_interval_seconds=30)
    db.add(monitor)
    db.commit()
    db.refresh(monitor)
    monitor_id = monitor.id

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(monitors_service_module, "SessionLocal", factory)

    def delete_then_succeed(*_args, **_kwargs):
        db.query(Monitor).filter(Monitor.id == monitor_id).delete()
        db.commit()
        return CheckResult(open=True, response_time_ms=5.0, status_code=200)

    monkeypatch.setattr(monitors_service_module, "check_url", delete_then_succeed)

    StandaloneMonitorService()._tick()

    assert db.query(MonitorCheckHistory).count() == 0

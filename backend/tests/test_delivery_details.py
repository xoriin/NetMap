from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.api.deps import get_db, require_alert_write
from app.db import session as db_session
from app.db.session import Base
from app.models.alert_rule import AlertRule
from app.models.device import Device
from app.models.monitor import Monitor
from app.models.notification_delivery import NotificationDelivery
from app.services.alerting import service as alerting_service
from app.services.monitors import service as monitors_service
from app.services.monitoring.port_checker import CheckResult


def _factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def test_device_alert_delivery_keeps_the_message_trigger_and_device_name(monkeypatch):
    factory = _factory()
    with factory() as db:
        db.add(Device(id=1, ip_address="10.0.0.1", display_name="core-sw-01", status="online", lifecycle="active", monitoring_paused=False))
        db.add(AlertRule(name="Core switch down", event_type="device_offline", channels='["email", "ntfy"]', cooldown_minutes=0, enabled=True))
        db.commit()
    monkeypatch.setattr(alerting_service, "SessionLocal", factory)
    monkeypatch.setattr(alerting_service, "load_notification_settings", lambda db: {})
    monkeypatch.setattr(alerting_service, "list_notification_profiles", lambda *a, **kw: [])
    monkeypatch.setattr(alerting_service, "send_notification_target", lambda target, *a: "ok" if target == "email" else "HTTP 401: delivery failed")
    monkeypatch.setattr(alerting_service, "check_port", lambda *a, **kw: SimpleNamespace(open=True, response_time_ms=1, status_code=None, error=None))
    worker = alerting_service.AlertMonitorService()
    monkeypatch.setattr(worker, "_prune_history", lambda: None)
    monkeypatch.setattr(worker, "_get_app_name", lambda db: "NetMap")
    state = ["online"]
    monkeypatch.setattr(worker, "_probe_device_status", lambda d: (state[0], 1.0))
    worker._check()
    state[0] = "offline"
    worker._check()

    with factory() as db:
        rows = db.scalars(select(NotificationDelivery).order_by(NotificationDelivery.target)).all()
    assert [(r.target, r.status) for r in rows] == [("email", "sent"), ("ntfy", "failed")]
    for row in rows:
        assert row.message == "NetMap Alert\n\n⚠️ core-sw-01 (10.0.0.1) is now OFFLINE"
        assert row.event_type == "device_offline"
        assert row.source_label == "core-sw-01"
    assert rows[1].detail == "HTTP 401: delivery failed"


def test_endpoint_alert_delivery_keeps_the_message_and_endpoint_name(monkeypatch):
    factory = _factory()
    with factory() as db:
        db.add(Monitor(name="Public site", url="https://example.com", enabled=True, check_interval_seconds=0, max_retries=0, last_status="online"))
        db.add(AlertRule(name="Site down", enabled=True, event_type="monitor_down", channels='["profile:1"]', cooldown_minutes=0))
        db.commit()
    monkeypatch.setattr(monitors_service, "SessionLocal", factory)
    monkeypatch.setattr(monitors_service, "check_url", lambda *a, **k: CheckResult(open=False))
    monkeypatch.setattr(monitors_service, "send_notification_target", lambda *a, **k: "ok")
    monitors_service.StandaloneMonitorService()._tick()

    with factory() as db:
        row = db.scalars(select(NotificationDelivery)).one()
    assert row.event_type == "monitor_down"
    assert row.source_label == "Public site"
    assert "Public site" in row.message and "DOWN" in row.message


def test_deliveries_api_returns_the_stored_details_and_empty_values_for_older_rows():
    factory = _factory()
    with factory() as db:
        sent = datetime(2026, 11, 1, 9, 41, tzinfo=timezone.utc)
        db.add(NotificationDelivery(rule_name="Old", target="email", status="sent", sent_at=sent.replace(day=1, month=10)))
        db.add(NotificationDelivery(rule_name="Core switch down", device_id=1, target="profile:2", status="sent", message="NetMap Alert\n\nbody", event_type="device_offline", source_label="core-sw-01", sent_at=sent))
        db.commit()

    def _db():
        with factory() as db:
            yield db

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[require_alert_write] = lambda: SimpleNamespace(id=1, role="SuperAdmin", is_active=True, username="admin")
    try:
        response = TestClient(app).get("/api/v1/alerts/deliveries")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200
    newest, older = response.json()
    assert newest["message"] == "NetMap Alert\n\nbody"
    assert newest["event_type"] == "device_offline"
    assert newest["source_label"] == "core-sw-01"
    assert (older["message"], older["event_type"], older["source_label"]) == ("", "", "")


def test_migration_0093_adds_the_columns_and_keeps_existing_rows():
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE notification_deliveries (id INTEGER PRIMARY KEY, rule_name VARCHAR(120) NOT NULL DEFAULT '', device_id INTEGER, "
            "target VARCHAR(120) NOT NULL, status VARCHAR(12) NOT NULL, detail VARCHAR(255) NOT NULL DEFAULT '', sent_at DATETIME NOT NULL)"
        ))
        conn.execute(text("INSERT INTO notification_deliveries VALUES (1, 'Core switch down', 4, 'email', 'failed', 'SMTP timeout', '2026-10-29 14:20:00')"))
        db_session._migrate_notification_delivery_message(conn, None)
        db_session._migrate_notification_delivery_message(conn, None)
        row = conn.execute(text("SELECT rule_name, detail, message, event_type, source_label FROM notification_deliveries")).one()
        assert tuple(row) == ("Core switch down", "SMTP timeout", "", "", "")
    with create_engine("sqlite://").begin() as conn:
        db_session._migrate_notification_delivery_message(conn, None)

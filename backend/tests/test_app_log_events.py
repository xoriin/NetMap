"""Tools → Logs (#47): status changes, check misses and audit writes are logged for the ring."""

import logging
from unittest.mock import MagicMock

from sqlalchemy.orm import sessionmaker

from app.services.audit.service import write_audit
from app.services.monitoring.port_checker import CheckResult
from app.services.monitors import service as monitors_service_module
from app.services.monitors.service import StandaloneMonitorService
from tests.test_monitors import _monitor, _session


def test_audit_writes_reach_the_app_log_without_the_detail(caplog):
    with caplog.at_level(logging.INFO, logger="app.services.audit.service"):
        write_audit(MagicMock(), "monitor.update", actor_user_id=3, target="monitor:web", detail="password=nope")
    assert "Audit: monitor.update monitor:web (user 3)" in caplog.text
    assert "nope" not in caplog.text


def test_monitor_misses_and_status_changes_are_logged_once(monkeypatch, caplog):
    db = _session()
    db.add(_monitor(name="web", check_interval_seconds=0, max_retries=1, last_status="online"))
    db.commit()
    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(monitors_service_module, "SessionLocal", factory)
    outcome = {"open": False}
    monkeypatch.setattr(
        monitors_service_module, "check_url",
        lambda *a, **k: CheckResult(open=outcome["open"], error="connection refused"),
    )
    service = StandaloneMonitorService()
    logger_name = "app.services.monitors.service"
    with caplog.at_level(logging.INFO, logger=logger_name):
        for _ in range(4):
            service._tick()
        outcome["open"] = True
        service._tick()
    # The in-memory test schema lacks some tables the tick also reads; only the monitor lines matter here.
    lines = [
        (record.levelname, record.getMessage())
        for record in caplog.records
        if record.name == logger_name and record.getMessage().startswith("Monitor 'web'")
    ]
    assert lines == [
        ("INFO", "Monitor 'web' check failed (1 in a row): connection refused"),
        ("INFO", "Monitor 'web' check failed (2 in a row): connection refused"),
        ("WARNING", "Monitor 'web' is offline (was online)"),
        ("INFO", "Monitor 'web' is online (was offline)"),
    ]

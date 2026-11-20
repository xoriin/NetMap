"""Tools → Logs (#47): ring buffer, redaction and handler wiring."""

import logging
import threading
import time

import pytest

from app.core import app_log
from app.core.app_log import (
    AppLogBuffer,
    AppLogHandler,
    install_app_log,
    redact,
    source_for,
    uninstall_app_log,
)


# --------------------------------------------------------------------------- buffer


def _add(buffer, message="m", *, level="INFO", logger="app.services.monitors.service", created=None, exception=None):
    return buffer.append(
        created=created if created is not None else time.time(),
        level_no=logging.getLevelName(level), level=level, logger=logger, message=message, exception=exception,
    )


def test_ring_is_bounded_and_ids_keep_increasing():
    buffer = AppLogBuffer(capacity=3)
    for index in range(5):
        _add(buffer, f"m{index}")
    snapshot = buffer.snapshot()
    assert [entry.id for entry in snapshot.entries] == [3, 4, 5]
    assert [entry.message for entry in snapshot.entries] == ["m2", "m3", "m4"]
    assert (snapshot.capacity, snapshot.dropped) == (3, 2)


def test_ring_is_bounded_by_characters_too():
    buffer = AppLogBuffer(capacity=100, max_total_chars=1000)
    for _ in range(10):
        _add(buffer, "x" * 300, logger="a")
    assert len(buffer) == 3
    assert buffer.snapshot().dropped == 7


def test_ring_is_thread_safe():
    buffer = AppLogBuffer(capacity=10_000)

    def worker():
        for _ in range(500):
            _add(buffer)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    ids = [entry.id for entry in buffer.snapshot().entries]
    assert ids == list(range(1, 4001))


def test_timestamp_is_utc_iso_with_z():
    entry = _add(AppLogBuffer(), created=0.25)
    assert entry.to_dict()["timestamp"] == "1970-01-01T00:00:00.250Z"


@pytest.mark.parametrize(
    ("logger", "source"),
    [
        ("uvicorn.error", "uvicorn"),
        ("uvicorn.access", "uvicorn"),
        ("app.services.monitors.service", "monitors"),
        ("app.services.alerting.service", "alerts"),
        ("app.services.discovery.scanner", "discovery"),
        ("app.services.snmp", "snmp"),
        ("app.services.oidc.provider", "auth"),
        ("app.api.v1.auth", "auth"),
        ("app.api.v1.tools", "tools"),
        ("app.api.v1.system", "api"),
        ("app.db.session", "database"),
        ("app.main", "core"),
        ("httpx", "httpx"),
    ],
)
def test_source_is_a_top_level_component(logger, source):
    assert source_for(logger) == source


# --------------------------------------------------------------------------- redaction

SECRETS = [
    ("login failed password=hunter2xyz for admin", "hunter2xyz"),
    ('payload {"password": "s3cr3t-pw", "user": "a"}', "s3cr3t-pw"),
    ("{'client_secret': 'oidc-secret-value'}", "oidc-secret-value"),
    ("GET https://api.example.com/v1?token=abc123tok&x=1", "abc123tok"),
    ("GET https://example.com/cb?code=1&access_token=atok999", "atok999"),
    ("GET https://example.com/?api_key=k-12345&key=raw-key-1", "k-12345"),
    ("GET https://example.com/?key=raw-key-1", "raw-key-1"),
    ("connect to https://admin:p%40ssw0rd@db.example.com/x", "p%40ssw0rd"),
    ("proxy http://user:proxypass@10.0.0.1:3128", "proxypass"),
    ("headers Authorization: Bearer abc.def-ghi", "abc.def-ghi"),
    ("headers {'authorization': 'Basic dXNlcjpwYXNz'}", "dXNlcjpwYXNz"),
    ("sent bearer tokenvalue123", "tokenvalue123"),
    ("Cookie: netmap_access=cookieval1; netmap_refresh=cookieval2", "cookieval2"),
    ("set-cookie=netmap_session=sessval; Path=/", "sessval"),
    ("session_id=sid-777 and sessionid: sid-888", "sid-888"),
    ("snmp community=public-ro failed", "public-ro"),
    ("v3 auth_key=authpass123 priv_key=privpass456", "privpass456"),
    ("v3 auth_key=authpass123 priv_key=privpass456", "authpass123"),
    ("X-API-Key: nm_abcd1234_ZZZZZZZZZZZZZZZZZZZZ", "ZZZZZZZZZZZZZZZZZZZZ"),
    ("key nm_abcd1234_QQQQQQQQQQQQQQQQQQQQ in text", "QQQQQQQQQQQQQQQQQQQQ"),
    (
        "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl leaked",
        "eyJzdWIiOiIxIn0",
    ),
    ("encrypted gAAAAABmZmZmZmZmZmZmZmZmZmZmZmZmZmZm== stored", "gAAAAABmZmZmZmZmZmZmZmZmZmZmZmZmZmZm"),
    ("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", "MIIEvQIBADANBg"),
    ("smtp_password: 'mail-pw-1'", "mail-pw-1"),
    ("csrf_token=csrf-abc", "csrf-abc"),
]


@pytest.mark.parametrize(("text", "secret"), SECRETS)
def test_redaction_removes_secrets(text, secret):
    cleaned = redact(text)
    assert secret not in cleaned
    assert "REDACTED" in cleaned


def test_redaction_keeps_ordinary_text():
    text = "Monitor 'web' is offline (was online); keyword=status check took 12 ms on https://example.com/health"
    assert redact(text) == text


def test_handler_redacts_message_and_exception_before_storing():
    buffer = AppLogBuffer()
    handler = AppLogHandler(buffer)
    log = logging.getLogger("test.app_log.redact")
    log.propagate = False
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    try:
        log.warning("login with password=%s", "pw-in-args")
        try:
            raise RuntimeError("connect failed token=tok-in-exception")
        except RuntimeError:
            log.exception("probe failed for https://u:pw-in-url@host/")
    finally:
        log.removeHandler(handler)
    stored = " ".join(f"{entry.message} {entry.exception}" for entry in buffer.snapshot().entries)
    for secret in ("pw-in-args", "tok-in-exception", "pw-in-url"):
        assert secret not in stored
    last = buffer.snapshot().entries[-1]
    assert last.exception and "RuntimeError" in last.exception and last.level == "ERROR"


def test_handler_caps_message_and_exception_length():
    buffer = AppLogBuffer()
    handler = AppLogHandler(buffer, max_message_chars=200, max_exception_chars=300)
    record = logging.LogRecord("app.x", logging.INFO, __file__, 1, "y" * 5000, None, None)
    handler.emit(record)
    try:
        raise ValueError("z" * 5000)
    except ValueError:
        import sys

        record = logging.LogRecord("app.x", logging.ERROR, __file__, 1, "boom", None, sys.exc_info())
    handler.emit(record)
    first, second = buffer.snapshot().entries
    assert first.message.startswith("y" * 200) and first.message.endswith("[truncated]")
    assert len(first.message) < 250
    assert second.exception.startswith("[truncated]") and len(second.exception) < 350


def test_handler_never_raises_or_logs_on_a_bad_record():
    buffer = AppLogBuffer()
    handler = AppLogHandler(buffer)
    record = logging.LogRecord("app.x", logging.INFO, __file__, 1, "%d items", ("not-a-number",), None)
    handler.emit(record)  # getMessage() raises TypeError; the handler keeps the raw message
    assert buffer.snapshot().entries[0].message == "%d items"


def test_access_lines_for_the_logs_endpoint_are_skipped():
    buffer = AppLogBuffer()
    handler = AppLogHandler(buffer)
    fmt = '%s - "%s %s HTTP/%s" %d'
    handler.emit(logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1, fmt, ("1.2.3.4", "GET", "/api/v1/tools/logs?since_id=5", "1.1", 200), None,
    ))
    handler.emit(logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1, fmt, ("1.2.3.4", "GET", "/api/v1/monitors", "1.1", 200), None,
    ))
    assert [entry.message for entry in buffer.snapshot().entries] == ['1.2.3.4 - "GET /api/v1/monitors HTTP/1.1" 200']


def test_install_captures_app_info_keeps_stderr_at_warning_and_is_idempotent():
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    app_logger = logging.getLogger("app")
    saved_level = app_logger.level
    uninstall_app_log()
    try:
        for existing in saved_handlers:
            root.removeHandler(existing)
        app_logger.setLevel(logging.NOTSET)
        buffer = install_app_log(capacity=100)
        assert install_app_log(capacity=5) is buffer
        logging.getLogger("app.services.monitors.service").info("Monitor 'web' is offline (was online)")
        logging.getLogger("thirdparty.lib").info("not captured: below root WARNING")
        messages = [entry.message for entry in buffer.snapshot().entries]
        assert "Monitor 'web' is offline (was online)" in messages
        assert "not captured: below root WARNING" not in messages
        stderr_handlers = [h for h in root.handlers if type(h) is logging.StreamHandler]
        assert stderr_handlers and stderr_handlers[0].level == logging.WARNING
        assert app_log.get_app_log_buffer() is buffer
    finally:
        uninstall_app_log()
        for handler in list(root.handlers):
            root.removeHandler(handler)
        for existing in saved_handlers:
            root.addHandler(existing)
        app_logger.setLevel(saved_level)

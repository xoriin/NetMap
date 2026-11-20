"""Tools → Logs (#47): GET /api/v1/tools/logs filters, polling, paging and permissions."""

import logging
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1 import app_logs as app_logs_api
from app.core.app_log import AppLogBuffer
from app.db.session import Base, get_db
from app.models.user import User, UserRole


def _add(buffer, message="m", *, level="INFO", logger="app.services.monitors.service", created=None, exception=None):
    return buffer.append(
        created=created if created is not None else time.time(),
        level_no=logging.getLevelName(level), level=level, logger=logger, message=message, exception=exception,
    )


@pytest.fixture
def api(monkeypatch):
    buffer = AppLogBuffer(capacity=50)
    monkeypatch.setattr(app_logs_api, "get_app_log_buffer", lambda: buffer)
    from app.models import device, site, snmp_profile, topology_group  # noqa: F401  (mapper config)

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[User.__table__])
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    app = FastAPI()
    app.include_router(app_logs_api.router, prefix="/api/v1")

    def _db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    state = {"role": UserRole.NETWORK_ADMIN}

    def _user():
        return User(id=1, username="u", password_hash="x", role=state["role"], is_active=True)

    client = TestClient(app)

    def as_role(role):
        state["role"] = role
        app.dependency_overrides[get_current_user] = _user
        return client

    return buffer, client, as_role


def _fill(buffer):
    base = 1_800_000_000.0
    rows = [
        ("INFO", "app.services.monitors.service", "Monitor 'web' is online (was offline)", None),
        ("WARNING", "app.services.monitors.service", "Monitor 'db' is offline (was online)", None),
        ("INFO", "app.services.discovery.scanner", "Scan 4 started", None),
        ("ERROR", "app.services.snmp", "SNMP probe failed", "Traceback ...\nTimeoutError: snmp timed out"),
        ("INFO", "uvicorn.error", "Application startup complete.", None),
        ("DEBUG", "app.services.monitors.service", "debug detail", None),
    ]
    for offset, (level, logger, message, exception) in enumerate(rows):
        _add(buffer, message, level=level, logger=logger, created=base + offset * 60, exception=exception)


def test_logs_requires_authentication(api):
    _buffer, client, _as_role = api
    response = client.get("/api/v1/tools/logs")
    assert response.status_code == 401


@pytest.mark.parametrize("role", [UserRole.VIEWER, UserRole.SECURITY_ANALYST])
def test_logs_requires_diagnostics_view(api, role):
    _buffer, _client, as_role = api
    response = as_role(role).get("/api/v1/tools/logs")
    assert response.status_code == 403


def test_logs_response_shape_newest_first(api):
    buffer, _client, as_role = api
    _fill(buffer)
    body = as_role(UserRole.SUPER_ADMIN).get("/api/v1/tools/logs").json()
    assert set(body) == {
        "entries", "order", "count", "has_more", "next_since_id", "next_before_id", "oldest_id", "latest_id",
        "capacity", "dropped", "wrapped", "gap", "sources", "loggers", "levels",
    }
    assert [entry["id"] for entry in body["entries"]] == [6, 5, 4, 3, 2, 1]
    assert body["order"] == "desc" and body["count"] == 6 and body["has_more"] is False
    assert (body["oldest_id"], body["latest_id"], body["next_since_id"], body["next_before_id"]) == (1, 6, 6, None)
    assert (body["capacity"], body["dropped"], body["wrapped"], body["gap"]) == (50, 0, False, False)
    assert body["sources"] == ["discovery", "monitors", "snmp", "uvicorn"]
    assert "app.services.snmp" in body["loggers"]
    assert body["levels"] == ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
    entry = body["entries"][2]
    assert set(entry) == {"id", "timestamp", "level", "logger", "source", "message", "exception"}
    assert entry["timestamp"].endswith("Z") and entry["source"] == "snmp" and "TimeoutError" in entry["exception"]


def test_logs_filters(api):
    buffer, _client, as_role = api
    _fill(buffer)
    client = as_role(UserRole.NETWORK_ADMIN)

    def ids(**params):
        response = client.get("/api/v1/tools/logs", params=params)
        assert response.status_code == 200, response.text
        return [entry["id"] for entry in response.json()["entries"]]

    assert ids(level="WARNING") == [4, 2]
    assert ids(level="warning") == [4, 2]
    assert ids(levels="INFO,ERROR") == [5, 4, 3, 1]
    assert ids(levels=["INFO", "DEBUG"]) == [6, 5, 3, 1]
    assert ids(source="monitors") == [6, 2, 1]
    assert ids(source="snmp,uvicorn") == [5, 4]
    assert ids(logger="app.services") == [6, 4, 3, 2, 1]
    assert ids(logger="uvicorn") == [5]
    assert ids(q="OFFLINE") == [2, 1]
    assert ids(q="timed out") == [4]
    assert ids(q="discovery") == [3]
    assert ids(since="2027-01-15T08:02:00Z", until="2027-01-15T08:04:00Z") == [5, 4, 3]
    assert ids(since="2027-01-15T08:02:00") == [6, 5, 4, 3]  # naive = UTC
    assert ids(level="INFO", source="monitors", q="online") == [2, 1]
    assert ids(levels="INFO", source="monitors", q="online") == [1]


def test_logs_since_id_polling(api):
    buffer, _client, as_role = api
    _fill(buffer)
    client = as_role(UserRole.NETWORK_ADMIN)
    body = client.get("/api/v1/tools/logs", params={"since_id": 2, "limit": 2, "order": "asc"}).json()
    assert [entry["id"] for entry in body["entries"]] == [3, 4]
    assert body["has_more"] is True and body["next_since_id"] == 4
    body = client.get("/api/v1/tools/logs", params={"since_id": 4, "limit": 2}).json()
    assert [entry["id"] for entry in body["entries"]] == [6, 5]
    assert body["has_more"] is False and body["next_since_id"] == 6
    body = client.get("/api/v1/tools/logs", params={"since_id": 6}).json()
    assert body["entries"] == [] and body["next_since_id"] == 6
    # Nothing matched the filter, but polling still moves past the entries it skipped.
    body = client.get("/api/v1/tools/logs", params={"since_id": 1, "source": "nothing"}).json()
    assert body["entries"] == [] and body["next_since_id"] == 6


def test_logs_paging_with_before_id(api):
    buffer, _client, as_role = api
    _fill(buffer)
    client = as_role(UserRole.NETWORK_ADMIN)
    body = client.get("/api/v1/tools/logs", params={"limit": 4}).json()
    assert [entry["id"] for entry in body["entries"]] == [6, 5, 4, 3]
    assert body["has_more"] is True and body["next_before_id"] == 3
    body = client.get("/api/v1/tools/logs", params={"limit": 4, "before_id": 3}).json()
    assert [entry["id"] for entry in body["entries"]] == [2, 1]
    assert body["has_more"] is False and body["next_before_id"] is None


def test_logs_reports_wrap_and_polling_gap(api):
    buffer, _client, as_role = api
    for index in range(60):
        _add(buffer, f"line {index}")
    client = as_role(UserRole.NETWORK_ADMIN)
    body = client.get("/api/v1/tools/logs", params={"since_id": 3, "limit": 5, "order": "asc"}).json()
    assert (body["oldest_id"], body["latest_id"], body["dropped"], body["wrapped"]) == (11, 60, 10, True)
    assert body["gap"] is True
    assert [entry["id"] for entry in body["entries"]] == [11, 12, 13, 14, 15]
    assert client.get("/api/v1/tools/logs", params={"since_id": 20}).json()["gap"] is False


@pytest.mark.parametrize(
    "params",
    [{"level": "LOUD"}, {"levels": "INFO,LOUD"}, {"limit": 0}, {"limit": 1001}, {"order": "up"}, {"since_id": -1},
     {"before_id": 0}, {"since": "yesterday"}],
)
def test_logs_rejects_bad_parameters(api, params):
    _buffer, _client, as_role = api
    response = as_role(UserRole.NETWORK_ADMIN).get("/api/v1/tools/logs", params=params)
    assert response.status_code == 422


def test_limit_defaults_to_200_and_caps_at_1000(api):
    buffer, _client, as_role = api
    buffer.capacity = 2000
    for index in range(1200):
        _add(buffer, f"line {index}")
    client = as_role(UserRole.NETWORK_ADMIN)
    assert client.get("/api/v1/tools/logs").json()["count"] == 200
    assert client.get("/api/v1/tools/logs", params={"limit": 1000}).json()["count"] == 1000

"""Route-level tests for endpoint (monitor) favourites.

The rest of the monitor favourite coverage in ``test_monitors.py`` calls the
handler functions directly, which cannot catch a path/registration mistake —
e.g. ``/monitors/favourites`` being swallowed by ``/monitors/{monitor_id}``, or
a route simply not being mounted. These drive the real router over an in-memory
database so the URLs themselves are exercised.
"""

from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1 import monitors as monitors_api
from app.db.session import Base, get_db
from app.models.audit_log import AuditLog
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.user import User, UserRole
from app.models.user_monitor_favourite import UserMonitorFavourite


def _build_client() -> tuple[TestClient, sessionmaker]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    from app.models import device, site, snmp_profile, topology_group  # noqa: F401  (mapper config)

    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__, Monitor.__table__, MonitorCheckHistory.__table__,
            UserMonitorFavourite.__table__, AuditLog.__table__,
        ],
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    with SessionLocal() as setup:
        setup.add(User(
            username="viewer",
            password_hash="x",
            role=UserRole.VIEWER,
            is_active=True,
        ))
        setup.commit()

    app = FastAPI()
    app.include_router(monitors_api.router, prefix="/api/v1")

    def _override_db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def _override_user(db: Annotated[object, Depends(_override_db)]) -> User:
        return db.query(User).first()  # type: ignore[union-attr]

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = _override_user
    return TestClient(app), SessionLocal


def test_favourite_routes_resolve_and_round_trip():
    client, SessionLocal = _build_client()
    with SessionLocal() as db:
        monitor = Monitor(name="Google", url="https://google.com/")
        db.add(monitor)
        db.commit()
        monitor_id = monitor.id

    # "favourites" must not be parsed as a monitor id by /monitors/{monitor_id}.
    listed = client.get("/api/v1/monitors/favourites")
    assert listed.status_code == 200, listed.text
    assert listed.json() == []

    toggled = client.patch(f"/api/v1/monitors/{monitor_id}/favourite")
    assert toggled.status_code == 200, toggled.text
    assert toggled.json()["is_favourite"] is True

    assert client.get("/api/v1/monitors/favourites").json() == [monitor_id]
    assert client.get("/api/v1/monitors").json()[0]["is_favourite"] is True

    untoggled = client.patch(f"/api/v1/monitors/{monitor_id}/favourite")
    assert untoggled.status_code == 200
    assert untoggled.json()["is_favourite"] is False
    assert client.get("/api/v1/monitors/favourites").json() == []


def test_favourite_route_404s_for_unknown_monitor():
    client, _ = _build_client()
    response = client.patch("/api/v1/monitors/4242/favourite")
    assert response.status_code == 404

import threading

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.api.v1 import auth as auth_api
from app.core.security import create_access_token
from app.db.session import Base, get_db
from app.models.audit_log import AuditLog
from app.models.site import Site  # noqa: F401 - imported so Device relationships resolve
from app.models.topology_group import TopologyGroup  # noqa: F401
from app.models.auth_session import AuthSession, RefreshTokenState
from app.models.oidc import ExternalIdentity
from app.models.user import User, UserRole

CONFLICT = {"detail": "At least one active SuperAdmin must remain"}


@pytest.fixture()
def app_and_factory(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'admins.db'}", connect_args={"check_same_thread": False, "timeout": 15})
    Base.metadata.create_all(engine, tables=[User.__table__, AuditLog.__table__, RefreshTokenState.__table__, AuthSession.__table__, ExternalIdentity.__table__])
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    app = FastAPI()
    app.include_router(auth_api.router, prefix="/api/v1")

    def override_get_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return app, factory


def _admins(factory, *names):
    with factory() as db:
        users = [User(username=name, password_hash="x", role=UserRole.SUPER_ADMIN, is_active=True) for name in names]
        db.add_all(users)
        db.commit()
        return [(u.id, {"Authorization": f"Bearer {create_access_token(u.id)}"}) for u in users]


def _active_super_admins(factory):
    with factory() as db:
        return db.scalar(select(func.count()).select_from(User).where(User.role == UserRole.SUPER_ADMIN, User.is_active.is_(True)))


@pytest.mark.parametrize("change", [{"role": "Viewer"}, {"is_active": False}, {"role": "Viewer", "is_active": False}])
def test_the_last_super_admin_cannot_demote_or_disable_themselves(app_and_factory, change):
    app, factory = app_and_factory
    [(admin_id, headers)] = _admins(factory, "root")
    response = TestClient(app).patch(f"/api/v1/auth/users/{admin_id}", headers=headers, json=change)
    assert response.status_code == 409
    assert response.json() == CONFLICT
    assert _active_super_admins(factory) == 1
    with factory() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "auth.user_updated").count() == 0


def test_another_super_admin_can_be_demoted_until_one_is_left(app_and_factory):
    app, factory = app_and_factory
    (first_id, first_headers), (second_id, _second_headers) = _admins(factory, "root", "deputy")
    client = TestClient(app)
    assert client.patch(f"/api/v1/auth/users/{second_id}", headers=first_headers, json={"role": "Viewer"}).status_code == 200
    assert client.patch(f"/api/v1/auth/users/{first_id}", headers=first_headers, json={"is_active": False}).json() == CONFLICT
    assert _active_super_admins(factory) == 1


def test_concurrent_cross_demotion_leaves_one_super_admin(app_and_factory, monkeypatch):
    app, factory = app_and_factory
    (first_id, first_headers), (second_id, second_headers) = _admins(factory, "root", "deputy")
    barrier = threading.Barrier(2, timeout=10)
    real = auth_api._demote_unless_last_super_admin

    def demote_together(*args):
        barrier.wait()
        return real(*args)

    monkeypatch.setattr(auth_api, "_demote_unless_last_super_admin", demote_together)
    statuses = []

    def demote(target_id, headers):
        statuses.append(TestClient(app).patch(f"/api/v1/auth/users/{target_id}", headers=headers, json={"role": "Viewer"}).status_code)

    threads = [threading.Thread(target=demote, args=args) for args in ((second_id, first_headers), (first_id, second_headers))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(statuses) == [200, 409]
    assert _active_super_admins(factory) == 1

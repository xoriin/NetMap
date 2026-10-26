import threading

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.api.v1 import auth as auth_api
from app.db.session import Base, get_db
from app.models.audit_log import AuditLog
from app.models.site import Site  # noqa: F401 - imported so Device relationships resolve
from app.models.topology_group import TopologyGroup  # noqa: F401
from app.models.system_setting import SystemSetting
from app.models.user import User, UserRole

PASSWORD = "correct horse battery"


def _app(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'setup.db'}", connect_args={"check_same_thread": False, "timeout": 15})
    Base.metadata.create_all(engine, tables=[User.__table__, AuditLog.__table__, SystemSetting.__table__])
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


def test_concurrent_setup_creates_exactly_one_admin(tmp_path, monkeypatch):
    app, factory = _app(tmp_path)
    barrier = threading.Barrier(2, timeout=10)
    real_hash = auth_api.hash_password

    def hash_once_both_have_checked(password):
        barrier.wait()
        return real_hash(password)

    monkeypatch.setattr(auth_api, "hash_password", hash_once_both_have_checked)
    statuses = {}

    def setup(name):
        statuses[name] = TestClient(app).post("/api/v1/setup/admin", json={"username": name, "password": PASSWORD}).status_code

    threads = [threading.Thread(target=setup, args=(name,)) for name in ("first-admin", "second-admin")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(statuses.values()) == [201, 409]
    with factory() as db:
        assert len(db.scalars(select(User).where(User.role == UserRole.SUPER_ADMIN)).all()) == 1
        assert db.get(SystemSetting, "setup_completed") is not None


def test_setup_after_completion_is_a_conflict(tmp_path):
    app, factory = _app(tmp_path)
    client = TestClient(app)
    assert client.post("/api/v1/setup/admin", json={"username": "admin", "password": PASSWORD}).status_code == 201
    again = client.post("/api/v1/setup/admin", json={"username": "admin", "password": PASSWORD})
    assert again.status_code == 409
    assert again.json() == {"detail": "Initial setup is complete"}


def test_duplicate_username_is_a_conflict_not_a_server_error(tmp_path, monkeypatch):
    app, factory = _app(tmp_path)
    with factory() as db:
        db.add(User(username="admin", password_hash="x", role=UserRole.VIEWER))
        db.commit()
    # Pretend the existence check missed the row, as a racing writer would.
    monkeypatch.setattr(auth_api, "_users_exist", lambda _db: False)
    response = TestClient(app).post("/api/v1/setup/admin", json={"username": "admin", "password": PASSWORD})
    assert response.status_code == 409
    assert response.json() == {"detail": "Username is unavailable"}

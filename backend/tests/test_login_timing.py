import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import auth as auth_api
from app.core import security as core_security
from app.core.security import hash_password
from app.db.session import get_db
from app.models.user import User
from tests.oidc_helpers import memory_session_factory

PASSWORD = "correct horse battery"


@pytest.fixture()
def client_and_db(monkeypatch):
    monkeypatch.setattr(auth_api, "apply_progressive_delay", lambda _attempts: None)
    session_factory = memory_session_factory()
    app = FastAPI()
    app.include_router(auth_api.router, prefix="/api/v1")

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    db = session_factory()
    db.add_all([
        User(username="alice", password_hash=hash_password(PASSWORD), role="Viewer", is_active=True),
        User(username="gone", password_hash=hash_password(PASSWORD), role="Viewer", is_active=False),
    ])
    db.commit()
    try:
        yield TestClient(app, base_url="http://testserver"), db
    finally:
        db.close()


@pytest.mark.parametrize(
    ("username", "password"),
    [("alice", "wrong password!"), ("nobody", "wrong password!"), ("gone", PASSWORD)],
)
def test_every_failed_sign_in_runs_one_argon2_check_and_looks_the_same(client_and_db, monkeypatch, username, password):
    client, _db = client_and_db
    calls = []
    real = core_security.password_hasher

    class CountingHasher:
        def verify(self, password_hash, candidate):
            calls.append(password_hash)
            return real.verify(password_hash, candidate)

        def hash(self, value):
            return real.hash(value)

    monkeypatch.setattr(core_security, "password_hasher", CountingHasher())
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid credentials"}
    assert len(calls) == 1
    assert calls[0].startswith("$argon2")

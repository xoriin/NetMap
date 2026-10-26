"""Shared harness: the full schema in an in-memory database and the real app with overrides."""
from __future__ import annotations

from contextlib import contextmanager

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.db.session import Base, get_db, import_all_models
from app.models.user import User

TEST_PASSWORD = "Correct-horse-battery-9!"


def memory_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    import_all_models()
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def add_user(db, username, role, **extra):
    user = User(username=username, password_hash=hash_password(TEST_PASSWORD), role=role, is_active=True, **extra)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@contextmanager
def real_app_client(factory, user=None):
    """The real FastAPI app (all /api/v1 routers and middleware) without running startup."""
    from app.api.deps import get_current_user
    from app.main import app

    def override_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    if user is not None:
        app.dependency_overrides[get_current_user] = lambda: user
    try:
        yield TestClient(app, base_url="http://testserver")
    finally:
        app.dependency_overrides.clear()

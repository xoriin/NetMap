"""Per-user opt-out for coloured entity chips (`PATCH /auth/me`)."""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.auth import update_profile
from app.db.session import Base
from app.models.audit_log import AuditLog
from app.models.device import Device  # noqa: F401 — registers mappers Device relates to
from app.models.site import Site  # noqa: F401
from app.models.topology_group import TopologyGroup  # noqa: F401
from app.models.user import User, UserRole
from app.schemas.auth import ProfileUpdateRequest, UserRead


def _db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine, tables=[User.__table__, AuditLog.__table__])
    db = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    user = User(username="alice", password_hash="x", role=UserRole.VIEWER.value, display_name="Alice")
    db.add(user)
    db.commit()
    return db, user


def test_colours_are_on_by_default():
    _, user = _db()
    assert user.entity_colors_enabled is True
    assert UserRead.model_validate(user).entity_colors_enabled is True


def test_preference_can_be_turned_off_and_back_on():
    db, user = _db()

    update_profile(ProfileUpdateRequest(entity_colors_enabled=False), user, db)
    assert user.entity_colors_enabled is False

    update_profile(ProfileUpdateRequest(entity_colors_enabled=True), user, db)
    assert user.entity_colors_enabled is True


def test_unrelated_profile_edit_leaves_the_preference_alone():
    db, user = _db()
    update_profile(ProfileUpdateRequest(entity_colors_enabled=False), user, db)

    # display_name-only update must not reset the preference to its default.
    update_profile(ProfileUpdateRequest(display_name="Alice B"), user, db)
    assert user.display_name == "Alice B"
    assert user.entity_colors_enabled is False


def test_preference_is_per_user():
    db, alice = _db()
    bob = User(username="bob", password_hash="x", role=UserRole.VIEWER.value)
    db.add(bob)
    db.commit()

    update_profile(ProfileUpdateRequest(entity_colors_enabled=False), alice, db)

    db.refresh(bob)
    assert bob.entity_colors_enabled is True

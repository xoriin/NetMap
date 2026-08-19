from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.admin import delete_role_endpoint, update_role_permissions
from app.db.session import Base
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.schemas.admin import RolePermissionsUpdate
from app.schemas.auth import UserRead
from app.services.rbac.permissions import add_role, get_all_permissions, has_permission


def _session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine, tables=[User.__table__, SystemSetting.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def _admin() -> User:
    return User(username="admin", password_hash="x", role="SuperAdmin")


def test_custom_role_permissions_are_saved():
    db = _session()
    admin = _admin()
    db.add(admin)
    db.commit()
    add_role("OperationsTeam")

    response = update_role_permissions(
        RolePermissionsUpdate(roles={
            **get_all_permissions(),
            "OperationsTeam": ["topology_write", "ipam_reservation_claim"],
        }),
        admin,
        db,
    )

    assert response.roles["OperationsTeam"] == ["ipam_reservation_claim", "topology_write"]
    assert has_permission("OperationsTeam", "ipam_reservation_claim")


def test_built_in_roles_cannot_be_deleted():
    db = _session()
    admin = _admin()
    db.add(admin)
    db.commit()

    for role in ("SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"):
        try:
            delete_role_endpoint(role, admin, db)
        except HTTPException as exc:
            assert exc.status_code == 400
        else:
            raise AssertionError(f"built-in role {role} was deleted")


def test_user_response_exposes_effective_custom_role_permissions():
    add_role("ReadOnlyOperator")
    from app.services.rbac.permissions import set_role_permissions

    set_role_permissions("ReadOnlyOperator", ["security_view", "firewall_export"])
    user = User(
        id=2,
        username="operator",
        password_hash="x",
        role="ReadOnlyOperator",
        is_active=True,
        entity_colors_enabled=True,
    )

    response = UserRead.model_validate(user)

    assert response.permissions == ["firewall_export", "security_view"]


def test_super_admin_response_exposes_every_permission():
    from app.services.rbac.permissions import PERMISSION_KEYS

    admin = _admin()
    admin.id = 1
    admin.is_active = True
    admin.entity_colors_enabled = True
    response = UserRead.model_validate(admin)

    assert set(response.permissions) == set(PERMISSION_KEYS)

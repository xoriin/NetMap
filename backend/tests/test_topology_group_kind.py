"""Cloud topology groups: kind/provider, validation, migration 0094, IPAM exclusion."""
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.ipam import vlan_suggestions
from app.api.v1.topology import create_topology_group, update_topology_group
from app.db.session import Base, _live_columns, _migrate_topology_group_kind
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.site import Site
from app.models.subnet import Subnet
from app.models.topology_group import TopologyGroup
from app.models.user import User, UserRole
from app.schemas.group import (
    CLOUD_NETWORK_FIELDS_ERROR,
    PROVIDER_NETWORK_ERROR,
    TopologyGroupCreate,
    TopologyGroupUpdate,
)


def _session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            AuditLog.__table__,
            Site.__table__,
            TopologyGroup.__table__,
            Device.__table__,
            Subnet.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def _admin(db):
    admin = User(username="admin", password_hash="x", role=UserRole.SUPER_ADMIN.value)
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return admin


def test_create_cloud_group_defaults_and_provider():
    db = _session()
    group = create_topology_group(
        TopologyGroupCreate(name="aws-workloads", kind="cloud", provider="  AWS  "),
        _admin(db),
        db,
    )
    assert group.kind == "cloud"
    assert group.provider == "AWS"
    assert group.ip_range is None


def test_create_cloud_group_rejects_network_fields():
    try:
        TopologyGroupCreate(name="aws", kind="cloud", ip_range="10.0.0.0/24")
    except ValidationError as exc:
        assert CLOUD_NETWORK_FIELDS_ERROR in str(exc)
    else:
        raise AssertionError("expected ValidationError")


def test_create_network_group_rejects_provider():
    try:
        TopologyGroupCreate(name="vlan10", provider="AWS")
    except ValidationError as exc:
        assert PROVIDER_NETWORK_ERROR in str(exc)
    else:
        raise AssertionError("expected ValidationError")


def test_update_to_cloud_is_rejected_until_network_fields_are_cleared():
    db = _session()
    admin = _admin(db)
    group = TopologyGroup(name="vlan10", kind="network", vlan_id="10", ip_range="10.0.10.0/24", gateway="10.0.10.1")
    db.add(group)
    db.commit()

    try:
        update_topology_group(group.id, TopologyGroupUpdate(kind="cloud"), admin, db)
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail == CLOUD_NETWORK_FIELDS_ERROR
    else:
        raise AssertionError("expected 422")
    db.refresh(group)
    assert group.kind == "network"
    assert group.ip_range == "10.0.10.0/24"

    updated = update_topology_group(
        group.id,
        TopologyGroupUpdate(kind="cloud", vlan_id=None, ip_range=None, gateway=None, provider="Azure"),
        admin,
        db,
    )
    assert updated.kind == "cloud"
    assert updated.provider == "Azure"
    assert updated.ip_range is None
    assert updated.vlan_id is None
    assert updated.gateway is None


def test_vlan_suggestions_exclude_cloud_groups():
    db = _session()
    db.add_all(
        [
            TopologyGroup(name="net", kind="network", ip_range="10.0.0.0/24"),
            TopologyGroup(name="cloud", kind="cloud", provider="AWS"),
        ]
    )
    db.commit()
    suggestions = vlan_suggestions(_admin(db), db)
    assert [item.name for item in suggestions] == ["net"]


def test_0094_adds_kind_and_provider_and_is_idempotent():
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE topology_groups (id INTEGER PRIMARY KEY, name VARCHAR(120), ip_range VARCHAR(64))"))
        conn.execute(text("INSERT INTO topology_groups (id, name, ip_range) VALUES (1, 'existing', '10.0.0.0/24')"))
        _migrate_topology_group_kind(conn, None)
        row = conn.execute(text("SELECT kind, provider FROM topology_groups WHERE id = 1")).fetchone()
        assert row == ("network", None)
        assert "kind" in _live_columns(conn, "topology_groups")
        assert "provider" in _live_columns(conn, "topology_groups")
        _migrate_topology_group_kind(conn, None)
        assert conn.execute(text("SELECT count(*), min(ip_range) FROM topology_groups")).fetchone() == (1, "10.0.0.0/24")

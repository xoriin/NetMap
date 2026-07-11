"""Bulk device update: group and site assignment semantics."""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.topology import bulk_update_devices
from app.db.session import Base
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.site import Site
from app.models.topology_group import TopologyGroup
from app.models.user import User, UserRole
from app.schemas.group import DeviceBulkUpdateRequest


def _db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            Site.__table__,
            TopologyGroup.__table__,
            Device.__table__,
            AuditLog.__table__,
        ],
    )
    db = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    admin = User(username="admin", password_hash="x", role=UserRole.SUPER_ADMIN.value)
    group = TopologyGroup(name="Servers")
    site = Site(name="HQ")
    devices = [
        Device(hostname=f"host-{n}", ip_address=f"10.0.0.{n}", status="online", topology_group="Servers")
        for n in (1, 2)
    ]
    db.add_all([admin, group, site, *devices])
    db.commit()
    for device in devices:
        device.topology_group_id = group.id
    db.commit()
    return db, admin, group, site, devices


def test_site_only_bulk_update_preserves_group_membership():
    db, admin, group, site, devices = _db()

    result = bulk_update_devices(
        payload=DeviceBulkUpdateRequest(device_ids=[d.id for d in devices], site_id=site.id),
        current_user=admin,
        db=db,
    )

    assert result.updated == 2
    db.expire_all()
    for device in devices:
        assert device.site_id == site.id
        assert device.topology_group == "Servers"
        assert device.topology_group_id == group.id


def test_group_bulk_update_still_assigns_group():
    db, admin, _group, _site, devices = _db()
    other = TopologyGroup(name="Cameras")
    db.add(other)
    db.commit()

    bulk_update_devices(
        payload=DeviceBulkUpdateRequest(device_ids=[d.id for d in devices], topology_group_id=other.id),
        current_user=admin,
        db=db,
    )

    db.expire_all()
    for device in devices:
        assert device.topology_group == "Cameras"
        assert device.site_id is None


def test_combined_group_and_site_bulk_update():
    db, admin, _group, site, devices = _db()
    other = TopologyGroup(name="Cameras")
    db.add(other)
    db.commit()

    bulk_update_devices(
        payload=DeviceBulkUpdateRequest(
            device_ids=[devices[0].id],
            topology_group_id=other.id,
            site_id=site.id,
        ),
        current_user=admin,
        db=db,
    )

    db.expire_all()
    assert devices[0].topology_group == "Cameras"
    assert devices[0].site_id == site.id
    assert devices[1].topology_group == "Servers"

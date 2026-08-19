"""Device response timestamps and deletion cleanup."""

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.topology import create_device, delete_device, get_device, list_devices, topology_graph
from app.db.session import Base
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.ip_reservation import IpReservation
from app.models.relationship import DeviceRelationship
from app.models.site import Site
from app.models.topology_group import TopologyGroup
from app.models.user import User, UserRole
from app.models.user_device_favourite import UserDeviceFavourite
from app.schemas.topology import DeviceCreate
from app.services.rbac.permissions import set_role_permissions


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
            Site.__table__,
            TopologyGroup.__table__,
            Device.__table__,
            IpReservation.__table__,
            DeviceRelationship.__table__,
            UserDeviceFavourite.__table__,
            AuditLog.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def _user(username: str, role: UserRole = UserRole.SUPER_ADMIN) -> User:
    return User(username=username, password_hash="x", role=role.value)


def test_device_reads_restore_utc_offsets_from_sqlite():
    db = _session()
    actor = _user("admin")
    naive_utc = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=5)
    device = Device(
        hostname="router",
        ip_address="192.168.1.1",
        status="online",
        last_monitored_at=naive_utc,
        created_at=naive_utc,
        updated_at=naive_utc,
    )
    db.add_all([actor, device])
    db.commit()
    db.refresh(device)

    assert device.last_monitored_at is not None
    assert device.last_monitored_at.tzinfo is None
    assert device.created_at.tzinfo is None
    assert device.updated_at.tzinfo is None

    detail = get_device(device.id, actor, db)
    listed = list_devices(actor, db)[0]
    graphed = topology_graph(actor, db).devices[0]

    for result in (detail, listed, graphed):
        assert result.last_monitored_at is not None
        assert result.last_monitored_at.utcoffset() == timedelta(0)
        assert result.created_at.utcoffset() == timedelta(0)
        assert result.updated_at.utcoffset() == timedelta(0)


def test_creating_device_persists_os_for_overview_and_inventory():
    db = _session()
    actor = _user("admin")
    db.add(actor)
    db.commit()

    created = create_device(
        DeviceCreate(hostname="os-host", ip_address="192.168.1.20", os="Windows Server 2025"),
        actor,
        db,
    )

    assert created.os == "Windows Server 2025"
    assert db.get(Device, created.id).os == "Windows Server 2025"


def test_reserved_ip_requires_confirmation_before_device_creation():
    db = _session()
    actor = _user("admin")
    reservation = IpReservation(
        ip_address="192.168.1.30",
        label="Printer allocation",
        mac_address="00:11:22:33:44:55",
    )
    db.add_all([actor, reservation])
    db.commit()

    try:
        create_device(DeviceCreate(hostname="printer", ip_address="192.168.1.30"), actor, db)
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail["code"] == "ip_reservation_conflict"
        assert exc.detail["label"] == "Printer allocation"
        assert exc.detail["can_claim"] is True
    else:
        raise AssertionError("reserved address was allocated without confirmation")

    assert db.scalar(select(IpReservation).where(IpReservation.ip_address == "192.168.1.30")) is not None
    assert db.scalar(select(Device).where(Device.ip_address == "192.168.1.30")) is None


def test_confirming_reserved_ip_claim_deletes_reservation_and_creates_device():
    db = _session()
    actor = _user("admin")
    db.add_all([actor, IpReservation(ip_address="192.168.1.31", label="Camera allocation")])
    db.commit()

    created = create_device(
        DeviceCreate(hostname="camera", ip_address="192.168.1.31", claim_reservation=True),
        actor,
        db,
    )

    assert created.ip_address == "192.168.1.31"
    assert db.scalar(select(IpReservation).where(IpReservation.ip_address == "192.168.1.31")) is None
    assert db.scalar(select(AuditLog).where(AuditLog.action == "ipam.reservation_claimed")) is not None


def test_role_without_claim_permission_cannot_convert_reservation():
    db = _session()
    actor = _user("operator", UserRole.VIEWER)
    actor.role = "InventoryOperator"
    set_role_permissions("InventoryOperator", ["topology_write"])
    db.add_all([actor, IpReservation(ip_address="192.168.1.32", label="Reserved")])
    db.commit()

    try:
        create_device(
            DeviceCreate(hostname="blocked", ip_address="192.168.1.32", claim_reservation=True),
            actor,
            db,
        )
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("role without claim permission converted a reservation")


def test_deleting_device_clears_every_users_favourites_and_relationships():
    db = _session()
    actor = _user("admin")
    viewer = _user("viewer", UserRole.VIEWER)
    target = Device(hostname="target", ip_address="192.168.1.10", status="online")
    peer = Device(hostname="peer", ip_address="192.168.1.11", status="online")
    db.add_all([actor, viewer, target, peer])
    db.flush()
    db.add_all(
        [
            UserDeviceFavourite(user_id=actor.id, device_id=target.id),
            UserDeviceFavourite(user_id=viewer.id, device_id=target.id),
            DeviceRelationship(source_device_id=target.id, target_device_id=peer.id),
        ]
    )
    db.commit()
    target_id = target.id

    delete_device(target_id, actor, db)

    assert db.get(Device, target_id) is None
    assert db.scalars(
        select(UserDeviceFavourite).where(UserDeviceFavourite.device_id == target_id)
    ).all() == []
    assert db.scalars(
        select(DeviceRelationship).where(
            (DeviceRelationship.source_device_id == target_id)
            | (DeviceRelationship.target_device_id == target_id)
        )
    ).all() == []

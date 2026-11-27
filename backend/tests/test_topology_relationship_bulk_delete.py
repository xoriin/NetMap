"""Bulk link removal on the Topology map."""

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.topology import bulk_delete_relationships
from app.db.session import Base
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.relationship import DeviceRelationship
from app.models.site import Site
from app.models.topology_group import TopologyGroup
from app.models.user import User, UserRole
from app.schemas.topology import RelationshipBulkDeleteRequest


def _db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            Site.__table__,
            TopologyGroup.__table__,
            Device.__table__,
            DeviceRelationship.__table__,
            AuditLog.__table__,
        ],
    )
    db = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    admin = User(username="admin", password_hash="x", role=UserRole.SUPER_ADMIN.value)
    devices = [Device(hostname=f"host-{n}", ip_address=f"10.0.0.{n}", status="online") for n in (1, 2, 3)]
    db.add_all([admin, *devices])
    db.commit()
    links = [
        DeviceRelationship(source_device_id=devices[0].id, target_device_id=devices[1].id, link_speed_mbps=1000, notes="n1"),
        DeviceRelationship(source_device_id=devices[1].id, target_device_id=devices[2].id, relationship_type="uplink"),
        DeviceRelationship(source_device_id=devices[0].id, target_device_id=devices[2].id),
    ]
    db.add_all(links)
    db.commit()
    return db, admin, links


def test_bulk_delete_removes_links_and_returns_them_for_undo():
    db, admin, links = _db()
    wanted = [links[0].id, links[1].id]

    result = bulk_delete_relationships(payload=RelationshipBulkDeleteRequest(relationship_ids=wanted), current_user=admin, db=db)

    assert sorted(r.id for r in result.deleted) == sorted(wanted)
    first = next(r for r in result.deleted if r.id == links[0].id)
    assert first.link_speed_mbps == 1000 and first.notes == "n1"
    remaining = db.scalars(select(DeviceRelationship.id)).all()
    assert remaining == [links[2].id]


def test_bulk_delete_writes_one_audit_entry_with_count():
    db, admin, links = _db()

    bulk_delete_relationships(
        payload=RelationshipBulkDeleteRequest(relationship_ids=[link.id for link in links]), current_user=admin, db=db
    )

    audits = db.scalars(select(AuditLog).where(AuditLog.action == "topology.relationships_bulk_deleted")).all()
    assert len(audits) == 1
    assert audits[0].target == "count:3"


def test_bulk_delete_ignores_ids_that_no_longer_exist():
    db, admin, links = _db()

    result = bulk_delete_relationships(
        payload=RelationshipBulkDeleteRequest(relationship_ids=[links[0].id, 99999]), current_user=admin, db=db
    )

    assert [r.id for r in result.deleted] == [links[0].id]


def test_bulk_delete_with_nothing_matching_is_404():
    db, admin, _links = _db()

    with pytest.raises(HTTPException) as exc:
        bulk_delete_relationships(payload=RelationshipBulkDeleteRequest(relationship_ids=[99999]), current_user=admin, db=db)

    assert exc.value.status_code == 404


def test_bulk_delete_request_limits():
    with pytest.raises(ValidationError):
        RelationshipBulkDeleteRequest(relationship_ids=[])
    with pytest.raises(ValidationError):
        RelationshipBulkDeleteRequest(relationship_ids=list(range(1, 1002)))
    assert RelationshipBulkDeleteRequest(relationship_ids=[3, 3, 1]).relationship_ids == [3, 1]

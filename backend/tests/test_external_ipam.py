from fastapi import HTTPException
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.ipam import (
    create_external_ip_assignment,
    create_external_ip_pool,
    delete_external_ip_pool,
    external_ip_summary,
    list_external_pool_addresses,
    update_external_ip_pool,
)
from app.db.session import Base
from app.models.external_ip import ExternalIpAssignment, ExternalIpPool
from app.models.site import Site  # noqa: F401 - registers Device.site for isolated test runs
from app.schemas.ipam import ExternalIpAssignmentCreate, ExternalIpPoolCreate, ExternalIpPoolUpdate


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[ExternalIpPool.__table__, ExternalIpAssignment.__table__])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_external_pool_address_page_and_summary():
    db = _session()
    pool = create_external_ip_pool(
        ExternalIpPoolCreate(name="WAN allocation", cidr="8.8.8.0/29", provider="Example ISP"), None, db,
    )
    assert pool.total == 6
    assert pool.free == 6

    assignment = create_external_ip_assignment(
        ExternalIpAssignmentCreate(
            pool_id=pool.id, ip_address="8.8.8.2", label="Public endpoint", status="in_use",
            owner="Infrastructure", service="HTTPS",
        ),
        None,
        db,
    )
    assert assignment.ip_address == "8.8.8.2"

    page = list_external_pool_addresses(pool.id, None, db, offset=0, limit=256)
    assert page.total == 6
    assert [entry.ip_address for entry in page.addresses] == [
        "8.8.8.1", "8.8.8.2", "8.8.8.3", "8.8.8.4", "8.8.8.5", "8.8.8.6",
    ]
    tracked = next(entry for entry in page.addresses if entry.ip_address == "8.8.8.2")
    assert tracked.assignment is not None
    assert tracked.assignment.service == "HTTPS"

    summary = external_ip_summary(None, db)
    assert summary.pool_count == 1
    assert summary.total == 6
    assert summary.in_use == 1
    assert summary.free == 5


def test_external_assignment_requires_managed_range_and_public_validation():
    db = _session()
    with pytest.raises(ValidationError):
        ExternalIpAssignmentCreate(ip_address="1.1.1.1", label="Unmanaged")

    with pytest.raises(HTTPException) as exc:
        create_external_ip_pool(ExternalIpPoolCreate(name="Private", cidr="10.0.0.0/24"), None, db)
    assert exc.value.status_code == 422


def test_external_pool_accepts_arbitrary_range():
    db = _session()
    address_range = create_external_ip_pool(
        ExternalIpPoolCreate(name="Small allocation", cidr="8.8.8.10 - 8.8.8.13"), None, db,
    )
    assert address_range.cidr == "8.8.8.10-8.8.8.13"
    assert address_range.total == 4
    page = list_external_pool_addresses(address_range.id, None, db, offset=0, limit=256)
    assert [entry.ip_address for entry in page.addresses] == [
        "8.8.8.10", "8.8.8.11", "8.8.8.12", "8.8.8.13",
    ]

    with pytest.raises(HTTPException) as single:
        create_external_ip_pool(ExternalIpPoolCreate(name="Single address", cidr="9.9.9.9"), None, db)
    assert single.value.status_code == 422

    with pytest.raises(HTTPException) as single_cidr:
        create_external_ip_pool(ExternalIpPoolCreate(name="Single CIDR", cidr="9.9.9.9/32"), None, db)
    assert single_cidr.value.status_code == 422


def test_external_range_overlap_and_order_validation():
    db = _session()
    create_external_ip_pool(ExternalIpPoolCreate(name="Assigned", cidr="8.8.4.10-8.8.4.15"), None, db)
    with pytest.raises(HTTPException) as overlap:
        create_external_ip_pool(ExternalIpPoolCreate(name="Overlap", cidr="8.8.4.15-8.8.4.20"), None, db)
    assert overlap.value.status_code == 409

    with pytest.raises(HTTPException) as reversed_range:
        create_external_ip_pool(ExternalIpPoolCreate(name="Reversed", cidr="9.9.9.20-9.9.9.10"), None, db)
    assert reversed_range.value.status_code == 422


def test_external_pool_overlap_and_resize_protection():
    db = _session()
    pool = create_external_ip_pool(ExternalIpPoolCreate(name="Primary", cidr="8.8.8.0/28"), None, db)
    create_external_ip_assignment(
        ExternalIpAssignmentCreate(pool_id=pool.id, ip_address="8.8.8.10", label="Edge"), None, db,
    )

    with pytest.raises(HTTPException) as exc:
        create_external_ip_pool(ExternalIpPoolCreate(name="Overlap", cidr="8.8.8.8/29"), None, db)
    assert exc.value.status_code == 409

    with pytest.raises(HTTPException) as exc:
        update_external_ip_pool(pool.id, ExternalIpPoolUpdate(cidr="8.8.8.0/29"), None, db)
    assert exc.value.status_code == 422


def test_external_pool_rejects_network_and_broadcast_assignments():
    db = _session()
    pool = create_external_ip_pool(ExternalIpPoolCreate(name="WAN", cidr="8.8.4.0/29"), None, db)
    for address in ("8.8.4.0", "8.8.4.7"):
        with pytest.raises(HTTPException) as exc:
            create_external_ip_assignment(
                ExternalIpAssignmentCreate(pool_id=pool.id, ip_address=address, label="Invalid"), None, db,
            )
        assert exc.value.status_code == 422


def test_deleting_external_pool_removes_its_assignments():
    db = _session()
    pool = create_external_ip_pool(ExternalIpPoolCreate(name="WAN", cidr="8.8.4.8/29"), None, db)
    create_external_ip_assignment(
        ExternalIpAssignmentCreate(pool_id=pool.id, ip_address="8.8.4.10", label="Edge"), None, db,
    )
    delete_external_ip_pool(pool.id, None, db)
    assert db.query(ExternalIpAssignment).count() == 0

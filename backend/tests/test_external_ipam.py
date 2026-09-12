from fastapi import HTTPException
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.ipam import (
    create_external_addresses,
    delete_external_address,
    dismiss_external_migration_report,
    external_migration_report,
    list_external_addresses,
    update_external_address,
    external_ip_summary,
)
from app.db.session import Base
from app.models.cloud import CloudAsset, CloudProvider
from app.models.device import Device
from app.models.external_ip import ExternalIpAddress, ExternalIpAssignment, ExternalIpPool, ExternalIpRange, ExternalProviderAccount, ExternalLocation
from app.models.system_setting import SystemSetting
from app.models.site import Site  # noqa: F401 - registers Device.site for isolated test runs
from app.models.user import User, UserRole
from app.schemas.ipam import (
    ExternalIpAddressCreate,
    ExternalIpAddressUpdate,
)


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[
        CloudProvider.__table__, CloudAsset.__table__, Device.__table__, ExternalProviderAccount.__table__, ExternalLocation.__table__,
        ExternalIpPool.__table__, ExternalIpRange.__table__, ExternalIpAssignment.__table__, ExternalIpAddress.__table__,
        SystemSetting.__table__,
    ])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


@pytest.fixture
def session():
    return _session()


def _reader() -> User:
    """A permission object with read-only access, matching the User/UserRole
    objects the app's route dependencies already check (see app/api/deps.py)."""
    return User(username="reader", password_hash="x", role=UserRole.VIEWER, is_active=True)


def _writer() -> User:
    """A permission object with IPAM write access."""
    return User(username="writer", password_hash="x", role=UserRole.NETWORK_ADMIN, is_active=True)


def test_create_single_address_requires_only_the_address(session):
    """GitHub #42: the minimum viable record is an IP and nothing else."""
    created = create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.68"), db=session, user=_writer()
    )
    assert len(created) == 1
    assert created[0].ip_address == "104.23.54.68"
    assert created[0].location_id is None
    assert created[0].status == "in_use"
    assert created[0].label is None


def test_create_range_produces_available_rows(session):
    created = create_external_addresses(
        ExternalIpAddressCreate(ip_address="203.0.113.0/29", status="available"),
        db=session, user=_writer(),
    )
    assert len(created) == 6
    assert {row.status for row in created} == {"available"}


def test_create_rejects_over_cap_and_writes_nothing(session):
    with pytest.raises(HTTPException) as excinfo:
        create_external_addresses(
            ExternalIpAddressCreate(ip_address="203.0.112.0/23"), db=session, user=_writer()
        )
    assert excinfo.value.status_code == 422
    assert session.query(ExternalIpAddress).count() == 0


def test_duplicate_address_is_rejected(session):
    create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.68"), db=session, user=_writer()
    )
    with pytest.raises(HTTPException) as excinfo:
        create_external_addresses(
            ExternalIpAddressCreate(ip_address="104.23.54.68"), db=session, user=_writer()
        )
    assert excinfo.value.status_code == 409


def test_address_can_be_released_with_empty_label(session):
    """GitHub #42 comment 2: clearing a mandatory label used to block the save."""
    created = create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.68", label="Decommissioned box"),
        db=session, user=_writer(),
    )
    updated = update_external_address(
        created[0].id,
        ExternalIpAddressUpdate(status="available", label=None, device_id=None),
        db=session, user=_writer(),
    )
    assert updated.status == "available"
    assert updated.label is None


def test_summary_counts_statuses(session):
    create_external_addresses(
        ExternalIpAddressCreate(ip_address="203.0.113.0/29", status="available"),
        db=session, user=_writer(),
    )
    create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.68", status="in_use"),
        db=session, user=_writer(),
    )
    summary = external_ip_summary(db=session, user=_reader())
    assert summary.total == 7
    assert summary.in_use == 1
    assert summary.free == 6


def test_list_and_delete_external_addresses(session):
    created = create_external_addresses(
        ExternalIpAddressCreate(ip_address="203.0.113.0/29", status="available"),
        db=session, user=_writer(),
    )
    listed = list_external_addresses(db=session, user=_reader(), status=None, location_id=None)
    assert len(listed) == 6

    delete_external_address(created[0].id, db=session, user=_writer())
    assert session.query(ExternalIpAddress).count() == 5

    with pytest.raises(HTTPException) as missing:
        delete_external_address(created[0].id, db=session, user=_writer())
    assert missing.value.status_code == 404


def test_migration_report_returns_none_when_nothing_declined(session):
    session.add(SystemSetting(key="external_ip_migration_report",
                              value='{"migrated": 4, "declined": []}'))
    session.commit()
    assert external_migration_report(db=session, user=_reader()) is None


def test_migration_report_lists_declined_blocks(session):
    session.add(SystemSetting(
        key="external_ip_migration_report",
        value='{"migrated": 3, "declined": [{"cidr": "203.0.0.0/16", '
              '"location": "Central US", "kept": 3}]}',
    ))
    session.commit()
    report = external_migration_report(db=session, user=_reader())
    assert report.declined[0].cidr == "203.0.0.0/16"


def test_dismissing_the_report_removes_it(session):
    session.add(SystemSetting(key="external_ip_migration_report",
                              value='{"migrated": 1, "declined": [{"cidr": "203.0.0.0/16", '
                                    '"location": "x", "kept": 1}]}'))
    session.commit()
    dismiss_external_migration_report(db=session, user=_writer())
    assert external_migration_report(db=session, user=_reader()) is None


def test_update_rejects_empty_string_ip_address(session):
    """GitHub review round 2, item 1: `{"ip_address": ""}` used to skip validation
    entirely (falsy-string bug) and persist an empty address."""
    created = create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.68"), db=session, user=_writer()
    )
    with pytest.raises(HTTPException) as excinfo:
        update_external_address(
            created[0].id, ExternalIpAddressUpdate(ip_address=""), db=session, user=_writer(),
        )
    assert excinfo.value.status_code == 422
    unchanged = session.get(ExternalIpAddress, created[0].id)
    assert unchanged.ip_address == "104.23.54.68"


def test_update_rejects_null_ip_address(session):
    """`{"ip_address": null}` used to hit a NOT NULL IntegrityError and return 500."""
    created = create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.68"), db=session, user=_writer()
    )
    with pytest.raises(HTTPException) as excinfo:
        update_external_address(
            created[0].id, ExternalIpAddressUpdate(ip_address=None), db=session, user=_writer(),
        )
    assert excinfo.value.status_code == 422
    unchanged = session.get(ExternalIpAddress, created[0].id)
    assert unchanged.ip_address == "104.23.54.68"


def test_update_to_an_already_tracked_address_returns_409(session):
    """GitHub review round 2, item 2: PATCH used to raise an uncaught UNIQUE
    IntegrityError (500) instead of matching the create path's 409."""
    create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.68"), db=session, user=_writer()
    )
    other = create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.69"), db=session, user=_writer()
    )
    with pytest.raises(HTTPException) as excinfo:
        update_external_address(
            other[0].id, ExternalIpAddressUpdate(ip_address="104.23.54.68"),
            db=session, user=_writer(),
        )
    assert excinfo.value.status_code == 409
    assert excinfo.value.detail == "104.23.54.68 is already tracked"
    # The failed update must not have clobbered the other row.
    assert session.query(ExternalIpAddress).count() == 2
    assert session.get(ExternalIpAddress, other[0].id).ip_address == "104.23.54.69"


def test_address_linked_to_a_device_returns_its_identity(session):
    """GitHub review round 2, item 3: `device` was always null even when
    `device_id` was set, which would permanently block a later task's Device column."""
    device = Device(hostname="edge-01", ip_address="10.0.0.9", display_name="Edge 01")
    session.add(device)
    session.commit()

    created = create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.68", device_id=device.id),
        db=session, user=_writer(),
    )
    assert created[0].device is not None
    assert created[0].device.id == device.id
    assert created[0].device.hostname == "edge-01"

    listed = list_external_addresses(db=session, user=_reader(), status=None, location_id=None)
    assert listed[0].device is not None
    assert listed[0].device.id == device.id

    unlinked = create_external_addresses(
        ExternalIpAddressCreate(ip_address="104.23.54.70"), db=session, user=_writer()
    )
    assert unlinked[0].device is None

    updated = update_external_address(
        unlinked[0].id, ExternalIpAddressUpdate(device_id=device.id),
        db=session, user=_writer(),
    )
    assert updated.device is not None
    assert updated.device.id == device.id


def test_migration_report_returns_none_for_malformed_json(session):
    """GitHub review round 2, item 4: this endpoint loads on every External IPs
    page view, so a corrupt row must not 500 the whole workspace."""
    session.add(SystemSetting(key="external_ip_migration_report", value="{not valid json"))
    session.commit()
    assert external_migration_report(db=session, user=_reader()) is None


def test_list_external_addresses_does_not_issue_a_query_per_device(session):
    """GitHub review round 3: `db.get(Device, ...)` inside the list comprehension
    issued one query per distinct device — a register with hundreds of addresses
    each on a different device would issue hundreds of queries. Query count must
    stay flat as the row count grows, not merely return the right data (that
    assertion alone passed before the fix and would pass after a regression too).
    """
    devices = [Device(hostname=f"dev-{i}", ip_address=f"10.0.0.{i}") for i in range(5)]
    session.add_all(devices)
    session.commit()
    for i, device in enumerate(devices):
        create_external_addresses(
            ExternalIpAddressCreate(ip_address=f"104.23.54.{70 + i}", device_id=device.id),
            db=session, user=_writer(),
        )

    engine = session.get_bind()
    query_count = 0

    def _count(*_args, **_kwargs):
        nonlocal query_count
        query_count += 1

    event.listen(engine, "before_cursor_execute", _count)
    try:
        listed = list_external_addresses(db=session, user=_reader(), status=None, location_id=None)
    finally:
        event.remove(engine, "before_cursor_execute", _count)

    assert len(listed) == 5
    assert {entry.device.id for entry in listed} == {device.id for device in devices}
    # One query for the address rows, one batched IN(...) query for their devices —
    # not one query per row.
    assert query_count <= 3, f"expected a constant query count, got {query_count}"


def test_migration_report_returns_none_for_partial_json(session):
    """Valid JSON that doesn't match the report shape must also degrade to None."""
    session.add(SystemSetting(key="external_ip_migration_report", value='{"declined": "not-a-list"}'))
    session.commit()
    assert external_migration_report(db=session, user=_reader()) is None

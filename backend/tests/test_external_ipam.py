from fastapi import HTTPException
import pytest
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
from app.models.cloud import CloudAsset, CloudAssetType, CloudProvider
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
        CloudProvider.__table__, CloudAsset.__table__, CloudAssetType.__table__, Device.__table__, ExternalProviderAccount.__table__, ExternalLocation.__table__,
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


def test_saved_cloud_resources_remain_readable_without_assignments_or_devices(session):
    from app.api.v1.ipam import list_saved_cloud_assets

    assert list_saved_cloud_assets(user=_reader(), db=session) == []
    session.add_all([
        CloudAsset(name="Unaddressed resource", kind="nat_gateway", account="Production", region="Sydney", description="Keep this metadata"),
        CloudAsset(name="Old optional link", device_id=999),
    ])
    session.commit()
    before = [(row.id, row.name, row.device_id) for row in session.query(CloudAsset).order_by(CloudAsset.id)]
    rows = list_saved_cloud_assets(user=_reader(), db=session)
    assert {row.name for row in rows} == {"Unaddressed resource", "Old optional link"}
    resource = next(row for row in rows if row.name == "Unaddressed resource")
    assert (resource.account, resource.region, resource.description, resource.device_id) == ("Production", "Sydney", "Keep this metadata", None)
    assert next(row for row in rows if row.name == "Old optional link").device_id == 999
    assert session.query(Device).count() == 0
    assert session.query(ExternalIpAddress).count() == 0
    assert [(row.id, row.name, row.device_id) for row in session.query(CloudAsset).order_by(CloudAsset.id)] == before


def test_saved_cloud_resource_api_requires_auth_and_write_permission(session):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.deps import get_current_user
    from app.api.v1.ipam import router
    from app.db.session import get_db

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: session
    client = TestClient(app)
    assert client.get("/ipam/external/assets").status_code == 401
    app.dependency_overrides[get_current_user] = _reader
    session.add(CloudAsset(name="Visible to Inventory readers"))
    session.commit()
    response = client.get("/ipam/external/assets")
    assert response.status_code == 200
    assert response.json()[0]["name"] == "Visible to Inventory readers"
    assert client.post("/ipam/external/assets", json={"name": "Denied"}).status_code == 403
    assert session.query(CloudAsset).count() == 1


def test_extend_cidr_preserves_every_existing_record_and_relationship(session):
    """#53: correct /26 to /24 without recreating edited or linked addresses."""
    session.add_all([
        ExternalLocation(id=1, name="Original location"),
        ExternalLocation(id=2, name="New addresses"),
        Device(id=1, hostname="edge", ip_address="10.0.0.1", status="active"),
    ])
    session.commit()
    original = create_external_addresses(
        ExternalIpAddressCreate(ip_address="203.0.113.0/26", status="available", location_id=1),
        db=session, user=_writer(),
    )
    update_external_address(original[0].id, ExternalIpAddressUpdate(
        device_id=1, status="in_use", label="Production edge", url="https://edge.example.com",
        owner="Operations", tags="critical,public", notes="Keep these details",
    ), db=session, user=_writer())
    update_external_address(original[1].id, ExternalIpAddressUpdate(status="reserved"), db=session, user=_writer())
    before = {row.id: row.model_dump() for row in list_external_addresses(db=session, user=_reader(), status=None, location_id=None)}
    created = create_external_addresses(
        ExternalIpAddressCreate(ip_address="203.0.113.0/24", skip_existing=True, status="available", location_id=2, tags="new", notes="New only"),
        db=session, user=_writer(),
    )
    assert len(created) == 192
    assert all(row.location_id == 2 and row.status == "available" and row.tags == "new" for row in created)
    after = list_external_addresses(db=session, user=_reader(), status=None, location_id=None)
    assert len(after) == 254
    assert {row.id: row.model_dump() for row in after if row.id in before} == before
    assert session.get(Device, 1).hostname == "edge"
    # Repeating the operation is a no-op, including timestamps and metadata.
    snapshot = {row.id: row.model_dump() for row in after}
    assert create_external_addresses(
        ExternalIpAddressCreate(ip_address="203.0.113.0/24", skip_existing=True, status="reserved", location_id=1),
        db=session, user=_writer(),
    ) == []
    assert {row.id: row.model_dump() for row in list_external_addresses(db=session, user=_reader(), status=None, location_id=None)} == snapshot


@pytest.mark.parametrize("existing,expanded,count", [
    ("203.0.113.1", "203.0.113.1-203.0.113.4", 3),
    ("2001:db8::1", "2001:db8::/126", 2),
    ("2001:db8::1", "2001:db8::1-2001:db8::4", 3),
])
def test_extend_range_preserves_overlaps_for_both_address_families(session, existing, expanded, count):
    old = create_external_addresses(ExternalIpAddressCreate(ip_address=existing, label="Keep"), db=session, user=_writer())[0]
    result = create_external_addresses(ExternalIpAddressCreate(ip_address=expanded, skip_existing=True, status="available"), db=session, user=_writer())
    assert len(result) == count
    assert session.get(ExternalIpAddress, old.id).label == "Keep"
    assert session.query(ExternalIpAddress).count() == count + 1


def test_range_conflict_is_still_atomic_without_opt_in(session):
    create_external_addresses(ExternalIpAddressCreate(ip_address="203.0.113.2"), db=session, user=_writer())
    with pytest.raises(HTTPException) as error:
        create_external_addresses(ExternalIpAddressCreate(ip_address="203.0.113.0/29"), db=session, user=_writer())
    assert error.value.status_code == 409
    assert session.query(ExternalIpAddress).count() == 1


def test_preserve_existing_does_not_bypass_cap_or_location_validation(session):
    create_external_addresses(ExternalIpAddressCreate(ip_address="203.0.113.1", label="Keep"), db=session, user=_writer())
    for payload in [
        ExternalIpAddressCreate(ip_address="203.0.112.0/23", skip_existing=True),
        ExternalIpAddressCreate(ip_address="203.0.113.0/29", skip_existing=True, location_id=999),
    ]:
        with pytest.raises(HTTPException) as error:
            create_external_addresses(payload, db=session, user=_writer())
        assert error.value.status_code in {404, 422}
    assert session.query(ExternalIpAddress).count() == 1


def test_extension_integrity_race_rolls_back_entire_batch(session):
    from sqlalchemy.exc import IntegrityError

    old = create_external_addresses(ExternalIpAddressCreate(ip_address="203.0.113.1", label="Keep"), db=session, user=_writer())[0]

    def conflict(*_):
        raise IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed"))

    event.listen(session, "before_flush", conflict)
    try:
        with pytest.raises(HTTPException) as error:
            create_external_addresses(ExternalIpAddressCreate(ip_address="203.0.113.0/29", skip_existing=True), db=session, user=_writer())
        assert error.value.status_code == 409
    finally:
        event.remove(session, "before_flush", conflict)
    assert session.query(ExternalIpAddress).count() == 1
    assert session.get(ExternalIpAddress, old.id).label == "Keep"


def test_extension_with_one_missing_address_still_uses_range_metadata_rules(session):
    create_external_addresses(ExternalIpAddressCreate(ip_address="203.0.113.1"), db=session, user=_writer())
    created = create_external_addresses(ExternalIpAddressCreate(
        ip_address="203.0.113.0/30", skip_existing=True,
        device_id=999, label="Not for every address", url="https://example.com", owner="Not shared",
    ), db=session, user=_writer())
    assert len(created) == 1
    assert created[0].ip_address == "203.0.113.2"
    assert created[0].device_id is None
    assert created[0].label is None
    assert created[0].url is None
    assert created[0].owner is None


def test_extension_api_keeps_permission_checks_and_returns_only_new_rows(session):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.deps import get_current_user
    from app.api.v1.ipam import router
    from app.db.session import get_db

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = _reader
    with TestClient(app) as client:
        denied = client.post("/ipam/external/addresses", json={"ip_address": "203.0.113.0/29", "skip_existing": True})
        assert denied.status_code == 403
        assert session.query(ExternalIpAddress).count() == 0
        app.dependency_overrides[get_current_user] = _writer
        payload = {"ip_address": "203.0.113.0/29", "skip_existing": True, "status": "available"}
        added = client.post("/ipam/external/addresses", json=payload)
        assert added.status_code == 201
        assert len(added.json()) == 6
        repeated = client.post("/ipam/external/addresses", json=payload)
        assert repeated.status_code == 201
        assert repeated.json() == []

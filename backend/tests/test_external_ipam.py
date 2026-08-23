from fastapi import HTTPException
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.ipam import (
    add_address_to_cloud_asset,
    create_cloud_asset,
    delete_cloud_asset,
    link_cloud_asset_device,
    unlink_cloud_asset_device,
    list_cloud_assets,
    list_external_ip_assignments,
    update_external_ip_range,
    create_external_ip_assignment,
    create_external_ip_pool,
    create_external_ip_range,
    delete_external_pool_address,
    delete_external_ip_range,
    delete_external_ip_pool,
    external_ip_summary,
    list_external_ip_pools,
    list_external_pool_addresses,
    update_external_ip_pool,
)
from app.api.v1.admin import (
    create_cloud_provider,
    delete_cloud_provider,
    list_cloud_providers,
    update_cloud_provider,
)
from app.db.session import Base
from app.models.cloud import CloudAsset, CloudProvider
from app.models.device import Device
from app.models.external_ip import ExternalIpAssignment, ExternalIpPool, ExternalIpRange
from app.models.system_setting import SystemSetting
from app.models.site import Site  # noqa: F401 - registers Device.site for isolated test runs
from app.schemas.ipam import (
    CloudAssetAddressCreate,
    CloudAssetCreate,
    ExternalIpAssignmentCreate,
    ExternalIpPoolCreate,
    ExternalIpPoolUpdate,
    ExternalIpRangeCreate,
)
from app.schemas.admin import CloudProviderCreate, CloudProviderUpdate


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[
        CloudProvider.__table__, CloudAsset.__table__, Device.__table__,
        ExternalIpPool.__table__, ExternalIpRange.__table__, ExternalIpAssignment.__table__,
        SystemSetting.__table__,
    ])
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_external_pool_address_page_and_summary():
    db = _session()
    pool = create_external_ip_pool(
        ExternalIpPoolCreate(name="WAN allocation", cidr="8.8.8.0/29"), None, db,
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
    assert tracked.assignment.asset is not None
    assert tracked.assignment.asset.kind == "https"

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


def test_external_pool_accepts_arbitrary_range_and_single_addresses():
    db = _session()
    address_range = create_external_ip_pool(
        ExternalIpPoolCreate(name="Small allocation", cidr="8.8.8.10 - 8.8.8.13"), None, db,
    )
    assert address_range.allocations[0].cidr == "8.8.8.10-8.8.8.13"
    assert address_range.total == 4
    page = list_external_pool_addresses(address_range.id, None, db, offset=0, limit=256)
    assert [entry.ip_address for entry in page.addresses] == [
        "8.8.8.10", "8.8.8.11", "8.8.8.12", "8.8.8.13",
    ]

    single = create_external_ip_pool(
        ExternalIpPoolCreate(name="Single address", cidr="9.9.9.9"), None, db,
    )
    assert single.allocations[0].cidr == "9.9.9.9/32"
    assert single.total == 1
    assert single.free == 1
    single_page = list_external_pool_addresses(single.id, None, db, offset=0, limit=256)
    assert single_page.total == 1
    assert [entry.ip_address for entry in single_page.addresses] == ["9.9.9.9"]

    assignment = create_external_ip_assignment(
        ExternalIpAssignmentCreate(
            pool_id=single.id, ip_address="9.9.9.9", label="Cloud public IP", status="in_use",
        ),
        None,
        db,
    )
    assert assignment.ip_address == "9.9.9.9"
    single = next(pool for pool in list_external_ip_pools(None, db) if pool.id == single.id)
    assert single.in_use == 1
    assert single.free == 0

    single_cidr = create_external_ip_pool(
        ExternalIpPoolCreate(name="Single CIDR", cidr="9.9.9.10/32"), None, db,
    )
    assert single_cidr.allocations[0].cidr == "9.9.9.10/32"
    assert single_cidr.total == 1

    single_ipv6 = create_external_ip_pool(
        ExternalIpPoolCreate(name="Single IPv6", cidr="2606:4700:4700::1111"), None, db,
    )
    assert single_ipv6.allocations[0].cidr == "2606:4700:4700::1111/128"
    assert single_ipv6.total == 1


def test_external_range_overlap_and_order_validation():
    db = _session()
    create_external_ip_pool(ExternalIpPoolCreate(name="Assigned", cidr="8.8.4.10-8.8.4.15"), None, db)
    with pytest.raises(HTTPException) as overlap:
        create_external_ip_pool(ExternalIpPoolCreate(name="Overlap", cidr="8.8.4.15-8.8.4.20"), None, db)
    assert overlap.value.status_code == 409

    with pytest.raises(HTTPException) as reversed_range:
        create_external_ip_pool(ExternalIpPoolCreate(name="Reversed", cidr="9.9.9.20-9.9.9.10"), None, db)
    assert reversed_range.value.status_code == 422


def test_allocation_group_accepts_unrelated_ranges_and_pages_them_together():
    db = _session()
    pool = create_external_ip_pool(
        ExternalIpPoolCreate(name="Azure production", cidr="9.9.9.9", service="Azure Functions", icon="server", account="sub-123", region="Australia East"),
        None,
        db,
    )
    second = create_external_ip_range(pool.id, ExternalIpRangeCreate(cidr="8.8.8.8"), None, db)
    third = create_external_ip_range(pool.id, ExternalIpRangeCreate(cidr="8.8.4.0/31"), None, db)

    pools = list_external_ip_pools(None, db)
    group = next(row for row in pools if row.id == pool.id)
    assert group.service == "Azure Functions"
    assert group.icon == "server"
    assert group.region == "Australia East"
    assert [row.cidr for row in group.allocations] == ["9.9.9.9/32", "8.8.8.8/32", "8.8.4.0/31"]
    assert group.total == 4
    page = list_external_pool_addresses(pool.id, None, db, offset=0, limit=256)
    assert [row.ip_address for row in page.addresses] == ["9.9.9.9", "8.8.8.8", "8.8.4.0", "8.8.4.1"]

    with pytest.raises(HTTPException) as overlap:
        create_external_ip_range(pool.id, ExternalIpRangeCreate(cidr="8.8.4.1"), None, db)
    assert overlap.value.status_code == 409

    delete_external_ip_range(pool.id, third.id, None, db)
    group = next(row for row in list_external_ip_pools(None, db) if row.id == pool.id)
    assert [row.id for row in group.allocations] == [pool.allocations[0].id, second.id]

    updated = update_external_ip_pool(pool.id, ExternalIpPoolUpdate(icon="database"), None, db)
    assert updated.icon == "database"
    assert db.get(ExternalIpPool, pool.id).icon == "database"
    fallback = update_external_ip_pool(pool.id, ExternalIpPoolUpdate(icon=None), None, db)
    assert fallback.icon == "cloud"


def test_delete_one_external_address_splits_its_range_and_removes_only_its_assignment():
    db = _session()
    pool = create_external_ip_pool(
        ExternalIpPoolCreate(name="AWS production", cidr="8.8.8.0/29"), None, db,
    )
    create_external_ip_assignment(
        ExternalIpAssignmentCreate(pool_id=pool.id, ip_address="8.8.8.3", label="Old endpoint", status="in_use"),
        None,
        db,
    )

    delete_external_pool_address(pool.id, "8.8.8.3", None, db)

    refreshed = next(row for row in list_external_ip_pools(None, db) if row.id == pool.id)
    assert [row.cidr for row in refreshed.allocations] == ["8.8.8.1-8.8.8.2", "8.8.8.4-8.8.8.6"]
    page = list_external_pool_addresses(pool.id, None, db, offset=0, limit=256)
    assert [row.ip_address for row in page.addresses] == ["8.8.8.1", "8.8.8.2", "8.8.8.4", "8.8.8.5", "8.8.8.6"]
    assert list_external_ip_assignments(None, db) == []


def test_delete_final_external_address_removes_the_empty_allocation():
    db = _session()
    pool = create_external_ip_pool(
        ExternalIpPoolCreate(name="Single cloud IP", cidr="9.9.9.9"), None, db,
    )

    delete_external_pool_address(pool.id, "9.9.9.9", None, db)

    assert db.get(ExternalIpPool, pool.id) is None
    assert db.query(ExternalIpRange).count() == 0


def test_provider_icon_lives_on_the_provider_not_the_pool():
    """Icons used to be copied onto every pool whose provider *string* matched.

    A rename split the group and the copies drifted. The icon now lives on the single
    provider row, so every pool referencing it is consistent by construction.
    """
    db = _session()
    provider = create_cloud_provider(
        CloudProviderCreate(name="AWS", aliases=["amazon"], icon="aws"), None, db,
    )
    first = create_external_ip_pool(
        ExternalIpPoolCreate(name="AWS production", cidr="8.8.8.8", provider_id=provider.id), None, db,
    )
    second = create_external_ip_pool(
        ExternalIpPoolCreate(name="AWS staging", cidr="9.9.9.9", provider_id=provider.id), None, db,
    )
    assert first.provider is not None and first.provider.icon == "aws"
    assert second.provider is not None and second.provider.icon == "aws"

    custom_data = "data:image/png;base64,iVBORw0KGgo="
    update_cloud_provider(
        provider.key,
        CloudProviderUpdate(name="AWS", aliases=["amazon"], icon="custom", icon_data=custom_data),
        None,
        db,
    )
    linked = {row.id: row.provider for row in list_external_ip_pools(None, db)}
    assert linked[first.id].icon == "custom"
    assert linked[second.id].icon == "custom"
    assert linked[first.id].icon_data == custom_data
    assert linked[second.id].icon_data == custom_data

    # Renaming no longer splits the grouping — both pools still point at one row.
    update_cloud_provider(
        provider.key,
        CloudProviderUpdate(name="Amazon Web Services", aliases=[], icon="aws"), None, db,
    )
    regrouped = {row.provider.id for row in list_external_ip_pools(None, db) if row.provider}
    assert regrouped == {provider.id}


def test_cloud_provider_table_crud_including_builtins():
    db = _session()
    icon_data = "data:image/png;base64,iVBORw0KGgo="
    provider = create_cloud_provider(
        CloudProviderCreate(name="Oracle Cloud", aliases=["OCI"], icon="custom", icon_data=icon_data), None, db,
    )
    assert provider.key == "oracle-cloud"
    assert list_cloud_providers(None, db)[0].aliases == ["OCI"]

    pool = create_external_ip_pool(
        ExternalIpPoolCreate(name="OCI production", cidr="1.1.1.1", provider_id=provider.id), None, db,
    )
    assert pool.provider is not None
    assert pool.provider.icon == "custom"
    assert pool.provider.icon_data == icon_data

    # Deleting a provider must not delete the pools that referenced it.
    delete_cloud_provider(provider.key, None, db)
    assert list_cloud_providers(None, db) == []
    orphaned = next(row for row in list_external_ip_pools(None, db) if row.id == pool.id)
    assert orphaned.provider_id is None
    assert orphaned.provider is None

    # Built-ins are deletable too — the flag records where the row came from, not whether
    # it is protected. Migration 0068 seeds them once, so this does not come back.
    builtin = CloudProvider(key="aws", name="AWS", aliases="[]", icon="aws", builtin=True)
    db.add(builtin)
    db.commit()
    delete_cloud_provider("aws", None, db)
    assert list_cloud_providers(None, db) == []

    with pytest.raises(HTTPException) as exc:
        delete_cloud_provider("aws", None, db)
    assert exc.value.status_code == 404


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
        update_external_ip_range(pool.id, pool.allocations[0].id, ExternalIpRangeCreate(cidr="8.8.8.0/29"), None, db)
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


def test_asset_holds_addresses_from_several_allocations():
    """The defect this tier exists to fix: one EC2 instance, several public IPs.

    Before the asset tier these were unrelated rows that happened to share a typed
    `service` string, which is why the UI could not group them.
    """
    db = _session()
    provider = create_cloud_provider(CloudProviderCreate(name="AWS", icon="aws"), None, db)
    elastic = create_external_ip_pool(
        ExternalIpPoolCreate(name="Elastic IPs", cidr="13.54.22.0/29", provider_id=provider.id), None, db,
    )
    byoip = create_external_ip_pool(
        ExternalIpPoolCreate(name="BYOIP block", cidr="52.62.1.9", provider_id=provider.id), None, db,
    )
    asset = create_cloud_asset(
        CloudAssetCreate(name="web-prod-01", kind="ec2", provider_id=provider.id, account="123456789012", region="ap-southeast-2"),
        None, db,
    )

    for pool_id, address in ((elastic.id, "13.54.22.1"), (elastic.id, "13.54.22.2"), (byoip.id, "52.62.1.9")):
        create_external_ip_assignment(
            ExternalIpAssignmentCreate(pool_id=pool_id, asset_id=asset.id, ip_address=address, label="web-prod-01"),
            None, db,
        )

    assets = list_cloud_assets(None, db)
    assert len(assets) == 1
    assert assets[0].address_count == 3
    assert assets[0].in_use == 3

    scoped = list_external_ip_assignments(None, db, asset_id=asset.id)
    assert {row.ip_address for row in scoped} == {"13.54.22.1", "13.54.22.2", "52.62.1.9"}
    # Every address still records which allocation it came from.
    assert {row.pool_id for row in scoped} == {elastic.id, byoip.id}


def test_deleting_an_asset_keeps_its_addresses():
    db = _session()
    pool = create_external_ip_pool(ExternalIpPoolCreate(name="WAN", cidr="8.8.8.0/29"), None, db)
    asset = create_cloud_asset(CloudAssetCreate(name="edge-01", kind="vm"), None, db)
    create_external_ip_assignment(
        ExternalIpAssignmentCreate(pool_id=pool.id, asset_id=asset.id, ip_address="8.8.8.2", label="edge"), None, db,
    )

    delete_cloud_asset(asset.id, None, db)

    remaining = list_external_ip_assignments(None, db)
    assert len(remaining) == 1
    assert remaining[0].asset_id is None
    assert remaining[0].asset is None
    summary = external_ip_summary(None, db)
    assert summary.asset_count == 0
    assert summary.unassigned_address_count == 1


def test_legacy_service_fields_still_create_an_asset():
    """A client that has not migrated keeps working, and its grouping is preserved."""
    db = _session()
    pool = create_external_ip_pool(ExternalIpPoolCreate(name="WAN", cidr="8.8.8.0/28"), None, db)
    first = create_external_ip_assignment(
        ExternalIpAssignmentCreate(
            pool_id=pool.id, ip_address="8.8.8.2", label="web-prod-01", service="EC2", account="acct-1",
        ),
        None, db,
    )
    second = create_external_ip_assignment(
        ExternalIpAssignmentCreate(
            pool_id=pool.id, ip_address="8.8.8.3", label="web-prod-01", service="EC2", account="acct-1",
        ),
        None, db,
    )
    assert first.asset_id is not None
    assert first.asset_id == second.asset_id
    assert first.asset.kind == "ec2"
    assert len(list_cloud_assets(None, db)) == 1


def test_asset_device_link_is_optional_and_reversible():
    db = _session()
    device = Device(hostname="web-prod-01", ip_address="10.0.0.5")
    db.add(device)
    db.commit()
    asset = create_cloud_asset(CloudAssetCreate(name="web-prod-01", kind="ec2"), None, db)
    assert asset.device_id is None

    linked = link_cloud_asset_device(asset.id, {"device_id": device.id}, None, db)
    assert linked.device_id == device.id

    unlinked = unlink_cloud_asset_device(asset.id, None, db)
    assert unlinked.device_id is None
    # Both sides survive the unlink.
    assert db.get(Device, device.id) is not None
    assert db.get(CloudAsset, asset.id) is not None


def test_asset_identity_is_unique_per_provider_and_account():
    db = _session()
    provider = create_cloud_provider(CloudProviderCreate(name="AWS", icon="aws"), None, db)
    create_cloud_asset(CloudAssetCreate(name="web-01", provider_id=provider.id, account="acct-1"), None, db)
    # Same name under a different account is legitimate.
    create_cloud_asset(CloudAssetCreate(name="web-01", provider_id=provider.id, account="acct-2"), None, db)
    with pytest.raises(HTTPException) as exc:
        create_cloud_asset(CloudAssetCreate(name="web-01", provider_id=provider.id, account="acct-1"), None, db)
    assert exc.value.status_code == 409

    with pytest.raises(HTTPException) as unknown:
        create_cloud_asset(CloudAssetCreate(name="bad-kind", kind="not_a_kind"), None, db)
    assert unknown.value.status_code == 422


def test_external_timestamps_are_utc_aware():
    """SQLite returns naive datetimes; every new endpoint must re-stamp UTC (GitHub #33)."""
    db = _session()
    pool = create_external_ip_pool(ExternalIpPoolCreate(name="WAN", cidr="8.8.8.0/29"), None, db)
    asset = create_cloud_asset(CloudAssetCreate(name="edge-01"), None, db)
    create_external_ip_assignment(
        ExternalIpAssignmentCreate(pool_id=pool.id, asset_id=asset.id, ip_address="8.8.8.2", label="edge"), None, db,
    )

    # Prove the stored values really are naive before serialization.
    raw = db.query(ExternalIpAssignment).first()
    assert raw.created_at.tzinfo is None

    assignment = list_external_ip_assignments(None, db)[0]
    assert assignment.created_at.tzinfo is not None
    assert assignment.updated_at.tzinfo is not None
    assert assignment.asset.created_at.tzinfo is not None
    assert list_cloud_assets(None, db)[0].updated_at.tzinfo is not None
    assert list_external_ip_pools(None, db)[0].created_at.tzinfo is not None


def test_address_can_be_added_straight_to_an_asset():
    """The primary cloud workflow: give this EC2 instance these IPs.

    No allocation has to exist first — a cloud elastic IP is a single address, not a
    delegated block, so requiring one was friction that did not match reality.
    """
    db = _session()
    provider = create_cloud_provider(CloudProviderCreate(name="AWS", icon="aws"), None, db)
    asset = create_cloud_asset(CloudAssetCreate(name="web-prod-01", kind="ec2", provider_id=provider.id), None, db)

    first = add_address_to_cloud_asset(asset.id, CloudAssetAddressCreate(ip_address="13.54.22.9"), None, db)
    second = add_address_to_cloud_asset(asset.id, CloudAssetAddressCreate(ip_address="52.62.1.9"), None, db)

    assert first.asset_id == asset.id
    assert second.asset_id == asset.id
    # Label defaults to the asset name rather than forcing the user to retype it.
    assert first.label == "web-prod-01"

    # Both were filed under one auto-created provider/service allocation.
    pools = list_external_ip_pools(None, db)
    assert [pool.name for pool in pools] == ["AWS Amazon EC2 individual addresses"]
    assert pools[0].service == "Amazon EC2"
    assert pools[0].total == 2
    assert first.pool_id == second.pool_id

    assets = list_cloud_assets(None, db)
    assert assets[0].address_count == 2


def test_address_added_to_an_asset_reuses_a_covering_allocation():
    """An existing block wins over creating a new individual-address bucket."""
    db = _session()
    provider = create_cloud_provider(CloudProviderCreate(name="AWS", icon="aws"), None, db)
    block = create_external_ip_pool(
        ExternalIpPoolCreate(name="BYOIP block", cidr="13.54.22.0/28", provider_id=provider.id), None, db,
    )
    asset = create_cloud_asset(CloudAssetCreate(name="web-prod-01", provider_id=provider.id), None, db)

    tracked = add_address_to_cloud_asset(asset.id, CloudAssetAddressCreate(ip_address="13.54.22.5"), None, db)

    assert tracked.pool_id == block.id
    assert [pool.name for pool in list_external_ip_pools(None, db)] == ["BYOIP block"]


def test_adding_an_address_to_an_asset_rejects_private_and_duplicate_addresses():
    db = _session()
    asset = create_cloud_asset(CloudAssetCreate(name="edge-01"), None, db)

    with pytest.raises(HTTPException) as private:
        add_address_to_cloud_asset(asset.id, CloudAssetAddressCreate(ip_address="10.0.0.5"), None, db)
    assert private.value.status_code == 422

    add_address_to_cloud_asset(asset.id, CloudAssetAddressCreate(ip_address="8.8.8.8"), None, db)
    with pytest.raises(HTTPException) as duplicate:
        add_address_to_cloud_asset(asset.id, CloudAssetAddressCreate(ip_address="8.8.8.8"), None, db)
    assert duplicate.value.status_code == 409

    with pytest.raises(HTTPException) as missing:
        add_address_to_cloud_asset(9999, CloudAssetAddressCreate(ip_address="8.8.4.4"), None, db)
    assert missing.value.status_code == 404

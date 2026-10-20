"""Retained resources are editable without reviving legacy address assignments."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_user
from app.api.v1.ipam import router
from app.db.session import get_db
from app.models.cloud import CloudAsset, CloudProvider
from app.models.device import Device
from app.models.external_ip import ExternalIpAddress
from test_external_ipam import _session, _reader, _writer


@pytest.fixture
def context():
    db = _session()
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: db
    actor = {"user": _writer()}
    app.dependency_overrides[get_current_user] = lambda: actor["user"]
    asset = CloudAsset(name="Retained VM", kind="vm", account="Production", region="Sydney", description="Keep me")
    db.add(asset)
    db.commit()
    yield TestClient(app), db, actor, asset.id
    db.close()


def test_edit_and_link_resource_without_modifying_device_or_addresses(context):
    client, db, _, asset_id = context
    device = Device(hostname="Existing", ip_address="203.0.113.10", monitoring_paused=True)
    provider = CloudProvider(key="example", name="Example", icon="cloud")
    db.add_all([device, provider])
    db.commit()
    result = client.patch(f"/ipam/external/assets/{asset_id}", json={
        "name": "Updated VM", "kind": "ec2", "provider_id": provider.id,
        "account": "New account", "region": "au-east", "description": "Updated notes", "device_id": device.id,
    })
    assert result.status_code == 200, result.text
    assert result.json()["name"] == "Updated VM"
    assert result.json()["device_id"] == device.id
    assert result.json()["provider_id"] == provider.id
    db.refresh(device)
    assert device.monitoring_paused is True
    assert db.query(Device).count() == 1
    assert db.query(ExternalIpAddress).count() == 0
    assert client.patch(f"/ipam/external/assets/{asset_id}", json={"device_id": None}).status_code == 200
    assert db.get(CloudAsset, asset_id).description == "Updated notes"
    assert db.query(Device).count() == 1


def test_patch_is_sparse_and_preserves_legacy_values(context):
    client, db, _, asset_id = context
    asset = db.get(CloudAsset, asset_id)
    asset.kind = "legacy_kind"
    asset.device_id = 999
    db.commit()
    result = client.patch(f"/ipam/external/assets/{asset_id}", json={"description": "Changed"})
    assert result.status_code == 200
    assert result.json()["kind"] == "legacy_kind"
    assert result.json()["device_id"] == 999
    assert result.json()["account"] == "Production"
    assert client.patch(f"/ipam/external/assets/{asset_id}", json={"account": None, "region": None}).status_code == 200


@pytest.mark.parametrize("patch,code", [
    ({"name": "  "}, 422), ({"name": None}, 422), ({"kind": "invented"}, 422),
    ({"provider_id": 123456}, 404), ({"device_id": 123456}, 404), ({"id": 999}, 422),
])
def test_invalid_patch_changes_nothing(context, patch, code):
    client, db, _, asset_id = context
    result = client.patch(f"/ipam/external/assets/{asset_id}", json=patch)
    assert result.status_code == code
    db.expire_all()
    assert db.get(CloudAsset, asset_id).name == "Retained VM"
    assert db.get(CloudAsset, asset_id).device_id is None


def test_update_requires_ipam_write_and_auth(context):
    client, db, actor, asset_id = context
    actor["user"] = _reader()
    assert client.patch(f"/ipam/external/assets/{asset_id}", json={"name": "Denied"}).status_code == 403
    client.app.dependency_overrides.pop(get_current_user)
    assert client.patch(f"/ipam/external/assets/{asset_id}", json={"name": "Denied"}).status_code == 401
    assert db.get(CloudAsset, asset_id).name == "Retained VM"


def test_duplicate_identity_and_missing_asset(context):
    client, db, _, asset_id = context
    provider = CloudProvider(key="p", name="Provider", icon="cloud")
    db.add(provider)
    db.flush()
    db.get(CloudAsset, asset_id).provider_id = provider.id
    db.add(CloudAsset(name="Taken", provider_id=provider.id, account="Production"))
    db.commit()
    assert client.patch(f"/ipam/external/assets/{asset_id}", json={"name": "Taken"}).status_code == 409
    assert client.patch("/ipam/external/assets/123456", json={"name": "Missing"}).status_code == 404
    db.expire_all()
    assert db.get(CloudAsset, asset_id).name == "Retained VM"

"""Cloud asset types: built-ins plus normalised custom types, and migration 0082."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1.ipam import router
from app.db import session as db_session
from app.db.session import _migrate_cloud_asset_types, _migrate_cloud_assets, get_db
from app.models.cloud import CloudAsset, CloudAssetType
from test_external_ipam import _reader, _session, _writer

BUILT_INS = [
    ("server", "Server"), ("load_balancer", "Load balancer"), ("database", "Database"),
    ("storage", "Storage"), ("network", "Network"), ("other", "Other"),
]


@pytest.fixture
def context():
    db = _session()
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: db
    actor = {"user": _writer()}
    app.dependency_overrides[get_current_user] = lambda: actor["user"]
    yield TestClient(app), db, actor
    db.close()


def test_lists_plain_built_ins_first(context):
    client, _, actor = context
    actor["user"] = _reader()
    rows = client.get("/ipam/external/asset-types").json()
    assert [(row["value"], row["label"]) for row in rows] == BUILT_INS
    assert all(row["is_builtin"] for row in rows)


def test_create_custom_type_normalises_and_lists_it(context):
    client, db, _ = context
    result = client.post("/ipam/external/asset-types", json={"label": "  Kubernetes   cluster "})
    assert result.status_code == 201, result.text
    assert result.json() == {"id": result.json()["id"], "value": "kubernetes_cluster", "label": "Kubernetes cluster", "is_builtin": False}
    assert db.query(CloudAssetType).count() == 1
    rows = client.get("/ipam/external/asset-types").json()
    assert rows[-1]["value"] == "kubernetes_cluster"


@pytest.mark.parametrize("label,value", [("Load Balancer", "load_balancer"), ("load balancer", "load_balancer"), ("SERVER", "server")])
def test_create_matching_a_built_in_returns_it(context, label, value):
    client, db, _ = context
    result = client.post("/ipam/external/asset-types", json={"label": label})
    assert result.status_code == 200
    assert result.json()["value"] == value and result.json()["is_builtin"] is True
    assert db.query(CloudAssetType).count() == 0


def test_create_matching_an_existing_custom_type_returns_it(context):
    client, db, _ = context
    first = client.post("/ipam/external/asset-types", json={"label": "Queue"}).json()
    again = client.post("/ipam/external/asset-types", json={"label": "QUEUE"})
    assert again.status_code == 200 and again.json() == first
    db.add(CloudAssetType(value="msg_bus", label="Message bus"))
    db.commit()
    assert client.post("/ipam/external/asset-types", json={"label": "message BUS"}).json()["value"] == "msg_bus"
    assert db.query(CloudAssetType).count() == 2


@pytest.mark.parametrize("label", ["", "   ", "!!!", "x" * 81])
def test_create_rejects_labels_without_a_usable_name(context, label):
    client, db, _ = context
    assert client.post("/ipam/external/asset-types", json={"label": label}).status_code == 422
    assert db.query(CloudAssetType).count() == 0


def test_create_requires_ipam_write_and_auth(context):
    client, db, actor = context
    actor["user"] = _reader()
    assert client.post("/ipam/external/asset-types", json={"label": "Queue"}).status_code == 403
    client.app.dependency_overrides.pop(get_current_user)
    assert client.get("/ipam/external/asset-types").status_code == 401
    assert client.post("/ipam/external/asset-types", json={"label": "Queue"}).status_code == 401
    assert db.query(CloudAssetType).count() == 0


def test_asset_type_must_be_a_built_in_or_existing_custom_value(context):
    client, db, _ = context
    assert client.post("/ipam/external/assets", json={"name": "A", "kind": "ec2"}).status_code == 422
    assert client.post("/ipam/external/assets", json={"name": "B", "kind": "queue"}).status_code == 422
    assert client.post("/ipam/external/assets", json={"name": "C", "kind": "server"}).status_code == 201
    client.post("/ipam/external/asset-types", json={"label": "Queue"})
    created = client.post("/ipam/external/assets", json={"name": "D", "kind": "queue"})
    assert created.status_code == 201 and created.json()["kind"] == "queue"
    asset_id = created.json()["id"]
    assert client.patch(f"/ipam/external/assets/{asset_id}", json={"kind": "vm"}).status_code == 422
    assert client.patch(f"/ipam/external/assets/{asset_id}", json={"kind": "network"}).json()["kind"] == "network"
    assert client.patch(f"/ipam/external/assets/{asset_id}", json={"kind": None}).json()["kind"] is None
    assert db.query(CloudAsset).count() == 2


def _legacy_conn():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    conn = engine.connect()
    _migrate_cloud_assets(conn, None)
    return conn


def _insert_assets(conn, kinds):
    for index, kind in enumerate(kinds):
        conn.execute(text(
            "INSERT INTO cloud_assets (name, kind, created_at, updated_at) VALUES (:name, :kind, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ), {"name": f"asset-{index}", "kind": kind})


def _kinds(conn):
    return [row[0] for row in conn.execute(text("SELECT kind FROM cloud_assets ORDER BY id"))]


def test_0082_maps_legacy_kinds_onto_the_new_built_ins():
    conn = _legacy_conn()
    legacy = ["ec2", "vm", "load_balancer", "nat_gateway", "k8s_ingress", "cdn", "database", "storage", "other", None]
    _insert_assets(conn, legacy)
    _migrate_cloud_asset_types(conn, None)
    assert _kinds(conn) == ["server", "server", "load_balancer", "network", "network", "network", "database", "storage", "other", None]
    assert conn.execute(text("SELECT COUNT(*) FROM cloud_asset_types")).scalar() == 0


def test_0082_keeps_unknown_kinds_as_custom_types():
    conn = _legacy_conn()
    _insert_assets(conn, ["aws_lambda", "aws_lambda", "Message Queue", "  "])
    _migrate_cloud_asset_types(conn, None)
    assert _kinds(conn) == ["aws_lambda", "aws_lambda", "message_queue", None]
    types = conn.execute(text("SELECT value, label FROM cloud_asset_types ORDER BY value")).fetchall()
    assert [tuple(row) for row in types] == [("aws_lambda", "Aws lambda"), ("message_queue", "Message Queue")]


def test_0082_is_idempotent():
    conn = _legacy_conn()
    _insert_assets(conn, ["ec2", "aws_lambda", "cdn"])
    _migrate_cloud_asset_types(conn, None)
    first = (_kinds(conn), conn.execute(text("SELECT value, label FROM cloud_asset_types")).fetchall())
    _migrate_cloud_asset_types(conn, None)
    assert (_kinds(conn), conn.execute(text("SELECT value, label FROM cloud_asset_types")).fetchall()) == first


def test_0082_on_a_database_without_cloud_assets_only_creates_the_table():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    conn = engine.connect()
    _migrate_cloud_asset_types(conn, None)
    assert "cloud_asset_types" in inspect(conn).get_table_names()
    assert "cloud_assets" not in inspect(conn).get_table_names()


def test_fresh_install_creates_cloud_asset_types_and_records_0082(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    monkeypatch.setattr(db_session, "engine", engine)
    db_session.init_db()
    columns = {column["name"] for column in inspect(engine).get_columns("cloud_asset_types")}
    assert columns == {"id", "value", "label", "created_at"}
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM schema_migrations WHERE name = '0082_cloud_asset_types'")).scalar() == 1
        assert conn.execute(text("PRAGMA integrity_check")).scalar() == "ok"

"""Every API datetime is UTC and serialised with a single ``Z`` suffix."""
from __future__ import annotations

import importlib
import pkgutil
import re
import typing
from datetime import datetime, timedelta, timezone

import pydantic
import pytest
import sqlalchemy as sa
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pydantic import BaseModel, PlainSerializer, TypeAdapter
from sqlalchemy.orm import sessionmaker

import app.api.v1
import app.schemas
from app.db.session import Base
from app.models import firewall_event  # noqa: F401  (registers the firewall table)
from app.models.user import UserRole
from app.schemas.datetimes import UtcAwareDatetime, UtcDatetime, utc_isoformat
from app.services.exports.service import format_csv_value, json_default
from app.websocket.firewall_events import serialize_json_value
from tests.app_helpers import add_user, memory_factory, real_app_client

UTC_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
ISO_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
NAIVE = datetime(2026, 10, 26, 9, 25, 39, 99090)


def test_naive_values_are_read_as_utc_and_end_in_z():
    adapter = TypeAdapter(UtcDatetime)
    assert adapter.dump_python(adapter.validate_python(NAIVE), mode="json") == "2026-10-26T09:25:39.099090Z"


def test_offset_values_are_converted_to_utc_and_end_in_z():
    adapter = TypeAdapter(UtcDatetime)
    brisbane = datetime(2026, 10, 26, 19, 25, 39, 99090, tzinfo=timezone(timedelta(hours=10)))
    assert adapter.dump_python(adapter.validate_python(brisbane), mode="json") == "2026-10-26T09:25:39.099090Z"
    assert adapter.dump_python(adapter.validate_python("2026-10-26T09:25:39+00:00"), mode="json") == (
        "2026-10-26T09:25:39Z"
    )


def test_aware_variant_still_requires_an_offset_and_emits_z():
    adapter = TypeAdapter(UtcAwareDatetime)
    with pytest.raises(pydantic.ValidationError):
        adapter.validate_python("2026-10-26T09:25:39")
    value = adapter.validate_python("2026-10-26T19:25:39+10:00")
    assert value == datetime(2026, 10, 26, 9, 25, 39, tzinfo=timezone.utc)
    assert adapter.dump_python(value, mode="json") == "2026-10-26T09:25:39Z"


def test_python_mode_keeps_datetime_objects():
    adapter = TypeAdapter(UtcDatetime)
    assert adapter.dump_python(adapter.validate_python(NAIVE)) == NAIVE.replace(tzinfo=timezone.utc)


def test_dict_serialisers_use_the_same_suffix():
    brisbane = datetime(2026, 10, 26, 19, 25, 39, tzinfo=timezone(timedelta(hours=10)))
    for value in (NAIVE, NAIVE.replace(tzinfo=timezone.utc), brisbane):
        for render in (utc_isoformat, format_csv_value, json_default, serialize_json_value):
            assert UTC_Z.match(render(value)), (render.__name__, render(value))
    assert format_csv_value(NAIVE) == "2026-10-26T09:25:39.099090Z"


def _modules(package):
    yield package
    for info in pkgutil.walk_packages(package.__path__, f"{package.__name__}."):
        yield importlib.import_module(info.name)


def _contains_datetime(annotation) -> bool:
    if annotation is datetime:
        return True
    return any(_contains_datetime(arg) for arg in typing.get_args(annotation))


def test_every_schema_datetime_field_uses_the_shared_utc_type():
    plain = []
    for module in [*_modules(app.schemas), *_modules(app.api.v1)]:
        for name, model in vars(module).items():
            if not (isinstance(model, type) and issubclass(model, BaseModel)) or model.__module__ != module.__name__:
                continue
            for field_name, field in model.model_fields.items():
                if not _contains_datetime(field.annotation):
                    continue
                serializers = [m for m in field.metadata if isinstance(m, PlainSerializer)]
                if not serializers:
                    # Optional fields keep the metadata on the inner Annotated type.
                    args = typing.get_args(field.annotation)
                    serializers = [
                        m for arg in args for m in getattr(arg, "__metadata__", ()) if isinstance(m, PlainSerializer)
                    ]
                if not serializers:
                    plain.append(f"{module.__name__}.{name}.{field_name}")
    assert plain == []


# ── Every GET endpoint, against a database seeded with naive datetimes ────────


# Values the generic seed would otherwise get wrong, so these endpoints return 200 too.
SEED_OVERRIDES = {
    ("notification_profiles", "provider"): "webhook",
    ("discovery_schedules", "scan_type"): "ping",
    ("discovery_schedules", "interval_minutes"): 60,
    ("devices", "status"): "online",
    ("devices", "lifecycle"): "active",
    ("devices", "expected_status"): "online",
    ("alert_rules", "channels"): "[]",
    ("external_ip_addresses", "status"): "in_use",
    ("topology_groups", "dhcp_start"): None,
    ("topology_groups", "dhcp_end"): None,
    ("status_pages", "slug"): "seed",
    ("status_pages", "visibility"): "public",
    ("status_pages", "custom_css"): None,
    ("status_pages", "logo"): None,
    ("status_pages", "accent"): None,
    ("status_pages", "heartbeat_window"): "1h",
}
# A seeded relationship would link device 1 to itself, which the graph rejects.
SEED_SKIP = {"users", "device_relationships"}


def _value(col: sa.Column):
    if (col.table.name, col.name) in SEED_OVERRIDES:
        return SEED_OVERRIDES[(col.table.name, col.name)]
    t = col.type
    name = col.name.lower()
    if isinstance(t, sa.Enum):
        return t.enums[0]
    if isinstance(t, sa.Boolean):
        return False
    if isinstance(t, sa.DateTime):
        return NAIVE
    if isinstance(t, sa.Date):
        return NAIVE.date()
    if isinstance(t, (sa.Integer, sa.BigInteger, sa.SmallInteger)):
        return 1
    if isinstance(t, (sa.Float, sa.Numeric)):
        return 1.0
    if isinstance(t, sa.JSON):
        return {} if "config" in name or "settings" in name else []
    if isinstance(t, sa.LargeBinary):
        return b""
    if name.endswith("json") or name.endswith("_list") or name in {"tags", "events", "ports", "headers"}:
        return "[]"
    for key, val in (("cidr", "192.168.1.0/24"), ("network", "192.168.1.0/24"), ("subnet", "192.168.1.0/24"),
                     ("mac", "aa:bb:cc:dd:ee:ff"), ("email", "seed@example.com"), ("url", "https://example.com"),
                     ("ip", "192.168.1.10"), ("address", "192.168.1.10"), ("host", "192.168.1.10"),
                     ("role", "Viewer"), ("severity", "warning"), ("method", "GET"), ("color", "#336699"),
                     ("colour", "#336699"), ("protocol", "tcp"), ("action", "allow"), ("status", "up"),
                     ("state", "up"), ("kind", "http"), ("type", "server")):
        if key in name:
            return val
    return f"seed-{name}"[: getattr(t, "length", None) or 64]


def _seed(factory, admin_id: int, metadata=Base.metadata) -> None:
    with factory() as db:
        conn = db.connection()
        for table in metadata.sorted_tables:
            if table.name in SEED_SKIP:
                continue
            row = {}
            for col in table.columns:
                if col.primary_key and isinstance(col.type, sa.Integer):
                    continue
                if col.name.endswith("user_id") or col.name in {"actor_user_id", "created_by", "owner_id"}:
                    row[col.name] = admin_id
                    continue
                row[col.name] = _value(col)
            try:
                with conn.begin_nested():
                    conn.execute(table.insert().values(**row))
            except sa.exc.SQLAlchemyError:
                pass  # constraint quirks leave the table empty
        db.commit()


def _datetimes(obj, path="$"):
    if isinstance(obj, dict):
        for key, value in obj.items():
            yield from _datetimes(value, f"{path}.{key}")
    elif isinstance(obj, list):
        for index, value in enumerate(obj[:3]):
            yield from _datetimes(value, f"{path}[{index}]")
    elif isinstance(obj, str) and "T" in obj and ISO_DATETIME.match(obj):
        yield path, obj


@pytest.fixture()
def firewall_db(monkeypatch, tmp_path):
    from app.core.config import settings
    from app.db import firewall_session
    from app.db.firewall_session import FirewallBase, get_firewall_db
    from app.main import app

    engine = sa.create_engine(f"sqlite:///{tmp_path}/firewall.db", connect_args={"check_same_thread": False})
    FirewallBase.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "backup_dir", str(tmp_path / "backups"), raising=False)
    monkeypatch.setitem(firewall_session.FirewallSessionLocal.kw, "bind", engine)

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_firewall_db] = override
    yield factory
    app.dependency_overrides.pop(get_firewall_db, None)
    engine.dispose()


@pytest.mark.filterwarnings("ignore::sqlalchemy.exc.SAWarning")
def test_every_get_endpoint_serialises_datetimes_as_utc_z(firewall_db):
    from app.db.firewall_session import FirewallBase
    from app.main import app

    factory = memory_factory()
    with factory() as db:
        admin = add_user(db, "seed-admin", UserRole.SUPER_ADMIN, email="admin@example.com")
    _seed(factory, admin.id)
    _seed(firewall_db, admin.id, FirewallBase.metadata)

    offenders, checked = {}, 0
    with real_app_client(factory, admin):
        client = TestClient(app, base_url="http://testserver", raise_server_exceptions=False)
        for route in app.routes:
            if not isinstance(route, APIRoute) or "GET" not in route.methods:
                continue
            response = client.get(re.sub(r"\{[^}]+\}", "1", route.path))
            if response.status_code != 200 or "json" not in response.headers.get("content-type", ""):
                continue
            checked += 1
            bad = sorted({f"{p}={v}" for p, v in _datetimes(response.json()) if not UTC_Z.match(v)})
            if bad:
                offenders[route.path] = bad
    assert checked >= 80  # the rest stream files, redirect to OIDC, probe SNMP or need a built cache
    assert offenders == {}


def test_ipam_reservation_expiry_date_round_trips():
    factory = memory_factory()
    with factory() as db:
        admin = add_user(db, "ipam-admin", UserRole.SUPER_ADMIN)
    with real_app_client(factory, admin) as client:
        created = client.post(
            "/api/v1/ipam/reservations",
            json={"ip_address": "192.168.1.50", "label": "Printer", "expires_at": "2026-12-31T23:59:59Z"},
        )
        assert created.status_code == 201, created.text
        assert created.json()["expires_at"] == "2026-12-31T23:59:59Z"
        listed = client.get("/api/v1/ipam/reservations").json()
        assert listed[0]["expires_at"] == "2026-12-31T23:59:59Z"
        assert listed[0]["expires_at"][:10] == "2026-12-31"
        assert UTC_Z.match(listed[0]["created_at"])

        updated = client.patch(
            f"/api/v1/ipam/reservations/{listed[0]['id']}", json={"expires_at": "2027-01-15T23:59:59+00:00"}
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["expires_at"] == "2027-01-15T23:59:59Z"

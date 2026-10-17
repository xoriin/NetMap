import json

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import StaticPool

from app.db.session import _migrate_status_pages
from app.models.status_page import (
    OPEN_INCIDENT_DEFAULT_EVENTS,
    StatusIncident,
    StatusIncidentSource,
    StatusMaintenance,
    StatusPage,
    StatusPageGroup,
    StatusPageItem,
)
from app.services.rbac.permissions import PERMISSION_KEYS, ROLE_DEFAULTS
from tests.status_page_helpers import make_session, seed_device, seed_monitor, seed_service_check


def _legacy_engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE alert_rules (id INTEGER PRIMARY KEY, name VARCHAR(120), event_type VARCHAR(40) NOT NULL)"
        ))
        conn.execute(text("CREATE TABLE system_settings (key VARCHAR(120) PRIMARY KEY, value TEXT, updated_at DATETIME)"))
        conn.execute(text("INSERT INTO alert_rules (name, event_type) VALUES ('a', 'device_offline'), ('b', 'rtt_above')"))
    return engine


def _page_with_group(db, slug="main"):
    page = StatusPage(slug=slug, name="Main")
    db.add(page)
    db.flush()
    group = StatusPageGroup(page_id=page.id, name="Main")
    db.add(group)
    db.commit()
    return page, group


def test_fresh_schema_has_status_tables_and_rule_columns():
    db = make_session()
    names = set(inspect(db.get_bind()).get_table_names())
    assert {"status_pages", "status_page_items", "status_incidents", "status_breach_streaks",
            "status_integration_tokens", "status_maintenance"} <= names
    cols = {c["name"] for c in inspect(db.get_bind()).get_columns("alert_rules")}
    assert {"open_incident", "incident_min_failures"} <= cols


def test_migration_backfills_rule_defaults_by_event_type():
    engine = _legacy_engine()
    with engine.begin() as conn:
        _migrate_status_pages(conn, None)
        rows = {r[0]: (r[1], r[2]) for r in conn.execute(
            text("SELECT event_type, open_incident, incident_min_failures FROM alert_rules"))}
    assert rows == {"device_offline": (1, 3), "rtt_above": (0, 3)}
    assert "device_offline" in OPEN_INCIDENT_DEFAULT_EVENTS


def test_migration_is_idempotent():
    engine = _legacy_engine()
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO system_settings (key, value) VALUES ('role_permissions', :v)"),
                     {"v": json.dumps({"NetworkAdmin": ["alert_write"]})})
        _migrate_status_pages(conn, None)
        first = (conn.execute(text("SELECT * FROM alert_rules ORDER BY id")).fetchall(),
                 conn.execute(text("SELECT value FROM system_settings")).scalar_one())
        conn.execute(text("UPDATE alert_rules SET open_incident = 0 WHERE event_type = 'device_offline'"))
        _migrate_status_pages(conn, None)
        second = (conn.execute(text("SELECT * FROM alert_rules ORDER BY id")).fetchall(),
                  conn.execute(text("SELECT value FROM system_settings")).scalar_one())
    assert second[1] == first[1]
    assert [tuple(r)[:3] for r in second[0]] == [tuple(r)[:3] for r in first[0]]
    assert second[0][0].open_incident == 0


def test_migration_creates_active_source_index_on_existing_table():
    db = make_session()
    with db.get_bind().begin() as conn:
        conn.execute(text("DROP INDEX uq_status_incident_sources_active"))
        _migrate_status_pages(conn, None)
        _migrate_status_pages(conn, None)
        sql = conn.execute(text(
            "SELECT sql FROM sqlite_master WHERE name = 'uq_status_incident_sources_active'")).scalar_one()
    assert "WHERE active = 1" in sql


def test_network_admin_gets_permission_in_stored_role_matrix():
    engine = _legacy_engine()
    stored = {"NetworkAdmin": ["alert_write"], "Viewer": ["tools_passive"]}
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO system_settings (key, value) VALUES ('role_permissions', :v)"),
                     {"v": json.dumps(stored)})
        _migrate_status_pages(conn, None)
        _migrate_status_pages(conn, None)
        roles = json.loads(conn.execute(text("SELECT value FROM system_settings")).scalar_one())
    assert roles["NetworkAdmin"] == ["alert_write", "status_page_manage"]
    assert roles["Viewer"] == ["tools_passive"]


def test_permission_registered_for_network_admin_only():
    assert "status_page_manage" in PERMISSION_KEYS
    assert "status_page_manage" in ROLE_DEFAULTS["NetworkAdmin"]
    assert "status_page_manage" not in ROLE_DEFAULTS["Viewer"]


def test_item_shape_check_rejects_monitor_item_with_device_id():
    db = make_session()
    page, group = _page_with_group(db)
    device, monitor = seed_device(db), seed_monitor(db)
    db.add(StatusPageItem(page_id=page.id, group_id=group.id, kind="monitor", device_id=device.id,
                          monitor_id=monitor.id, display_name="x"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_item_shapes_accept_valid_kinds_and_reject_duplicates():
    db = make_session()
    page, group = _page_with_group(db)
    device, monitor = seed_device(db), seed_monitor(db)
    check = seed_service_check(db, None)
    base = dict(page_id=page.id, group_id=group.id)
    db.add_all([
        StatusPageItem(kind="device", device_id=device.id, display_name="d", **base),
        StatusPageItem(kind="monitor", monitor_id=monitor.id, display_name="m", **base),
        StatusPageItem(kind="service_check", device_id=device.id, port_target_id=check.id, display_name="s", **base),
    ])
    db.commit()
    assert db.query(StatusPageItem).count() == 3
    for extra in (dict(kind="monitor", monitor_id=monitor.id), dict(kind="device", device_id=device.id)):
        db.add(StatusPageItem(display_name="dup", **base, **extra))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


def test_item_requires_non_empty_display_name_and_valid_service_check_shape():
    db = make_session()
    page, group = _page_with_group(db)
    device = seed_device(db)
    db.add(StatusPageItem(page_id=page.id, group_id=group.id, kind="device", device_id=device.id, display_name=""))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    db.add(StatusPageItem(page_id=page.id, group_id=group.id, kind="service_check", device_id=device.id,
                          display_name="x"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_item_extras_default_to_empty_object():
    db = make_session()
    page, group = _page_with_group(db)
    device = seed_device(db)
    item = StatusPageItem(page_id=page.id, group_id=group.id, kind="device", device_id=device.id, display_name="d")
    db.add(item)
    db.commit()
    db.refresh(item)
    assert item.extras == {}


def test_page_slug_visibility_and_accent_constraints():
    db = make_session()
    for kwargs in (dict(slug="Upper"), dict(slug="has space"), dict(slug="a" * 49), dict(slug=""),
                   dict(slug="ok", visibility="hidden"), dict(slug="ok", heartbeat_window="7d"),
                   dict(slug="ok", accent="red")):
        db.add(StatusPage(name="n", **kwargs))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
    db.add(StatusPage(slug="a-1", name="n", accent="#0a1b2c"))
    db.commit()
    db.add(StatusPage(slug="a-1", name="again"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_one_active_auto_association_per_source_family_page():
    db = make_session()
    page, _ = _page_with_group(db)
    first = StatusIncident(title="t", source="netmap")
    second = StatusIncident(title="t2", source="netmap")
    db.add_all([first, second])
    db.commit()
    row = dict(source_key="device:1", condition_family="reachability", page_id=page.id)
    db.add(StatusIncidentSource(incident_id=first.id, **row))
    db.commit()
    db.add(StatusIncidentSource(incident_id=second.id, **row))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    db.add(StatusIncidentSource(incident_id=second.id, active=False, **row))
    db.commit()


def test_incident_history_survives_source_deletion():
    db = make_session()
    page, _ = _page_with_group(db)
    device = seed_device(db)
    incident = StatusIncident(title="t", source="netmap")
    db.add(incident)
    db.commit()
    db.add(StatusIncidentSource(incident_id=incident.id, source_key=f"device:{device.id}",
                                condition_family="reachability", page_id=page.id))
    db.commit()
    db.delete(device)
    db.commit()
    assert db.query(StatusIncident).count() == 1
    assert db.query(StatusIncidentSource).count() == 1


def test_maintenance_window_must_end_after_start():
    from datetime import datetime, timedelta, timezone
    db = make_session()
    now = datetime.now(timezone.utc)
    db.add(StatusMaintenance(title="m", starts_at=now, ends_at=now))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
    db.add(StatusMaintenance(title="m", starts_at=now, ends_at=now + timedelta(hours=1)))
    db.commit()

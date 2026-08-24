from collections.abc import Generator
from datetime import datetime, timezone
import json
import logging
import re
import sqlite3

from sqlalchemy import event, inspect, text
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings

logger = logging.getLogger(__name__)

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine_kwargs = {"connect_args": connect_args}

if settings.database_url == "sqlite://":
    engine_kwargs["poolclass"] = StaticPool
else:
    # The default pool (5 + 10 overflow) is too small once the request
    # threadpool competes with the alert monitor, standalone monitors, the
    # scheduled-backup thread and scheduled discovery for connections.
    engine_kwargs["pool_size"] = 20
    engine_kwargs["max_overflow"] = 20
    engine_kwargs["pool_timeout"] = 10

engine = create_engine(settings.database_url, **engine_kwargs)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, _rec):
    if isinstance(dbapi_conn, sqlite3.Connection):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        # 5 s was not enough headroom for bursty writers (topology autosave,
        # monitor history, retention purges) and surfaced as "database is
        # locked" 500s on unrelated requests.
        cur.execute("PRAGMA busy_timeout=20000")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from app.models import alert_rule, api_key, auth_session, audit_log, device, device_type, dhcp_lease, discovery, external_ip, ip_reservation, monitor, monitor_history, notification_delivery, notification_profile, oidc, password_reset_token, port_target, relationship, saved_search, site, snmp_profile, subnet, system_setting, topology_group, topology_layout, user, user_device_favourite, user_monitor_favourite  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_migrations_table()
    apply_sqlite_schema_updates()


def _ensure_migrations_table() -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    applied_at DATETIME NOT NULL
                )
                """
            )
        )


def _migration_applied(connection, name: str) -> bool:
    row = connection.execute(
        text("SELECT 1 FROM schema_migrations WHERE name = :name"), {"name": name}
    ).fetchone()
    return row is not None


def _record_migration(connection, name: str) -> None:
    connection.execute(
        text("INSERT INTO schema_migrations (name, applied_at) VALUES (:name, :now)"),
        {"name": name, "now": datetime.now(timezone.utc).isoformat()},
    )
    logger.info("Applied schema migration: %s", name)


def apply_sqlite_schema_updates() -> None:
    if not settings.database_url.startswith("sqlite"):
        return

    inspector = inspect(engine)
    if "devices" not in inspector.get_table_names():
        return

    with engine.begin() as conn:
        _run_migration(conn, inspector, "0001_devices_columns", _migrate_devices_columns)
        _run_migration(conn, inspector, "0003_topology_groups_columns", _migrate_topology_group_columns)
        _run_migration(conn, inspector, "0004_topology_group_entity_backfill", _migrate_topology_group_backfill)
        _run_migration(conn, inspector, "0005_system_settings", _migrate_system_settings)
        _run_migration(conn, inspector, "0006_user_profile_columns", _migrate_user_profile_columns)
        _run_migration(conn, inspector, "0007_relationship_traffic_columns", _migrate_relationship_traffic_columns)
        _run_migration(conn, inspector, "0008_relationship_direction_flags", _migrate_relationship_direction_flags)
        _run_migration(conn, inspector, "0009_device_icon_default", _migrate_device_icon_default)
        _run_migration(conn, inspector, "0010_user_email", _migrate_user_email)
        _run_migration(conn, inspector, "0011_topology_group_network_fields", _migrate_topology_group_network_fields)
        _run_migration(conn, inspector, "0012_sites_table", _migrate_sites_table)
        _run_migration(conn, inspector, "0013_device_site_id", _migrate_device_site_id)
        _run_migration(conn, inspector, "0014_alert_rules", _migrate_alert_rules)
        _run_migration(conn, inspector, "0015_monitor_history", _migrate_monitor_history)
        _run_migration(conn, inspector, "0016_port_targets", _migrate_port_targets)
        _run_migration(conn, inspector, "0017_subnets", _migrate_subnets)
        _run_migration(conn, inspector, "0018_dhcp_leases", _migrate_dhcp_leases)
        _run_migration(conn, inspector, "0019_role_varchar", _migrate_role_varchar)
        _run_migration(conn, inspector, "0020_alert_events", _migrate_alert_events)
        _run_migration(conn, inspector, "0021_device_monitor_status", _migrate_device_monitor_status)
        _run_migration(conn, inspector, "0022_device_is_favourite", _migrate_device_is_favourite)
        _run_migration(conn, inspector, "0023_ip_reservations", _migrate_ip_reservations)
        _run_migration(conn, inspector, "0024_subnet_dhcp_range", _migrate_subnet_dhcp_range)
        _run_migration(conn, inspector, "0025_topology_group_dhcp_range", _migrate_topology_group_dhcp_range)
        _run_migration(conn, inspector, "0026_backend_hot_path_indexes", _migrate_backend_hot_path_indexes)
        _run_migration(conn, inspector, "0027_user_device_favourites", _migrate_user_device_favourites)
        _run_migration(conn, inspector, "0028_topology_layouts", _migrate_topology_layouts)
        _run_migration(conn, inspector, "0029_topology_layout_display_prefs", _migrate_topology_layout_display_prefs)
        _run_migration(conn, inspector, "0030_snmp_profiles", _migrate_snmp_profiles)
        _run_migration(conn, inspector, "0031_service_check_fields", _migrate_service_check_fields)
        _run_migration(conn, inspector, "0032_notification_profiles", _migrate_notification_profiles)
        _run_migration(conn, inspector, "0033_scheduled_discovery", _migrate_scheduled_discovery)
        _run_migration(conn, inspector, "0034_lldp_neighbours", _migrate_lldp_neighbours)
        _run_migration(conn, inspector, "0035_device_os", _migrate_device_os)
        _run_migration(conn, inspector, "0036_alert_rule_threshold_ms", _migrate_alert_rule_threshold_ms)
        _run_migration(conn, inspector, "0037_device_monitoring_fields", _migrate_device_monitoring_fields)
        _run_migration(conn, inspector, "0038_service_check_http_path", _migrate_service_check_http_path)
        _run_migration(conn, inspector, "0039_notification_deliveries", _migrate_notification_deliveries)
        _run_migration(conn, inspector, "0040_ip_reservation_expiry", _migrate_ip_reservation_expiry)
        _run_migration(conn, inspector, "0041_saved_security_searches", _migrate_saved_security_searches)
        _run_migration(conn, inspector, "0042_device_types", _migrate_device_types)
        _run_migration(conn, inspector, "0043_oidc_login_states", _migrate_oidc_login_states)
        _run_migration(conn, inspector, "0044_external_identities", _migrate_external_identities)
        _run_migration(conn, inspector, "0045_api_keys", _migrate_api_keys)
        _run_migration(conn, inspector, "0046_api_key_rate_limit", _migrate_api_key_rate_limit)
        _run_migration(conn, inspector, "0047_user_whats_new_ack", _migrate_user_whats_new_ack)
        _run_migration(conn, inspector, "0048_layout_share_codes", _migrate_layout_share_codes)
        _run_migration(conn, inspector, "0049_relationship_link_speed", _migrate_relationship_link_speed)
        _run_migration(conn, inspector, "0050_alert_rule_ping_loss", _migrate_alert_rule_ping_loss)
        _run_migration(conn, inspector, "0051_ip_reservation_reminder", _migrate_ip_reservation_reminder)
        _run_migration(conn, inspector, "0052_service_check_http_options", _migrate_service_check_http_options)
        _run_migration(conn, inspector, "0053_alert_rule_service_check", _migrate_alert_rule_service_check)
        _run_migration(conn, inspector, "0054_alert_rule_monitor", _migrate_alert_rule_monitor)
        _run_migration(conn, inspector, "0055_monitor_history_uptime_index", _migrate_monitor_history_uptime_index)
        _run_migration(conn, inspector, "0056_monitor_http_options", _migrate_monitor_http_options)
        _run_migration(conn, inspector, "0057_topology_group_color", _migrate_topology_group_color)
        _run_migration(conn, inspector, "0058_user_entity_colors", _migrate_user_entity_colors)
        _run_migration(conn, inspector, "0059_device_expected_status", _migrate_device_expected_status)
        _run_migration(conn, inspector, "0060_api_key_display_suffix", _migrate_api_key_display_suffix)
        _run_migration(conn, inspector, "0061_external_ip_tracking", _migrate_external_ip_tracking)
        _run_migration(conn, inspector, "0062_user_monitor_favourites", _migrate_user_monitor_favourites)
        _run_migration(conn, inspector, "0063_ipam_reservation_claim_permission", _migrate_ipam_reservation_claim_permission)
        _run_migration(conn, inspector, "0064_service_check_order", _migrate_service_check_order)
        _run_migration(conn, inspector, "0065_external_ip_allocation_groups", _migrate_external_ip_allocation_groups)
        _run_migration(conn, inspector, "0066_external_ip_provider_icons", _migrate_external_ip_provider_icons)
        _run_migration(conn, inspector, "0067_external_ip_custom_icons", _migrate_external_ip_custom_icons)
        _run_migration(conn, inspector, "0068_cloud_providers", _migrate_cloud_providers)
        _run_migration(conn, inspector, "0069_cloud_assets", _migrate_cloud_assets)
        _run_migration(conn, inspector, "0070_external_ip_asset_backfill", _migrate_external_ip_asset_backfill)
        _run_migration(conn, inspector, "0071_external_ip_pool_cleanup", _migrate_external_ip_pool_cleanup)
        _run_migration(conn, inspector, "0072_user_schema_repair", _migrate_user_schema_repair)
        _run_migration(conn, inspector, "0073_external_ip_device_link", _migrate_external_ip_device_link)
        _run_migration(conn, inspector, "0074_external_ip_cloud_services", _migrate_external_ip_cloud_services)
        _run_migration(conn, inspector, "0075_external_ip_allocation_icons", _migrate_external_ip_allocation_icons)
        _run_migration(conn, inspector, "0076_core_cloud_providers", _migrate_core_cloud_providers)


def _run_migration(conn, inspector, name: str, fn) -> None:
    if _migration_applied(conn, name):
        return
    fn(conn, inspector)
    _record_migration(conn, name)



def _live_columns(conn, table: str) -> set[str]:
    """Column names read from the live connection.

    `apply_sqlite_schema_updates` builds one inspector *before* running any migration
    and passes it to all of them, so it cannot see a column an earlier migration in the
    same run just added. Any migration that depends on a prior step's DDL must read the
    schema back through the connection instead.
    """
    return {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})")).fetchall()}


def _live_tables(conn) -> set[str]:
    return {row[0] for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type = 'table'")).fetchall()}


def _migrate_devices_columns(conn, inspector) -> None:
    existing = {col["name"] for col in inspector.get_columns("devices")}
    column_sql = {
        "display_name": "ALTER TABLE devices ADD COLUMN display_name VARCHAR(255)",
        "vendor": "ALTER TABLE devices ADD COLUMN vendor VARCHAR(120)",
        "device_type": "ALTER TABLE devices ADD COLUMN device_type VARCHAR(80)",
        "status": "ALTER TABLE devices ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'unknown'",
        "icon": "ALTER TABLE devices ADD COLUMN icon VARCHAR(40) NOT NULL DEFAULT 'device'",
        "color": "ALTER TABLE devices ADD COLUMN color VARCHAR(16)",
        "vlan_id": "ALTER TABLE devices ADD COLUMN vlan_id VARCHAR(32)",
        "subnet": "ALTER TABLE devices ADD COLUMN subnet VARCHAR(64)",
        "topology_group_id": "ALTER TABLE devices ADD COLUMN topology_group_id INTEGER",
        "topology_group": "ALTER TABLE devices ADD COLUMN topology_group VARCHAR(120)",
        "tags": "ALTER TABLE devices ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
        "notes": "ALTER TABLE devices ADD COLUMN notes TEXT",
        "updated_at": "ALTER TABLE devices ADD COLUMN updated_at DATETIME",
    }
    for col, sql in column_sql.items():
        if col not in existing:
            conn.execute(text(sql))
    if "updated_at" not in existing:
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(text("UPDATE devices SET updated_at = :now"), {"now": now})



def _migrate_topology_group_columns(conn, inspector) -> None:
    if "topology_groups" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("topology_groups")}
    column_sql = {
        "display_name": "ALTER TABLE topology_groups ADD COLUMN display_name VARCHAR(120)",
        "ip_range": "ALTER TABLE topology_groups ADD COLUMN ip_range VARCHAR(64)",
        "description": "ALTER TABLE topology_groups ADD COLUMN description TEXT",
        "updated_at": "ALTER TABLE topology_groups ADD COLUMN updated_at DATETIME",
    }
    for col, sql in column_sql.items():
        if col not in existing:
            conn.execute(text(sql))
    if "updated_at" not in existing:
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(text("UPDATE topology_groups SET updated_at = :now WHERE updated_at IS NULL"), {"now": now})


def _migrate_topology_group_backfill(conn, inspector) -> None:
    if "topology_groups" not in inspector.get_table_names():
        return
    device_cols = {col["name"] for col in inspector.get_columns("devices")}
    if "topology_group_id" not in device_cols:
        return
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        text(
            """
            INSERT INTO topology_groups (name, created_at, updated_at)
            SELECT DISTINCT d.topology_group, :now, :now
            FROM devices d
            WHERE d.topology_group IS NOT NULL
              AND TRIM(d.topology_group) <> ''
              AND NOT EXISTS (
                SELECT 1 FROM topology_groups g WHERE g.name = d.topology_group
              )
            """
        ),
        {"now": now},
    )
    conn.execute(
        text(
            """
            UPDATE devices
            SET topology_group_id = (
              SELECT g.id FROM topology_groups g WHERE g.name = devices.topology_group
            )
            WHERE topology_group_id IS NULL
              AND topology_group IS NOT NULL
              AND TRIM(topology_group) <> ''
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_subnets_id ON subnets (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_subnets_site_id ON subnets (site_id)"))


def _migrate_user_profile_columns(conn, inspector) -> None:
    if "users" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("users")}
    column_sql = {
        "display_name": "ALTER TABLE users ADD COLUMN display_name VARCHAR(100)",
        "avatar_data": "ALTER TABLE users ADD COLUMN avatar_data TEXT",
    }
    for col, sql in column_sql.items():
        if col not in existing:
            conn.execute(text(sql))


def _migrate_system_settings(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR(120) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        )
    )


def _migrate_relationship_traffic_columns(conn, inspector) -> None:
    if "device_relationships" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("device_relationships")}
    column_sql = {
        "traffic_outbound": "ALTER TABLE device_relationships ADD COLUMN traffic_outbound VARCHAR(240)",
        "traffic_inbound": "ALTER TABLE device_relationships ADD COLUMN traffic_inbound VARCHAR(240)",
    }
    for col, sql in column_sql.items():
        if col not in existing:
            conn.execute(text(sql))


def _migrate_relationship_direction_flags(conn, inspector) -> None:
    if "device_relationships" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("device_relationships")}
    column_sql = {
        "allow_outbound": "ALTER TABLE device_relationships ADD COLUMN allow_outbound BOOLEAN NOT NULL DEFAULT 1",
        "allow_inbound": "ALTER TABLE device_relationships ADD COLUMN allow_inbound BOOLEAN NOT NULL DEFAULT 1",
    }
    for col, sql in column_sql.items():
        if col not in existing:
            conn.execute(text(sql))


def _migrate_device_icon_default(conn, inspector) -> None:
    if "devices" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("devices")}
    if "icon" not in existing:
        return
    conn.execute(text("UPDATE devices SET icon = 'device' WHERE icon IS NULL OR TRIM(icon) = '' OR icon = 'unknown'"))


def _migrate_user_email(conn, inspector) -> None:
    if "users" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("users")}
    if "email" not in existing:
        conn.execute(text("ALTER TABLE users ADD COLUMN email VARCHAR(254)"))


def _migrate_topology_group_network_fields(conn, inspector) -> None:
    if "topology_groups" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("topology_groups")}
    column_sql = {
        "vlan_id": "ALTER TABLE topology_groups ADD COLUMN vlan_id VARCHAR(16)",
        "gateway": "ALTER TABLE topology_groups ADD COLUMN gateway VARCHAR(64)",
        "dns_servers": "ALTER TABLE topology_groups ADD COLUMN dns_servers VARCHAR(255)",
    }
    for col, sql in column_sql.items():
        if col not in existing:
            conn.execute(text(sql))


def _migrate_sites_table(conn, inspector) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS sites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(120) NOT NULL UNIQUE,
                display_name VARCHAR(120),
                description TEXT,
                address VARCHAR(255),
                color VARCHAR(16),
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_sites_id ON sites (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_sites_name ON sites (name)"))
    _ = now


def _migrate_device_site_id(conn, inspector) -> None:
    if "devices" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("devices")}
    if "site_id" not in existing:
        conn.execute(text("ALTER TABLE devices ADD COLUMN site_id INTEGER REFERENCES sites(id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_devices_site_id ON devices (site_id)"))


def _migrate_alert_rules(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS alert_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(120) NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                event_type VARCHAR(40) NOT NULL,
                device_id INTEGER,
                channels TEXT NOT NULL DEFAULT '[]',
                cooldown_minutes INTEGER NOT NULL DEFAULT 30,
                last_triggered_at DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_alert_rules_id ON alert_rules (id)"))


def _migrate_notification_profiles(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS notification_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(120) NOT NULL,
                provider VARCHAR(40) NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                config_json TEXT NOT NULL DEFAULT '{}',
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_profiles_id ON notification_profiles (id)"))


def _migrate_scheduled_discovery(conn, inspector) -> None:
    tables = set(inspector.get_table_names())
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS discovery_schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id INTEGER NOT NULL REFERENCES users(id),
                name VARCHAR(120) NOT NULL,
                target VARCHAR(255) NOT NULL,
                scan_type VARCHAR(40) NOT NULL DEFAULT 'ping',
                enabled BOOLEAN NOT NULL DEFAULT 1,
                interval_minutes INTEGER NOT NULL DEFAULT 1440,
                confirm_large_scan BOOLEAN NOT NULL DEFAULT 0,
                topology_group_id INTEGER REFERENCES topology_groups(id) ON DELETE SET NULL,
                site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
                snmp_profile_id INTEGER REFERENCES snmp_profiles(id) ON DELETE SET NULL,
                snmp_targets_json TEXT NOT NULL DEFAULT '[]',
                notification_targets_json TEXT NOT NULL DEFAULT '[]',
                last_run_at DATETIME,
                next_run_at DATETIME,
                last_scan_id INTEGER REFERENCES discovery_scans(id) ON DELETE SET NULL,
                last_status VARCHAR(40),
                last_error TEXT,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_schedules_id ON discovery_schedules (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_schedules_owner_user_id ON discovery_schedules (owner_user_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_schedules_next_run_at ON discovery_schedules (next_run_at)"))
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS discovery_observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                schedule_id INTEGER NOT NULL REFERENCES discovery_schedules(id) ON DELETE CASCADE,
                scan_id INTEGER REFERENCES discovery_scans(id) ON DELETE SET NULL,
                device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                observation_type VARCHAR(40) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'open',
                ip_address VARCHAR(64),
                mac_address VARCHAR(64),
                hostname VARCHAR(255),
                summary VARCHAR(255) NOT NULL,
                details_json TEXT NOT NULL DEFAULT '{}',
                first_seen_at DATETIME NOT NULL,
                last_seen_at DATETIME NOT NULL,
                resolved_at DATETIME
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_observations_id ON discovery_observations (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_observations_schedule_id ON discovery_observations (schedule_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_observations_scan_id ON discovery_observations (scan_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_observations_device_id ON discovery_observations (device_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_observations_status ON discovery_observations (status)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_observations_type ON discovery_observations (observation_type)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_observations_last_seen_at ON discovery_observations (last_seen_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_observations_ip ON discovery_observations (ip_address)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_observations_mac ON discovery_observations (mac_address)"))
    if "discovery_scans" in tables:
        existing = {col["name"] for col in inspector.get_columns("discovery_scans")}
        if "schedule_id" not in existing:
            conn.execute(text("ALTER TABLE discovery_scans ADD COLUMN schedule_id INTEGER REFERENCES discovery_schedules(id) ON DELETE SET NULL"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discovery_scans_schedule_id ON discovery_scans (schedule_id)"))


def _migrate_monitor_history(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS device_monitor_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                checked_at DATETIME NOT NULL,
                status VARCHAR(20) NOT NULL,
                rtt_ms REAL,
                port_results TEXT NOT NULL DEFAULT '[]'
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_monitor_history_id ON device_monitor_history (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_monitor_history_device_id ON device_monitor_history (device_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_monitor_history_checked_at ON device_monitor_history (checked_at)"))


def _migrate_port_targets(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS device_port_targets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
                port INTEGER NOT NULL,
                label VARCHAR(60) NOT NULL,
                check_type VARCHAR(20) NOT NULL DEFAULT 'tcp',
                enabled BOOLEAN NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_port_targets_id ON device_port_targets (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_port_targets_device_id ON device_port_targets (device_id)"))
    # Seed common ports so the feature works out of the box
    conn.execute(
        text(
            """
            INSERT OR IGNORE INTO device_port_targets (device_id, port, label, created_at)
            SELECT NULL, 22, 'SSH', datetime('now') WHERE NOT EXISTS (SELECT 1 FROM device_port_targets WHERE port = 22 AND device_id IS NULL)
            """
        )
    )
    conn.execute(
        text(
            """
            INSERT OR IGNORE INTO device_port_targets (device_id, port, label, created_at)
            SELECT NULL, 80, 'HTTP', datetime('now') WHERE NOT EXISTS (SELECT 1 FROM device_port_targets WHERE port = 80 AND device_id IS NULL)
            """
        )
    )
    conn.execute(
        text(
            """
            INSERT OR IGNORE INTO device_port_targets (device_id, port, label, created_at)
            SELECT NULL, 443, 'HTTPS', datetime('now') WHERE NOT EXISTS (SELECT 1 FROM device_port_targets WHERE port = 443 AND device_id IS NULL)
            """
        )
    )


def _migrate_subnets(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS subnets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(120) NOT NULL,
                cidr VARCHAR(50) NOT NULL UNIQUE,
                description TEXT,
                vlan_id VARCHAR(32),
                site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
                gateway VARCHAR(64),
                dns_servers VARCHAR(255),
                notes TEXT,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        )
    )


def _migrate_service_check_fields(conn, inspector) -> None:
    if "device_port_targets" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("device_port_targets")}
    if "check_type" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN check_type VARCHAR(20) NOT NULL DEFAULT 'tcp'"))
    if "enabled" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 1"))


def _migrate_role_varchar(conn, inspector) -> None:
    # Remove the CHECK constraint on users.role so custom role names are accepted.
    # SQLite requires a full table recreation to drop constraints.
    table_sql = conn.execute(text(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'"
    )).scalar_one_or_none()
    if not table_sql:
        return

    # Fresh databases already use an unconstrained VARCHAR role. Rebuilding them
    # from the old fixed column list dropped every user column added after 0019.
    role_has_check = re.search(r"CHECK\s*\([^)]*\brole\b", table_sql, re.IGNORECASE | re.DOTALL)
    if role_has_check:
        # Preserve every live column, including ones introduced after this old
        # migration. PRAGMA exposes the column definitions without table-level
        # CHECK constraints, which is exactly what this rebuild needs.
        columns = conn.execute(text("PRAGMA table_info(users)")).fetchall()

        def quoted(identifier: str) -> str:
            return '"' + identifier.replace('"', '""') + '"'

        definitions: list[str] = []
        names: list[str] = []
        for _cid, name, declared_type, not_null, default, primary_key in columns:
            names.append(quoted(name))
            parts = [quoted(name), "VARCHAR(50)" if name == "role" else (declared_type or "BLOB")]
            if primary_key:
                parts.append("PRIMARY KEY")
            elif not_null:
                parts.append("NOT NULL")
            if default is not None:
                parts.append(f"DEFAULT {default}")
            definitions.append(" ".join(parts))

        column_list = ", ".join(names)
        conn.execute(text("DROP TABLE IF EXISTS users_new"))
        conn.execute(text(f"CREATE TABLE users_new ({', '.join(definitions)})"))
        conn.execute(text(f"INSERT INTO users_new ({column_list}) SELECT {column_list} FROM users"))
        conn.execute(text("DROP TABLE users"))
        conn.execute(text("ALTER TABLE users_new RENAME TO users"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_id ON users (id)"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)"))

    # SQLAlchemy Enum stored member names (e.g. SUPER_ADMIN) instead of values (SuperAdmin).
    # Normalise to values so plain string comparisons work correctly.
    for name, value in [("SUPER_ADMIN", "SuperAdmin"), ("NETWORK_ADMIN", "NetworkAdmin"),
                        ("SECURITY_ANALYST", "SecurityAnalyst"), ("VIEWER", "Viewer")]:
        conn.execute(text(f"UPDATE users SET role = '{value}' WHERE role = '{name}'"))


def _migrate_dhcp_leases(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS dhcp_leases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip_address VARCHAR(64) NOT NULL,
                mac_address VARCHAR(64),
                hostname VARCHAR(255),
                expires_at DATETIME,
                is_active BOOLEAN NOT NULL DEFAULT 1,
                source VARCHAR(40) NOT NULL DEFAULT 'import',
                imported_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_dhcp_leases_id ON dhcp_leases (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_dhcp_leases_ip ON dhcp_leases (ip_address)"))


def _migrate_alert_events(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS alert_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alert_rule_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
                alert_rule_name VARCHAR(120) NOT NULL DEFAULT '',
                device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                event_type VARCHAR(60) NOT NULL,
                fired_at DATETIME NOT NULL,
                message TEXT NOT NULL DEFAULT ''
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_alert_events_id ON alert_events (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_alert_events_device ON alert_events (device_id)"))


def _migrate_device_monitor_status(conn, inspector) -> None:
    if "devices" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("devices")}
    if "monitor_status" not in existing:
        conn.execute(text("ALTER TABLE devices ADD COLUMN monitor_status VARCHAR(20)"))
    if "last_monitored_at" not in existing:
        conn.execute(text("ALTER TABLE devices ADD COLUMN last_monitored_at DATETIME"))


def _migrate_device_is_favourite(conn, inspector) -> None:
    if "devices" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("devices")}
    if "is_favourite" not in existing:
        conn.execute(text("ALTER TABLE devices ADD COLUMN is_favourite BOOLEAN DEFAULT 0"))


def _migrate_ip_reservations(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS ip_reservations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip_address VARCHAR(64) NOT NULL UNIQUE,
                subnet_id INTEGER REFERENCES subnets(id) ON DELETE CASCADE,
                label VARCHAR(120) NOT NULL,
                mac_address VARCHAR(64),
                notes TEXT,
                reserved_by VARCHAR(80),
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_ip_reservations_id ON ip_reservations (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_ip_reservations_ip ON ip_reservations (ip_address)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_ip_reservations_subnet ON ip_reservations (subnet_id)"))


def _migrate_subnet_dhcp_range(conn, inspector) -> None:
    if "subnets" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("subnets")}
    if "dhcp_start" not in existing:
        conn.execute(text("ALTER TABLE subnets ADD COLUMN dhcp_start VARCHAR(64)"))
    if "dhcp_end" not in existing:
        conn.execute(text("ALTER TABLE subnets ADD COLUMN dhcp_end VARCHAR(64)"))


def _migrate_topology_group_dhcp_range(conn, inspector) -> None:
    if "topology_groups" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("topology_groups")}
    if "dhcp_start" not in existing:
        conn.execute(text("ALTER TABLE topology_groups ADD COLUMN dhcp_start VARCHAR(64)"))
    if "dhcp_end" not in existing:
        conn.execute(text("ALTER TABLE topology_groups ADD COLUMN dhcp_end VARCHAR(64)"))


def _migrate_backend_hot_path_indexes(conn, inspector) -> None:
    tables = set(inspector.get_table_names())
    if "device_monitor_history" in tables:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_monitor_history_device_checked_at "
            "ON device_monitor_history (device_id, checked_at)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_monitor_history_checked_at_rtt "
            "ON device_monitor_history (checked_at, rtt_ms)"
        ))
    if "alert_events" in tables:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_alert_events_device_fired_at "
            "ON alert_events (device_id, fired_at)"
        ))
    if "devices" in tables:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_devices_status_monitor_status "
            "ON devices (status, monitor_status)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_devices_site_group_favourite_ip "
            "ON devices (site_id, topology_group_id, is_favourite, ip_address)"
        ))
    if "dhcp_leases" in tables:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_dhcp_leases_active_ip "
            "ON dhcp_leases (is_active, ip_address)"
        ))
    if "ip_reservations" in tables:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_ip_reservations_subnet_ip "
            "ON ip_reservations (subnet_id, ip_address)"
        ))


def _migrate_monitor_history_uptime_index(conn, inspector) -> None:
    """Make the monitoring uptime aggregates index-only.

    ``ix_monitor_history_device_checked_at`` narrows to the right rows but does
    not carry ``status``/``rtt_ms``, so the 24 h and 7 d uptime rollups do a
    table lookup per matching row. Over a week of history for a whole fleet
    that is hundreds of thousands of scattered page reads on every uncached
    /monitoring/devices call. Widening the index makes both aggregates a
    covering scan.
    """
    if "device_monitor_history" not in set(inspector.get_table_names()):
        return
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_monitor_history_device_checked_status "
        "ON device_monitor_history (device_id, checked_at, status, rtt_ms)"
    ))


def _migrate_monitor_http_options(conn, inspector) -> None:
    """Add the Uptime Kuma-style HTTP options without changing old monitors."""
    tables = set(inspector.get_table_names())
    if "monitors" not in tables:
        return
    existing = {col["name"] for col in inspector.get_columns("monitors")}
    columns = {
        "description": "TEXT",
        "tags_json": "TEXT NOT NULL DEFAULT '[]'",
        "max_redirects": "INTEGER NOT NULL DEFAULT 10",
        "accepted_status_codes": "VARCHAR(255) NOT NULL DEFAULT '200-399'",
        "request_headers_encrypted": "TEXT",
        "request_body_encrypted": "TEXT",
        "body_encoding": "VARCHAR(20) NOT NULL DEFAULT 'json'",
        "auth_type": "VARCHAR(20) NOT NULL DEFAULT 'none'",
        "auth_username": "VARCHAR(255)",
        "auth_password_encrypted": "TEXT",
        "bearer_token_encrypted": "TEXT",
        "oauth_token_url": "VARCHAR(2048)",
        "oauth_client_id": "VARCHAR(255)",
        "oauth_client_secret_encrypted": "TEXT",
        "oauth_scopes": "VARCHAR(1000)",
        "oauth_audience": "VARCHAR(1000)",
        "oauth_auth_method": "VARCHAR(30) NOT NULL DEFAULT 'client_secret_basic'",
        "proxy_url_encrypted": "TEXT",
        "tls_ca_encrypted": "TEXT",
        "tls_cert_encrypted": "TEXT",
        "tls_key_encrypted": "TEXT",
        "keyword": "VARCHAR(1000)",
        "keyword_inverted": "BOOLEAN NOT NULL DEFAULT 0",
        "json_path": "VARCHAR(1000)",
        "json_operator": "VARCHAR(20) NOT NULL DEFAULT 'equals'",
        "expected_value": "VARCHAR(2000)",
        "cache_bust": "BOOLEAN NOT NULL DEFAULT 0",
        "upside_down": "BOOLEAN NOT NULL DEFAULT 0",
        "retry_interval_seconds": "INTEGER NOT NULL DEFAULT 20",
        "certificate_expiry_alert": "BOOLEAN NOT NULL DEFAULT 0",
        "certificate_expiry_days": "INTEGER NOT NULL DEFAULT 14",
        "last_cert_expires_at": "DATETIME",
        "last_cert_issuer": "VARCHAR(255)",
    }
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(text(f"ALTER TABLE monitors ADD COLUMN {name} {definition}"))
    # Preserve custom ranges configured before flexible status-code support.
    conn.execute(text(
        "UPDATE monitors SET accepted_status_codes = "
        "CAST(expected_status_min AS TEXT) || '-' || CAST(expected_status_max AS TEXT)"
    ))

    if "monitor_check_history" in tables:
        history_existing = {col["name"] for col in inspector.get_columns("monitor_check_history")}
        history_columns = {
            "assertion_detail": "VARCHAR(255)",
            "response_size_bytes": "INTEGER",
            "cert_expires_at": "DATETIME",
        }
        for name, definition in history_columns.items():
            if name not in history_existing:
                conn.execute(text(f"ALTER TABLE monitor_check_history ADD COLUMN {name} {definition}"))


def _migrate_user_device_favourites(conn, inspector) -> None:
    tables = set(inspector.get_table_names())
    if "user_device_favourites" not in tables:
        conn.execute(text(
            """
            CREATE TABLE user_device_favourites (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, device_id)
            )
            """
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_user_device_favourites_user_id "
            "ON user_device_favourites (user_id)"
        ))


def _migrate_user_monitor_favourites(conn, inspector) -> None:
    tables = set(inspector.get_table_names())
    if "user_monitor_favourites" not in tables:
        conn.execute(text(
            """
            CREATE TABLE user_monitor_favourites (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, monitor_id)
            )
            """
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_user_monitor_favourites_user_id "
            "ON user_monitor_favourites (user_id)"
        ))


def _migrate_topology_layout_display_prefs(conn, inspector) -> None:
    if "topology_layouts" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("topology_layouts")}
    if "display_prefs_json" not in existing:
        conn.execute(text("ALTER TABLE topology_layouts ADD COLUMN display_prefs_json TEXT"))


def _migrate_topology_layouts(conn, inspector) -> None:
    tables = set(inspector.get_table_names())
    if "topology_layouts" not in tables:
        conn.execute(text(
            """
            CREATE TABLE topology_layouts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id INTEGER NOT NULL REFERENCES users(id),
                name VARCHAR(80) NOT NULL,
                positions_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                UNIQUE (owner_user_id, name)
            )
            """
        ))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_topology_layouts_id ON topology_layouts (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_topology_layouts_owner_user_id ON topology_layouts (owner_user_id)"))


def _migrate_snmp_profiles(conn, inspector) -> None:
    tables = set(inspector.get_table_names())
    if "snmp_profiles" not in tables:
        conn.execute(text(
            """
            CREATE TABLE snmp_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(120) NOT NULL UNIQUE,
                version VARCHAR(16) NOT NULL DEFAULT 'v2c',
                community_encrypted TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 161,
                timeout_seconds INTEGER NOT NULL DEFAULT 3,
                retries INTEGER NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        ))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_snmp_profiles_id ON snmp_profiles (id)"))
    existing = {col["name"] for col in inspector.get_columns("devices")}
    if "snmp_profile_id" not in existing:
        conn.execute(text("ALTER TABLE devices ADD COLUMN snmp_profile_id INTEGER REFERENCES snmp_profiles(id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_devices_snmp_profile_id ON devices (snmp_profile_id)"))


def _migrate_lldp_neighbours(conn, inspector) -> None:
    tables = set(inspector.get_table_names())
    if "lldp_neighbours" not in tables:
        conn.execute(text(
            """
            CREATE TABLE lldp_neighbours (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                local_port_index INTEGER NOT NULL,
                local_port_id VARCHAR(255),
                local_port_desc VARCHAR(255),
                remote_chassis_id VARCHAR(64) NOT NULL,
                remote_port_id VARCHAR(255),
                remote_port_desc VARCHAR(255),
                remote_sys_name VARCHAR(255),
                remote_mgmt_addr VARCHAR(64),
                matched_device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                dismissed BOOLEAN NOT NULL DEFAULT 0,
                last_seen DATETIME NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_lldp_neighbour UNIQUE (source_device_id, local_port_index, remote_chassis_id)
            )
            """
        ))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_lldp_neighbours_id ON lldp_neighbours (id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_lldp_neighbours_source_device_id ON lldp_neighbours (source_device_id)"))


def _migrate_device_os(conn, inspector) -> None:
    existing = {col["name"] for col in inspector.get_columns("devices")}
    if "os" not in existing:
        conn.execute(text("ALTER TABLE devices ADD COLUMN os VARCHAR(255)"))


def _migrate_alert_rule_threshold_ms(conn, inspector) -> None:
    if "alert_rules" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("alert_rules")}
    if "threshold_ms" not in existing:
        conn.execute(text("ALTER TABLE alert_rules ADD COLUMN threshold_ms INTEGER"))


def _migrate_alert_rule_ping_loss(conn, inspector) -> None:
    if "alert_rules" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("alert_rules")}
    if "loss_pct_threshold" not in existing:
        conn.execute(text("ALTER TABLE alert_rules ADD COLUMN loss_pct_threshold REAL"))
    if "loss_window_minutes" not in existing:
        conn.execute(text("ALTER TABLE alert_rules ADD COLUMN loss_window_minutes INTEGER"))


def _migrate_device_monitoring_fields(conn, inspector) -> None:
    existing = {col["name"] for col in inspector.get_columns("devices")}
    if "monitoring_paused" not in existing:
        conn.execute(text("ALTER TABLE devices ADD COLUMN monitoring_paused BOOLEAN NOT NULL DEFAULT 0"))
    if "lifecycle" not in existing:
        conn.execute(text("ALTER TABLE devices ADD COLUMN lifecycle VARCHAR(20) NOT NULL DEFAULT 'active'"))


def _migrate_device_expected_status(conn, inspector) -> None:
    """Store expected reachability and snapshot compliance with every poll."""
    device_columns = {col["name"] for col in inspector.get_columns("devices")}
    if "expected_status" not in device_columns:
        conn.execute(text(
            "ALTER TABLE devices ADD COLUMN expected_status VARCHAR(20) NOT NULL DEFAULT 'online'"
        ))

    if "device_monitor_history" not in set(inspector.get_table_names()):
        return
    history_columns = {col["name"] for col in inspector.get_columns("device_monitor_history")}
    if "expected_status" not in history_columns:
        conn.execute(text(
            "ALTER TABLE device_monitor_history ADD COLUMN expected_status VARCHAR(20) NOT NULL DEFAULT 'online'"
        ))
    if "is_healthy" not in history_columns:
        conn.execute(text("ALTER TABLE device_monitor_history ADD COLUMN is_healthy BOOLEAN"))
        conn.execute(text(
            "UPDATE device_monitor_history "
            "SET is_healthy = CASE "
            "WHEN status = 'online' THEN 1 "
            "WHEN status = 'offline' THEN 0 "
            "ELSE NULL END"
        ))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_monitor_history_device_checked_health "
        "ON device_monitor_history (device_id, checked_at, is_healthy, status, rtt_ms)"
    ))


def _migrate_service_check_http_path(conn, inspector) -> None:
    if "device_port_targets" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("device_port_targets")}
    if "http_path" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN http_path VARCHAR(200)"))


def _migrate_notification_deliveries(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS notification_deliveries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_name VARCHAR(120) NOT NULL DEFAULT '',
                device_id INTEGER,
                target VARCHAR(120) NOT NULL,
                status VARCHAR(12) NOT NULL,
                detail VARCHAR(255) NOT NULL DEFAULT '',
                sent_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_deliveries_id ON notification_deliveries (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notification_deliveries_sent_at ON notification_deliveries (sent_at)"))


def _migrate_ip_reservation_expiry(conn, inspector) -> None:
    if "ip_reservations" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("ip_reservations")}
    if "expires_at" not in existing:
        conn.execute(text("ALTER TABLE ip_reservations ADD COLUMN expires_at DATETIME"))


def _migrate_ip_reservation_reminder(conn, inspector) -> None:
    if "ip_reservations" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("ip_reservations")}
    if "reminder_sent_at" not in existing:
        conn.execute(text("ALTER TABLE ip_reservations ADD COLUMN reminder_sent_at DATETIME"))


def _migrate_saved_security_searches(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS saved_security_searches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(80) NOT NULL,
                filters_json TEXT NOT NULL DEFAULT '{}',
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_saved_search_owner_name UNIQUE (owner_user_id, name)
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_saved_security_searches_id ON saved_security_searches (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_saved_security_searches_owner ON saved_security_searches (owner_user_id)"))


def _migrate_device_types(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS device_types (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                value VARCHAR(80) NOT NULL UNIQUE,
                label VARCHAR(80) NOT NULL,
                icon VARCHAR(80) NOT NULL DEFAULT 'device',
                is_builtin BOOLEAN NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_device_types_id ON device_types (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_device_types_value ON device_types (value)"))


def _migrate_oidc_login_states(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS oidc_login_states (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                state VARCHAR(128) NOT NULL UNIQUE,
                nonce VARCHAR(128) NOT NULL,
                code_verifier VARCHAR(128) NOT NULL,
                redirect_uri VARCHAR(512) NOT NULL,
                created_at DATETIME NOT NULL,
                expires_at DATETIME NOT NULL,
                used_at DATETIME
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_oidc_login_states_id ON oidc_login_states (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_oidc_login_states_state ON oidc_login_states (state)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_oidc_login_states_expires_at ON oidc_login_states (expires_at)"))


def _migrate_external_identities(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS external_identities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_key VARCHAR(40) NOT NULL DEFAULT 'oidc',
                issuer VARCHAR(255) NOT NULL,
                subject VARCHAR(255) NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users (id),
                email VARCHAR(254),
                email_verified BOOLEAN NOT NULL DEFAULT 0,
                display_name VARCHAR(100),
                created_at DATETIME NOT NULL,
                last_login_at DATETIME,
                CONSTRAINT uq_external_identity_issuer_subject UNIQUE (issuer, subject)
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_identities_id ON external_identities (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_identities_issuer ON external_identities (issuer)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_identities_subject ON external_identities (subject)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_identities_user_id ON external_identities (user_id)"))


def _migrate_api_keys(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users (id),
                name VARCHAR(100) NOT NULL,
                prefix VARCHAR(16) NOT NULL UNIQUE,
                suffix VARCHAR(4),
                key_hash VARCHAR(64) NOT NULL,
                created_at DATETIME NOT NULL,
                expires_at DATETIME,
                last_used_at DATETIME,
                last_used_ip VARCHAR(64),
                revoked_at DATETIME,
                revoked_reason VARCHAR(120),
                created_ip VARCHAR(64)
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_api_keys_id ON api_keys (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_api_keys_user_id ON api_keys (user_id)"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_api_keys_prefix ON api_keys (prefix)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_api_keys_expires_at ON api_keys (expires_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_api_keys_revoked_at ON api_keys (revoked_at)"))


def _migrate_api_key_rate_limit(conn, inspector) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS api_key_throttle_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                subject VARCHAR(255) NOT NULL UNIQUE,
                window_started_at DATETIME,
                request_count INTEGER NOT NULL DEFAULT 0,
                failed_attempts INTEGER NOT NULL DEFAULT 0,
                locked_until DATETIME,
                updated_at DATETIME NOT NULL
            )
            """
        )
    )
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_api_key_throttle_state_id ON api_key_throttle_state (id)"))
    conn.execute(
        text("CREATE UNIQUE INDEX IF NOT EXISTS ix_api_key_throttle_state_subject ON api_key_throttle_state (subject)")
    )
    conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_api_key_throttle_state_locked_until ON api_key_throttle_state (locked_until)")
    )


def _migrate_api_key_display_suffix(conn, inspector) -> None:
    if "api_keys" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("api_keys")}
    if "suffix" not in existing:
        conn.execute(text("ALTER TABLE api_keys ADD COLUMN suffix VARCHAR(4)"))


def _migrate_external_ip_tracking(conn, _inspector) -> None:
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS external_ip_pools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name VARCHAR(120) NOT NULL,
            cidr VARCHAR(128) NOT NULL UNIQUE,
            provider VARCHAR(80),
            account VARCHAR(120),
            description TEXT,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_pools_id ON external_ip_pools (id)"))
    if "cidr" in _live_columns(conn, "external_ip_pools"):
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_external_ip_pools_cidr ON external_ip_pools (cidr)"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS external_ip_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id INTEGER NOT NULL REFERENCES external_ip_pools (id) ON DELETE CASCADE,
            ip_address VARCHAR(64) NOT NULL UNIQUE,
            label VARCHAR(120) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'in_use',
            provider VARCHAR(80),
            account VARCHAR(120),
            owner VARCHAR(120),
            service VARCHAR(120),
            tags VARCHAR(500),
            notes TEXT,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_assignments_id ON external_ip_assignments (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_assignments_pool_id ON external_ip_assignments (pool_id)"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_external_ip_assignments_ip ON external_ip_assignments (ip_address)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_assignments_status ON external_ip_assignments (status)"))


def _migrate_user_whats_new_ack(conn, inspector) -> None:
    if "users" not in _live_tables(conn):
        return
    existing = _live_columns(conn, "users")
    if "whats_new_acknowledged_version" not in existing:
        conn.execute(text("ALTER TABLE users ADD COLUMN whats_new_acknowledged_version VARCHAR(40)"))


def _migrate_layout_share_codes(conn, inspector) -> None:
    existing = {col["name"] for col in inspector.get_columns("topology_layouts")}
    if "share_code" not in existing:
        conn.execute(text("ALTER TABLE topology_layouts ADD COLUMN share_code VARCHAR(24)"))
    conn.execute(
        text("CREATE UNIQUE INDEX IF NOT EXISTS ix_topology_layouts_share_code ON topology_layouts (share_code)")
    )


def _migrate_relationship_link_speed(conn, inspector) -> None:
    existing = {col["name"] for col in inspector.get_columns("device_relationships")}
    if "link_speed_mbps" not in existing:
        conn.execute(text("ALTER TABLE device_relationships ADD COLUMN link_speed_mbps INTEGER"))


def _migrate_service_check_http_options(conn, inspector) -> None:
    if "device_port_targets" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("device_port_targets")}
    if "http_method" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN http_method VARCHAR(10) NOT NULL DEFAULT 'GET'"))
    if "expected_status_min" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN expected_status_min INTEGER NOT NULL DEFAULT 200"))
    if "expected_status_max" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN expected_status_max INTEGER NOT NULL DEFAULT 399"))
    if "timeout_seconds" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN timeout_seconds REAL"))
    if "verify_tls" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN verify_tls BOOLEAN NOT NULL DEFAULT 0"))
    if "follow_redirects" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN follow_redirects BOOLEAN NOT NULL DEFAULT 1"))


def _migrate_alert_rule_service_check(conn, inspector) -> None:
    if "alert_rules" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("alert_rules")}
    if "port_target_id" not in existing:
        conn.execute(text("ALTER TABLE alert_rules ADD COLUMN port_target_id INTEGER"))


def _migrate_alert_rule_monitor(conn, inspector) -> None:
    if "alert_rules" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("alert_rules")}
    if "monitor_id" not in existing:
        conn.execute(text("ALTER TABLE alert_rules ADD COLUMN monitor_id INTEGER"))


def _migrate_topology_group_color(conn, inspector) -> None:
    if "topology_groups" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("topology_groups")}
    if "color" not in existing:
        conn.execute(text("ALTER TABLE topology_groups ADD COLUMN color VARCHAR(16)"))


def _migrate_user_entity_colors(conn, inspector) -> None:
    if "users" not in _live_tables(conn):
        return
    existing = _live_columns(conn, "users")
    if "entity_colors_enabled" not in existing:
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN entity_colors_enabled BOOLEAN NOT NULL DEFAULT 1"
        ))


def _migrate_user_schema_repair(conn, inspector) -> None:
    """Repair clean installs affected by the old destructive 0019 rebuild.

    Some databases have 0047 and 0058 in ``schema_migrations`` even though the
    stale inspector caused those migrations to skip their columns. This new
    migration deliberately checks the live schema instead of trusting that ledger.
    """
    if "users" not in _live_tables(conn):
        return
    existing = _live_columns(conn, "users")
    if "whats_new_acknowledged_version" not in existing:
        conn.execute(text("ALTER TABLE users ADD COLUMN whats_new_acknowledged_version VARCHAR(40)"))
    if "entity_colors_enabled" not in existing:
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN entity_colors_enabled BOOLEAN NOT NULL DEFAULT 1"
        ))


def _migrate_ipam_reservation_claim_permission(conn, inspector) -> None:
    if "system_settings" not in inspector.get_table_names():
        return
    raw = conn.execute(text(
        "SELECT value FROM system_settings WHERE key = 'role_permissions'"
    )).scalar_one_or_none()
    if not raw:
        return
    try:
        roles = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return
    network_admin = roles.get("NetworkAdmin")
    if not isinstance(network_admin, list) or "ipam_reservation_claim" in network_admin:
        return
    network_admin.append("ipam_reservation_claim")
    conn.execute(
        text("UPDATE system_settings SET value = :value, updated_at = :now WHERE key = 'role_permissions'"),
        {"value": json.dumps(roles), "now": datetime.now(timezone.utc).isoformat()},
    )


def _migrate_service_check_order(conn, inspector) -> None:
    if "device_port_targets" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("device_port_targets")}
    if "sort_order" not in existing:
        conn.execute(text("ALTER TABLE device_port_targets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"))
    rows = conn.execute(text(
        "SELECT id FROM device_port_targets ORDER BY lower(label), port, id"
    )).all()
    for index, row in enumerate(rows, start=1):
        conn.execute(text(
            "UPDATE device_port_targets SET sort_order = :sort_order WHERE id = :id"
        ), {"sort_order": index, "id": row[0]})


def _migrate_external_ip_allocation_groups(conn, inspector) -> None:
    if "external_ip_pools" not in _live_tables(conn):
        return
    existing = _live_columns(conn, "external_ip_pools")
    if "region" not in existing:
        conn.execute(text("ALTER TABLE external_ip_pools ADD COLUMN region VARCHAR(120)"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS external_ip_ranges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id INTEGER NOT NULL REFERENCES external_ip_pools (id) ON DELETE CASCADE,
            cidr VARCHAR(128) NOT NULL UNIQUE,
            created_at DATETIME NOT NULL
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_ranges_id ON external_ip_ranges (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_ranges_pool_id ON external_ip_ranges (pool_id)"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_external_ip_ranges_cidr ON external_ip_ranges (cidr)"))
    if "cidr" in existing:
        conn.execute(text("""
            INSERT OR IGNORE INTO external_ip_ranges (pool_id, cidr, created_at)
            SELECT id, cidr, created_at FROM external_ip_pools
        """))


def _migrate_external_ip_provider_icons(conn, inspector) -> None:
    if "external_ip_pools" not in _live_tables(conn):
        return
    existing = _live_columns(conn, "external_ip_pools")
    if "provider" not in existing:
        return
    if "provider_icon" not in existing:
        conn.execute(text("ALTER TABLE external_ip_pools ADD COLUMN provider_icon VARCHAR(40) NOT NULL DEFAULT 'cloud'"))
        conn.execute(text("""
            UPDATE external_ip_pools
            SET provider_icon = CASE
                WHEN lower(trim(coalesce(provider, ''))) LIKE '%aws%' OR lower(trim(coalesce(provider, ''))) LIKE '%amazon%' THEN 'aws'
                WHEN lower(trim(coalesce(provider, ''))) LIKE '%azure%' OR lower(trim(coalesce(provider, ''))) LIKE '%microsoft%' THEN 'azure'
                WHEN lower(trim(coalesce(provider, ''))) LIKE '%cloudflare%' THEN 'cloudflare'
                WHEN lower(trim(coalesce(provider, ''))) LIKE '%google cloud%' OR lower(trim(coalesce(provider, ''))) = 'gcp' THEN 'google_cloud'
                ELSE provider_icon
            END
        """))


def _migrate_external_ip_custom_icons(conn, inspector) -> None:
    if "external_ip_pools" not in _live_tables(conn):
        return
    existing = _live_columns(conn, "external_ip_pools")
    if "provider" not in existing:
        return
    if "provider_icon_data" not in existing:
        conn.execute(text("ALTER TABLE external_ip_pools ADD COLUMN provider_icon_data TEXT"))


# Built-in cloud providers seeded by 0068. The `builtin` flag now only marks provenance —
# these rows can be edited and deleted like any other, and the seed never runs again.
_BUILTIN_CLOUD_PROVIDERS = (
    ("aws", "AWS", ["amazon", "amazon web services", "ec2"], "aws"),
    ("azure", "Azure", ["microsoft", "microsoft azure"], "azure"),
    ("google-cloud", "Google Cloud", ["gcp", "google"], "google_cloud"),
)


def _migrate_cloud_providers(conn, inspector) -> None:
    """Promote providers from a free-text string + JSON blob to a real table."""
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS cloud_providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key VARCHAR(60) NOT NULL UNIQUE,
            name VARCHAR(80) NOT NULL,
            aliases TEXT,
            icon VARCHAR(40) NOT NULL DEFAULT 'cloud',
            icon_data TEXT,
            builtin BOOLEAN NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
    """))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_cloud_providers_key ON cloud_providers (key)"))

    now = datetime.now(timezone.utc)
    for key, name, aliases, icon in _BUILTIN_CLOUD_PROVIDERS:
        conn.execute(
            text("""
                INSERT OR IGNORE INTO cloud_providers (key, name, aliases, icon, builtin, created_at, updated_at)
                VALUES (:key, :name, :aliases, :icon, 1, :now, :now)
            """),
            {"key": key, "name": name, "aliases": json.dumps(aliases), "icon": icon, "now": now},
        )

    # Import the custom catalogue that lived in the `cloud_provider_catalog` system setting.
    # The setting row is deliberately left in place for one release as a rollback path.
    row = conn.execute(text("SELECT value FROM system_settings WHERE key = 'cloud_provider_catalog'")).fetchone()
    if row is not None and row[0]:
        try:
            entries = json.loads(row[0])
        except (TypeError, ValueError):
            entries = []
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            key = str(entry.get("key") or "").strip()
            name = str(entry.get("name") or "").strip()
            if not key or not name:
                continue
            aliases = entry.get("aliases") or []
            icon_data = entry.get("icon_data")
            conn.execute(
                text("""
                    INSERT OR IGNORE INTO cloud_providers (key, name, aliases, icon, icon_data, builtin, created_at, updated_at)
                    VALUES (:key, :name, :aliases, :icon, :icon_data, 0, :now, :now)
                """),
                {
                    "key": key, "name": name,
                    "aliases": json.dumps(aliases if isinstance(aliases, list) else []),
                    "icon": "custom" if icon_data else "cloud",
                    "icon_data": icon_data, "now": now,
                },
            )

    # Adopt any provider strings already used by pools that matched no catalogue entry.
    if "external_ip_pools" in _live_tables(conn):
        existing = _live_columns(conn, "external_ip_pools")
        if "provider" in existing:
            for (value,) in conn.execute(text(
                "SELECT DISTINCT TRIM(provider) FROM external_ip_pools WHERE TRIM(COALESCE(provider, '')) <> ''"
            )).fetchall():
                key = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")[:60]
                if not key:
                    continue
                icon = "cloud"
                if "provider_icon" in existing:
                    icon_row = conn.execute(
                        text("SELECT provider_icon FROM external_ip_pools WHERE TRIM(provider) = :value AND provider_icon IS NOT NULL LIMIT 1"),
                        {"value": value.strip()},
                    ).fetchone()
                    if icon_row is not None and icon_row[0]:
                        icon = icon_row[0]
                conn.execute(
                    text("""
                        INSERT OR IGNORE INTO cloud_providers (key, name, aliases, icon, builtin, created_at, updated_at)
                        VALUES (:key, :name, '[]', :icon, 0, :now, :now)
                    """),
                    {"key": key, "name": value.strip(), "icon": icon, "now": now},
                )


def _migrate_cloud_assets(conn, inspector) -> None:
    """Create the asset tier and point assignments at it."""
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS cloud_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name VARCHAR(120) NOT NULL,
            kind VARCHAR(40),
            provider_id INTEGER REFERENCES cloud_providers (id) ON DELETE SET NULL,
            account VARCHAR(120),
            region VARCHAR(120),
            device_id INTEGER REFERENCES devices (id) ON DELETE SET NULL,
            description TEXT,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            CONSTRAINT uq_cloud_assets_identity UNIQUE (provider_id, account, name)
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_cloud_assets_provider_id ON cloud_assets (provider_id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_cloud_assets_device_id ON cloud_assets (device_id)"))

    if "external_ip_assignments" in _live_tables(conn):
        existing = _live_columns(conn, "external_ip_assignments")
        if "asset_id" not in existing:
            conn.execute(text("ALTER TABLE external_ip_assignments ADD COLUMN asset_id INTEGER REFERENCES cloud_assets (id) ON DELETE SET NULL"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_assignments_asset_id ON external_ip_assignments (asset_id)"))


def _migrate_external_ip_asset_backfill(conn, inspector) -> None:
    """Synthesise assets from the fields that were standing in for them.

    Addresses that shared a (provider, account, service, label) tuple were the user's
    way of saying "these belong to the same EC2 instance". Collapse each distinct tuple
    into one asset. Nothing is deleted — rows with no usable label keep asset_id NULL
    and surface under an "Unassigned" bucket in the UI.
    """
    if "external_ip_assignments" not in _live_tables(conn):
        return
    existing = _live_columns(conn, "external_ip_assignments")
    if "asset_id" not in existing or "service" not in existing:
        return

    now = datetime.now(timezone.utc)
    rows = conn.execute(text("""
        SELECT id, TRIM(COALESCE(provider, '')), TRIM(COALESCE(account, '')),
               TRIM(COALESCE(service, '')), TRIM(COALESCE(label, ''))
        FROM external_ip_assignments
        WHERE asset_id IS NULL
    """)).fetchall()

    cache: dict[tuple, int] = {}
    for assignment_id, provider, account, service, label in rows:
        if not label:
            continue
        provider_id = None
        if provider:
            key = re.sub(r"[^a-z0-9]+", "-", provider.lower()).strip("-")[:60]
            found = conn.execute(text("SELECT id FROM cloud_providers WHERE key = :key"), {"key": key}).fetchone()
            provider_id = found[0] if found is not None else None
        kind = re.sub(r"[^a-z0-9]+", "_", service.lower()).strip("_")[:40] or None
        identity = (provider_id, account or None, label)
        asset_id = cache.get(identity)
        if asset_id is None:
            found = conn.execute(
                text("""
                    SELECT id FROM cloud_assets
                    WHERE name = :name
                      AND ((provider_id IS NULL AND :provider_id IS NULL) OR provider_id = :provider_id)
                      AND ((account IS NULL AND :account IS NULL) OR account = :account)
                """),
                {"name": label, "provider_id": provider_id, "account": account or None},
            ).fetchone()
            if found is not None:
                asset_id = found[0]
            else:
                asset_id = conn.execute(
                    text("""
                        INSERT INTO cloud_assets (name, kind, provider_id, account, region, created_at, updated_at)
                        VALUES (:name, :kind, :provider_id, :account, NULL, :now, :now)
                    """),
                    {"name": label, "kind": kind, "provider_id": provider_id, "account": account or None, "now": now},
                ).lastrowid
            cache[identity] = asset_id
        conn.execute(
            text("UPDATE external_ip_assignments SET asset_id = :asset_id WHERE id = :id"),
            {"asset_id": asset_id, "id": assignment_id},
        )


def _migrate_external_ip_pool_cleanup(conn, inspector) -> None:
    """Resolve pool.provider to a FK, then drop the vestigial cidr/provider columns.

    `external_ip_pools.cidr` was NOT NULL + UNIQUE while every pool's ranges also lived
    in `external_ip_ranges` (0065 back-filled the former into the latter), forcing a
    privileged "primary" range and blocking two groups from sharing a CIDR.
    """
    if "external_ip_pools" not in _live_tables(conn):
        return
    existing = _live_columns(conn, "external_ip_pools")
    if "provider_id" not in existing:
        conn.execute(text("ALTER TABLE external_ip_pools ADD COLUMN provider_id INTEGER REFERENCES cloud_providers (id) ON DELETE SET NULL"))
        existing.add("provider_id")
    if "provider" in existing:
        conn.execute(text("""
            UPDATE external_ip_pools
            SET provider_id = (
                SELECT p.id FROM cloud_providers p
                WHERE p.key = TRIM(LOWER(REPLACE(REPLACE(COALESCE(external_ip_pools.provider, ''), ' ', '-'), '.', '-')))
            )
            WHERE provider_id IS NULL AND TRIM(COALESCE(provider, '')) <> ''
        """))

    # Nothing legacy left to strip on a fresh database.
    if "cidr" not in existing:
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_pools_provider_id ON external_ip_pools (provider_id)"))
        return

    # Any pool CIDR not yet represented in external_ip_ranges must survive the drop.
    conn.execute(text("""
        INSERT OR IGNORE INTO external_ip_ranges (pool_id, cidr, created_at)
        SELECT id, cidr, created_at FROM external_ip_pools
        WHERE TRIM(COALESCE(cidr, '')) <> ''
    """))

    # SQLite cannot DROP COLUMN on older files — rebuild the table.
    conn.execute(text("""
        CREATE TABLE external_ip_pools_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name VARCHAR(120) NOT NULL,
            provider_id INTEGER REFERENCES cloud_providers (id) ON DELETE SET NULL,
            account VARCHAR(120),
            region VARCHAR(120),
            description TEXT,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
    """))
    conn.execute(text("""
        INSERT INTO external_ip_pools_new (id, name, provider_id, account, region, description, created_at, updated_at)
        SELECT id, name, provider_id, account,
               CASE WHEN :has_region THEN region ELSE NULL END,
               description, created_at, updated_at
        FROM external_ip_pools
    """), {"has_region": 1 if "region" in existing else 0})
    conn.execute(text("DROP TABLE external_ip_pools"))
    conn.execute(text("ALTER TABLE external_ip_pools_new RENAME TO external_ip_pools"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_pools_id ON external_ip_pools (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_pools_provider_id ON external_ip_pools (provider_id)"))


def _migrate_external_ip_device_link(conn, inspector) -> None:
    """Point external addresses straight at their inventory device.

    A cloud asset *is* a device, so `cloud_assets` was an extra hop between an address
    and the thing holding it. Addresses now carry `device_id`; the value is taken from
    the asset they were attached to. `cloud_assets` and `asset_id` are left in place for
    one release as a rollback path, but nothing writes them.
    """
    if "external_ip_assignments" not in _live_tables(conn):
        return
    columns = _live_columns(conn, "external_ip_assignments")
    if "device_id" not in columns:
        conn.execute(text("ALTER TABLE external_ip_assignments ADD COLUMN device_id INTEGER REFERENCES devices (id) ON DELETE SET NULL"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_assignments_device_id ON external_ip_assignments (device_id)"))

    if "asset_id" in columns and "cloud_assets" in _live_tables(conn):
        conn.execute(text("""
            UPDATE external_ip_assignments
            SET device_id = (
                SELECT c.device_id FROM cloud_assets c WHERE c.id = external_ip_assignments.asset_id
            )
            WHERE device_id IS NULL AND asset_id IS NOT NULL
        """))


def _migrate_external_ip_cloud_services(conn, inspector) -> None:
    """Add the provider → cloud service organisational tier to allocations.

    Old address records carried a free-text service, and the short-lived cloud asset
    tier carried a normalized kind. Reuse either only when every linked address in an
    allocation agrees; mixed allocations remain uncategorised instead of being assigned
    a misleading service.
    """
    if "external_ip_pools" not in _live_tables(conn):
        return
    columns = _live_columns(conn, "external_ip_pools")
    if "service" not in columns:
        conn.execute(text("ALTER TABLE external_ip_pools ADD COLUMN service VARCHAR(120)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_pools_service ON external_ip_pools (service)"))

    assignment_columns = _live_columns(conn, "external_ip_assignments") if "external_ip_assignments" in _live_tables(conn) else set()
    for (pool_id,) in conn.execute(text("SELECT id FROM external_ip_pools WHERE TRIM(COALESCE(service, '')) = ''")).fetchall():
        candidates: list[str] = []
        if "service" in assignment_columns:
            candidates = [
                row[0].strip() for row in conn.execute(text("""
                    SELECT DISTINCT service FROM external_ip_assignments
                    WHERE pool_id = :pool_id AND TRIM(COALESCE(service, '')) <> ''
                """), {"pool_id": pool_id}).fetchall()
                if row[0] and row[0].strip()
            ]
        if len(candidates) == 1:
            conn.execute(text("UPDATE external_ip_pools SET service = :service WHERE id = :id"), {"service": candidates[0], "id": pool_id})
            continue

        if "asset_id" not in assignment_columns or "cloud_assets" not in _live_tables(conn):
            continue
        kinds = [
            row[0] for row in conn.execute(text("""
                SELECT DISTINCT c.kind
                FROM external_ip_assignments a
                JOIN cloud_assets c ON c.id = a.asset_id
                WHERE a.pool_id = :pool_id AND TRIM(COALESCE(c.kind, '')) <> ''
            """), {"pool_id": pool_id}).fetchall()
            if row[0]
        ]
        if len(kinds) != 1:
            continue
        provider_key = conn.execute(text("""
            SELECT p.key FROM external_ip_pools e
            LEFT JOIN cloud_providers p ON p.id = e.provider_id
            WHERE e.id = :pool_id
        """), {"pool_id": pool_id}).scalar()
        kind = kinds[0]
        labels = {
            "ec2": "Amazon EC2" if provider_key == "aws" else "EC2",
            "vm": "Virtual Machines",
            "load_balancer": "Load Balancing",
            "nat_gateway": "NAT Gateway",
            "k8s_ingress": "Kubernetes",
            "database": "Database",
            "storage": "Storage",
            "cdn": "CDN",
            "other": "Other services",
        }
        label = labels.get(kind, kind.replace("_", " ").title())
        conn.execute(text("UPDATE external_ip_pools SET service = :service WHERE id = :id"), {"service": label, "id": pool_id})


def _migrate_external_ip_allocation_icons(conn, inspector) -> None:
    """Give each External IP allocation its own selectable design-system icon."""
    if "external_ip_pools" not in _live_tables(conn):
        return
    if "icon" not in _live_columns(conn, "external_ip_pools"):
        conn.execute(text("ALTER TABLE external_ip_pools ADD COLUMN icon VARCHAR(80) NOT NULL DEFAULT 'cloud'"))


def _migrate_core_cloud_providers(conn, inspector) -> None:
    """Keep only AWS, Azure, and Google Cloud in the stock provider catalogue.

    An untouched, unused Cloudflare row came from the old four-provider seed and can be
    removed safely. If it has been customised or is already referenced, retain it as a
    normal provider so upgrading cannot detach allocations or cloud assets.
    """
    tables = _live_tables(conn)
    if "cloud_providers" not in tables:
        return
    row = conn.execute(text("""
        SELECT id, name, aliases, icon, icon_data, builtin
        FROM cloud_providers WHERE key = 'cloudflare'
    """)).fetchone()
    if row is None or not row[5]:
        return

    provider_id = row[0]
    referenced = False
    if "external_ip_pools" in tables and "provider_id" in _live_columns(conn, "external_ip_pools"):
        referenced = bool(conn.execute(
            text("SELECT 1 FROM external_ip_pools WHERE provider_id = :provider_id LIMIT 1"),
            {"provider_id": provider_id},
        ).fetchone())
    if not referenced and "cloud_assets" in tables and "provider_id" in _live_columns(conn, "cloud_assets"):
        referenced = bool(conn.execute(
            text("SELECT 1 FROM cloud_assets WHERE provider_id = :provider_id LIMIT 1"),
            {"provider_id": provider_id},
        ).fetchone())

    untouched = row[1] == "Cloudflare" and row[2] in (None, "", "[]") and row[3] == "cloudflare" and not row[4]
    if untouched and not referenced:
        conn.execute(text("DELETE FROM cloud_providers WHERE id = :provider_id"), {"provider_id": provider_id})
        return
    conn.execute(
        text("UPDATE cloud_providers SET builtin = 0, updated_at = :now WHERE id = :provider_id"),
        {"provider_id": provider_id, "now": datetime.now(timezone.utc)},
    )

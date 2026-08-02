from collections.abc import Generator
from datetime import datetime, timezone
import logging
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
    from app.models import alert_rule, api_key, auth_session, audit_log, device, device_type, dhcp_lease, discovery, external_ip, ip_reservation, monitor, monitor_history, notification_delivery, notification_profile, oidc, password_reset_token, port_target, relationship, saved_search, site, snmp_profile, subnet, system_setting, topology_group, topology_layout, user, user_device_favourite  # noqa: F401

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


def _run_migration(conn, inspector, name: str, fn) -> None:
    if _migration_applied(conn, name):
        return
    fn(conn, inspector)
    _record_migration(conn, name)


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
    cols = {c["name"] for c in inspector.get_columns("users")}
    # If the table already has role as unconstrained VARCHAR this migration is a no-op.
    # We detect by trying to insert a known-bad value; simpler: always recreate.
    conn.execute(text("PRAGMA foreign_keys = OFF"))
    extra = ", avatar_data TEXT" if "avatar_data" in cols else ""
    email_col = ", email VARCHAR(254)" if "email" in cols else ""
    conn.execute(
        text(
            f"""
            CREATE TABLE IF NOT EXISTS users_new (
                id INTEGER NOT NULL PRIMARY KEY,
                username VARCHAR(80) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL,
                is_active BOOLEAN NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                display_name VARCHAR(100){extra}{email_col}
            )
            """
        )
    )
    col_list = "id, username, password_hash, role, is_active, created_at, updated_at, display_name"
    if "avatar_data" in cols:
        col_list += ", avatar_data"
    if "email" in cols:
        col_list += ", email"
    conn.execute(text(f"INSERT INTO users_new SELECT {col_list} FROM users"))
    conn.execute(text("DROP TABLE users"))
    conn.execute(text("ALTER TABLE users_new RENAME TO users"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_id ON users (id)"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)"))
    # SQLAlchemy Enum stored member names (e.g. SUPER_ADMIN) instead of values (SuperAdmin).
    # Normalise to values so plain string comparisons work correctly.
    for name, value in [("SUPER_ADMIN", "SuperAdmin"), ("NETWORK_ADMIN", "NetworkAdmin"),
                        ("SECURITY_ANALYST", "SecurityAnalyst"), ("VIEWER", "Viewer")]:
        conn.execute(text(f"UPDATE users SET role = '{value}' WHERE role = '{name}'"))
    conn.execute(text("PRAGMA foreign_keys = ON"))


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
            cidr VARCHAR(64) NOT NULL UNIQUE,
            provider VARCHAR(80),
            account VARCHAR(120),
            description TEXT,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_external_ip_pools_id ON external_ip_pools (id)"))
    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_external_ip_pools_cidr ON external_ip_pools (cidr)"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS external_ip_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id INTEGER REFERENCES external_ip_pools (id) ON DELETE CASCADE,
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
    existing = {col["name"] for col in inspector.get_columns("users")}
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
    if "users" not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns("users")}
    if "entity_colors_enabled" not in existing:
        conn.execute(text(
            "ALTER TABLE users ADD COLUMN entity_colors_enabled BOOLEAN NOT NULL DEFAULT 1"
        ))

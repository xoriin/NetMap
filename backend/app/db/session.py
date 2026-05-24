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

engine = create_engine(settings.database_url, **engine_kwargs)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, _rec):
    if isinstance(dbapi_conn, sqlite3.Connection):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
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
    from app.models import alert_rule, auth_session, audit_log, device, dhcp_lease, discovery, ip_reservation, monitor_history, password_reset_token, port_target, relationship, site, subnet, system_setting, topology_group, topology_layout, user, user_device_favourite  # noqa: F401

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
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_subnets_id ON subnets (id)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_subnets_site_id ON subnets (site_id)"))


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

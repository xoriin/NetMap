from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import StaticPool

from app.db import session
from app.db.session import _migrate_role_varchar, _migrate_user_schema_repair
from app.models.user import User


def _connection():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    return engine.connect()


def test_role_migration_does_not_strip_columns_from_fresh_users_table():
    conn = _connection()
    User.__table__.create(conn)
    before = {column["name"] for column in inspect(conn).get_columns("users")}

    _migrate_role_varchar(conn, inspect(conn))

    after = {column["name"] for column in inspect(conn).get_columns("users")}
    assert after == before
    assert "whats_new_acknowledged_version" in after
    assert "entity_colors_enabled" in after


def test_role_migration_preserves_unknown_columns_when_removing_legacy_check():
    conn = _connection()
    conn.execute(text("""
        CREATE TABLE users (
            id INTEGER NOT NULL PRIMARY KEY,
            username VARCHAR(80) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(50) NOT NULL CHECK (role IN ('SUPER_ADMIN', 'VIEWER')),
            is_active BOOLEAN NOT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            display_name VARCHAR(100),
            future_column TEXT
        )
    """))
    conn.execute(text("""
        INSERT INTO users (
            id, username, password_hash, role, is_active, created_at, updated_at,
            display_name, future_column
        ) VALUES (1, 'admin', 'hash', 'SUPER_ADMIN', 1, CURRENT_TIMESTAMP,
                  CURRENT_TIMESTAMP, 'Admin', 'keep me')
    """))

    _migrate_role_varchar(conn, inspect(conn))

    row = conn.execute(text(
        "SELECT role, future_column FROM users WHERE username = 'admin'"
    )).one()
    assert row == ("SuperAdmin", "keep me")
    conn.execute(text("UPDATE users SET role = 'CustomRole' WHERE id = 1"))
    assert conn.execute(text("SELECT role FROM users WHERE id = 1")).scalar_one() == "CustomRole"


def test_repair_restores_columns_when_old_migrations_are_already_recorded():
    conn = _connection()
    conn.execute(text("""
        CREATE TABLE users (
            id INTEGER NOT NULL PRIMARY KEY,
            username VARCHAR(80) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(50) NOT NULL,
            is_active BOOLEAN NOT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            display_name VARCHAR(100),
            avatar_data TEXT,
            email VARCHAR(254)
        )
    """))
    conn.execute(text("""
        INSERT INTO users VALUES (
            1, 'admin', 'hash', 'SuperAdmin', 1, CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP, 'Admin', NULL, 'admin@example.com'
        )
    """))
    conn.execute(text("""
        CREATE TABLE schema_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at DATETIME NOT NULL
        )
    """))
    conn.execute(text("""
        INSERT INTO schema_migrations (name, applied_at) VALUES
        ('0019_role_varchar', CURRENT_TIMESTAMP),
        ('0047_user_whats_new_ack', CURRENT_TIMESTAMP),
        ('0058_user_entity_colors', CURRENT_TIMESTAMP)
    """))

    _migrate_user_schema_repair(conn, inspect(conn))
    _migrate_user_schema_repair(conn, inspect(conn))

    columns = {column["name"] for column in inspect(conn).get_columns("users")}
    assert "whats_new_acknowledged_version" in columns
    assert "entity_colors_enabled" in columns
    row = conn.execute(text("""
        SELECT username, role, email, whats_new_acknowledged_version,
               entity_colors_enabled
        FROM users WHERE id = 1
    """)).one()
    assert row == ("admin", "SuperAdmin", "admin@example.com", None, 1)


def test_full_fresh_database_initialization_keeps_current_schema(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    monkeypatch.setattr(session, "engine", engine)

    session.init_db()

    user_columns = {column["name"] for column in inspect(engine).get_columns("users")}
    assert "whats_new_acknowledged_version" in user_columns
    assert "entity_colors_enabled" in user_columns
    pool_columns = {column["name"] for column in inspect(engine).get_columns("external_ip_pools")}
    assert "cidr" not in pool_columns
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA integrity_check")).scalar_one() == "ok"
        assert conn.execute(text(
            "SELECT COUNT(*) FROM schema_migrations WHERE name = '0072_user_schema_repair'"
        )).scalar_one() == 1

    # Reproduce the production 1.5.x state: the old migrations remain recorded,
    # but their two columns have disappeared. Only the new repair is pending.
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE users DROP COLUMN whats_new_acknowledged_version"))
        conn.execute(text("ALTER TABLE users DROP COLUMN entity_colors_enabled"))
        conn.execute(text(
            "DELETE FROM schema_migrations WHERE name = '0072_user_schema_repair'"
        ))
    session.apply_sqlite_schema_updates()

    repaired = {column["name"] for column in inspect(engine).get_columns("users")}
    assert "whats_new_acknowledged_version" in repaired
    assert "entity_colors_enabled" in repaired
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA integrity_check")).scalar_one() == "ok"

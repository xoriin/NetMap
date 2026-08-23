"""Migration coverage for the External IPAM asset tier (0068-0071).

These exercise the migrations against a hand-built *pre-migration* schema rather than
a fresh `create_all`, because the interesting behaviour is the 0070 backfill and the
0071 table rebuild — neither of which runs on a clean database.
"""

import json

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import StaticPool

from app.db.session import (
    _migrate_cloud_assets,
    _migrate_cloud_providers,
    _migrate_external_ip_asset_backfill,
    _migrate_external_ip_pool_cleanup,
)


# Schema as it stood after 0067, before the asset tier existed.
_PRE_MIGRATION_DDL = (
    """
    CREATE TABLE system_settings (
        key VARCHAR(120) PRIMARY KEY,
        value TEXT,
        updated_at DATETIME
    )
    """,
    """
    CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname VARCHAR(255),
        ip_address VARCHAR(64) NOT NULL
    )
    """,
    """
    CREATE TABLE external_ip_pools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(120) NOT NULL,
        cidr VARCHAR(128) NOT NULL UNIQUE,
        provider VARCHAR(80),
        provider_icon VARCHAR(40) NOT NULL DEFAULT 'cloud',
        provider_icon_data TEXT,
        account VARCHAR(120),
        region VARCHAR(120),
        description TEXT,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
    )
    """,
    """
    CREATE TABLE external_ip_ranges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_id INTEGER NOT NULL REFERENCES external_ip_pools (id) ON DELETE CASCADE,
        cidr VARCHAR(128) NOT NULL UNIQUE,
        created_at DATETIME NOT NULL
    )
    """,
    """
    CREATE TABLE external_ip_assignments (
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
    """,
)


def _legacy_db(*, with_catalog: bool = True):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    conn = engine.connect()
    for statement in _PRE_MIGRATION_DDL:
        conn.execute(text(statement))

    if with_catalog:
        conn.execute(
            text("INSERT INTO system_settings (key, value, updated_at) VALUES ('cloud_provider_catalog', :value, CURRENT_TIMESTAMP)"),
            {"value": json.dumps([
                {"key": "oracle-cloud", "name": "Oracle Cloud", "aliases": ["OCI"], "icon_data": "data:image/png;base64,iVBORw0KGgo="},
            ])},
        )

    conn.execute(text("""
        INSERT INTO external_ip_pools (id, name, cidr, provider, provider_icon, account, region, created_at, updated_at)
        VALUES (1, 'AWS production', '13.54.22.0/28', 'AWS', 'aws', 'acct-1', 'ap-southeast-2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    """))
    conn.execute(text("INSERT INTO external_ip_ranges (pool_id, cidr, created_at) VALUES (1, '13.54.22.0/28', CURRENT_TIMESTAMP)"))

    # Two addresses on one EC2 instance, one on another, one with no label at all.
    rows = (
        ("13.54.22.1", "web-prod-01", "AWS", "acct-1", "EC2"),
        ("13.54.22.2", "web-prod-01", "AWS", "acct-1", "EC2"),
        ("13.54.22.3", "api-lb-01", "AWS", "acct-1", "Load balancer"),
        ("13.54.22.4", "", "AWS", "acct-1", ""),
    )
    for address, label, provider, account, service in rows:
        conn.execute(
            text("""
                INSERT INTO external_ip_assignments (pool_id, ip_address, label, status, provider, account, service, created_at, updated_at)
                VALUES (1, :ip, :label, 'in_use', :provider, :account, :service, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """),
            {"ip": address, "label": label, "provider": provider, "account": account, "service": service},
        )
    conn.commit()
    return conn


def _run_all(conn):
    """Run the chain the way `apply_sqlite_schema_updates` really does.

    The production runner builds ONE inspector before any migration executes and hands
    that same stale object to every step, so a migration cannot see a column an earlier
    migration in the same run just added. Reproducing that here is the point: building a
    fresh inspector per step hid a real bug where 0070 skipped its backfill entirely.
    """
    stale_inspector = inspect(conn)
    for fn in (
        _migrate_cloud_providers,
        _migrate_cloud_assets,
        _migrate_external_ip_asset_backfill,
        _migrate_external_ip_pool_cleanup,
    ):
        fn(conn, stale_inspector)
    conn.commit()


def test_backfill_collapses_shared_identity_into_one_asset():
    conn = _legacy_db()
    _run_all(conn)

    assets = conn.execute(text("SELECT name, kind, account FROM cloud_assets ORDER BY name")).fetchall()
    assert [row[0] for row in assets] == ["api-lb-01", "web-prod-01"]
    # `service` becomes the asset kind, slugified.
    assert dict((row[0], row[1]) for row in assets) == {"api-lb-01": "load_balancer", "web-prod-01": "ec2"}

    # The two addresses that shared (provider, account, service, label) now share an asset.
    linked = conn.execute(text("""
        SELECT a.ip_address, c.name FROM external_ip_assignments a
        LEFT JOIN cloud_assets c ON c.id = a.asset_id ORDER BY a.ip_address
    """)).fetchall()
    assert dict(linked) == {
        "13.54.22.1": "web-prod-01",
        "13.54.22.2": "web-prod-01",
        "13.54.22.3": "api-lb-01",
        "13.54.22.4": None,  # no label — kept, not deleted
    }

    # Nothing was destroyed.
    assert conn.execute(text("SELECT COUNT(*) FROM external_ip_assignments")).scalar() == 4


def test_provider_catalog_and_pool_strings_become_rows():
    conn = _legacy_db()
    _run_all(conn)

    providers = dict(conn.execute(text("SELECT key, name FROM cloud_providers")).fetchall())
    # Built-ins seeded, custom catalogue entry imported, pool's own string adopted.
    assert providers["aws"] == "AWS"
    assert providers["azure"] == "Azure"
    assert providers["oracle-cloud"] == "Oracle Cloud"

    builtin = conn.execute(text("SELECT builtin FROM cloud_providers WHERE key = 'aws'")).scalar()
    assert builtin == 1
    imported = conn.execute(text("SELECT builtin, icon_data FROM cloud_providers WHERE key = 'oracle-cloud'")).fetchone()
    assert imported[0] == 0
    assert imported[1].startswith("data:image/png;base64,")

    # The pool's provider string resolved to the FK.
    provider_id = conn.execute(text("SELECT provider_id FROM external_ip_pools WHERE id = 1")).scalar()
    assert provider_id == conn.execute(text("SELECT id FROM cloud_providers WHERE key = 'aws'")).scalar()

    # The old setting row is deliberately retained for one release as a rollback path.
    assert conn.execute(text("SELECT COUNT(*) FROM system_settings WHERE key = 'cloud_provider_catalog'")).scalar() == 1


def test_pool_cleanup_drops_vestigial_columns_and_keeps_ranges():
    conn = _legacy_db()
    _run_all(conn)

    columns = {col["name"] for col in inspect(conn).get_columns("external_ip_pools")}
    assert "cidr" not in columns
    assert "provider" not in columns
    assert "provider_icon" not in columns
    assert "provider_icon_data" not in columns
    assert "provider_id" in columns

    # The pool's CIDR survives as a range rather than being lost with the column.
    ranges = [row[0] for row in conn.execute(text("SELECT cidr FROM external_ip_ranges WHERE pool_id = 1")).fetchall()]
    assert ranges == ["13.54.22.0/28"]
    assert conn.execute(text("SELECT name FROM external_ip_pools WHERE id = 1")).scalar() == "AWS production"


def test_migrations_are_idempotent():
    conn = _legacy_db()
    _run_all(conn)
    assets_before = conn.execute(text("SELECT COUNT(*) FROM cloud_assets")).scalar()
    providers_before = conn.execute(text("SELECT COUNT(*) FROM cloud_providers")).scalar()

    _run_all(conn)

    assert conn.execute(text("SELECT COUNT(*) FROM cloud_assets")).scalar() == assets_before
    assert conn.execute(text("SELECT COUNT(*) FROM cloud_providers")).scalar() == providers_before
    assert conn.execute(text("SELECT COUNT(*) FROM external_ip_assignments")).scalar() == 4


def test_migrations_are_a_noop_on_a_fresh_database():
    """0071 must not try to rebuild a table that never had the legacy columns."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    conn = engine.connect()
    conn.execute(text("CREATE TABLE system_settings (key VARCHAR(120) PRIMARY KEY, value TEXT, updated_at DATETIME)"))
    conn.execute(text("CREATE TABLE devices (id INTEGER PRIMARY KEY AUTOINCREMENT, hostname VARCHAR(255), ip_address VARCHAR(64) NOT NULL)"))
    conn.commit()

    _run_all(conn)

    assert conn.execute(text("SELECT COUNT(*) FROM cloud_providers")).scalar() == 4
    assert conn.execute(text("SELECT COUNT(*) FROM cloud_assets")).scalar() == 0

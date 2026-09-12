"""Migration coverage for the External IPAM schema and catalogue (0068-0076).

These exercise the migrations against a hand-built *pre-migration* schema rather than
a fresh `create_all`, because the interesting behaviour is the 0070 backfill and the
0071 table rebuild — neither of which runs on a clean database.
"""

import json
import re
from datetime import datetime

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import StaticPool

from app.db.session import (
    _live_tables,
    _migrate_cloud_assets,
    _migrate_cloud_providers,
    _migrate_core_cloud_providers,
    _migrate_external_ip_addresses,
    _migrate_external_ip_asset_backfill,
    _migrate_external_ip_cloud_services,
    _migrate_external_ip_allocation_icons,
    _migrate_external_ip_device_link,
    _migrate_external_ip_pool_cleanup,
    _migrate_external_locations,
    _migrate_user_schema_repair,
)


def _run_migration_0078(conn):
    _migrate_external_ip_addresses(conn, None)


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


# Schema for a database that has never carried the legacy pool.cidr/provider strings —
# i.e. one already past 0071's table rebuild — used to build fixtures for migrations
# past that point without replaying the rebuild's exact (default-less) column set.
_BARE_MODERN_DDL = (
    """
    CREATE TABLE system_settings (
        key VARCHAR(120) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME NOT NULL
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
        account VARCHAR(120),
        region VARCHAR(120),
        description TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE external_ip_ranges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_id INTEGER NOT NULL REFERENCES external_ip_pools (id) ON DELETE CASCADE,
        cidr VARCHAR(128) NOT NULL UNIQUE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
)


def _run_through_0077(conn):
    """Run the 0068-0077 chain the same stale-inspector way `_run_all` does.

    Starts from `_BARE_MODERN_DDL` (no legacy pool.cidr/provider columns), so 0071's
    table-rebuild branch is a no-op here exactly as it would be on a database that
    was already past that migration — see `test_migrations_are_a_noop_on_a_fresh_database`
    above for the same idea applied to the 0068-0071 chain.
    """
    stale_inspector = inspect(conn)
    for fn in (
        _migrate_cloud_providers,
        _migrate_cloud_assets,
        _migrate_external_ip_asset_backfill,
        _migrate_external_ip_pool_cleanup,
        _migrate_user_schema_repair,
        _migrate_external_ip_device_link,
        _migrate_external_ip_cloud_services,
        _migrate_external_ip_allocation_icons,
        _migrate_core_cloud_providers,
        _migrate_external_locations,
    ):
        fn(conn, stale_inspector)
    conn.commit()


@pytest.fixture
def migrated_conn_factory():
    """Return a connection with migrations applied through the requested checkpoint.

    Only "0077" is needed by the current tests.
    """
    def factory(*, through: str = "0077"):
        if through != "0077":
            raise ValueError(f"unsupported migration checkpoint: {through!r}")
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        conn = engine.connect()
        for statement in _BARE_MODERN_DDL:
            conn.execute(text(statement))
        conn.commit()
        _run_through_0077(conn)
        return conn

    return factory


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
        _migrate_external_ip_cloud_services,
        _migrate_external_ip_allocation_icons,
        _migrate_core_cloud_providers,
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
    assert "service" in columns
    assert "icon" in columns
    assert conn.execute(text("SELECT icon FROM external_ip_pools WHERE id = 1")).scalar() == "cloud"

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


def test_service_tier_backfills_only_an_unambiguous_legacy_service():
    conn = _legacy_db()
    conn.execute(text("""
        INSERT INTO external_ip_pools (id, name, cidr, provider, provider_icon, account, region, created_at, updated_at)
        VALUES (2, 'Lambda outbound', '52.62.1.9', 'AWS', 'aws', 'acct-1', 'ap-southeast-2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    """))
    conn.execute(text("INSERT INTO external_ip_ranges (pool_id, cidr, created_at) VALUES (2, '52.62.1.9', CURRENT_TIMESTAMP)"))
    conn.execute(text("""
        INSERT INTO external_ip_assignments (pool_id, ip_address, label, status, provider, account, service, created_at, updated_at)
        VALUES (2, '52.62.1.9', 'function-egress', 'in_use', 'AWS', 'acct-1', 'AWS Lambda', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    """))
    conn.commit()

    _run_all(conn)

    assert conn.execute(text("SELECT service FROM external_ip_pools WHERE id = 2")).scalar() == "AWS Lambda"
    # Pool 1 mixed EC2 and load-balancer addresses, so guessing would be misleading.
    assert conn.execute(text("SELECT service FROM external_ip_pools WHERE id = 1")).scalar() is None


def test_migrations_are_a_noop_on_a_fresh_database():
    """0071 must not try to rebuild a table that never had the legacy columns."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    conn = engine.connect()
    conn.execute(text("CREATE TABLE system_settings (key VARCHAR(120) PRIMARY KEY, value TEXT, updated_at DATETIME)"))
    conn.execute(text("CREATE TABLE devices (id INTEGER PRIMARY KEY AUTOINCREMENT, hostname VARCHAR(255), ip_address VARCHAR(64) NOT NULL)"))
    conn.commit()

    _run_all(conn)

    assert conn.execute(text("SELECT COUNT(*) FROM cloud_providers")).scalar() == 3
    assert conn.execute(text("SELECT COUNT(*) FROM cloud_assets")).scalar() == 0


def test_retired_stock_cloudflare_is_removed_only_when_safe():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    conn = engine.connect()
    conn.execute(text("""
        CREATE TABLE cloud_providers (
            id INTEGER PRIMARY KEY, key TEXT UNIQUE, name TEXT, aliases TEXT, icon TEXT,
            icon_data TEXT, builtin BOOLEAN, created_at DATETIME, updated_at DATETIME
        )
    """))
    conn.execute(text("CREATE TABLE external_ip_pools (id INTEGER PRIMARY KEY, provider_id INTEGER)"))
    conn.execute(text("CREATE TABLE cloud_assets (id INTEGER PRIMARY KEY, provider_id INTEGER)"))
    conn.execute(text("""
        INSERT INTO cloud_providers
            (id, key, name, aliases, icon, icon_data, builtin, created_at, updated_at)
        VALUES (1, 'cloudflare', 'Cloudflare', '[]', 'cloudflare', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    """))

    _migrate_core_cloud_providers(conn, inspect(conn))
    assert conn.execute(text("SELECT COUNT(*) FROM cloud_providers WHERE key = 'cloudflare'")).scalar() == 0

    conn.execute(text("""
        INSERT INTO cloud_providers
            (id, key, name, aliases, icon, icon_data, builtin, created_at, updated_at)
        VALUES (2, 'cloudflare', 'Cloudflare', '[]', 'cloudflare', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    """))
    conn.execute(text("INSERT INTO external_ip_pools (id, provider_id) VALUES (1, 2)"))
    _migrate_core_cloud_providers(conn, inspect(conn))
    preserved = conn.execute(text("SELECT builtin FROM cloud_providers WHERE id = 2")).scalar()
    assert preserved == 0
    assert conn.execute(text("SELECT provider_id FROM external_ip_pools WHERE id = 1")).scalar() == 2


def test_0078_folds_assignments_forward(migrated_conn_factory):
    """An assignment keeps its metadata and inherits its pool's location."""
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_provider_accounts (id, provider_id, name) VALUES (1, NULL, 'prod')"))
    conn.execute(text("INSERT INTO external_locations (id, account_id, name, region) VALUES (1, 1, 'Central US', 'centralus')"))
    conn.execute(text(
        "INSERT INTO external_ip_pools (id, name, location_id, icon, service) "
        "VALUES (1, 'Public web', 1, 'cloud', 'Amazon EC2')"
    ))
    conn.execute(text("INSERT INTO external_ip_ranges (id, pool_id, cidr) VALUES (1, 1, '203.0.113.0/29')"))
    conn.execute(text(
        "INSERT INTO external_ip_assignments (id, pool_id, ip_address, label, status, owner, notes) "
        "VALUES (1, 1, '203.0.113.1', 'Web edge', 'in_use', 'Platform', 'Existing note')"
    ))

    _run_migration_0078(conn)

    rows = conn.execute(text(
        "SELECT ip_address, location_id, status, label, owner, notes "
        "FROM external_ip_addresses ORDER BY ip_address"
    )).fetchall()
    assert len(rows) == 6                        # .1-.6, network and broadcast excluded
    tracked = rows[0]
    assert tracked[0] == "203.0.113.1"
    assert tracked[1] == 1
    assert tracked[2] == "in_use"
    assert tracked[3] == "Web edge"
    assert tracked[4] == "Platform"
    assert "Existing note" in tracked[5]
    assert "From allocation: Public web · Amazon EC2" in tracked[5]
    assert [row[2] for row in rows[1:]] == ["available"] * 5


def test_0078_pool_without_location_is_unassigned(migrated_conn_factory):
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon) VALUES (1, 'Legacy', NULL, 'cloud')"))
    conn.execute(text(
        "INSERT INTO external_ip_assignments (id, pool_id, ip_address, label, status) "
        "VALUES (1, 1, '198.51.100.7', 'Old', 'in_use')"
    ))

    _run_migration_0078(conn)

    row = conn.execute(text("SELECT ip_address, location_id FROM external_ip_addresses")).first()
    assert row[0] == "198.51.100.7"
    assert row[1] is None


def test_0078_declines_large_block_but_keeps_tracked_addresses(migrated_conn_factory):
    """Real records migrate unconditionally; derived filler obeys the cap."""
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon) VALUES (1, 'Big', NULL, 'cloud')"))
    conn.execute(text("INSERT INTO external_ip_ranges (id, pool_id, cidr) VALUES (1, 1, '203.0.0.0/16')"))
    conn.execute(text(
        "INSERT INTO external_ip_assignments (id, pool_id, ip_address, label, status) "
        "VALUES (1, 1, '203.0.5.9', 'Kept', 'in_use')"
    ))

    _run_migration_0078(conn)

    rows = conn.execute(text("SELECT ip_address FROM external_ip_addresses")).fetchall()
    assert [row[0] for row in rows] == ["203.0.5.9"]
    report = json.loads(conn.execute(text(
        "SELECT value FROM system_settings WHERE key = 'external_ip_migration_report'"
    )).scalar())
    assert report["declined"][0]["cidr"] == "203.0.0.0/16"
    assert report["declined"][0]["kept"] == 1


def test_0078_is_idempotent(migrated_conn_factory):
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon) VALUES (1, 'P', NULL, 'cloud')"))
    conn.execute(text(
        "INSERT INTO external_ip_assignments (id, pool_id, ip_address, label, status) "
        "VALUES (1, 1, '198.51.100.7', 'Old', 'in_use')"
    ))

    _run_migration_0078(conn)
    _run_migration_0078(conn)

    assert conn.execute(text("SELECT COUNT(*) FROM external_ip_addresses")).scalar() == 1


def test_0078_leaves_old_tables_intact(migrated_conn_factory):
    """The old tables are the rollback path in patch 1."""
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon) VALUES (1, 'P', NULL, 'cloud')"))

    _run_migration_0078(conn)

    tables = _live_tables(conn)
    assert "external_ip_pools" in tables
    assert "external_ip_ranges" in tables
    assert "external_ip_assignments" in tables
    assert conn.execute(text("SELECT COUNT(*) FROM external_ip_pools")).scalar() == 1


def test_0078_kept_count_is_per_range_not_per_pool(migrated_conn_factory):
    """Two declined ranges sharing a pool must each report their own kept count.

    Before this fix, `kept` summed every tracked address in the *pool*, so both
    declined entries reported the same (wrong) total regardless of which range
    the tracked addresses actually fell inside.
    """
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon) VALUES (1, 'Big', NULL, 'cloud')"))
    conn.execute(text("INSERT INTO external_ip_ranges (id, pool_id, cidr) VALUES (1, 1, '203.0.0.0/16')"))
    conn.execute(text("INSERT INTO external_ip_ranges (id, pool_id, cidr) VALUES (2, 1, '203.1.0.0/16')"))
    conn.execute(text(
        "INSERT INTO external_ip_assignments (id, pool_id, ip_address, label, status) "
        "VALUES (1, 1, '203.0.5.9', 'Kept A', 'in_use')"
    ))
    conn.execute(text(
        "INSERT INTO external_ip_assignments (id, pool_id, ip_address, label, status) "
        "VALUES (2, 1, '203.0.6.9', 'Kept B', 'in_use')"
    ))

    _run_migration_0078(conn)

    report = json.loads(conn.execute(text(
        "SELECT value FROM system_settings WHERE key = 'external_ip_migration_report'"
    )).scalar())
    by_cidr = {entry["cidr"]: entry["kept"] for entry in report["declined"]}
    assert by_cidr["203.0.0.0/16"] == 2   # both tracked addresses fall in this range
    assert by_cidr["203.1.0.0/16"] == 0   # none fall in this one


def test_0078_writes_naive_datetimes_matching_orm_format(migrated_conn_factory):
    """Migrated rows must read back the same naive shape ORM-written rows do.

    Binding an aware `datetime` through sqlite3's default adapter stores an
    offset-suffixed string, while the ORM's DateTime columns store a plain naive
    "YYYY-MM-DD HH:MM:SS.ffffff" string. Mixing the two breaks any Python-side
    comparison across migrated vs. app-written rows (SQLite returns naive
    datetimes throughout this project).
    """
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon) VALUES (1, 'P', NULL, 'cloud')"))
    conn.execute(text(
        "INSERT INTO external_ip_assignments (id, pool_id, ip_address, label, status) "
        "VALUES (1, 1, '198.51.100.7', 'Old', 'in_use')"
    ))

    _run_migration_0078(conn)

    address_created_at = conn.execute(text(
        "SELECT created_at FROM external_ip_addresses WHERE ip_address = '198.51.100.7'"
    )).scalar()
    report_updated_at = conn.execute(text(
        "SELECT updated_at FROM system_settings WHERE key = 'external_ip_migration_report'"
    )).scalar()

    naive_shape = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$")
    assert naive_shape.match(address_created_at), address_created_at
    assert naive_shape.match(report_updated_at), report_updated_at
    # Both parse back with no tzinfo — the same shape the ORM writes, not aware.
    assert datetime.fromisoformat(address_created_at).tzinfo is None
    assert datetime.fromisoformat(report_updated_at).tzinfo is None


def test_0078_rebuilds_external_locations_account_id_to_nullable():
    """A location must be creatable without a provider account (spec requirement).

    0077 shipped `external_locations.account_id` as NOT NULL; SQLite can't drop that
    constraint in place, so 0078 must rebuild the table when it finds one. Built by
    hand rather than via `migrated_conn_factory`, since that fixture's 0077 now
    creates the column nullable already (the model is `nullable=True` and
    `_migrate_external_locations` creates the table straight from it) — this test
    is specifically for a database that already ran the old dev-only DDL.
    """
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    conn = engine.connect()
    conn.execute(text("""
        CREATE TABLE external_provider_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider_id INTEGER,
            name VARCHAR(120) NOT NULL DEFAULT ''
        )
    """))
    conn.execute(text("""
        CREATE TABLE external_locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL REFERENCES external_provider_accounts (id),
            name VARCHAR(120) NOT NULL,
            region VARCHAR(120)
        )
    """))
    conn.execute(text("INSERT INTO external_provider_accounts (id, provider_id, name) VALUES (1, NULL, 'prod')"))
    conn.execute(text("INSERT INTO external_locations (id, account_id, name, region) VALUES (1, 1, 'Central US', 'centralus')"))
    conn.commit()

    def _account_id_notnull():
        column = next(
            row for row in conn.execute(text("PRAGMA table_info(external_locations)")).fetchall()
            if row[1] == "account_id"
        )
        return column[3]

    assert _account_id_notnull() == 1  # NOT NULL before the fix-up

    _run_migration_0078(conn)

    assert _account_id_notnull() == 0  # nullable after the rebuild
    assert conn.execute(text(
        "SELECT id, account_id, name, region FROM external_locations"
    )).fetchall() == [(1, 1, "Central US", "centralus")]

    # Idempotent: re-running finds the column already nullable and leaves it alone.
    _run_migration_0078(conn)
    assert _account_id_notnull() == 0
    assert conn.execute(text(
        "SELECT id, account_id, name, region FROM external_locations"
    )).fetchall() == [(1, 1, "Central US", "centralus")]


def test_0078_leaves_already_nullable_external_locations_untouched(migrated_conn_factory):
    """A fresh 0077 (post-fix) already creates the column nullable — no-op path."""
    conn = migrated_conn_factory(through="0077")
    columns = {row[1]: row[3] for row in conn.execute(text("PRAGMA table_info(external_locations)")).fetchall()}
    assert columns["account_id"] == 0  # already nullable, straight from the model

    conn.execute(text("INSERT INTO external_provider_accounts (id, provider_id, name) VALUES (1, NULL, 'prod')"))
    conn.execute(text("INSERT INTO external_locations (id, account_id, name, region) VALUES (1, 1, 'Central US', NULL)"))
    conn.execute(text("INSERT INTO external_locations (id, account_id, name, region) VALUES (2, NULL, 'No account yet', NULL)"))

    _run_migration_0078(conn)

    rows = conn.execute(text("SELECT id, account_id, name FROM external_locations ORDER BY id")).fetchall()
    assert rows == [(1, 1, "Central US"), (2, None, "No account yet")]


def test_0078_raises_when_the_row_count_does_not_reconcile(migrated_conn_factory):
    """The spec's compensating control for a migration only ever run against fixtures:
    count the source before writing, the destination after, and raise on a mismatch.

    A `BEFORE INSERT ... RAISE(IGNORE)` trigger abandons one row silently — exactly the
    failure mode the reconciliation exists to catch — and no error would otherwise
    surface. Since every migration shares one transaction, the raise rolls the whole
    upgrade back.
    """
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon) VALUES (1, 'P', NULL, 'cloud')"))
    for index, address in enumerate(("198.51.100.1", "198.51.100.2", "198.51.100.3"), start=1):
        conn.execute(
            text("INSERT INTO external_ip_assignments (id, pool_id, ip_address, label, status) "
                 "VALUES (:id, 1, :ip, 'x', 'in_use')"),
            {"id": index, "ip": address},
        )
    from app.models.external_ip import ExternalIpAddress
    ExternalIpAddress.__table__.create(conn, checkfirst=True)
    conn.execute(text(
        "CREATE TRIGGER swallow_one BEFORE INSERT ON external_ip_addresses "
        "WHEN NEW.ip_address = '198.51.100.2' BEGIN SELECT RAISE(IGNORE); END"
    ))

    with pytest.raises(RuntimeError) as exc:
        _run_migration_0078(conn)

    message = str(exc.value)
    assert "expected 3" in message
    assert "produced 2" in message


def test_0078_records_and_logs_an_unparseable_range(migrated_conn_factory, caplog):
    """The one place a real database's odd data could vanish wordlessly."""
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_provider_accounts (id, provider_id, name) VALUES (1, NULL, 'prod')"))
    conn.execute(text("INSERT INTO external_locations (id, account_id, name, region) VALUES (1, 1, 'Central US', NULL)"))
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon, service) VALUES (1, 'Public web', 1, 'cloud', 'Amazon EC2')"))
    conn.execute(text("INSERT INTO external_ip_ranges (id, pool_id, cidr) VALUES (1, 1, 'not-a-cidr')"))

    with caplog.at_level("WARNING", logger="app.db.session"):
        _run_migration_0078(conn)

    assert "not-a-cidr" in caplog.text
    report = json.loads(conn.execute(text(
        "SELECT value FROM system_settings WHERE key = 'external_ip_migration_report'"
    )).scalar())
    assert report["skipped"] == [
        {"cidr": "not-a-cidr", "location": "Central US", "reason": "Not a valid CIDR"}
    ]
    # Skipping must not disturb the reconciliation.
    assert report["migrated"] == 0


def test_0078_declined_notice_names_the_location_not_the_pool(migrated_conn_factory):
    """The UI renders `${cidr} at ${location}`, so this must be a location name."""
    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_provider_accounts (id, provider_id, name) VALUES (1, NULL, 'prod')"))
    conn.execute(text("INSERT INTO external_locations (id, account_id, name, region) VALUES (1, 1, 'Central US', NULL)"))
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon, service) VALUES (1, 'Public web endpoints', 1, 'cloud', 'Amazon EC2')"))
    conn.execute(text("INSERT INTO external_ip_ranges (id, pool_id, cidr) VALUES (1, 1, '203.0.0.0/16')"))
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon) VALUES (2, 'Homeless', NULL, 'cloud')"))
    conn.execute(text("INSERT INTO external_ip_ranges (id, pool_id, cidr) VALUES (2, 2, '198.18.0.0/16')"))

    _run_migration_0078(conn)

    report = json.loads(conn.execute(text(
        "SELECT value FROM system_settings WHERE key = 'external_ip_migration_report'"
    )).scalar())
    by_cidr = {entry["cidr"]: entry["location"] for entry in report["declined"]}
    assert by_cidr["203.0.0.0/16"] == "Central US"
    assert by_cidr["198.18.0.0/16"] == "Unassigned"


def test_0078_normalises_ipv6_the_way_the_api_would(migrated_conn_factory):
    """Migrated text must match what `parse_address_input` would have stored, or a
    later add of the same address is a second row rather than a 409."""
    import ipaddress as _ipaddress

    conn = migrated_conn_factory(through="0077")
    conn.execute(text("INSERT INTO external_ip_pools (id, name, location_id, icon) VALUES (1, 'P', NULL, 'cloud')"))
    conn.execute(text(
        "INSERT INTO external_ip_assignments (id, pool_id, ip_address, label, status) "
        "VALUES (1, 1, '2001:0DB8::0001', 'v6', 'in_use')"
    ))

    _run_migration_0078(conn)

    stored = conn.execute(text("SELECT ip_address FROM external_ip_addresses")).scalar()
    assert stored == "2001:db8::1"
    assert stored == str(_ipaddress.ip_address("2001:0DB8::0001"))

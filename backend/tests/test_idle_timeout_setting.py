import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import StaticPool

from app.api.v1.admin import DEFAULTS
from app.db.session import _migrate_idle_timeout_preserve, _migrate_system_settings
from app.schemas.admin import SystemSettingsRead, SystemSettingsUpdate


def _connection():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    conn = engine.connect()
    conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(80))"))
    _migrate_system_settings(conn, inspect(conn))
    return conn


def _add_user(conn) -> None:
    conn.execute(text("INSERT INTO users (username) VALUES ('admin')"))


def _idle_value(conn):
    row = conn.execute(text("SELECT value FROM system_settings WHERE key = 'idle_timeout_minutes'")).fetchone()
    return None if row is None else row[0]


def test_clean_install_defaults_to_disabled():
    assert DEFAULTS["idle_timeout_minutes"] == "0"
    assert SystemSettingsRead.model_fields["idle_timeout_minutes"].default == 0


def test_zero_disables_and_range_is_still_bounded():
    assert SystemSettingsUpdate(idle_timeout_minutes=0).idle_timeout_minutes == 0
    assert SystemSettingsUpdate(idle_timeout_minutes=480).idle_timeout_minutes == 480
    with pytest.raises(ValidationError):
        SystemSettingsUpdate(idle_timeout_minutes=-1)
    with pytest.raises(ValidationError):
        SystemSettingsUpdate(idle_timeout_minutes=481)


def test_upgrade_keeps_the_previous_fifteen_minute_default():
    conn = _connection()
    _add_user(conn)

    _migrate_idle_timeout_preserve(conn, inspect(conn))

    assert _idle_value(conn) == "15"


def test_upgrade_keeps_an_explicitly_configured_timeout():
    conn = _connection()
    _add_user(conn)
    conn.execute(text(
        "INSERT INTO system_settings (key, value, updated_at) VALUES ('idle_timeout_minutes', '45', '2026-01-01')"
    ))

    _migrate_idle_timeout_preserve(conn, inspect(conn))

    assert _idle_value(conn) == "45"


def test_fresh_database_gets_no_stored_timeout():
    conn = _connection()

    _migrate_idle_timeout_preserve(conn, inspect(conn))

    assert _idle_value(conn) is None

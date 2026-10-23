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


@pytest.mark.parametrize("value", [0, "0", 1, "1", 15, "30", 480, "480"])
def test_settings_read_preserves_disabled_and_enabled_values(value):
    settings = SystemSettingsRead(**{**DEFAULTS, "idle_timeout_minutes": value})
    assert settings.idle_timeout_minutes == int(value)


def test_clean_install_settings_response_is_actually_disabled():
    assert SystemSettingsRead(**DEFAULTS).idle_timeout_minutes == 0


@pytest.mark.parametrize("value", [None, "", "invalid"])
def test_invalid_stored_idle_timeout_uses_the_disabled_default(value):
    assert SystemSettingsRead(**{**DEFAULTS, "idle_timeout_minutes": value}).idle_timeout_minutes == 0


def test_other_positive_integer_settings_keep_their_validation():
    settings = SystemSettingsRead(**{**DEFAULTS, "monitor_interval_seconds": "0", "backup_retention_count": "0"})
    assert settings.monitor_interval_seconds == 1
    assert settings.backup_retention_count == 1


def test_idle_setting_round_trips_through_save_and_new_database_sessions(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import Session
    from app.api.deps import get_current_user
    from app.api.v1.admin import router
    from app.db.session import Base, get_db
    from app.models.site import Site  # noqa: F401 - register Device.site for isolated runs
    from app.models.system_setting import SystemSetting
    from app.models.user import User, UserRole

    engine = create_engine(f"sqlite:///{tmp_path / 'idle-setting.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[SystemSetting.__table__])
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_current_user] = lambda: User(id=1, username="admin", role=UserRole.SUPER_ADMIN, password_hash="x", is_active=True)

    def fresh_session():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_db] = fresh_session
    try:
        with TestClient(app) as client:
            assert client.get("/api/v1/admin/settings").json()["idle_timeout_minutes"] == 0
            for minutes in [30, 0, 1, 0, 480, 0]:
                response = client.put("/api/v1/admin/settings", json={"idle_timeout_minutes": minutes})
                assert response.status_code == 200
                assert response.json()["idle_timeout_minutes"] == minutes
                with Session(engine) as db:
                    assert db.get(SystemSetting, "idle_timeout_minutes").value == str(minutes)
                # Reads use new sessions, as after navigation/reload or another login.
                for path in ["/api/v1/admin/settings", "/api/v1/admin/settings/app"]:
                    assert client.get(path).json()["idle_timeout_minutes"] == minutes
                app.dependency_overrides[get_current_user] = lambda: User(id=2, username="viewer", role=UserRole.VIEWER, password_hash="x", is_active=True)
                assert client.get("/api/v1/admin/settings/app").json()["idle_timeout_minutes"] == minutes
                assert client.put("/api/v1/admin/settings", json={"idle_timeout_minutes": 0}).status_code == 403
                app.dependency_overrides[get_current_user] = lambda: User(id=1, username="admin", role=UserRole.SUPER_ADMIN, password_hash="x", is_active=True)
    finally:
        engine.dispose()

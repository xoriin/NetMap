import sqlite3

from sqlalchemy import create_engine

from app.core import secrets
from app.db.session import Base
from app.models import alert_rule, auth_session, audit_log, device, dhcp_lease, discovery, ip_reservation, monitor_history, password_reset_token, port_target, relationship, site, snmp_profile, subnet, system_setting, topology_group, topology_layout, user, user_device_favourite  # noqa: F401
from app.services.exports import service as export_service


def test_backup_database_bytes_uses_active_sqlite_engine(tmp_path, monkeypatch):
    db_path = tmp_path / "netmap.db"
    test_engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=test_engine)

    monkeypatch.setattr(export_service, "engine", test_engine)
    monkeypatch.setattr(secrets, "signing_secret", lambda: "test-secret")

    filename, payload = export_service.backup_database_bytes()
    db_bytes = export_service._verify_and_strip_backup(payload, "test-secret")

    assert filename.startswith("netmap-backup-")
    assert db_bytes.startswith(b"SQLite format 3\x00")

    restored_path = tmp_path / "restored.db"
    restored_path.write_bytes(db_bytes)
    export_service._validate_backup_schema(restored_path)
    with sqlite3.connect(restored_path) as conn:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    assert {"users", "system_settings", "devices", "device_relationships"}.issubset(tables)

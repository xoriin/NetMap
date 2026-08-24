from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.admin import SystemSettingsRead, SystemSettingsUpdate
from app.services.exports import backup_schedule


def _touch_backup(directory, name: str, *, age_seconds: float = 0) -> None:
    path = directory / name
    path.write_bytes(b"SQLite format 3\x00fake")
    if age_seconds:
        import os
        stamp = (datetime.now(timezone.utc) - timedelta(seconds=age_seconds)).timestamp()
        os.utime(path, (stamp, stamp))


def test_scheduled_backup_dir_created_under_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    directory = backup_schedule.scheduled_backup_dir()
    assert directory == tmp_path / "backups"
    assert directory.is_dir()


def test_list_scheduled_backups_sorted_newest_first(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    directory = backup_schedule.scheduled_backup_dir()
    _touch_backup(directory, "netmap-backup-old.db", age_seconds=3600)
    _touch_backup(directory, "netmap-backup-new.db", age_seconds=0)

    listed = backup_schedule.list_scheduled_backups()
    assert [entry["filename"] for entry in listed] == ["netmap-backup-new.db", "netmap-backup-old.db"]
    assert listed[0]["size_bytes"] > 0


def test_prune_scheduled_backups_keeps_newest_n(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    directory = backup_schedule.scheduled_backup_dir()
    for i in range(5):
        _touch_backup(directory, f"netmap-backup-{i}.db", age_seconds=i * 60)

    deleted = backup_schedule.prune_scheduled_backups(2)
    remaining = {entry["filename"] for entry in backup_schedule.list_scheduled_backups()}
    assert remaining == {"netmap-backup-0.db", "netmap-backup-1.db"}
    assert set(deleted) == {"netmap-backup-2.db", "netmap-backup-3.db", "netmap-backup-4.db"}


def test_backup_filename_path_rejects_traversal_and_missing_files(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    directory = backup_schedule.scheduled_backup_dir()
    _touch_backup(directory, "netmap-backup-ok.db")

    assert backup_schedule.backup_filename_path("../netmap-backup-ok.db") is None
    assert backup_schedule.backup_filename_path("../../etc/passwd") is None
    assert backup_schedule.backup_filename_path("nonexistent.db") is None
    resolved = backup_schedule.backup_filename_path("netmap-backup-ok.db")
    assert resolved is not None
    assert resolved.name == "netmap-backup-ok.db"


def test_backup_filename_path_ignores_unmanaged_files_and_symlinks(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    directory = backup_schedule.scheduled_backup_dir()
    unmanaged = directory / "notes.db"
    unmanaged.write_bytes(b"not a scheduled backup")
    outside = tmp_path / "outside.db"
    outside.write_bytes(b"SQLite format 3\x00outside")
    (directory / "netmap-backup-link.db").symlink_to(outside)

    assert backup_schedule.backup_filename_path(unmanaged.name) is None
    assert backup_schedule.backup_filename_path("netmap-backup-link.db") is None
    assert backup_schedule.list_scheduled_backups() == []


def test_check_skips_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    service = backup_schedule.BackupScheduleService()
    monkeypatch.setattr(service, "_load_settings", lambda db: (False, 24, 7))
    monkeypatch.setattr(service, "_run_backup", lambda retention_count: (_ for _ in ()).throw(AssertionError("should not run")))
    service._check()  # should not raise — disabled means no-op


def test_check_runs_backup_when_due_and_skips_when_not(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    service = backup_schedule.BackupScheduleService()
    monkeypatch.setattr(service, "_load_settings", lambda db: (True, 24, 7))

    calls = []
    monkeypatch.setattr(service, "_run_backup", lambda retention_count: calls.append(retention_count))

    service._check()
    assert calls == [7]

    # ran again immediately — within the 24h interval, should not run again
    service._check()
    assert calls == [7]

    # simulate the interval having elapsed
    service._last_run_at = datetime.now(timezone.utc) - timedelta(hours=25)
    service._check()
    assert calls == [7, 7]


def test_backup_schedule_settings_defaults_and_validation():
    parsed = SystemSettingsRead(app_name="NetMap", login_message="", announcement="")
    assert parsed.backup_schedule_enabled is False
    assert parsed.backup_schedule_interval_hours == 24
    assert parsed.backup_retention_count == 7

    update = SystemSettingsUpdate(backup_schedule_enabled=True, backup_schedule_interval_hours=12, backup_retention_count=30)
    assert update.backup_schedule_interval_hours == 12

    with pytest.raises(ValidationError):
        SystemSettingsUpdate(backup_schedule_interval_hours=0)
    with pytest.raises(ValidationError):
        SystemSettingsUpdate(backup_retention_count=91)

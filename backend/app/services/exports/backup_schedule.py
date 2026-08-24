from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import settings
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

CHECK_INTERVAL_SECONDS = 3600
DEFAULT_INTERVAL_HOURS = 24
DEFAULT_RETENTION_COUNT = 7
BACKUP_GLOB = "netmap-backup-*.db"


def scheduled_backup_dir() -> Path:
    path = Path(settings.data_dir) / "backups"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _existing_backups() -> list[Path]:
    directory = scheduled_backup_dir().resolve()
    backups: list[Path] = []
    for candidate in directory.glob(BACKUP_GLOB):
        # Scheduled backups are regular files created in this directory. Ignore
        # symlinks and anything that no longer resolves beneath the fixed root.
        if candidate.is_symlink():
            continue
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(directory)
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            backups.append(resolved)
    return sorted(backups, key=lambda path: path.stat().st_mtime, reverse=True)


def list_scheduled_backups() -> list[dict]:
    return [
        {
            "filename": f.name,
            "size_bytes": f.stat().st_size,
            "created_at": datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc),
        }
        for f in _existing_backups()
    ]


def prune_scheduled_backups(retention_count: int) -> list[str]:
    """Delete the oldest scheduled backups beyond retention_count. Returns deleted filenames."""
    deleted = []
    for stale in _existing_backups()[max(retention_count, 0):]:
        stale.unlink(missing_ok=True)
        deleted.append(stale.name)
    return deleted


def backup_filename_path(filename: str) -> Path | None:
    """Return a known scheduled backup without constructing a path from request data."""
    return next((candidate for candidate in _existing_backups() if candidate.name == filename), None)


class BackupScheduleService:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._last_run_at: datetime | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="backup-schedule", daemon=True)
        self._thread.start()
        logger.info("Backup schedule service started")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)

    @staticmethod
    def _load_settings(db) -> tuple[bool, int, int]:  # type: ignore[no-untyped-def]
        from app.api.v1.admin import load_settings
        from app.schemas.admin import SystemSettingsRead

        parsed = SystemSettingsRead(**load_settings(db))
        return (
            parsed.backup_schedule_enabled,
            parsed.backup_schedule_interval_hours,
            parsed.backup_retention_count,
        )

    def _run(self) -> None:
        if self._stop.wait(60):
            return
        while True:
            try:
                self._check()
            except Exception:
                logger.exception("Scheduled backup check failed")
            if self._stop.wait(CHECK_INTERVAL_SECONDS):
                break

    def _check(self) -> None:
        with SessionLocal() as db:
            enabled, interval_hours, retention_count = self._load_settings(db)
        if not enabled:
            return
        if self._last_run_at is None:
            self._last_run_at = self._latest_existing_backup_time()
        now = datetime.now(timezone.utc)
        if self._last_run_at is not None and (now - self._last_run_at).total_seconds() < interval_hours * 3600:
            return
        self._run_backup(retention_count)
        self._last_run_at = now

    @staticmethod
    def _latest_existing_backup_time() -> datetime | None:
        existing = _existing_backups()
        if not existing:
            return None
        return datetime.fromtimestamp(existing[0].stat().st_mtime, tz=timezone.utc)

    @staticmethod
    def _run_backup(retention_count: int) -> None:
        from app.services.exports.service import backup_database_bytes

        filename, payload = backup_database_bytes()
        (scheduled_backup_dir() / filename).write_bytes(payload)
        logger.info("Scheduled backup written: %s", filename)
        prune_scheduled_backups(retention_count)


backup_schedule_service = BackupScheduleService()

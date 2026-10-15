from __future__ import annotations

import logging
import json
import re
import uuid
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
    path = Path(settings.backup_dir) if settings.backup_dir else Path(settings.data_dir) / "backups"
    if not path.is_absolute():
        raise ValueError("BACKUP_DIR must be an absolute container path")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _existing_backups() -> list[Path]:
    directories = {scheduled_backup_dir().resolve(), (Path(settings.data_dir) / "backups").resolve()}
    backups: list[Path] = []
    for directory in directories:
        # Custom filenames are managed explicitly; never glob arbitrary .db files.
        manifest = directory / ".netmap-backups.json"
        names = []
        if manifest.is_file() and not manifest.is_symlink():
            names = json.loads(manifest.read_text())
        candidates = set(directory.glob(BACKUP_GLOB))
        for name in names:
            if isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_-]+\.db", name):
                candidates.add(directory / name)
        for candidate in candidates:
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

        from app.api.v1.admin import load_settings
        from app.schemas.admin import SystemSettingsRead, SystemSettingsUpdate

        with SessionLocal() as db:
            config = SystemSettingsRead(**load_settings(db))
        # Revalidate stored naming settings before using them as a filename.
        naming = SystemSettingsUpdate(backup_filename_prefix=config.backup_filename_prefix, backup_date_format=config.backup_date_format)
        formats = {"yyyy-MM-dd": "%Y-%m-%d", "MM-dd-yyyy": "%m-%d-%Y", "dd-MM-yyyy": "%d-%m-%Y"}
        stamp = datetime.now(timezone.utc).strftime(formats[naming.backup_date_format] + "-%H%M%S")
        filename = f"{naming.backup_filename_prefix}-{stamp}-{uuid.uuid4().hex[:12]}.db"
        _, payload = backup_database_bytes()
        directory = scheduled_backup_dir()
        manifest = directory / ".netmap-backups.json"
        if manifest.is_symlink():
            raise ValueError("Backup manifest must not be a symlink")
        names = json.loads(manifest.read_text()) if manifest.exists() else []
        # Write via an exclusive temporary file, then atomically publish.
        temporary = directory / f".{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("xb") as output:
                output.write(payload)
            temporary.replace(directory / filename)
            names = [name for name in names if isinstance(name, str) and (directory / name).name == name and (directory / name).is_file()]
            names.append(filename)
            with temporary.open("x") as output:
                json.dump(names, output)
            temporary.replace(manifest)
        finally:
            temporary.unlink(missing_ok=True)
        logger.info("Scheduled backup written: %s", filename)
        prune_scheduled_backups(retention_count)


backup_schedule_service = BackupScheduleService()

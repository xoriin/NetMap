from __future__ import annotations

import logging
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_diagnostics_view
from app.core.config import installed_app_channel, installed_app_version, settings
from app.db.session import get_db
from app.models.device import Device
from app.models.monitor_history import DeviceMonitorHistory
from app.models.user import User
from app.api.v1.monitoring import monitoring_cache_status
from app.services.changelog import changelog_for_installed_version, changelog_release_to_dict
from app.services.syslog.storage import count_events, get_retention_status

router = APIRouter(prefix="/system", tags=["system"])
logger = logging.getLogger(__name__)

_GITHUB_REPO = "xoriin/netmap"
_CACHE_TTL = 3600  # 1 hour

_cached_latest: str | None = None
_cached_at: float = 0.0


def _fetch_latest_version() -> str | None:
    global _cached_latest, _cached_at
    now = time.monotonic()
    if _cached_latest is not None and (now - _cached_at) < _CACHE_TTL:
        return _cached_latest
    try:
        import json
        url = f"https://api.github.com/repos/{_GITHUB_REPO}/tags?per_page=10"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": f"netmap/{installed_app_version(settings.app_version)}"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            tags = json.loads(resp.read())
        for entry in tags:
            tag = entry.get("name", "")
            version = tag.lstrip("v")
            if re.fullmatch(r"\d+\.\d+\.\d+", version):
                _cached_latest = version
                _cached_at = now
                return version
    except Exception:
        logger.debug("Could not fetch latest tag from GitHub", exc_info=True)
    return None


def _version_tuple(version: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", version.strip())
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


@router.get("/version")
def get_version() -> dict:
    current = installed_app_version(settings.app_version).lstrip("v")
    latest = _fetch_latest_version()
    current_tuple = _version_tuple(current)
    latest_tuple = _version_tuple(latest) if latest else None
    up_to_date = latest_tuple is None or (current_tuple is not None and current_tuple >= latest_tuple)
    whats_new = [
        changelog_release_to_dict(release)
        for release in changelog_for_installed_version(
            current,
            user_agent=f"netmap/{current}",
        )
    ]
    return {
        "current": current,
        "channel": installed_app_channel(),
        "latest": latest,
        "up_to_date": up_to_date,
        "release_url": f"https://github.com/{_GITHUB_REPO}/releases/tag/v{latest}" if latest else f"https://github.com/{_GITHUB_REPO}",
        "current_release_url": f"https://github.com/{_GITHUB_REPO}/releases/tag/v{current}",
        "whats_new": whats_new,
    }


@router.get("/diagnostics")
def get_diagnostics(
    _current_user: Annotated[User, Depends(require_diagnostics_view)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    retention = get_retention_status()
    data_dir = Path(settings.data_dir)
    last_monitor_check = db.scalar(select(func.max(DeviceMonitorHistory.checked_at)))
    device_status_rows = db.execute(
        select(Device.monitor_status, func.count())
        .where(Device.status != "disabled")
        .group_by(Device.monitor_status)
    ).all()
    return {
        "generated_at": datetime.now(timezone.utc),
        "database": {
            "main": _sqlite_file_sizes(data_dir / "netmap.db"),
            "firewall": _sqlite_file_sizes(data_dir / "firewall.db"),
        },
        "monitoring": {
            "last_checked_at": last_monitor_check,
            "device_status_counts": {status or "unknown": int(count or 0) for status, count in device_status_rows},
            "cache": monitoring_cache_status(),
        },
        "syslog": {
            "total_events": count_events(),
            "retention_last_run_at": retention.last_run_at,
            "retention_last_deleted": retention.last_deleted,
            "retention_last_error": retention.last_error,
            "last_event_received_at": retention.last_event_received_at,
        },
        "process": {
            "pid": os.getpid(),
        },
    }


def _sqlite_file_sizes(db_path: Path) -> dict[str, int | bool]:
    db_size = _file_size(db_path)
    wal_size = _file_size(Path(f"{db_path}-wal"))
    shm_size = _file_size(Path(f"{db_path}-shm"))
    return {
        "exists": db_path.exists(),
        "bytes": db_size,
        "wal_bytes": wal_size,
        "shm_bytes": shm_size,
        "total_bytes": db_size + wal_size + shm_size,
    }


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except FileNotFoundError:
        return 0

"""Manual discovery scans run one at a time on a background worker; the API returns once a scan is queued."""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.discovery import DiscoveryScan
from app.services.discovery.scheduled import DiscoveryScanJob, run_discovery_scan

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = ("queued", "running")
PROGRESS_WRITE_INTERVAL_SECONDS = 1.0

start_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="manual-discovery")


def active_manual_scan_id(db: Session) -> int | None:
    return db.scalar(
        select(DiscoveryScan.id)
        .where(DiscoveryScan.schedule_id.is_(None), DiscoveryScan.status.in_(ACTIVE_STATUSES))
        .order_by(DiscoveryScan.id)
        .limit(1)
    )


def submit(job: DiscoveryScanJob) -> None:
    _executor.submit(run_manual_scan, job)


class _ProgressWriter:
    def __init__(self, scan_id: int) -> None:
        self.scan_id = scan_id
        self.last_write = 0.0

    def __call__(self, done: int) -> None:
        now = time.monotonic()
        if now - self.last_write < PROGRESS_WRITE_INTERVAL_SECONDS:
            return
        self.last_write = now
        try:
            with SessionLocal() as db:
                db.execute(
                    update(DiscoveryScan)
                    .where(DiscoveryScan.id == self.scan_id, DiscoveryScan.status == "running")
                    .values(progress_done=done)
                )
                db.commit()
        except Exception:
            logger.exception("Could not record progress for discovery scan %s", self.scan_id)


def run_manual_scan(job: DiscoveryScanJob) -> None:
    try:
        with SessionLocal() as db:
            scan = db.get(DiscoveryScan, job.scan_id)
            if scan is None or scan.status != "queued":
                return
            scan.status = "running"
            scan.started_at = datetime.now(timezone.utc)
            db.commit()
            run_discovery_scan(db, job, on_progress=_ProgressWriter(job.scan_id))
    except Exception as exc:
        logger.exception("Manual discovery scan %s failed", job.scan_id)
        with SessionLocal() as db:
            scan = db.get(DiscoveryScan, job.scan_id)
            if scan is not None and scan.status in ACTIVE_STATUSES:
                scan.status = "failed"
                scan.error = str(exc) or "Scan failed"
                scan.completed_at = datetime.now(timezone.utc)
                db.commit()

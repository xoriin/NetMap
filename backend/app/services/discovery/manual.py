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
from app.services.audit.service import write_audit
from app.services.discovery.scheduled import SCAN_CANCELLED_MESSAGE, DiscoveryScanJob, run_discovery_scan

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = ("queued", "running")
PROGRESS_WRITE_INTERVAL_SECONDS = 1.0

start_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="manual-discovery")
_cancel_events: dict[int, threading.Event] = {}
_cancel_events_lock = threading.Lock()


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
    cancel_event = threading.Event()
    with _cancel_events_lock:
        _cancel_events[job.scan_id] = cancel_event
    try:
        with SessionLocal() as db:
            started = db.execute(
                update(DiscoveryScan)
                .where(DiscoveryScan.id == job.scan_id, DiscoveryScan.status == "queued")
                .values(status="running", started_at=datetime.now(timezone.utc))
            )
            db.commit()
            if started.rowcount == 0:
                return
            run_discovery_scan(db, job, on_progress=_ProgressWriter(job.scan_id), cancel_event=cancel_event)
    except Exception as exc:
        logger.exception("Manual discovery scan %s failed", job.scan_id)
        with SessionLocal() as db:
            scan = db.get(DiscoveryScan, job.scan_id)
            if scan is not None and scan.status in ACTIVE_STATUSES:
                scan.status = "failed"
                scan.error = str(exc) or "Scan failed"
                scan.completed_at = datetime.now(timezone.utc)
                db.commit()
    finally:
        with _cancel_events_lock:
            _cancel_events.pop(job.scan_id, None)


def cancel_manual_scan(db: Session, scan_id: int, actor_user_id: int) -> None:
    """A queued scan is cancelled at once; a running one stops its nmap process
    and the worker records it as cancelled."""
    if _mark_cancelled(db, scan_id, "queued", actor_user_id):
        return
    with _cancel_events_lock:
        cancel_event = _cancel_events.get(scan_id)
        if cancel_event is not None:
            cancel_event.set()
    if cancel_event is not None:
        write_audit(db, action="discovery.scan_cancelled", actor_user_id=actor_user_id, target=f"scan:{scan_id}")
        db.commit()
        return
    # Running here but no worker owns it (left over from a restart).
    _mark_cancelled(db, scan_id, "running", actor_user_id)


def _mark_cancelled(db: Session, scan_id: int, from_status: str, actor_user_id: int) -> bool:
    result = db.execute(
        update(DiscoveryScan)
        .where(DiscoveryScan.id == scan_id, DiscoveryScan.status == from_status)
        .values(status="cancelled", error=SCAN_CANCELLED_MESSAGE, completed_at=datetime.now(timezone.utc))
    )
    if result.rowcount:
        write_audit(db, action="discovery.scan_cancelled", actor_user_id=actor_user_id, target=f"scan:{scan_id}")
    db.commit()
    return bool(result.rowcount)

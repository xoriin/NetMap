from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.status_page import StatusPage, StatusPageItem
from app.services.status_pages import evaluator, retention, worker_lock
from app.services.status_pages.aggregates import BuildCycle, SourceHistory
from app.services.status_pages.projection import load_page, project_page
from app.services.status_pages.sources import SourceRef

logger = logging.getLogger(__name__)

TIMER_SECONDS = 15
REFRESH_LEAD = timedelta(seconds=2)
MIN_TIMER_WAIT = 0.05
JOIN_TIMEOUT = 10
PRUNE_INTERVAL = timedelta(hours=24)
CYCLE_MAX_AGE = timedelta(seconds=5)

_ITEM_SOURCE = (
    StatusPageItem.page_id, StatusPageItem.kind, StatusPageItem.device_id,
    StatusPageItem.monitor_id, StatusPageItem.port_target_id,
)


@dataclass(frozen=True)
class RegistryEntry:
    page_id: int
    slug: str
    visibility: str
    generation: int


@dataclass(frozen=True)
class Snapshot:
    body: bytes
    etag: str
    generated_at: datetime
    valid_until: datetime
    generation: int


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _etag(audience: str, generation: int, body: bytes) -> str:
    return '"' + hashlib.sha256(f"{audience}{generation}".encode() + body).hexdigest()[:32] + '"'


def _source_key(row) -> str:
    return SourceRef(row.kind, row.device_id, row.monitor_id, row.port_target_id).key


class StatusSnapshotCache:
    """Each page is cached for its own audience only: public pages get a public snapshot, private pages a private one."""

    def __init__(self) -> None:
        self._lock = threading.Condition()
        self._by_id: dict[int, RegistryEntry] = {}
        self._by_slug: dict[str, RegistryEntry] = {}
        self._floor: dict[int, int] = {}
        self._snapshots: dict[tuple[int, str], Snapshot] = {}
        self._sources: dict[str, set[int]] = defaultdict(set)
        self._page_sources: dict[int, set[str]] = {}
        self._queue: dict[int, None] = {}
        self._checked: dict[SourceRef, None] = {}
        self._building: set[int] = set()
        self._dirty: set[int] = set()
        self._retry_at: dict[int, datetime] = {}
        self._threads: list[threading.Thread] = []
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._locked = False
        self._last_prune: datetime | None = None
        self.history = SourceHistory()
        self.ready = False

    def start(self, data_dir: str | None = None, timer: bool = True) -> None:
        if self._threads:
            return
        path = data_dir or settings.data_dir
        if not worker_lock.acquire(path):
            logger.warning(
                "Status pages are disabled in this process: could not take the single-worker lock %s "
                "(another NetMap worker holds it, or DATA_DIR is not writable). Status page reads return 503.",
                worker_lock.lock_path(path),
            )
            return
        self._locked = True
        try:
            self.load_registry()
        except Exception:
            logger.exception("Could not load the status page registry; status pages stay unavailable")
            self._release_lock()
            return
        self._stop.clear()
        self._spawn("status-pages-builder", self._run_builder)
        if timer:
            self._spawn("status-pages-timer", self._run_timer)

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            self.ready = False
            self._lock.notify_all()
        self._wake.set()
        for thread in self._threads:
            thread.join(JOIN_TIMEOUT)
        self._threads = []
        self._release_lock()

    def load_registry(self) -> None:
        with SessionLocal() as db:
            pages = db.execute(
                select(StatusPage.id, StatusPage.slug, StatusPage.visibility, StatusPage.generation)
            ).all()
            items = db.execute(select(*_ITEM_SOURCE)).all()
        sources: dict[int, set[str]] = defaultdict(set)
        for row in items:
            sources[row.page_id].add(_source_key(row))
        with self._lock:
            entries = [RegistryEntry(*row) for row in pages]
            self._by_id = {e.page_id: e for e in entries if e.generation >= self._floor.get(e.page_id, 0)}
            self._by_slug = {e.slug: e for e in self._by_id.values()}
            self._snapshots = {
                key: snap for key, snap in self._snapshots.items()
                if (entry := self._by_id.get(key[0])) is not None and entry.generation == snap.generation
            }
            self._sources = defaultdict(set)
            self._page_sources = {}
            for page_id in self._by_id:
                self._set_sources(page_id, sources.get(page_id, set()))
                self._enqueue(page_id, dirty=False)
            self.ready = True
            self._lock.notify_all()

    def lookup(self, slug: str) -> RegistryEntry | None:
        with self._lock:
            return self._by_slug.get(slug)

    def get(self, page_id: int, audience: str, now: datetime) -> Snapshot | None:
        with self._lock:
            entry = self._by_id.get(page_id)
            snap = self._snapshots.get((page_id, audience))
        if entry is None or snap is None or entry.visibility != audience or snap.generation != entry.generation:
            return None
        return snap if now < snap.valid_until else None

    def register_page(self, entry: RegistryEntry) -> None:
        with self._lock:
            self._drop(entry.page_id)
            self._floor[entry.page_id] = entry.generation
            self._register(entry)

    def remove_page_sync(self, page_id: int, replacement: RegistryEntry | None = None) -> None:
        with self._lock:
            floor = self._floor.get(page_id, 0)
            if replacement is not None and replacement.generation < floor:
                return
            sources = self._page_sources.get(page_id, set())
            old = self._drop(page_id)
            if replacement is not None:
                self._floor[page_id] = replacement.generation
                self._register(replacement)
                self._set_sources(page_id, sources)
            elif old is not None:
                self._floor[page_id] = max(floor, old.generation + 1)
            self._lock.notify_all()

    def request_build(self, page_id: int) -> None:
        with self._lock:
            if self.ready:
                self._enqueue(page_id, dirty=False)

    def invalidate_pages(self, page_ids: Iterable[int]) -> None:
        with self._lock:
            if not self.ready:
                return
            for page_id in set(page_ids):
                self._retry_at.pop(page_id, None)
                self._enqueue(page_id, dirty=True)

    def invalidate_sources(self, keys: Iterable[str]) -> None:
        with self._lock:
            if not self.ready:
                return
            pages = set().union(*(self._sources.get(key, ()) for key in set(keys)))
            for page_id in pages:
                self._enqueue(page_id, dirty=True)

    def sources_checked(self, refs: Iterable[SourceRef]) -> None:
        with self._lock:
            if not self.ready:
                return
            for ref in refs:
                pages = self._sources.get(ref.key, ())
                if not pages:
                    continue
                self._checked[ref] = None
                for page_id in pages:
                    self._enqueue(page_id, dirty=True)

    def pending(self) -> list[int]:
        with self._lock:
            return list(self._queue)

    def wait_idle(self, timeout: float) -> bool:
        with self._lock:
            return self._lock.wait_for(lambda: not self._queue and not self._building, timeout)

    def build_now(self, page_id: int, now: datetime | None = None) -> bool:
        with self._lock:
            self._queue.pop(page_id, None)
        return self._build(page_id, now or _now(), self.history.cycle())

    def drain(self, now: datetime | None = None) -> None:
        while batch := self._take(block=False):
            try:
                self._run_batch(batch, now)
            finally:
                self._finish(batch)

    def run_timer_once(self, now: datetime | None = None) -> list[int]:
        now = now or _now()
        with self._lock:
            if not self.ready:
                return []
            due = []
            for page_id, entry in self._by_id.items():
                retry = self._retry_at.get(page_id)
                if retry is not None and retry > now:
                    continue
                snap = self._snapshots.get((page_id, entry.visibility))
                if snap is None or self._due_at(snap) <= now:
                    due.append(page_id)
            for page_id in due:
                self._enqueue(page_id, dirty=False)
            return due

    def maybe_prune(self, now: datetime) -> None:
        if self._last_prune is not None and now - self._last_prune < PRUNE_INTERVAL:
            return
        self._last_prune = now
        try:
            retention.prune(SessionLocal, now)
        except Exception:
            logger.exception("Status page retention prune failed")

    def timer_delay(self, now: datetime) -> float:
        with self._lock:
            times = []
            for page_id, entry in self._by_id.items():
                if page_id in self._queue or page_id in self._building:
                    continue
                retry = self._retry_at.get(page_id)
                if retry is not None and retry > now:
                    times.append(retry)
                elif (snap := self._snapshots.get((page_id, entry.visibility))) is not None:
                    times.append(self._due_at(snap))
        seconds = min(((t - now).total_seconds() for t in times), default=TIMER_SECONDS)
        return min(TIMER_SECONDS, max(MIN_TIMER_WAIT, seconds))

    @staticmethod
    def _due_at(snap: Snapshot) -> datetime:
        early = snap.valid_until - REFRESH_LEAD
        return early if snap.generated_at < early else snap.valid_until

    def _register(self, entry: RegistryEntry) -> None:
        self._by_id[entry.page_id] = entry
        self._by_slug[entry.slug] = entry

    def _drop(self, page_id: int) -> RegistryEntry | None:
        entry = self._by_id.pop(page_id, None)
        if entry is not None and self._by_slug.get(entry.slug) == entry:
            del self._by_slug[entry.slug]
        for audience in ("public", "private"):
            self._snapshots.pop((page_id, audience), None)
        self._set_sources(page_id, set())
        self._queue.pop(page_id, None)
        self._dirty.discard(page_id)
        self._retry_at.pop(page_id, None)
        return entry

    def _set_sources(self, page_id: int, keys: set[str]) -> None:
        for key in self._page_sources.pop(page_id, set()):
            self._sources[key].discard(page_id)
            if not self._sources[key]:
                del self._sources[key]
        if keys:
            self._page_sources[page_id] = set(keys)
            for key in keys:
                self._sources[key].add(page_id)

    def _enqueue(self, page_id: int, dirty: bool) -> None:
        if page_id not in self._by_id:
            return
        if page_id in self._building:
            if dirty:
                self._dirty.add(page_id)
            return
        if page_id not in self._queue:
            self._queue[page_id] = None
            self._lock.notify_all()

    def _take(self, block: bool) -> list[int]:
        with self._lock:
            while not self._queue:
                if not block or self._stop.is_set():
                    return []
                self._lock.wait()
            if block and self._stop.is_set():
                return []
            batch, self._queue = list(self._queue), {}
            self._building = set(batch)
            return batch

    def _finish(self, batch: list[int]) -> None:
        with self._lock:
            self._building = set()
            for page_id in batch:
                if page_id in self._dirty:
                    self._dirty.discard(page_id)
                    self._enqueue(page_id, dirty=False)
            self._lock.notify_all()

    def _run_batch(self, batch: list[int], now: datetime | None = None) -> None:
        """One build cycle: every page in the batch shares the cycle's source states and history."""
        at = now or _now()
        self._evaluate_checked(at, set(batch))
        cycle = self.history.cycle()
        for page_id in batch:
            if now is None and _now() - at > CYCLE_MAX_AGE:
                at, cycle = _now(), self.history.cycle()
            self._build(page_id, at, cycle)

    def _build(self, page_id: int, now: datetime, cycle: BuildCycle) -> bool:
        with self._lock:
            entry = self._by_id.get(page_id)
        if entry is None:
            return False
        try:
            with SessionLocal() as db:
                page = db.get(StatusPage, page_id)
                if page is None or (page.slug, page.visibility, page.generation) != (
                    entry.slug, entry.visibility, entry.generation,
                ):
                    inputs = None
                else:
                    inputs = load_page(db, page, now, cycle)
                    keys = {_source_key(row) for row in db.execute(
                        select(*_ITEM_SOURCE).where(StatusPageItem.page_id == page_id)
                    )}
            if inputs is None:
                self._retry_later(entry, now)
                return False
            payload = project_page(inputs, entry.visibility, cycle)
            body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
            snapshot = Snapshot(
                body=body,
                etag=_etag(entry.visibility, entry.generation, body),
                generated_at=datetime.fromisoformat(payload["generated_at"]),
                valid_until=datetime.fromisoformat(payload["valid_until"]),
                generation=entry.generation,
            )
        except Exception:
            logger.exception("Status page %d snapshot build failed", page_id)
            self._retry_later(entry, now)
            return False
        with self._lock:
            if self._by_id.get(page_id) != entry:
                return False
            self._snapshots[(page_id, entry.visibility)] = snapshot
            self._set_sources(page_id, keys)
            self._retry_at.pop(page_id, None)
        self._wake.set()
        return True

    def _retry_later(self, entry: RegistryEntry, now: datetime) -> None:
        with self._lock:
            if self._by_id.get(entry.page_id) == entry:
                self._retry_at[entry.page_id] = now + timedelta(seconds=TIMER_SECONDS)

    def _evaluate_checked(self, now: datetime, building: set[int]) -> None:
        with self._lock:
            refs, self._checked = list(self._checked), {}
        if not refs:
            return
        try:
            with SessionLocal() as db:
                affected = evaluator.evaluate(db, refs, now)
        except Exception:
            logger.exception("Status page incident evaluation failed")
            return
        self.invalidate_pages(affected - building)

    def _run_builder(self) -> None:
        while batch := self._take(block=True):
            try:
                self._run_batch(batch)
            finally:
                self._finish(batch)

    def _run_timer(self) -> None:
        while not self._stop.is_set():
            self._wake.clear()
            now = _now()
            try:
                self.run_timer_once(now)
                self.maybe_prune(now)
                delay = self.timer_delay(now)
            except Exception:
                logger.exception("Status page timer run failed")
                delay = TIMER_SECONDS
            self._wake.wait(delay)

    def _spawn(self, name: str, target) -> None:
        thread = threading.Thread(target=target, name=name, daemon=True)
        self._threads.append(thread)
        thread.start()

    def _release_lock(self) -> None:
        if self._locked:
            worker_lock.release()
            self._locked = False


status_cache = StatusSnapshotCache()

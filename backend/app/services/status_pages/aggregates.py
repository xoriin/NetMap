from __future__ import annotations

import logging
import threading
import time
import zlib
from collections.abc import Callable, Hashable, Iterable
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.services.status_pages.history import (
    Availability,
    RawHistory,
    Sample,
    SampleConverter,
    fetch_history,
    period_availability,
)
from app.services.status_pages.sources import CurrentState, SourceRef, load_current_states, threshold_breaching_sources

LONG_REFRESH = timedelta(minutes=5)
LONG_JITTER = timedelta(seconds=60)
LONG_HARD_CAP = timedelta(minutes=15)
LONG_IDLE = timedelta(minutes=30)
LONG_RETRY = timedelta(minutes=1)
FIRST_BUILD_SOURCES_PER_CYCLE = 4
FIRST_BUILD_SECONDS_PER_CYCLE = 0.25
REFRESHER_IDLE_SECONDS = 5.0
REFRESHER_PAUSE_SECONDS = 0.01
PENDING = Availability(None, 0.0, "no_data")

LongKey = tuple[str, str, int, tuple[tuple[datetime, datetime], ...]]

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LongEntry:
    value: Availability
    computed_at: datetime
    refresh_at: datetime

    def stale(self, now: datetime) -> bool:
        return now >= self.refresh_at

    def overdue(self, now: datetime) -> bool:
        return now - self.computed_at >= LONG_HARD_CAP


@dataclass
class _Job:
    ref: SourceRef
    length: timedelta
    used_at: datetime
    due_at: datetime


def _shown(value: Availability | None):
    if value is None:
        return None
    rounded = None if value.percent is None else round(value.percent, 4)
    return rounded, value.label, round(value.coverage, 4)


def compute_long(fetch: Callable[..., RawHistory], ref: SourceRef, key: LongKey, length: timedelta, now: datetime) -> Availability:
    since = now - length
    raw = fetch([ref], since, now)
    return period_availability(SampleConverter(raw).points(ref), since, now, key[2], list(key[3]))


class SourceHistory:
    """Source aggregates shared by every page.

    Long-period availability is stale-while-revalidate: builds always serve the cached value (flagged once older
    than LONG_HARD_CAP) and a background refresher recomputes due values oldest first. Only a value never computed
    is worked out inline, a few per build cycle.
    """

    def __init__(self, seed: int = 0, on_change: Callable[[str], None] | None = None) -> None:
        self._lock = threading.Lock()
        self._long: dict[LongKey, LongEntry] = {}
        self._jobs: dict[LongKey, _Job] = {}
        self.seed = seed
        self.generation = 0
        self.on_change = on_change
        self.wake = threading.Event()
        self._warned_at: datetime | None = None

    def cycle(self, sessions: Callable[[], Session] | None = None, capped: bool = False, budget: InlineBudget | None = None) -> BuildCycle:
        return BuildCycle(self, sessions, capped, budget)

    def clear(self) -> None:
        with self._lock:
            self._long.clear()
            self._jobs.clear()
            self.generation += 1

    def jitter(self, key: LongKey) -> timedelta:
        spread = int(LONG_JITTER.total_seconds() * 1000)
        return timedelta(milliseconds=zlib.crc32(f"{self.seed}:{key[0]}:{key[1]}".encode()) % spread)

    def long(self, key: LongKey, now: datetime, ref: SourceRef | None = None, length: timedelta | None = None) -> LongEntry | None:
        """The cached value whatever its age; with `ref` the key is also kept on the refresher's list."""
        with self._lock:
            found = self._long.get(key)
            if ref is not None and length is not None:
                job = self._jobs.get(key)
                if job is None:
                    self._jobs[key] = _Job(ref, length, now, found.refresh_at if found else now)
                elif now > job.used_at:
                    job.used_at = now
        if found is None and ref is not None:
            self.wake.set()
        return found

    def store_long(self, key: LongKey, now: datetime, value: Availability, generation: int | None = None) -> bool:
        """Whether the stored value changed what a page shows."""
        entry = LongEntry(value, now, now + LONG_REFRESH + self.jitter(key))
        with self._lock:
            if generation is not None and generation != self.generation:
                return False
            old = self._long.get(key)
            if old is not None and old.computed_at > now:
                return False
            self._long[key] = entry
            if (job := self._jobs.get(key)) is not None:
                job.due_at = entry.refresh_at
        return old is None or _shown(old.value) != _shown(value)

    def backlog(self, now: datetime) -> list[LongKey]:
        """Due keys in refresh order: never-computed first, then oldest due time (which carries the jitter)."""
        with self._lock:
            for key in [k for k, job in self._jobs.items() if now - job.used_at > LONG_IDLE]:
                del self._jobs[key]
                self._long.pop(key, None)
            due = [(key not in self._long, job.due_at, key) for key, job in self._jobs.items() if job.due_at <= now]
        due.sort(key=lambda d: (not d[0], d[1]))
        return [key for _, _, key in due]

    def idle_delay(self, now: datetime) -> float:
        with self._lock:
            soonest = min((job.due_at for job in self._jobs.values()), default=None)
        if soonest is None:
            return REFRESHER_IDLE_SECONDS
        return min(REFRESHER_IDLE_SECONDS, max(REFRESHER_PAUSE_SECONDS, (soonest - now).total_seconds()))

    def refresh_once(self, now: datetime, sessions: Callable[[], Session]) -> bool:
        """Recompute the most overdue long-period value. Returns False when nothing is due."""
        due = self.backlog(now)
        if not due:
            return False
        self._warn_backlog(now, due)
        key = due[0]
        with self._lock:
            job, generation = self._jobs.get(key), self.generation
        if job is None:
            return True

        def fetch(refs, start, end):
            with sessions() as db:
                return fetch_history(db, refs, start, end, health_only=True)

        try:
            value = compute_long(fetch, job.ref, key, job.length, now)
        except Exception:
            with self._lock:
                if self._jobs.get(key) is job:
                    job.due_at = now + LONG_RETRY
            raise
        if self.store_long(key, now, value, generation) and self.on_change is not None:
            self.on_change(key[0])
        return True

    def _warn_backlog(self, now: datetime, due: list[LongKey]) -> None:
        with self._lock:
            oldest = self._jobs[due[0]].due_at if due[0] in self._jobs else now
            overdue = sum(1 for key in due if (e := self._long.get(key)) is not None and e.overdue(now))
            if now - oldest <= LONG_REFRESH or (self._warned_at is not None and now - self._warned_at < LONG_REFRESH):
                return
            self._warned_at = now
        logger.warning(
            "Status page long-period refresh is behind: %d values due, oldest due %ds ago, %d past the %d-minute cap",
            len(due), int((now - oldest).total_seconds()), overdue, int(LONG_HARD_CAP.total_seconds() // 60),
        )


@dataclass
class InlineBudget:
    keys: set = field(default_factory=set)
    seconds: float = 0.0


class BuildCycle:
    """One builder pass: current states, heartbeat-window history and computed spans are loaded once per source."""

    def __init__(
        self, shared: SourceHistory, sessions: Callable[[], Session] | None = None, capped: bool = False,
        budget: InlineBudget | None = None,
    ) -> None:
        self.shared = shared
        self.sessions = sessions
        self.capped = capped
        self.budget = budget if budget is not None else InlineBudget()
        self.generation = shared.generation
        self.rows = 0
        self.deferred: set[LongKey] = set()
        self.overdue: set[LongKey] = set()
        self._states: dict[tuple[SourceRef, datetime], CurrentState] = {}
        self._degraded: dict[tuple[SourceRef, datetime], bool] = {}
        self._raw: dict[tuple[datetime, datetime], RawHistory] = {}
        self._converters: dict[tuple[datetime, datetime], SampleConverter] = {}
        self._samples: dict[tuple[SourceRef, datetime, datetime], list[Sample]] = {}
        self._memo: dict[Hashable, object] = {}

    def states(self, db: Session, refs: Iterable[SourceRef], now: datetime) -> dict[SourceRef, CurrentState]:
        refs = set(refs)
        missing = [r for r in refs if (r, now) not in self._states]
        if missing:
            for ref, state in load_current_states(db, missing, now).items():
                self._states[(ref, now)] = state
        return {r: self._states[(r, now)] for r in refs}

    def degraded(self, db: Session, refs: Iterable[SourceRef], now: datetime) -> set[SourceRef]:
        refs = set(refs)
        missing = [r for r in refs if (r, now) not in self._degraded]
        if missing:
            breaching = threshold_breaching_sources(db, missing, now, self.states(db, missing, now))
            for ref in missing:
                self._degraded[(ref, now)] = ref in breaching
        return {r for r in refs if self._degraded[(r, now)]}

    def fetch(self, db: Session, refs: Iterable[SourceRef], start: datetime, end: datetime) -> None:
        raw = self._raw.get((start, end))
        before = raw.rows if raw is not None else 0
        raw = fetch_history(db, refs, start, end, raw=raw)
        self._raw[(start, end)] = raw
        self.rows += raw.rows - before

    def samples(self, ref: SourceRef, start: datetime, end: datetime) -> list[Sample]:
        key = (ref, start, end)
        if key not in self._samples:
            converter = self._converters.get((start, end))
            if converter is None:
                converter = self._converters[(start, end)] = SampleConverter(self._raw[(start, end)])
            self._samples[key] = converter.samples(ref)
        return self._samples[key]

    def claim_inline(self, key: LongKey) -> bool:
        """Whether this build may compute a never-computed long-period value itself instead of leaving it to the refresher."""
        budget = self.budget
        if not self.capped or key in budget.keys:
            return True
        if len(budget.keys) >= FIRST_BUILD_SOURCES_PER_CYCLE or budget.seconds >= FIRST_BUILD_SECONDS_PER_CYCLE:
            return False
        budget.keys.add(key)
        return True

    @contextmanager
    def timed(self):
        started = time.perf_counter()
        try:
            yield
        finally:
            self.budget.seconds += time.perf_counter() - started

    def fetch_long(self, refs: Iterable[SourceRef], start: datetime, end: datetime, db: Session | None = None) -> RawHistory:
        """One source's long-period rows, in a short session of its own when the cycle has a session factory."""
        if self.sessions is not None:
            with self.sessions() as own:
                raw = fetch_history(own, refs, start, end, health_only=True)
        else:
            raw = fetch_history(db, refs, start, end, health_only=True)
        self.rows += raw.rows
        return raw

    def memo(self, key: Hashable, compute: Callable[[], object]):
        if key not in self._memo:
            self._memo[key] = compute()
        return self._memo[key]

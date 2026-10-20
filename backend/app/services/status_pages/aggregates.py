from __future__ import annotations

import threading
import time
import zlib
from collections.abc import Callable, Hashable, Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.services.status_pages.history import Availability, RawHistory, Sample, SampleConverter, fetch_history
from app.services.status_pages.sources import CurrentState, SourceRef, load_current_states, threshold_breaching_sources

LONG_REFRESH = timedelta(minutes=5)
LONG_JITTER = timedelta(seconds=60)
LONG_HARD_CAP = timedelta(minutes=15)
REFRESH_SOURCES_PER_CYCLE = 4
REFRESH_SECONDS_PER_CYCLE = 0.25

LongKey = tuple[str, str, int, tuple[tuple[datetime, datetime], ...]]


@dataclass(frozen=True)
class LongEntry:
    value: Availability
    computed_at: datetime
    refresh_at: datetime

    def stale(self, now: datetime) -> bool:
        return now >= self.refresh_at


class SourceHistory:
    """Source aggregates shared by every page.

    Long-period availability is served stale once its jittered refresh time passes, refreshed a few sources per
    build cycle, and never served once older than LONG_HARD_CAP.
    """

    def __init__(self, seed: int = 0) -> None:
        self._lock = threading.Lock()
        self._long: dict[LongKey, LongEntry] = {}
        self.seed = seed

    def cycle(self, sessions: Callable[[], Session] | None = None) -> BuildCycle:
        return BuildCycle(self, sessions)

    def clear(self) -> None:
        with self._lock:
            self._long.clear()

    def jitter(self, key: LongKey) -> timedelta:
        spread = int(LONG_JITTER.total_seconds() * 1000)
        return timedelta(milliseconds=zlib.crc32(f"{self.seed}:{key[0]}:{key[1]}".encode()) % spread)

    def long(self, key: LongKey, now: datetime) -> LongEntry | None:
        with self._lock:
            found = self._long.get(key)
        if found is None or not timedelta(0) <= now - found.computed_at < LONG_HARD_CAP:
            return None
        return found

    def store_long(self, key: LongKey, now: datetime, value: Availability) -> None:
        entry = LongEntry(value, now, now + LONG_REFRESH + self.jitter(key))
        with self._lock:
            self._long = {k: v for k, v in self._long.items() if timedelta(0) <= now - v.computed_at < LONG_HARD_CAP}
            self._long[key] = entry


class BuildCycle:
    """One builder pass: current states, heartbeat-window history and computed spans are loaded once per source."""

    def __init__(self, shared: SourceHistory, sessions: Callable[[], Session] | None = None) -> None:
        self.shared = shared
        self.sessions = sessions
        self.rows = 0
        self.refreshed: set[LongKey] = set()
        self.refresh_seconds = 0.0
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

    def claim_refresh(self, key: LongKey) -> bool:
        """Whether this cycle may recompute a stale long-period value (a missing one is always computed)."""
        if key in self.refreshed:
            return True
        if len(self.refreshed) >= REFRESH_SOURCES_PER_CYCLE or self.refresh_seconds >= REFRESH_SECONDS_PER_CYCLE:
            return False
        self.refreshed.add(key)
        return True

    @contextmanager
    def timed(self):
        started = time.perf_counter()
        try:
            yield
        finally:
            self.refresh_seconds += time.perf_counter() - started

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

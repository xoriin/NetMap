from __future__ import annotations

import threading
from collections.abc import Callable, Hashable, Iterable
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.services.status_pages.history import Availability, RawHistory, Sample, SampleConverter, fetch_history
from app.services.status_pages.sources import CurrentState, SourceRef, load_current_states, threshold_breaching_sources

LONG_REFRESH = timedelta(minutes=5)

LongKey = tuple[str, str, int, tuple[tuple[datetime, datetime], ...]]


class SourceHistory:
    """Source aggregates shared by every page; long-period availability is reused for up to LONG_REFRESH."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._long: dict[LongKey, tuple[datetime, Availability]] = {}

    def cycle(self) -> BuildCycle:
        return BuildCycle(self)

    def clear(self) -> None:
        with self._lock:
            self._long.clear()

    def long(self, key: LongKey, now: datetime) -> Availability | None:
        with self._lock:
            found = self._long.get(key)
        if found is None or not timedelta(0) <= now - found[0] < LONG_REFRESH:
            return None
        return found[1]

    def store_long(self, key: LongKey, now: datetime, value: Availability) -> None:
        with self._lock:
            self._long = {k: v for k, v in self._long.items() if timedelta(0) <= now - v[0] < LONG_REFRESH}
            self._long[key] = (now, value)


class BuildCycle:
    """One builder pass: current states, heartbeat-window history and computed spans are loaded once per source."""

    def __init__(self, shared: SourceHistory) -> None:
        self.shared = shared
        self.rows = 0
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

    def fetch_long(self, db: Session, refs: Iterable[SourceRef], start: datetime, end: datetime) -> RawHistory:
        raw = fetch_history(db, refs, start, end, health_only=True)
        self.rows += raw.rows
        return raw

    def memo(self, key: Hashable, compute: Callable[[], object]):
        if key not in self._memo:
            self._memo[key] = compute()
        return self._memo[key]

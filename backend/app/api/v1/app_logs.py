"""Tools → Logs (#47): read the rolling in-memory application log."""

from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import require_diagnostics_view
from app.core.app_log import LEVELS, MAX_LISTED_LOGGERS, LogEntry, get_app_log_buffer
from app.models.user import User
from app.schemas.app_log import AppLogPage

router = APIRouter(prefix="/tools", tags=["tools"])

DEFAULT_LIMIT = 200
MAX_LIMIT = 1000


def _level_number(name: str) -> int:
    value = LEVELS.get(name.strip().upper())
    if value is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unknown log level {name!r}; use one of {', '.join(LEVELS)}",
        )
    return value


def _split(values: list[str] | None) -> list[str]:
    return [part.strip() for value in values or [] for part in value.split(",") if part.strip()]


def _epoch(moment: datetime | None) -> float | None:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()


@router.get("/logs", response_model=AppLogPage)
def read_app_logs(
    _current_user: Annotated[User, Depends(require_diagnostics_view)],
    level: Annotated[str | None, Query(description="Minimum level (DEBUG, INFO, WARNING, ERROR, CRITICAL)")] = None,
    levels: Annotated[list[str] | None, Query(description="Exact levels; repeat or comma-separate")] = None,
    logger: Annotated[str | None, Query(max_length=200, description="Logger name prefix")] = None,
    source: Annotated[list[str] | None, Query(description="Sources; repeat or comma-separate")] = None,
    since: Annotated[datetime | None, Query(description="Entries at or after this time (naive = UTC)")] = None,
    until: Annotated[datetime | None, Query(description="Entries at or before this time (naive = UTC)")] = None,
    q: Annotated[str | None, Query(max_length=200, description="Case-insensitive text in message, logger or exception")] = None,
    since_id: Annotated[int | None, Query(ge=0, description="Polling: entries with id > since_id, oldest first")] = None,
    before_id: Annotated[int | None, Query(ge=1, description="Paging: entries with id < before_id")] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    order: Annotated[Literal["desc", "asc"], Query(description="Order of the returned entries")] = "desc",
) -> dict:
    min_level = _level_number(level) if level else None
    exact_levels = {_level_number(name) for name in _split(levels)} or None
    sources = set(_split(source)) or None
    since_ts, until_ts = _epoch(since), _epoch(until)
    needle = q.strip().lower() if q and q.strip() else None
    logger_prefix = logger.strip() if logger and logger.strip() else None

    snapshot = get_app_log_buffer().snapshot()
    entries = snapshot.entries

    def matches(entry: LogEntry) -> bool:
        if since_id is not None and entry.id <= since_id:
            return False
        if before_id is not None and entry.id >= before_id:
            return False
        if min_level is not None and entry.level_no < min_level:
            return False
        if exact_levels is not None and entry.level_no not in exact_levels:
            return False
        if sources is not None and entry.source not in sources:
            return False
        if logger_prefix is not None and not entry.logger.startswith(logger_prefix):
            return False
        if since_ts is not None and entry.created < since_ts:
            return False
        if until_ts is not None and entry.created > until_ts:
            return False
        if needle is not None and not (
            needle in entry.message.lower()
            or needle in entry.logger.lower()
            or (entry.exception is not None and needle in entry.exception.lower())
        ):
            return False
        return True

    polling = since_id is not None and before_id is None
    selected: list[LogEntry] = []
    has_more = False
    # Polling takes the oldest matches after since_id so a client never skips entries;
    # otherwise take the newest matches (before before_id when paging back).
    walk = entries if polling else reversed(entries)
    for entry in walk:
        if not matches(entry):
            continue
        if len(selected) == limit:
            has_more = True
            break
        selected.append(entry)
    selected.sort(key=lambda entry: entry.id, reverse=order == "desc")

    oldest_id = entries[0].id if entries else None
    latest_id = entries[-1].id if entries else None
    returned_max = max((entry.id for entry in selected), default=None)
    if polling and has_more and returned_max is not None:
        next_since_id = returned_max
    else:
        next_since_id = max(latest_id or 0, since_id or 0)
    next_before_id = min(entry.id for entry in selected) if (not polling and has_more and selected) else None
    gap = bool(
        since_id is not None and snapshot.dropped and oldest_id is not None and since_id + 1 < oldest_id
    )

    loggers = sorted({entry.logger for entry in entries})
    return {
        "entries": [entry.to_dict() for entry in selected],
        "order": order,
        "count": len(selected),
        "has_more": has_more,
        "next_since_id": next_since_id,
        "next_before_id": next_before_id,
        "oldest_id": oldest_id,
        "latest_id": latest_id,
        "capacity": snapshot.capacity,
        "dropped": snapshot.dropped,
        "wrapped": snapshot.dropped > 0,
        "gap": gap,
        "sources": sorted({entry.source for entry in entries}),
        "loggers": loggers[:MAX_LISTED_LOGGERS],
        "levels": list(LEVELS),
    }

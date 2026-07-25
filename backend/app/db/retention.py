"""Shared helpers for time-based history pruning.

Retention tables (device_monitor_history, monitor_check_history, …) grow to
millions of rows on a busy install. A single unbounded ``DELETE`` holds the
SQLite write lock for as long as it takes to remove them, which starves every
other writer — a 5 s ``busy_timeout`` is easily exceeded and unrelated requests
fail with "database is locked". Deleting in committed batches keeps each write
lock hold short so other writers can interleave.
"""

from __future__ import annotations

from datetime import datetime, timezone
import logging
import re

from sqlalchemy import text

from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 2000
# Bound the work per pruning run so a very large backlog is spread over several
# days rather than blocking writes for minutes on the first pass.
MAX_ROWS_PER_RUN = 500_000

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _sqlite_timestamp(value: datetime) -> str:
    """Render a UTC datetime the way SQLAlchemy's SQLite DATETIME stores it.

    Comparison here is textual, so the cutoff has to use the same
    space-separated, offset-free layout as the stored values — an ISO string
    with a "T" and a "+00:00" suffix would not sort against them correctly.
    """
    naive = value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value
    return naive.strftime("%Y-%m-%d %H:%M:%S.%f")


def delete_rows_before(
    table: str,
    timestamp_column: str,
    cutoff: datetime,
    batch_size: int = DEFAULT_BATCH_SIZE,
    max_rows: int = MAX_ROWS_PER_RUN,
) -> int:
    """Delete rows older than ``cutoff`` in committed batches. Returns rows deleted."""
    if not _IDENTIFIER.match(table) or not _IDENTIFIER.match(timestamp_column):
        raise ValueError("table and timestamp_column must be plain SQL identifiers")

    statement = text(
        f"DELETE FROM {table} WHERE rowid IN ("  # noqa: S608 - identifiers validated above
        f"SELECT rowid FROM {table} WHERE {timestamp_column} < :cutoff LIMIT :limit)"
    )
    params = {"cutoff": _sqlite_timestamp(cutoff), "limit": batch_size}

    deleted = 0
    while deleted < max_rows:
        with SessionLocal() as db:
            removed = int(db.execute(statement, params).rowcount or 0)
            db.commit()
        deleted += removed
        if removed < batch_size:
            break
    if deleted:
        logger.info("Pruned %d rows from %s older than %s", deleted, table, cutoff.isoformat())
    return deleted

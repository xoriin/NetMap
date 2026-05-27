from __future__ import annotations

import logging
import sqlite3
import threading
from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import DatabaseError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings

logger = logging.getLogger(__name__)
_fts_rebuild_needed = False
_fts_rebuild_lock = threading.Lock()


def _firewall_db_url() -> str:
    return f"sqlite:///{settings.data_dir}/firewall.db"


def _firewall_db_path() -> Path:
    return Path(settings.data_dir) / "firewall.db"


firewall_engine = create_engine(
    _firewall_db_url(),
    connect_args={"check_same_thread": False},
)


@event.listens_for(firewall_engine, "connect")
def _set_firewall_pragmas(dbapi_conn, _rec):
    if isinstance(dbapi_conn, sqlite3.Connection):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()


FirewallSessionLocal = sessionmaker(bind=firewall_engine, autoflush=False, autocommit=False)


class FirewallBase(DeclarativeBase):
    pass


def get_firewall_db() -> Generator[Session, None, None]:
    db = FirewallSessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_firewall_db() -> None:
    from app.models.firewall_event import FirewallEvent  # noqa: F401
    schema_corrupt = False
    try:
        FirewallBase.metadata.create_all(bind=firewall_engine)
    except DatabaseError as exc:
        if not _is_corrupt_db_error(exc):
            raise
        schema_corrupt = True
        logger.warning(
            "firewall.db is corrupt and cannot be opened; deleting and recreating (syslog history lost)",
            exc_info=True,
        )

    if schema_corrupt:
        # Close all pooled connections before touching the file.
        firewall_engine.dispose()
        db_path = _firewall_db_path()
        for path in (db_path, Path(str(db_path) + "-wal"), Path(str(db_path) + "-shm")):
            path.unlink(missing_ok=True)
        FirewallBase.metadata.create_all(bind=firewall_engine)

    init_firewall_fts()


def init_firewall_fts() -> None:
    global _fts_rebuild_needed
    malformed = False
    try:
        with firewall_engine.begin() as conn:
            setup_firewall_fts(conn)
    except DatabaseError as exc:
        if not _is_malformed_fts_error(exc):
            raise
        malformed = True
        logger.warning("Firewall FTS index is malformed; rebuilding from scratch", exc_info=True)

    if malformed:
        # SQLite marks a connection corrupt after SQLITE_CORRUPT — dispose the pool so
        # recovery uses a fresh connection with a clean page cache.
        firewall_engine.dispose()
        with firewall_engine.begin() as conn:
            _drop_firewall_fts_objects(conn)
            _create_firewall_fts_objects(conn)
        with _fts_rebuild_lock:
            _fts_rebuild_needed = True


def setup_firewall_fts(conn) -> None:
    global _fts_rebuild_needed
    existed = _firewall_fts_exists(conn)
    try:
        _create_firewall_fts_objects(conn)
        if existed:
            _probe_firewall_fts(conn)
        else:
            with _fts_rebuild_lock:
                _fts_rebuild_needed = True
    except DatabaseError as exc:
        if not _is_malformed_fts_error(exc):
            raise
        _drop_firewall_fts_objects(conn)
        _create_firewall_fts_objects(conn)
        with _fts_rebuild_lock:
            _fts_rebuild_needed = True


def _create_firewall_fts_objects(conn) -> None:
    conn.execute(
        text(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS firewall_events_fts
            USING fts5(raw_log, content='firewall_events', content_rowid='id')
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TRIGGER IF NOT EXISTS firewall_events_ai
            AFTER INSERT ON firewall_events BEGIN
                INSERT INTO firewall_events_fts(rowid, raw_log)
                VALUES (new.id, new.raw_log);
            END
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TRIGGER IF NOT EXISTS firewall_events_ad
            AFTER DELETE ON firewall_events BEGIN
                INSERT INTO firewall_events_fts(firewall_events_fts, rowid, raw_log)
                VALUES ('delete', old.id, old.raw_log);
            END
            """
        )
    )
    conn.execute(
        text(
            """
            CREATE TRIGGER IF NOT EXISTS firewall_events_au
            AFTER UPDATE OF raw_log ON firewall_events BEGIN
                INSERT INTO firewall_events_fts(firewall_events_fts, rowid, raw_log)
                VALUES ('delete', old.id, old.raw_log);
                INSERT INTO firewall_events_fts(rowid, raw_log)
                VALUES (new.id, new.raw_log);
            END
            """
        )
    )


def _probe_firewall_fts(conn) -> None:
    conn.execute(
        text("SELECT rowid FROM firewall_events_fts WHERE firewall_events_fts MATCH :probe LIMIT 1"),
        {"probe": "netmapftsprobe"},
    ).fetchall()


def rebuild_firewall_fts_if_needed() -> None:
    global _fts_rebuild_needed
    with _fts_rebuild_lock:
        if not _fts_rebuild_needed:
            return
    logger.info("Rebuilding firewall raw-log search index in the background")
    with firewall_engine.begin() as conn:
        _sync_firewall_fts(conn, force_rebuild=True)
    with _fts_rebuild_lock:
        _fts_rebuild_needed = False
    logger.info("Firewall raw-log search index rebuild complete")


def _sync_firewall_fts(conn, *, force_rebuild: bool = False) -> None:
    if force_rebuild:
        conn.execute(text("INSERT INTO firewall_events_fts(firewall_events_fts) VALUES ('rebuild')"))
        return

    _probe_firewall_fts(conn)
    indexed = int(conn.execute(text("SELECT count(*) FROM firewall_events_fts")).scalar() or 0)
    events = int(conn.execute(text("SELECT count(*) FROM firewall_events")).scalar() or 0)
    if force_rebuild or indexed != events:
        conn.execute(text("INSERT INTO firewall_events_fts(firewall_events_fts) VALUES ('rebuild')"))


def _drop_firewall_fts_objects(conn) -> None:
    conn.execute(text("DROP TRIGGER IF EXISTS firewall_events_ai"))
    conn.execute(text("DROP TRIGGER IF EXISTS firewall_events_ad"))
    conn.execute(text("DROP TRIGGER IF EXISTS firewall_events_au"))
    conn.execute(text("DROP TABLE IF EXISTS firewall_events_fts"))
    for table_name in (
        "firewall_events_fts_data",
        "firewall_events_fts_idx",
        "firewall_events_fts_docsize",
        "firewall_events_fts_config",
    ):
        conn.execute(text(f"DROP TABLE IF EXISTS {table_name}"))


def _is_malformed_fts_error(exc: DatabaseError) -> bool:
    return "database disk image is malformed" in str(exc).lower()


def _is_corrupt_db_error(exc: DatabaseError) -> bool:
    msg = str(exc).lower()
    return "malformed database schema" in msg or "database disk image is malformed" in msg


def _firewall_fts_exists(conn) -> bool:
    row = conn.execute(
        text("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'firewall_events_fts'")
    ).fetchone()
    return row is not None

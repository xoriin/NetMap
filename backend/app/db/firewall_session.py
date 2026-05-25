from __future__ import annotations

import logging
import sqlite3
from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import DatabaseError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings

logger = logging.getLogger(__name__)


def _firewall_db_url() -> str:
    return f"sqlite:///{settings.data_dir}/firewall.db"


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
    FirewallBase.metadata.create_all(bind=firewall_engine)
    init_firewall_fts()


def init_firewall_fts() -> None:
    malformed = False
    try:
        with firewall_engine.begin() as conn:
            existed = _firewall_fts_exists(conn)
            _create_firewall_fts_objects(conn)
            _sync_firewall_fts(conn, force_rebuild=not existed)
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
            _sync_firewall_fts(conn, force_rebuild=True)


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


def _sync_firewall_fts(conn, *, force_rebuild: bool = False) -> None:
    if force_rebuild:
        conn.execute(text("INSERT INTO firewall_events_fts(firewall_events_fts) VALUES ('rebuild')"))
        return

    conn.execute(
        text("SELECT rowid FROM firewall_events_fts WHERE firewall_events_fts MATCH :probe LIMIT 1"),
        {"probe": "netmapftsprobe"},
    ).fetchall()
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


def _firewall_fts_exists(conn) -> bool:
    row = conn.execute(
        text("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'firewall_events_fts'")
    ).fetchone()
    return row is not None

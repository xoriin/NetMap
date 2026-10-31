"""Release notice feed: a small JSON file the maintainer publishes (by default
xoriin/netmap-notices on GitHub) so installs can be warned about breaking
changes without a release. The request carries no information about the install."""

import json
import logging
import re
import threading
import urllib.request
from datetime import date, datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy.orm import Session

from app.core.config import installed_app_version, settings
from app.db.session import SessionLocal
from app.models.system_setting import SystemSetting

logger = logging.getLogger(__name__)

ENABLED_KEY = "notice_feed_enabled"
CACHE_KEY = "notice_feed_cache"
CHECKED_AT_KEY = "notice_feed_checked_at"
ERROR_KEY = "notice_feed_error"
ACK_KEY = "notice_feed_acknowledged"

MAX_FEED_BYTES = 64 * 1024
MAX_NOTICES = 20
FETCH_TIMEOUT_SECONDS = 5
CHECK_INTERVAL_SECONDS = 6 * 3600
FIRST_CHECK_DELAY_SECONDS = 60
_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


class Notice(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")
    severity: Literal["info", "warning", "breaking"] = "info"
    title: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=1000)
    link: str | None = Field(default=None, max_length=500)
    show_from: str | None = None
    show_below: str | None = None
    starts: date | None = None
    ends: date | None = None

    @field_validator("title", "message")
    @classmethod
    def _plain(cls, value: str) -> str:
        return value.strip()

    @field_validator("link")
    @classmethod
    def _https(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        value = value.strip()
        if not value.startswith("https://") or any(c in value for c in " <>\"'"):
            raise ValueError("link must be an https URL")
        return value

    @field_validator("show_from", "show_below")
    @classmethod
    def _version(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not _VERSION_RE.match(value.strip()):
            raise ValueError("versions look like 2.0.0")
        return value.strip().lstrip("v")


def version_tuple(value: str | None) -> tuple[int, int, int] | None:
    match = _VERSION_RE.match((value or "").strip())
    return tuple(int(part) for part in match.groups()) if match else None


def parse_feed(raw: bytes) -> list[Notice]:
    """Valid notices from the feed; a bad entry is skipped, not the whole feed."""
    payload = json.loads(raw.decode("utf-8"))
    entries = payload.get("notices") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        raise ValueError('The feed must be a JSON object with a "notices" list')
    notices: list[Notice] = []
    seen: set[str] = set()
    for entry in entries[:MAX_NOTICES]:
        try:
            notice = Notice.model_validate(entry)
        except ValidationError as exc:
            logger.warning("Skipping an invalid release notice: %s", exc.errors()[0].get("msg"))
            continue
        if notice.id not in seen:
            seen.add(notice.id)
            notices.append(notice)
    return notices


def fetch_feed(url: str) -> bytes:
    if not url.startswith("https://"):
        raise ValueError("The notice feed URL must use https")
    request = urllib.request.Request(url, headers={"User-Agent": "netmap-notices", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
        body = response.read(MAX_FEED_BYTES + 1)
    if len(body) > MAX_FEED_BYTES:
        raise ValueError("The notice feed is larger than 64 KB")
    return body


def _get(db: Session, key: str) -> str:
    row = db.get(SystemSetting, key)
    return row.value if row else ""


def _set(db: Session, key: str, value: str) -> None:
    now = datetime.now(timezone.utc)
    row = db.get(SystemSetting, key)
    if row is None:
        db.add(SystemSetting(key=key, value=value, updated_at=now))
    else:
        row.value = value
        row.updated_at = now


def feed_enabled(db: Session) -> bool:
    value = _get(db, ENABLED_KEY).strip().lower()
    return bool(settings.notice_feed_url) and value not in ("false", "0")


def refresh(db: Session) -> None:
    """Fetch the feed once. A failure keeps the last good copy and records the error."""
    if not feed_enabled(db):
        return
    try:
        notices = parse_feed(fetch_feed(settings.notice_feed_url))
    except Exception as exc:
        logger.info("Could not read the release notice feed: %s", exc)
        _set(db, ERROR_KEY, str(exc)[:300] or exc.__class__.__name__)
    else:
        _set(db, CACHE_KEY, json.dumps([notice.model_dump(mode="json") for notice in notices]))
        _set(db, ERROR_KEY, "")
    _set(db, CHECKED_AT_KEY, datetime.now(timezone.utc).isoformat())
    db.commit()


def cached_notices(db: Session) -> list[Notice]:
    raw = _get(db, CACHE_KEY)
    if not raw:
        return []
    try:
        return [Notice.model_validate(entry) for entry in json.loads(raw)]
    except (ValueError, ValidationError):
        return []


def applies(notice: Notice, version: str | None, today: date) -> bool:
    if notice.starts and today < notice.starts:
        return False
    if notice.ends and today > notice.ends:
        return False
    current = version_tuple(version)
    if current is None:
        return True
    low, high = version_tuple(notice.show_from), version_tuple(notice.show_below)
    return (low is None or current >= low) and (high is None or current < high)


def active_notices(db: Session) -> list[Notice]:
    if not feed_enabled(db):
        return []
    version = installed_app_version(settings.app_version)
    today = datetime.now(timezone.utc).date()
    return [notice for notice in cached_notices(db) if applies(notice, version, today)]


def acknowledgements(db: Session) -> dict[str, dict]:
    try:
        value = json.loads(_get(db, ACK_KEY) or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def acknowledge(db: Session, notice_id: str, username: str) -> None:
    acks = acknowledgements(db)
    acks[notice_id] = {"by": username, "at": datetime.now(timezone.utc).isoformat()}
    _set(db, ACK_KEY, json.dumps(acks))


def feed_status(db: Session) -> dict:
    checked = _get(db, CHECKED_AT_KEY)
    return {
        "enabled": feed_enabled(db),
        "url": settings.notice_feed_url,
        "checked_at": checked or None,
        "error": _get(db, ERROR_KEY) or None,
    }


class NoticeFeedService:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="notice-feed", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        if self._stop.wait(FIRST_CHECK_DELAY_SECONDS):
            return
        while True:
            try:
                with SessionLocal() as db:
                    refresh(db)
            except Exception:
                logger.exception("Release notice feed check failed")
            if self._stop.wait(CHECK_INTERVAL_SECONDS):
                return


notice_feed_service = NoticeFeedService()

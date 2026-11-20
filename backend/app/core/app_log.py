"""Rolling in-memory application log for Tools → Logs (#47).

A logging.Handler keeps the most recent records in a bounded ring. Every message and
traceback is redacted before it is stored, so the buffer never holds a password,
token, key or community string that a log call happened to include. Nothing is
written to disk: the container's stdout keeps the usual uvicorn and warning output.
"""

from __future__ import annotations

import logging
import re
import sys
import threading
import traceback
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

LEVELS: dict[str, int] = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
}
DEFAULT_CAPACITY = 5000
DEFAULT_MAX_MESSAGE_CHARS = 2000
DEFAULT_MAX_EXCEPTION_CHARS = 6000
# Upper bound on the characters held across all entries, whatever the entry count.
DEFAULT_MAX_TOTAL_CHARS = 8_000_000
LOGS_ENDPOINT_PATH = "/api/v1/tools/logs"
REDACTED = "[REDACTED]"
TRUNCATED_SUFFIX = " … [truncated]"
MAX_LISTED_LOGGERS = 200

# --------------------------------------------------------------------------- redaction

_SECRET_KEY_WORDS = (
    r"password|passwd|passphrase|secret|token|api[_-]?key|apikey|auth[_-]?key|authkey|"
    r"priv[_-]?key|privkey|private[_-]?key|community|session[_-]?id|sessionid|csrf|credential"
)
_REDACTIONS: tuple[tuple[re.Pattern[str], object], ...] = (
    # PEM private keys.
    (
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", re.S),
        "[REDACTED PRIVATE KEY]",
    ),
    # user:password@ in URLs.
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)([^/\s:@]*):([^/\s@]+)@"), rf"\1\2:{REDACTED}@"),
    # Cookie headers: the whole value, which can hold several name=value pairs.
    (re.compile(r"(?i)\b(set-cookie|cookie)([\"']?\s*[:=]\s*)[^\r\n]+"), rf"\1\2{REDACTED}"),
    # Authorization headers, with or without a scheme.
    (
        re.compile(
            r"(?i)\b((?:proxy-)?authorization)([\"']?\s*[:=]\s*[\"']?)"
            r"(?:(bearer|basic|digest|token|negotiate)\s+)?[^\s,;\"'}\]]+"
        ),
        lambda m: f"{m.group(1)}{m.group(2)}{(m.group(3) + ' ') if m.group(3) else ''}{REDACTED}",
    ),
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*"), rf"\1 {REDACTED}"),
    # key=value, key: value, "key": "value" for secret-looking keys (also query strings).
    (
        re.compile(
            r"(?i)(?<![\w-])((?:[\w-]*(?:" + _SECRET_KEY_WORDS + r")[\w-]*)|key|pwd|pass|sid|session|jwt|otp)"
            r"([\"']?\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s&,;\"'}\])]+)"
        ),
        lambda m: f"{m.group(1)}{m.group(2)}{_quoted(m.group(3))}",
    ),
    # JWTs, NetMap API keys and Fernet tokens wherever they appear.
    (re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}"), "[REDACTED JWT]"),
    (re.compile(r"\bnm_[A-Za-z0-9]{4,}_[A-Za-z0-9]{12,}\b"), "[REDACTED API KEY]"),
    (re.compile(r"\bgAAAAA[A-Za-z0-9_-]{20,}={0,2}"), REDACTED),
)


def _quoted(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return f"{value[0]}{REDACTED}{value[0]}"
    return REDACTED


def redact(text: str) -> str:
    """Remove secrets from free text. Over-redacting is preferred to leaking."""
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)  # type: ignore[arg-type]
    return text


def _cap_head(text: str, limit: int) -> str:
    """Redact, then keep the start (messages)."""
    clean = redact(text[: limit + 512])
    return clean if len(clean) <= limit and len(text) <= limit + 512 else clean[:limit] + TRUNCATED_SUFFIX


def _cap_tail(text: str, limit: int) -> str:
    """Redact, then keep the end (tracebacks: the last frames and the error matter most)."""
    clean = redact(text[-(limit + 512):])
    if len(clean) <= limit and len(text) <= limit + 512:
        return clean
    return "[truncated] … " + clean[-limit:]


# --------------------------------------------------------------------------- sources

_SOURCE_ALIASES = {
    "auth": "auth", "oidc": "auth", "api_keys": "auth", "totp": "auth", "admin": "auth",
    "monitors": "monitors", "monitoring": "monitors",
    "alerting": "alerts", "alerts": "alerts", "notifications": "notifications",
    "snmp": "snmp", "snmp_profiles": "snmp", "lldp": "snmp",
    "discovery": "discovery", "syslog": "syslog", "status_pages": "status_pages",
    "status_public": "status_pages", "status_integrations": "status_pages",
    "audit": "audit", "ipam": "ipam", "exports": "backup", "topology": "topology", "tools": "tools",
}


def source_for(logger_name: str) -> str:
    """A short component name for filtering: api, discovery, monitors, snmp, auth, uvicorn, …"""
    parts = logger_name.split(".")
    top = parts[0]
    if top == "uvicorn":
        return "uvicorn"
    if top != "app":
        return top or "root"
    if len(parts) >= 3 and parts[1] == "services":
        return _SOURCE_ALIASES.get(parts[2], parts[2])
    if len(parts) >= 4 and parts[1] == "api":
        return _SOURCE_ALIASES.get(parts[3], "api")
    if len(parts) >= 2:
        return {"db": "database", "core": "core", "main": "core", "middleware": "api", "websocket": "websocket"}.get(
            parts[1], parts[1]
        )
    return "app"


# --------------------------------------------------------------------------- buffer


@dataclass(frozen=True, slots=True)
class LogEntry:
    id: int
    created: float
    level: str
    level_no: int
    logger: str
    source: str
    message: str
    exception: str | None

    @property
    def timestamp(self) -> str:
        moment = datetime.fromtimestamp(self.created, timezone.utc)
        return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "level": self.level,
            "logger": self.logger,
            "source": self.source,
            "message": self.message,
            "exception": self.exception,
        }


@dataclass(frozen=True)
class BufferSnapshot:
    entries: list[LogEntry]
    capacity: int
    dropped: int


class AppLogBuffer:
    """Thread-safe ring of LogEntry with increasing ids, bounded by count and characters."""

    def __init__(self, capacity: int = DEFAULT_CAPACITY, max_total_chars: int = DEFAULT_MAX_TOTAL_CHARS) -> None:
        self.capacity = max(1, int(capacity))
        self.max_total_chars = max(1, int(max_total_chars))
        self._entries: deque[LogEntry] = deque()
        self._lock = threading.Lock()
        self._next_id = 1
        self._dropped = 0
        self._chars = 0

    @staticmethod
    def _size(entry: LogEntry) -> int:
        return len(entry.message) + len(entry.exception or "") + len(entry.logger)

    def append(
        self, *, created: float, level_no: int, level: str, logger: str, message: str, exception: str | None = None,
    ) -> LogEntry:
        with self._lock:
            entry = LogEntry(
                id=self._next_id, created=created, level=level, level_no=level_no, logger=logger,
                source=source_for(logger), message=message, exception=exception,
            )
            self._next_id += 1
            self._entries.append(entry)
            self._chars += self._size(entry)
            while len(self._entries) > self.capacity or (self._chars > self.max_total_chars and len(self._entries) > 1):
                evicted = self._entries.popleft()
                self._chars -= self._size(evicted)
                self._dropped += 1
            return entry

    def snapshot(self) -> BufferSnapshot:
        with self._lock:
            return BufferSnapshot(list(self._entries), self.capacity, self._dropped)

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


# --------------------------------------------------------------------------- handler


class AppLogHandler(logging.Handler):
    """Stores redacted records in an AppLogBuffer. Never logs, never raises."""

    def __init__(
        self,
        buffer: AppLogBuffer,
        *,
        level: int = logging.INFO,
        max_message_chars: int = DEFAULT_MAX_MESSAGE_CHARS,
        max_exception_chars: int = DEFAULT_MAX_EXCEPTION_CHARS,
    ) -> None:
        super().__init__(level)
        self.buffer = buffer
        self.max_message_chars = max_message_chars
        self.max_exception_chars = max_exception_chars

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if _is_logs_endpoint_access(record):
                return
            try:
                message = record.getMessage()
            except Exception:
                message = str(record.msg)
            exception = None
            if record.exc_info and record.exc_info[0] is not None:
                exception = "".join(traceback.format_exception(*record.exc_info))
            elif record.exc_text:
                exception = record.exc_text
            if record.stack_info:
                exception = f"{exception or ''}{record.stack_info}"
            self.buffer.append(
                created=record.created,
                level_no=record.levelno,
                level=record.levelname if record.levelname in LEVELS else logging.getLevelName(record.levelno),
                logger=record.name,
                message=_cap_head(message, self.max_message_chars),
                exception=_cap_tail(exception.rstrip(), self.max_exception_chars) if exception else None,
            )
        except RecursionError:
            raise
        except Exception:
            # Logging from here would recurse into this handler; drop the record instead.
            pass


def _is_logs_endpoint_access(record: logging.LogRecord) -> bool:
    if record.name != "uvicorn.access":
        return False
    args = record.args
    if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
        return args[2].startswith(LOGS_ENDPOINT_PATH)
    return LOGS_ENDPOINT_PATH in str(record.msg)


# --------------------------------------------------------------------------- install

_install_lock = threading.Lock()
_handler: AppLogHandler | None = None


def get_app_log_buffer() -> AppLogBuffer:
    """The installed buffer, or an empty one when logging capture was never installed."""
    return _handler.buffer if _handler is not None else _EMPTY_BUFFER


_EMPTY_BUFFER = AppLogBuffer(capacity=1)


def parse_level(value: str | None, default: int = logging.INFO) -> int:
    if not value:
        return default
    return LEVELS.get(value.strip().upper(), default)


def install_app_log(
    *,
    capacity: int = DEFAULT_CAPACITY,
    level: str | None = "INFO",
    max_message_chars: int = DEFAULT_MAX_MESSAGE_CHARS,
    include_access_log: bool = False,
) -> AppLogBuffer:
    """Attach the ring handler once. Safe to call again (returns the existing buffer)."""
    global _handler
    with _install_lock:
        if _handler is not None:
            return _handler.buffer
        level_no = parse_level(level)
        handler = AppLogHandler(AppLogBuffer(capacity), level=level_no, max_message_chars=max_message_chars)
        root = logging.getLogger()
        if not root.handlers:
            # Python's last-resort handler printed WARNING+ to stderr while root had no
            # handlers. Adding ours would silence it, so keep the same output explicitly.
            stderr_handler = logging.StreamHandler(sys.stderr)
            stderr_handler.setLevel(logging.WARNING)
            root.addHandler(stderr_handler)
        root.addHandler(handler)
        app_logger = logging.getLogger("app")
        if app_logger.level == logging.NOTSET or app_logger.level > level_no:
            # Lets the app's INFO records (status changes, service starts) reach the ring;
            # the stderr handler above still only prints WARNING and above.
            app_logger.setLevel(level_no)
        # uvicorn's own loggers do not propagate to root when uvicorn configured them.
        names: Iterable[str] = ("uvicorn", "uvicorn.access") if include_access_log else ("uvicorn",)
        for name in names:
            target = logging.getLogger(name)
            if not target.propagate:
                target.addHandler(handler)
        _handler = handler
        return handler.buffer


def uninstall_app_log() -> None:
    """Test helper: detach the handler installed by install_app_log."""
    global _handler
    with _install_lock:
        if _handler is None:
            return
        for name in ("", "uvicorn", "uvicorn.access"):
            logging.getLogger(name or None).removeHandler(_handler)
        _handler = None

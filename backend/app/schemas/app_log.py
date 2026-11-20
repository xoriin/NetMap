from typing import Literal

from pydantic import BaseModel

AppLogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


class AppLogEntryRead(BaseModel):
    id: int
    timestamp: str  # UTC ISO 8601 ending in Z, millisecond precision
    level: str
    logger: str
    source: str
    message: str
    exception: str | None = None


class AppLogPage(BaseModel):
    entries: list[AppLogEntryRead]
    order: Literal["desc", "asc"]
    count: int
    has_more: bool
    next_since_id: int
    next_before_id: int | None
    oldest_id: int | None
    latest_id: int | None
    capacity: int
    dropped: int
    wrapped: bool
    gap: bool
    sources: list[str]
    loggers: list[str]
    levels: list[AppLogLevel]

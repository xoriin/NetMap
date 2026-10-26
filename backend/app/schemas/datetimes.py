"""Shared UTC datetime handling for API schemas.

SQLite hands back naive datetimes for ``DateTime(timezone=True)`` columns, so
every datetime the API reads is treated as UTC when it carries no offset, and
aware values in other zones are converted to UTC. JSON output always uses the
single ``Z`` suffix form (``2026-10-26T09:25:39.099090Z``) so clients that sort
ISO strings lexically never see a mix of ``Z`` and ``+00:00``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from pydantic import AfterValidator, AwareDatetime, PlainSerializer


def as_utc(value: datetime) -> datetime:
    """Return ``value`` as an aware UTC datetime (naive values are read as UTC)."""
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def utc_isoformat(value: datetime) -> str:
    """ISO-8601 in UTC with a ``Z`` suffix."""
    return as_utc(value).isoformat().replace("+00:00", "Z")


def utc_isoformat_or_none(value: datetime | None) -> str | None:
    return utc_isoformat(value) if value is not None else None


_SERIALIZER = PlainSerializer(utc_isoformat, return_type=str, when_used="json")

# Use for every datetime field in a request or response schema.
UtcDatetime = Annotated[datetime, AfterValidator(as_utc), _SERIALIZER]
# Same output, but input must carry an explicit UTC offset.
UtcAwareDatetime = Annotated[AwareDatetime, AfterValidator(as_utc), _SERIALIZER]

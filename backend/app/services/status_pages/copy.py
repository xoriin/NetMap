from __future__ import annotations

from collections.abc import Sequence

TITLES = {
    "availability": "{names} unavailable",
    "latency": "Slow responses: {names}",
    "loss": "Failed checks: {names}",
    "flapping": "Unstable: {names}",
    "certificate": "Certificate expiring: {names}",
    "warning": "Warning: {names}",
}

_SOURCE_EVENTS = {
    "opened": "{names} failing ({count} consecutive checks).",
    "source_added": "{names} is also affected.",
    "rebreached": "{names} is failing again.",
    "source_removed": "Monitoring source removed",
}

_FIXED_EVENTS = {
    "recovered": "All affected systems have recovered. Monitoring.",
    "resolved_manual": "Resolved.",
}


def names(aliases: Sequence[str]) -> str:
    shown = ", ".join(aliases[:3])
    return f"{shown} and {len(aliases) - 3} more" if len(aliases) > 3 else shown


def auto_title(family: str, aliases: Sequence[str]) -> str:
    return TITLES.get(family, TITLES["warning"]).format(names=names(aliases))


def render_event(code: str, data: dict, aliases: dict[str, str]) -> str | None:
    if code in _FIXED_EVENTS:
        return _FIXED_EVENTS[code]
    template = _SOURCE_EVENTS.get(code)
    if template is None:
        return None
    sources = (data or {}).get("sources") or []
    local = [aliases[key] for key in sources if isinstance(key, str) and key in aliases]
    if not local:
        return None
    return template.format(names=names(local), count=int((data or {}).get("count") or 0))

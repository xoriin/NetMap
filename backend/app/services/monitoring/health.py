from __future__ import annotations

EXPECTED_DEVICE_STATUSES = ("online", "offline")


def normalize_expected_status(value: str | None) -> str:
    """Return a supported expected reachability state with a safe legacy default."""
    return value if value in EXPECTED_DEVICE_STATUSES else "online"


def observed_health(observed_status: str | None, expected_status: str | None) -> str:
    """Map raw reachability to expected-state health without hiding the raw result."""
    if observed_status not in EXPECTED_DEVICE_STATUSES:
        return "unknown"
    return "healthy" if observed_status == normalize_expected_status(expected_status) else "unhealthy"


def observed_is_healthy(observed_status: str | None, expected_status: str | None) -> bool | None:
    health = observed_health(observed_status, expected_status)
    if health == "unknown":
        return None
    return health == "healthy"

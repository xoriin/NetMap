from __future__ import annotations

import shutil


RAW_NETWORKING_UNAVAILABLE = (
    "Active network tools are unavailable because the container does not have raw "
    "network permissions. Start the container with --cap-add NET_RAW, or add "
    "cap_add: [NET_RAW] in Docker Compose."
)


class ActiveNetworkToolUnavailable(RuntimeError):
    pass


def require_command(command: str, label: str) -> str:
    path = shutil.which(command)
    if path is None:
        raise ActiveNetworkToolUnavailable(f"{label} is unavailable because {command} is not installed")
    return path


def raw_networking_error(output: str) -> bool:
    normalized = output.lower()
    permission_markers = (
        "operation not permitted",
        "permission denied",
        "you requested a scan type which requires root privileges",
        "requires root privileges",
        "raw socket",
        "cap_net_raw",
    )
    return any(marker in normalized for marker in permission_markers)

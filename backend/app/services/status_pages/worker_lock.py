import fcntl
import logging
import os
import threading
from typing import IO

logger = logging.getLogger(__name__)

LOCK_NAME = "status-pages.lock"

_guard = threading.Lock()
_handle: IO[str] | None = None


def lock_path(data_dir: str) -> str:
    return os.path.join(data_dir, LOCK_NAME)


def acquire(data_dir: str) -> bool:
    global _handle
    with _guard:
        if _handle is not None:
            return True
        path = lock_path(data_dir)
        try:
            os.makedirs(data_dir, exist_ok=True)
            handle = open(path, "a+")
        except OSError as exc:
            logger.warning("Could not open the status page worker lock %s: %s", path, exc)
            return False
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        _handle = handle
        return True


def release() -> None:
    global _handle
    with _guard:
        if _handle is None:
            return
        try:
            fcntl.flock(_handle, fcntl.LOCK_UN)
        finally:
            _handle.close()
            _handle = None

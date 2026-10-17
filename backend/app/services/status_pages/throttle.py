import threading
import time
from collections import OrderedDict

WINDOW_SECONDS = 60.0
PER_IP_LIMIT = 600
GLOBAL_LIMIT = 6000
MAX_TRACKED_IPS = 10_000
RETRY_AFTER_SECONDS = 60
_NO_IP = "-"


class RequestThrottle:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ips: OrderedDict[str, list[float]] = OrderedDict()
        self._global: list[float] = [0.0, 0]

    def reset(self) -> None:
        with self._lock:
            self._ips.clear()
            self._global = [0.0, 0]

    def allow(self, ip: str | None, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        key = ip or _NO_IP
        with self._lock:
            if now - self._global[0] >= WINDOW_SECONDS:
                self._global = [now, 0]
            bucket = self._ips.get(key)
            if bucket is None:
                if len(self._ips) >= MAX_TRACKED_IPS:
                    self._ips.popitem(last=False)
                bucket = self._ips[key] = [now, 0]
            elif now - bucket[0] >= WINDOW_SECONDS:
                bucket[0], bucket[1] = now, 0
                self._ips.move_to_end(key)
            if bucket[1] >= PER_IP_LIMIT or self._global[1] >= GLOBAL_LIMIT:
                return False
            bucket[1] += 1
            self._global[1] += 1
            return True

    def tracked(self) -> int:
        with self._lock:
            return len(self._ips)


throttle = RequestThrottle()


def allow(ip: str | None, now: float | None = None) -> bool:
    return throttle.allow(ip, now)

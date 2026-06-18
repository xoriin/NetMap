from __future__ import annotations

import socket
from ipaddress import ip_address


def check_port(host: str, port: int, timeout: float = 2.0, *, protocol: str = "tcp") -> bool:
    if protocol == "udp":
        return _check_udp(host, port, timeout)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _check_udp(host: str, port: int, timeout: float) -> bool:
    try:
        family = socket.AF_INET6 if ip_address(host).version == 6 else socket.AF_INET
    except ValueError:
        family = socket.AF_INET
    sock = socket.socket(family, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(b"\x00", (host, port))
        sock.recvfrom(1024)
        return True
    except socket.timeout:
        return False
    except ConnectionRefusedError:
        return False
    except OSError:
        return False
    finally:
        sock.close()

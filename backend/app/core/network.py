from __future__ import annotations

from ipaddress import ip_address, ip_network

from fastapi import Request

from app.core.config import settings


def _from_local_socket(request: Request) -> bool:
    # Uvicorn reports no client for a Unix-socket peer. In the all-in-one image
    # only the bundled nginx can reach that socket, and it overwrites X-Real-IP
    # and X-Forwarded-Proto on every request, so those headers are trusted.
    return request.client is None and request.scope.get("type") in {"http", "websocket"}


def _socket_proxy_ip(request: Request) -> str | None:
    value = (request.headers.get("x-real-ip") or "").strip()
    try:
        return str(ip_address(value))
    except ValueError:
        return None


def request_client_ip(request: Request) -> str | None:
    if _from_local_socket(request):
        return _socket_proxy_ip(request)
    direct_ip = request.client.host if request.client else None
    if not direct_ip:
        return None

    if not proxy_is_trusted(direct_ip):
        return direct_ip

    forwarded_for = request.headers.get("x-forwarded-for")
    if not forwarded_for:
        return direct_ip

    # Take the rightmost entry: the trusted proxy (nginx) appends the real
    # client address, so picking from the right prevents attacker-supplied
    # values at the head of a spoofed XFF header from influencing attribution.
    for candidate in reversed(forwarded_for.split(",")):
        value = candidate.strip()
        if value:
            return value
    return direct_ip


def request_scheme(request: Request) -> str:
    direct_scheme = request.url.scheme
    if _from_local_socket(request):
        forwarded_proto = (request.headers.get("x-forwarded-proto") or "").strip().lower()
        return forwarded_proto if forwarded_proto in {"http", "https"} else direct_scheme
    direct_ip = request.client.host if request.client else None
    if not direct_ip or not proxy_is_trusted(direct_ip):
        return direct_scheme
    forwarded_proto = request.headers.get("x-forwarded-proto")
    if not forwarded_proto:
        return direct_scheme
    return forwarded_proto.split(",", 1)[0].strip() or direct_scheme


def proxy_is_trusted(client_ip: str) -> bool:
    trusted_proxies = settings.trusted_proxy_ips
    if not trusted_proxies:
        return False
    try:
        parsed_ip = ip_address(client_ip)
    except ValueError:
        return False
    for entry in trusted_proxies:
        candidate = entry.strip()
        if not candidate:
            continue
        try:
            if "/" in candidate:
                if parsed_ip in ip_network(candidate, strict=False):
                    return True
            elif parsed_ip == ip_address(candidate):
                return True
        except ValueError:
            continue
    return False

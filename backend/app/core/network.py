from __future__ import annotations

from ipaddress import ip_address, ip_network

from fastapi import Request

from app.core.config import settings


def request_client_ip(request: Request) -> str | None:
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

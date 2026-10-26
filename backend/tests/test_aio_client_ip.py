import os
import re
import subprocess
import sys
from pathlib import Path

from starlette.requests import Request

from app.core import network
from app.core.network import request_client_ip, request_scheme

DOCKER = Path(__file__).resolve().parents[2] / "docker"


def _request(headers, client=None, server=None):
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/v1/auth/login",
        "scheme": "http",
        "headers": [(k.lower().encode(), v.encode()) for k, v in {"Host": "netmap.local", **headers}.items()],
        "client": client,
        "server": server,
        "query_string": b"",
    }
    return Request(scope)


def test_unix_socket_peer_uses_the_address_nginx_sets(monkeypatch):
    monkeypatch.setattr(network.settings, "trusted_proxy_ips", [])
    request = _request({"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "198.51.100.1, 203.0.113.7"})
    assert request_client_ip(request) == "203.0.113.7"


def test_unix_socket_peer_without_a_valid_header_is_unknown(monkeypatch):
    monkeypatch.setattr(network.settings, "trusted_proxy_ips", ["127.0.0.1"])
    assert request_client_ip(_request({"X-Forwarded-For": "203.0.113.7"})) is None
    assert request_client_ip(_request({"X-Real-IP": "not-an-ip"})) is None


def test_tcp_peers_still_ignore_forwarding_headers_unless_trusted(monkeypatch):
    monkeypatch.setattr(network.settings, "trusted_proxy_ips", [])
    request = _request({"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "203.0.113.7"}, client=("192.0.2.5", 5555))
    assert request_client_ip(request) == "192.0.2.5"
    assert request_scheme(_request({"X-Forwarded-Proto": "https"}, client=("192.0.2.5", 5555))) == "http"


def test_unix_socket_scheme_follows_nginx(monkeypatch):
    assert request_scheme(_request({"X-Forwarded-Proto": "https"})) == "https"
    assert request_scheme(_request({"X-Forwarded-Proto": "gopher"})) == "http"


def test_aio_nginx_overwrites_forwarding_headers():
    template = (DOCKER / "aio-nginx.conf.template").read_text()
    assert "$proxy_add_x_forwarded_for" not in template
    assert "proxy_set_header X-Real-IP $remote_addr;" in template
    assert "proxy_set_header X-Forwarded-For $remote_addr;" in template
    assert "proxy_set_header X-Forwarded-Proto $netmap_forwarded_proto;" in template
    assert "include /tmp/nginx-realip.conf;" in template


def _realip_conf(value):
    script = (DOCKER / "aio-entrypoint.sh").read_text()
    body = re.search(r"python3 - > /tmp/nginx-realip.conf <<'PY'\n(.*?)\nPY\n", script, re.S).group(1)
    env = {**os.environ, "TRUSTED_PROXY_IPS": value}
    return subprocess.run([sys.executable, "-c", body], env=env, capture_output=True, text=True, check=True).stdout


def test_entrypoint_trusts_no_upstream_by_default():
    conf = _realip_conf("")
    assert "set_real_ip_from" not in conf and "real_ip_header" not in conf
    assert "geo $realip_remote_addr $netmap_trusted_upstream {\n  default 0;\n}" in conf


def test_entrypoint_writes_real_ip_rules_for_trusted_proxies():
    for value in ('["10.0.0.0/8", "192.0.2.1"]', "10.0.0.0/8, 192.0.2.1, bogus"):
        conf = _realip_conf(value)
        assert "set_real_ip_from 10.0.0.0/8;\nset_real_ip_from 192.0.2.1/32;" in conf
        assert "real_ip_header X-Forwarded-For;\nreal_ip_recursive on;" in conf
        assert "  10.0.0.0/8 1;\n  192.0.2.1/32 1;" in conf

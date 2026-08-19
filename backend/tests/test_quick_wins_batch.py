"""Checks for the 2026-07-02 feature batch: pause/lifecycle, HTTP checks,
next-available-IP, reservation expiry, webhook provider, flapping badge."""
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import socket
import threading

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import pytest
from pydantic import ValidationError

from app.api.v1.ipam import next_available_ip
from app.api.v1.monitoring import _build_device_summaries
from app.db.session import Base
from app.models.device import Device
from app.models.dhcp_lease import DhcpLease
from app.models.ip_reservation import IpReservation
from app.models.monitor_history import DeviceMonitorHistory
from app.models.site import Site
from app.models.subnet import Subnet
from app.models.topology_group import TopologyGroup
from app.schemas.monitoring import PortTargetCreate
from app.services.monitoring import port_checker
from app.services.monitoring.port_checker import _build_dhcp_inform, _dhcp_options, check_port
from app.services.notifications import _send_webhook


def _session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            Site.__table__,
            TopologyGroup.__table__,
            Device.__table__,
            DeviceMonitorHistory.__table__,
            Subnet.__table__,
            IpReservation.__table__,
            DhcpLease.__table__,
        ],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
            return
        code = 404 if self.path == "/missing" else 500 if self.path == "/broken" else 200
        self.send_response(code)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_HEAD(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()

    def do_POST(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):  # silence test output
        pass


def _http_server():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def test_http_check_up_down_and_error_statuses():
    server = _http_server()
    port = server.server_address[1]
    try:
        assert check_port("127.0.0.1", port, 3.0, protocol="http").open is True
        # 404 is outside the default 200-399 expected range — down
        assert check_port("127.0.0.1", port, 3.0, protocol="http", http_path="/missing").open is False
        # 5xx means the service is erroring — down
        assert check_port("127.0.0.1", port, 3.0, protocol="http", http_path="/broken").open is False
        # widening the expected range accepts the 404 as "up"
        assert check_port(
            "127.0.0.1", port, 3.0, protocol="http", http_path="/missing",
            expected_status_min=200, expected_status_max=404,
        ).open is True
    finally:
        server.shutdown()
    # closed port — down
    assert check_port("127.0.0.1", port, 0.5, protocol="http").open is False


def test_http_check_records_response_time_and_status_code():
    server = _http_server()
    port = server.server_address[1]
    try:
        result = check_port("127.0.0.1", port, 3.0, protocol="http")
        assert result.status_code == 200
        assert result.response_time_ms is not None and result.response_time_ms >= 0
    finally:
        server.shutdown()


def test_http_check_method_and_no_redirect():
    server = _http_server()
    port = server.server_address[1]
    try:
        head_result = check_port("127.0.0.1", port, 3.0, protocol="http", http_method="HEAD")
        assert head_result.open is True
        redirect_result = check_port(
            "127.0.0.1", port, 3.0, protocol="http", http_path="/redirect",
            follow_redirects=False, expected_status_min=300, expected_status_max=399,
        )
        assert redirect_result.open is True
        assert redirect_result.status_code == 302
    finally:
        server.shutdown()


def test_tcp_and_udp_checks_record_response_time():
    server = _http_server()
    port = server.server_address[1]
    try:
        result = check_port("127.0.0.1", port, 3.0, protocol="tcp")
        assert result.open is True
        assert result.response_time_ms is not None
    finally:
        server.shutdown()


def test_dhcp_inform_probe_requires_matching_ack(monkeypatch):
    sockets = []

    class FakeSocket:
        def __init__(self):
            self.request = b""
            self.bound = None
            sockets.append(self)

        def connect(self, target):
            assert target == ("192.0.2.10", 67)

        def getsockname(self):
            return ("192.0.2.20", 49152)

        def setsockopt(self, *_args):
            pass

        def settimeout(self, _timeout):
            pass

        def bind(self, target):
            self.bound = target

        def sendto(self, payload, target):
            self.request = payload
            assert target == ("192.0.2.10", 67)

        def recvfrom(self, _size):
            response = bytearray(self.request)
            response[0] = 2  # BOOTREPLY
            response[242] = 5  # option 53: DHCPACK
            return bytes(response), ("192.0.2.10", 67)

        def close(self):
            pass

    monkeypatch.setattr(port_checker.socket, "socket", lambda *_args: FakeSocket())
    result = check_port("192.0.2.10", 67, 3.0, protocol="dhcp")

    assert result.open is True
    assert result.response_time_ms is not None
    assert sockets[1].bound == ("192.0.2.20", 68)
    assert _dhcp_options(sockets[1].request)[53] == b"\x08"


def test_dhcp_inform_packet_never_requests_a_lease():
    packet = _build_dhcp_inform(1234, "192.0.2.20", b"\x02\x00\x00\x00\x00\x01")
    assert packet[0] == 1
    assert socket.inet_ntoa(packet[12:16]) == "192.0.2.20"
    assert _dhcp_options(packet)[53] == b"\x08"  # DHCPINFORM, not DISCOVER/REQUEST


def test_dhcp_service_check_is_device_scoped_on_udp_67():
    target = PortTargetCreate(device_id=7, port=67, label="Windows DHCP", check_type="dhcp")
    assert target.check_type == "dhcp"
    with pytest.raises(ValidationError):
        PortTargetCreate(device_id=None, port=67, label="Unsafe global DHCP", check_type="dhcp")
    with pytest.raises(ValidationError):
        PortTargetCreate(device_id=7, port=68, label="Wrong port", check_type="dhcp")


def test_webhook_provider_posts_json():
    server = _http_server()
    port = server.server_address[1]
    try:
        result = _send_webhook("hello", {"webhook_url": f"http://127.0.0.1:{port}/hook"})
        assert result == "ok"
    finally:
        server.shutdown()
    assert _send_webhook("hello", {}) == "Webhook URL is required"


def test_next_available_ip_skips_used_gateway_and_dhcp_pool():
    db = _session()
    now = datetime.now(timezone.utc)
    subnet = Subnet(
        name="lan", cidr="192.168.1.0/29", gateway="192.168.1.1",
        dhcp_start="192.168.1.2", dhcp_end="192.168.1.3",
        created_at=now, updated_at=now,
    )
    db.add(subnet)
    db.add(Device(ip_address="192.168.1.4", status="online"))
    db.add(IpReservation(ip_address="192.168.1.5", label="printer", created_at=now, updated_at=now))
    db.commit()
    # .1 gateway, .2-.3 DHCP pool, .4 device, .5 reserved → first free is .6
    result = next_available_ip(subnet.id, None, db)
    assert result == {"ip": "192.168.1.6"}


def test_monitor_summaries_flag_paused_and_flapping():
    db = _session()
    now = datetime.now(timezone.utc)
    paused = Device(ip_address="10.0.0.1", status="online", monitor_status="online", monitoring_paused=True)
    retired = Device(ip_address="10.0.0.2", status="online", monitor_status="offline", lifecycle="retired")
    flappy = Device(ip_address="10.0.0.3", status="online", monitor_status="online")
    db.add_all([paused, retired, flappy])
    db.commit()
    statuses = ["online", "offline", "online", "offline", "online", "offline"]
    for i, status in enumerate(statuses):
        db.add(DeviceMonitorHistory(
            device_id=flappy.id,
            checked_at=now - timedelta(minutes=50 - i * 8),
            status=status,
            rtt_ms=1.0,
            port_results="[]",
        ))
    db.commit()

    summaries = {s.ip_address: s for s in _build_device_summaries(db, [paused, retired, flappy])}
    assert summaries["10.0.0.1"].status == "paused"
    assert summaries["10.0.0.2"].status == "paused"
    assert summaries["10.0.0.3"].flapping is True
    assert summaries["10.0.0.1"].flapping is False


def test_port_target_http_options_defaults_and_validation():
    tcp_target = PortTargetCreate(port=22, label="SSH", check_type="tcp")
    assert tcp_target.http_method == "GET"
    assert tcp_target.expected_status_min == 200
    assert tcp_target.expected_status_max == 399

    http_target = PortTargetCreate(port=443, label="HTTPS", check_type="https", http_method="head", expected_status_min=200, expected_status_max=299)
    assert http_target.http_method == "HEAD"

    with pytest.raises(ValidationError):
        PortTargetCreate(port=443, label="HTTPS", check_type="https", http_method="TRACE")

    with pytest.raises(ValidationError):
        PortTargetCreate(port=443, label="HTTPS", check_type="https", expected_status_min=500, expected_status_max=200)

    with pytest.raises(ValidationError):
        PortTargetCreate(port=443, label="HTTPS", check_type="https", timeout_seconds=60)


def test_network_probe_errors_are_human_readable():
    from app.services.monitoring.port_checker import _network_error_message

    assert _network_error_message(ConnectionRefusedError(111, "Connection refused")) == "Connection refused"
    assert _network_error_message(TimeoutError(110, "Connection timed out")) == "Timed Out"
    assert "Errno" not in _network_error_message(OSError(113, "No route to host"))

"""TLS certificate details must be read even when certificate verification is off."""

import ssl
import ipaddress
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from app.services.monitoring.port_checker import check_url

NOT_AFTER = datetime(2031, 3, 4, 5, 6, 7, tzinfo=timezone.utc)


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_args):
        pass


@pytest.fixture
def self_signed_https(tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "NetMap Test CA"),
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(NOT_AFTER)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_path = tmp_path / "cert.pem"
    key_path = tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    ))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert_path, key_path)
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"https://127.0.0.1:{server.server_address[1]}/", cert_path.read_text()
    finally:
        server.shutdown()
        server.server_close()


def test_verification_off_still_reports_the_presented_certificate(self_signed_https):
    url, _ca = self_signed_https
    result = check_url(url, timeout=5, verify_tls=False)

    assert result.open is True
    assert result.cert_expires_at == NOT_AFTER
    assert result.cert_issuer is not None
    assert "organizationName=NetMap Test CA" in result.cert_issuer
    assert "commonName=localhost" in result.cert_issuer


def test_verification_on_rejects_the_untrusted_certificate(self_signed_https):
    url, _ca = self_signed_https
    result = check_url(url, timeout=5, verify_tls=True)

    assert result.open is False
    assert result.cert_expires_at is None


def test_verified_certificate_is_read_from_a_connection_close_server(self_signed_https):
    # http.server answers HTTP/1.0 and closes the connection, which used to release the
    # TLS stream before the certificate was read.
    url, ca = self_signed_https
    result = check_url(url, timeout=5, verify_tls=True, tls_ca=ca)

    assert result.open is True
    assert result.cert_expires_at == NOT_AFTER
    assert result.cert_issuer is not None
    assert "organizationName=NetMap Test CA" in result.cert_issuer

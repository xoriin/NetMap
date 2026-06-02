from __future__ import annotations

import ipaddress
import logging
import socket
import ssl
import threading
from collections.abc import Callable

from app.core.config import settings
from app.services.syslog.storage import cleanup_expired_events, mark_denied_sender, store_syslog_line

logger = logging.getLogger(__name__)


class SyslogIngestionService:
    def __init__(self) -> None:
        self._stop_event = threading.Event()
        self._threads: list[threading.Thread] = []
        self._sockets: list[socket.socket] = []
        self._tcp_semaphore = threading.Semaphore(settings.syslog_max_tcp_connections)

    def start(self) -> None:
        if not settings.syslog_enabled:
            logger.info("Syslog ingestion disabled")
            return
        if self._threads:
            return
        if settings.syslog_udp_enabled:
            self._start_thread("syslog-udp", self._serve_udp)
        if settings.syslog_tcp_enabled:
            self._start_thread("syslog-tcp", self._serve_tcp_plain)
        if settings.syslog_tls_enabled:
            self._start_thread("syslog-tls", self._serve_tcp_tls)
        self._start_thread("syslog-retention", self._retention_loop)

    def stop(self) -> None:
        self._stop_event.set()
        for opened_socket in self._sockets:
            try:
                opened_socket.close()
            except OSError:
                pass
        for thread in self._threads:
            thread.join(timeout=2)
        self._threads.clear()
        self._sockets.clear()

    def _start_thread(self, name: str, target: Callable[[], None]) -> None:
        thread = threading.Thread(target=target, name=name, daemon=True)
        thread.start()
        self._threads.append(thread)

    def _serve_udp(self) -> None:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind((settings.syslog_host, settings.syslog_udp_port))
            sock.settimeout(1)
            self._sockets.append(sock)
            logger.info("UDP syslog listener started on %s:%s", settings.syslog_host, settings.syslog_udp_port)
        except OSError as exc:
            logger.error("UDP syslog listener failed to start: %s", exc)
            return

        while not self._stop_event.is_set():
            try:
                packet, address = sock.recvfrom(settings.syslog_max_line_bytes)
            except socket.timeout:
                continue
            except OSError:
                break
            sender_host = address[0]
            if not sender_allowed(sender_host):
                mark_denied_sender(sender_host)
                logger.debug("Denied UDP syslog packet from %s by SYSLOG_SENDER_ALLOWLIST", sender_host)
                continue
            try:
                store_syslog_line(packet, sender_host)
            except Exception:
                logger.exception("Failed to store UDP syslog packet from %s", sender_host)

    def _serve_tcp_plain(self) -> None:
        self._serve_tcp(settings.syslog_tcp_port, None, "TCP")

    def _serve_tcp_tls(self) -> None:
        if not settings.syslog_tls_certfile or not settings.syslog_tls_keyfile:
            logger.error("TLS syslog requested but certificate or key file is not configured")
            return
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(settings.syslog_tls_certfile, settings.syslog_tls_keyfile)
        self._serve_tcp(settings.syslog_tls_port, context, "TLS")

    def _serve_tcp(self, port: int, context: ssl.SSLContext | None, label: str) -> None:
        try:
            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind((settings.syslog_host, port))
            server.listen(20)
            server.settimeout(1)
            self._sockets.append(server)
            logger.info("%s syslog listener started on %s:%s", label, settings.syslog_host, port)
        except OSError as exc:
            logger.error("%s syslog listener failed to start: %s", label, exc)
            return

        while not self._stop_event.is_set():
            try:
                client, address = server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            sender_host = address[0]
            if not sender_allowed(sender_host):
                mark_denied_sender(sender_host)
                logger.debug("Denied %s syslog connection from %s by SYSLOG_SENDER_ALLOWLIST", label, sender_host)
                client.close()
                continue
            if not self._tcp_semaphore.acquire(blocking=False):
                client.close()
                logger.warning("TCP syslog connection limit reached (%s), dropping %s", settings.syslog_max_tcp_connections, sender_host)
                continue
            self._start_thread(
                f"syslog-{label.lower()}-{sender_host}",
                lambda client=client, sender_host=sender_host: self._handle_tcp_client(
                    client,
                    sender_host,
                    context,
                ),
            )

    def _handle_tcp_client(
        self,
        client: socket.socket,
        sender_host: str,
        context: ssl.SSLContext | None,
    ) -> None:
        try:
            stream = context.wrap_socket(client, server_side=True) if context else client
            stream.settimeout(5)
            buffer = b""
            while not self._stop_event.is_set():
                chunk = stream.recv(4096)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    self._store_tcp_line(line, sender_host)
                if len(buffer) > settings.syslog_max_line_bytes:
                    self._store_tcp_line(buffer[: settings.syslog_max_line_bytes], sender_host)
                    buffer = b""
            if buffer:
                self._store_tcp_line(buffer, sender_host)
        except Exception:
            logger.exception("Failed while handling TCP syslog connection from %s", sender_host)
        finally:
            self._tcp_semaphore.release()
            try:
                client.close()
            except OSError:
                pass

    def _store_tcp_line(self, line: bytes, sender_host: str) -> None:
        if not line.strip():
            return
        try:
            store_syslog_line(line[: settings.syslog_max_line_bytes], sender_host)
        except Exception:
            logger.exception("Failed to store TCP syslog line from %s", sender_host)

    def _retention_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                cleanup_expired_events()
            except Exception:
                logger.exception("Firewall event cleanup failed")
            self._stop_event.wait(3600)


def sender_allowed(sender_host: str) -> bool:
    allowlist = settings.syslog_sender_allowlist
    if not allowlist:
        return True
    try:
        sender_ip = ipaddress.ip_address(sender_host)
    except ValueError:
        return False
    for entry in allowlist:
        try:
            if "/" in entry and sender_ip in ipaddress.ip_network(entry, strict=False):
                return True
            if sender_ip == ipaddress.ip_address(entry):
                return True
        except ValueError:
            logger.warning("Ignoring invalid syslog allowlist entry: %s", entry)
    return False


syslog_service = SyslogIngestionService()

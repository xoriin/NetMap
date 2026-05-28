from __future__ import annotations

import random
import socket
import time
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Any

from app.services.discovery.scanner import vendor_for_mac

SNMP_VERSION_2C = 1
SNMP_GET_REQUEST = 0xA0
SNMP_GET_NEXT_REQUEST = 0xA1
SNMP_GET_RESPONSE = 0xA2
SNMP_NO_SUCH_OBJECT = 0x80
SNMP_NO_SUCH_INSTANCE = 0x81
SNMP_END_OF_MIB_VIEW = 0x82

OID_SYS_DESCR = (1, 3, 6, 1, 2, 1, 1, 1, 0)
OID_SYS_UPTIME = (1, 3, 6, 1, 2, 1, 1, 3, 0)
OID_SYS_NAME = (1, 3, 6, 1, 2, 1, 1, 5, 0)
OID_IF_DESCR = (1, 3, 6, 1, 2, 1, 2, 2, 1, 2)
OID_IF_OPER_STATUS = (1, 3, 6, 1, 2, 1, 2, 2, 1, 8)
OID_IP_NET_TO_MEDIA_PHYS_ADDRESS = (1, 3, 6, 1, 2, 1, 4, 22, 1, 2)

MAX_SNMP_WALK_ROWS = 512
MAX_SNMP_PACKET_BYTES = 65535


@dataclass(frozen=True)
class SnmpInterface:
    index: int
    name: str | None
    oper_status: str | None


@dataclass(frozen=True)
class SnmpArpEntry:
    ip_address: str
    mac_address: str
    vendor: str | None = None
    interface_index: int | None = None


@dataclass(frozen=True)
class SnmpProbeResult:
    host: str
    sys_name: str | None
    sys_descr: str | None
    sys_uptime_seconds: float | None
    interfaces: list[SnmpInterface]
    arp_entries: list[SnmpArpEntry]
    duration_ms: int


class SnmpError(RuntimeError):
    pass


def resolve_snmp_host(host: str) -> str:
    try:
        return str(ip_address(host))
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_DGRAM)
    except socket.gaierror as exc:
        raise ValueError(f"Unable to resolve SNMP host: {host}") from exc
    for info in infos:
        try:
            return str(ip_address(info[4][0]))
        except (IndexError, ValueError):
            continue
    raise ValueError(f"Unable to resolve SNMP host: {host}")


class SnmpClient:
    def __init__(
        self,
        host: str,
        community: str,
        *,
        port: int = 161,
        timeout_seconds: int = 3,
        retries: int = 1,
    ) -> None:
        self.host = resolve_snmp_host(host)
        self.community = community
        self.port = port
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        self._request_id = random.randint(1, 2_000_000_000)

    def get(self, oid: tuple[int, ...]) -> Any | None:
        return self._request(SNMP_GET_REQUEST, oid).value

    def walk(self, base_oid: tuple[int, ...], *, max_rows: int = MAX_SNMP_WALK_ROWS) -> list[tuple[tuple[int, ...], Any]]:
        rows: list[tuple[tuple[int, ...], Any]] = []
        current_oid = base_oid
        for _ in range(max_rows):
            varbind = self._request(SNMP_GET_NEXT_REQUEST, current_oid)
            if not oid_starts_with(varbind.oid, base_oid):
                break
            if varbind.value_type in {SNMP_NO_SUCH_OBJECT, SNMP_NO_SUCH_INSTANCE, SNMP_END_OF_MIB_VIEW}:
                break
            rows.append((varbind.oid, varbind.value))
            current_oid = varbind.oid
        return rows

    def _request(self, pdu_type: int, oid: tuple[int, ...]) -> "SnmpVarBind":
        self._request_id += 1
        packet = encode_sequence(
            encode_integer(SNMP_VERSION_2C)
            + encode_octet_string(self.community.encode())
            + encode_tlv(
                pdu_type,
                encode_integer(self._request_id)
                + encode_integer(0)
                + encode_integer(0)
                + encode_sequence(encode_sequence(encode_oid(oid) + encode_null())),
            )
        )
        last_error: Exception | None = None
        for _ in range(self.retries + 1):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.settimeout(self.timeout_seconds)
                    sock.sendto(packet, (self.host, self.port))
                    response, _ = sock.recvfrom(MAX_SNMP_PACKET_BYTES)
                return parse_response(response, self._request_id)
            except (OSError, TimeoutError, SnmpError) as exc:
                last_error = exc
        raise TimeoutError(f"SNMP request to {self.host} timed out") from last_error


@dataclass(frozen=True)
class SnmpVarBind:
    oid: tuple[int, ...]
    value_type: int
    value: Any | None


def probe_snmp_v2c(
    host: str,
    community: str,
    *,
    port: int = 161,
    timeout_seconds: int = 3,
    retries: int = 1,
) -> SnmpProbeResult:
    started = time.perf_counter()
    client = SnmpClient(host, community, port=port, timeout_seconds=timeout_seconds, retries=retries)
    sys_descr = value_to_text(client.get(OID_SYS_DESCR))
    sys_name = value_to_text(client.get(OID_SYS_NAME))
    sys_uptime_seconds = timeticks_to_seconds(client.get(OID_SYS_UPTIME))

    interface_names = {
        oid[-1]: value_to_text(value)
        for oid, value in client.walk(OID_IF_DESCR)
        if len(oid) > len(OID_IF_DESCR)
    }
    interface_statuses = {
        oid[-1]: interface_status_label(value)
        for oid, value in client.walk(OID_IF_OPER_STATUS)
        if len(oid) > len(OID_IF_OPER_STATUS)
    }
    interface_indexes = sorted(set(interface_names) | set(interface_statuses))
    interfaces = [
        SnmpInterface(index=index, name=interface_names.get(index), oper_status=interface_statuses.get(index))
        for index in interface_indexes
    ]

    arp_entries = read_snmp_arp_table(client)
    duration_ms = int((time.perf_counter() - started) * 1000)
    return SnmpProbeResult(
        host=host,
        sys_name=sys_name,
        sys_descr=sys_descr,
        sys_uptime_seconds=sys_uptime_seconds,
        interfaces=interfaces,
        arp_entries=arp_entries,
        duration_ms=duration_ms,
    )


def read_snmp_arp_table(client: SnmpClient) -> list[SnmpArpEntry]:
    entries: list[SnmpArpEntry] = []
    for oid, value in client.walk(OID_IP_NET_TO_MEDIA_PHYS_ADDRESS):
        suffix = oid[len(OID_IP_NET_TO_MEDIA_PHYS_ADDRESS):]
        if len(suffix) != 5 or not isinstance(value, bytes):
            continue
        interface_index = suffix[0]
        ip_value = ".".join(str(part) for part in suffix[1:])
        mac_address = mac_bytes_to_text(value)
        if mac_address is None:
            continue
        entries.append(
            SnmpArpEntry(
                ip_address=ip_value,
                mac_address=mac_address,
                vendor=vendor_for_mac(mac_address),
                interface_index=interface_index,
            )
        )
    return entries


def snmp_arp_map(
    hosts: list[str],
    community: str,
    *,
    port: int = 161,
    timeout_seconds: int = 3,
    retries: int = 1,
) -> dict[str, SnmpArpEntry]:
    entries: dict[str, SnmpArpEntry] = {}
    for host in hosts:
        client = SnmpClient(host, community, port=port, timeout_seconds=timeout_seconds, retries=retries)
        for entry in read_snmp_arp_table(client):
            entries.setdefault(entry.ip_address, entry)
    return entries


def encode_tlv(tag: int, value: bytes) -> bytes:
    return bytes([tag]) + encode_length(len(value)) + value


def encode_length(length: int) -> bytes:
    if length < 0x80:
        return bytes([length])
    encoded = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(encoded)]) + encoded


def encode_sequence(value: bytes) -> bytes:
    return encode_tlv(0x30, value)


def encode_integer(value: int) -> bytes:
    if value == 0:
        encoded = b"\x00"
    else:
        byte_length = (value.bit_length() + 7) // 8
        encoded = value.to_bytes(byte_length, "big", signed=False)
        if encoded[0] & 0x80:
            encoded = b"\x00" + encoded
    return encode_tlv(0x02, encoded)


def encode_octet_string(value: bytes) -> bytes:
    return encode_tlv(0x04, value)


def encode_null() -> bytes:
    return encode_tlv(0x05, b"")


def encode_oid(oid: tuple[int, ...]) -> bytes:
    if len(oid) < 2:
        raise ValueError("OID must contain at least two parts")
    encoded = bytes([oid[0] * 40 + oid[1]])
    for part in oid[2:]:
        encoded += encode_base128(part)
    return encode_tlv(0x06, encoded)


def encode_base128(value: int) -> bytes:
    chunks = [value & 0x7F]
    value >>= 7
    while value:
        chunks.append(0x80 | (value & 0x7F))
        value >>= 7
    return bytes(reversed(chunks))


def parse_response(packet: bytes, request_id: int) -> SnmpVarBind:
    root = BerReader(packet).read_tlv()
    reader = BerReader(root.value)
    _version = decode_integer(reader.expect(0x02).value)
    _community = reader.expect(0x04).value
    pdu = reader.read_tlv()
    if pdu.tag != SNMP_GET_RESPONSE:
        raise SnmpError("Unexpected SNMP response")
    pdu_reader = BerReader(pdu.value)
    response_request_id = decode_integer(pdu_reader.expect(0x02).value)
    if response_request_id != request_id:
        raise SnmpError("Mismatched SNMP response")
    error_status = decode_integer(pdu_reader.expect(0x02).value)
    error_index = decode_integer(pdu_reader.expect(0x02).value)
    if error_status:
        raise SnmpError(f"SNMP error status {error_status} at index {error_index}")
    varbinds = pdu_reader.expect(0x30)
    varbinds_reader = BerReader(varbinds.value)
    varbind = varbinds_reader.expect(0x30)
    varbind_reader = BerReader(varbind.value)
    oid = decode_oid(varbind_reader.expect(0x06).value)
    value_node = varbind_reader.read_tlv()
    return SnmpVarBind(oid=oid, value_type=value_node.tag, value=decode_value(value_node))


@dataclass(frozen=True)
class BerNode:
    tag: int
    value: bytes


class BerReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0

    def read_tlv(self) -> BerNode:
        if self.offset >= len(self.data):
            raise SnmpError("Unexpected end of SNMP packet")
        tag = self.data[self.offset]
        self.offset += 1
        length = self.read_length()
        end = self.offset + length
        if end > len(self.data):
            raise SnmpError("Invalid SNMP packet length")
        value = self.data[self.offset:end]
        self.offset = end
        return BerNode(tag=tag, value=value)

    def expect(self, tag: int) -> BerNode:
        node = self.read_tlv()
        if node.tag != tag:
            raise SnmpError(f"Unexpected SNMP field 0x{node.tag:02x}")
        return node

    def read_length(self) -> int:
        first = self.data[self.offset]
        self.offset += 1
        if first < 0x80:
            return first
        octets = first & 0x7F
        if octets == 0 or octets > 4:
            raise SnmpError("Unsupported SNMP length")
        end = self.offset + octets
        if end > len(self.data):
            raise SnmpError("Invalid SNMP length")
        value = int.from_bytes(self.data[self.offset:end], "big")
        self.offset = end
        return value


def decode_integer(value: bytes) -> int:
    if not value:
        return 0
    return int.from_bytes(value, "big", signed=bool(value[0] & 0x80))


def decode_unsigned_integer(value: bytes) -> int:
    if not value:
        return 0
    return int.from_bytes(value, "big", signed=False)


def decode_oid(value: bytes) -> tuple[int, ...]:
    if not value:
        raise SnmpError("Empty OID")
    first = value[0]
    oid = [first // 40, first % 40]
    current = 0
    for byte in value[1:]:
        current = (current << 7) | (byte & 0x7F)
        if not byte & 0x80:
            oid.append(current)
            current = 0
    return tuple(oid)


def decode_value(node: BerNode) -> Any | None:
    if node.tag == 0x02:
        return decode_integer(node.value)
    if node.tag in {0x41, 0x42, 0x43, 0x46}:
        return decode_unsigned_integer(node.value)
    if node.tag == 0x04:
        return node.value
    if node.tag == 0x05:
        return None
    if node.tag == 0x06:
        return decode_oid(node.value)
    if node.tag == 0x40:
        return ".".join(str(part) for part in node.value)
    if node.tag in {SNMP_NO_SUCH_OBJECT, SNMP_NO_SUCH_INSTANCE, SNMP_END_OF_MIB_VIEW}:
        return None
    return node.value


def oid_starts_with(oid: tuple[int, ...], base_oid: tuple[int, ...]) -> bool:
    return oid[: len(base_oid)] == base_oid


def value_to_text(value: Any | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip("\x00") or None
    return str(value)


def timeticks_to_seconds(value: Any | None) -> float | None:
    if isinstance(value, int):
        return value / 100
    return None


def interface_status_label(value: Any | None) -> str | None:
    if value == 1:
        return "up"
    if value == 2:
        return "down"
    if value == 3:
        return "testing"
    if value in {4, 5, 6, 7}:
        return "unknown"
    return None


def mac_bytes_to_text(value: bytes) -> str | None:
    if len(value) != 6:
        return None
    return ":".join(f"{part:02X}" for part in value)

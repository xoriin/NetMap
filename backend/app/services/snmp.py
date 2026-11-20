from __future__ import annotations

import hashlib
import hmac
import os
import random
import socket
import time
from dataclasses import dataclass, field
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


class SnmpAuthError(SnmpError):
    """The agent rejected the SNMPv3 credentials; retrying cannot help."""


# --- SNMPv3 user-based security (RFC 3412/3414, AES RFC 3826, SHA-2 RFC 7860) ---

SNMP_VERSION_3 = 3
SNMP_REPORT = 0xA8
USM_SECURITY_MODEL = 3
SNMP_V3_MAX_MESSAGE_SIZE = 65507
FLAG_AUTH = 0x01
FLAG_PRIV = 0x02
FLAG_REPORTABLE = 0x04

SECURITY_LEVELS = ("noAuthNoPriv", "authNoPriv", "authPriv")
# Protocol name -> (hashlib name, HMAC output length kept in the message)
AUTH_PROTOCOLS: dict[str, tuple[str, int]] = {
    "MD5": ("md5", 12),
    "SHA": ("sha1", 12),
    "SHA-224": ("sha224", 16),
    "SHA-256": ("sha256", 24),
    "SHA-384": ("sha384", 32),
    "SHA-512": ("sha512", 48),
}
# Protocol name -> localized key bytes needed (AES-192/256 use the Blumenthal
# key extension, as net-snmp does for AES-192/AES-256).
PRIV_PROTOCOLS: dict[str, int] = {"DES": 16, "AES": 16, "AES-192": 24, "AES-256": 32}

USM_STATS_PREFIX = (1, 3, 6, 1, 6, 3, 15, 1, 1)
USM_REPORT_MESSAGES = {
    1: "the agent does not support this security level",
    2: "the request was outside the agent's time window",
    3: "unknown SNMPv3 user name",
    4: "unknown SNMP engine ID",
    5: "authentication failed (check the authentication protocol and key)",
    6: "decryption failed (check the privacy protocol and key)",
}
USM_NOT_IN_TIME_WINDOW = 2


@dataclass(frozen=True)
class SnmpV3Credentials:
    """SNMPv3 USM credentials. Keys are passphrases; they are never included in repr."""

    username: str
    security_level: str
    auth_protocol: str | None = None
    auth_key: str | None = field(default=None, repr=False)
    priv_protocol: str | None = None
    priv_key: str | None = field(default=None, repr=False)
    context_name: str = ""

    @property
    def uses_auth(self) -> bool:
        return self.security_level in ("authNoPriv", "authPriv")

    @property
    def uses_priv(self) -> bool:
        return self.security_level == "authPriv"


def password_to_key(password: str, auth_protocol: str) -> bytes:
    """RFC 3414 A.2: hash 1 MB of the repeated passphrase."""
    hash_name = AUTH_PROTOCOLS[auth_protocol][0]
    secret = password.encode("utf-8")
    if not secret:
        raise ValueError("SNMPv3 keys cannot be empty")
    data = (secret * (1_048_576 // len(secret) + 1))[:1_048_576]
    return hashlib.new(hash_name, data).digest()


def localize_key(key: bytes, engine_id: bytes, auth_protocol: str) -> bytes:
    hash_name = AUTH_PROTOCOLS[auth_protocol][0]
    return hashlib.new(hash_name, key + engine_id + key).digest()


def localized_priv_key(password: str, engine_id: bytes, auth_protocol: str, priv_protocol: str) -> bytes:
    hash_name = AUTH_PROTOCOLS[auth_protocol][0]
    key = localize_key(password_to_key(password, auth_protocol), engine_id, auth_protocol)
    needed = PRIV_PROTOCOLS[priv_protocol]
    while len(key) < needed:
        key += hashlib.new(hash_name, key).digest()
    return key[:needed]


def _cipher(priv_protocol: str, key: bytes, iv: bytes):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    if priv_protocol == "DES":
        from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES

        # Three copies of one DES key make TripleDES behave as single DES.
        return Cipher(TripleDES(key[:8] * 3), modes.CBC(iv))
    from cryptography.hazmat.decrepit.ciphers.modes import CFB

    return Cipher(algorithms.AES(key), CFB(iv))


def encrypt_scoped_pdu(
    priv_protocol: str, priv_key: bytes, plaintext: bytes, boots: int, engine_time: int, salt_counter: int,
) -> tuple[bytes, bytes]:
    """Return (ciphertext, msgPrivacyParameters)."""
    if priv_protocol == "DES":
        salt = boots.to_bytes(4, "big") + (salt_counter & 0xFFFFFFFF).to_bytes(4, "big")
        iv = bytes(a ^ b for a, b in zip(priv_key[8:16], salt))
        padded = plaintext + b"\x00" * (-len(plaintext) % 8)
        encryptor = _cipher("DES", priv_key, iv).encryptor()
        return encryptor.update(padded) + encryptor.finalize(), salt
    salt = (salt_counter & 0xFFFFFFFFFFFFFFFF).to_bytes(8, "big")
    iv = boots.to_bytes(4, "big") + engine_time.to_bytes(4, "big") + salt
    encryptor = _cipher(priv_protocol, priv_key, iv).encryptor()
    return encryptor.update(plaintext) + encryptor.finalize(), salt


def decrypt_scoped_pdu(
    priv_protocol: str, priv_key: bytes, ciphertext: bytes, priv_params: bytes, boots: int, engine_time: int,
) -> bytes:
    if priv_protocol == "DES":
        if len(priv_params) != 8 or len(ciphertext) % 8:
            raise SnmpError("Invalid SNMPv3 encrypted response")
        iv = bytes(a ^ b for a, b in zip(priv_key[8:16], priv_params))
    else:
        if len(priv_params) != 8:
            raise SnmpError("Invalid SNMPv3 encrypted response")
        iv = boots.to_bytes(4, "big") + engine_time.to_bytes(4, "big") + priv_params
    decryptor = _cipher(priv_protocol, priv_key, iv).decryptor()
    return decryptor.update(ciphertext) + decryptor.finalize()


def encode_usm_security_parameters(
    engine_id: bytes, boots: int, engine_time: int, username: bytes, auth_params: bytes, priv_params: bytes,
) -> bytes:
    return encode_sequence(
        encode_octet_string(engine_id)
        + encode_integer(boots)
        + encode_integer(engine_time)
        + encode_octet_string(username)
        + encode_octet_string(auth_params)
        + encode_octet_string(priv_params)
    )


def encode_v3_message(msg_id: int, flags: int, security_parameters: bytes, msg_data: bytes) -> bytes:
    return encode_sequence(
        encode_integer(SNMP_VERSION_3)
        + encode_sequence(
            encode_integer(msg_id)
            + encode_integer(SNMP_V3_MAX_MESSAGE_SIZE)
            + encode_octet_string(bytes([flags]))
            + encode_integer(USM_SECURITY_MODEL)
        )
        + encode_octet_string(security_parameters)
        + msg_data
    )


def _auth_digest(auth_protocol: str, auth_key: bytes, message: bytes) -> bytes:
    hash_name, length = AUTH_PROTOCOLS[auth_protocol]
    return hmac.new(auth_key, message, hash_name).digest()[:length]


def _auth_params_offset(message: bytes, username: bytes, auth_params: bytes) -> int:
    # The security parameters precede msgData, so the first match is the real field.
    marker = encode_octet_string(username) + encode_octet_string(auth_params)
    index = message.find(marker)
    if index < 0:
        raise SnmpError("Invalid SNMPv3 message")
    return index + len(encode_octet_string(username)) + len(encode_octet_string(auth_params)) - len(auth_params)


@dataclass(frozen=True)
class _V3Response:
    msg_id: int
    flags: int
    engine_id: bytes
    boots: int
    engine_time: int
    pdu: BerNode


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
        community: str | SnmpV3Credentials,
        *,
        port: int = 161,
        timeout_seconds: int = 3,
        retries: int = 1,
    ) -> None:
        """`community` is a v2c community string, or SnmpV3Credentials for SNMPv3."""
        self.host = resolve_snmp_host(host)
        self.v3 = community if isinstance(community, SnmpV3Credentials) else None
        self.community = "" if self.v3 else community
        self.port = port
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        self._request_id = random.randint(1, 2_000_000_000)
        self._salt = int.from_bytes(os.urandom(8), "big")
        self._engine_id: bytes | None = None
        self._engine_boots = 0
        self._engine_time = 0
        self._engine_synced_at = 0.0
        self._auth_key: bytes | None = None
        self._priv_key: bytes | None = None

    def get(self, oid: tuple[int, ...]) -> Any | None:
        return self._request(SNMP_GET_REQUEST, oid).value

    def walk(
        self,
        base_oid: tuple[int, ...],
        *,
        max_rows: int = MAX_SNMP_WALK_ROWS,
        max_wall_seconds: float = 30.0,
    ) -> list[tuple[tuple[int, ...], Any]]:
        rows: list[tuple[tuple[int, ...], Any]] = []
        current_oid = base_oid
        deadline = time.monotonic() + max_wall_seconds
        for _ in range(max_rows):
            if time.monotonic() >= deadline:
                break
            varbind = self._request(SNMP_GET_NEXT_REQUEST, current_oid)
            if not oid_starts_with(varbind.oid, base_oid):
                break
            if varbind.value_type in {SNMP_NO_SUCH_OBJECT, SNMP_NO_SUCH_INSTANCE, SNMP_END_OF_MIB_VIEW}:
                break
            rows.append((varbind.oid, varbind.value))
            current_oid = varbind.oid
        return rows

    def _request(self, pdu_type: int, oid: tuple[int, ...]) -> "SnmpVarBind":
        if self.v3 is not None:
            return self._request_v3(pdu_type, oid)
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

    # --- SNMPv3 ---

    def _exchange(self, packet: bytes) -> bytes:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(self.timeout_seconds)
            sock.sendto(packet, (self.host, self.port))
            response, _ = sock.recvfrom(MAX_SNMP_PACKET_BYTES)
        return response

    def _engine_clock(self) -> tuple[int, int]:
        elapsed = int(time.monotonic() - self._engine_synced_at)
        return self._engine_boots, min(self._engine_time + elapsed, 2_147_483_647)

    def _sync_engine(self, response: "_V3Response") -> None:
        self._engine_boots = response.boots
        self._engine_time = response.engine_time
        self._engine_synced_at = time.monotonic()

    def _discover_engine(self) -> None:
        """RFC 3414 4: learn the agent's engine ID, boots and time from a Report."""
        self._request_id += 1
        msg_id = self._request_id
        pdu = encode_tlv(
            SNMP_GET_REQUEST,
            encode_integer(msg_id) + encode_integer(0) + encode_integer(0) + encode_sequence(b""),
        )
        packet = encode_v3_message(
            msg_id,
            FLAG_REPORTABLE,
            encode_usm_security_parameters(b"", 0, 0, b"", b"", b""),
            encode_sequence(encode_octet_string(b"") + encode_octet_string(b"") + pdu),
        )
        response = self._parse_v3(self._exchange(packet), msg_id, verify=False)
        if not response.engine_id:
            raise SnmpError("SNMPv3 engine discovery failed")
        self._engine_id = response.engine_id
        self._sync_engine(response)
        credentials = self.v3
        assert credentials is not None
        if credentials.uses_auth:
            self._auth_key = localize_key(
                password_to_key(credentials.auth_key or "", credentials.auth_protocol or ""),
                self._engine_id,
                credentials.auth_protocol or "",
            )
        if credentials.uses_priv:
            self._priv_key = localized_priv_key(
                credentials.priv_key or "", self._engine_id, credentials.auth_protocol or "", credentials.priv_protocol or "",
            )

    def _build_v3_request(self, pdu_type: int, oid: tuple[int, ...]) -> tuple[int, bytes]:
        credentials = self.v3
        assert credentials is not None and self._engine_id is not None
        self._request_id += 1
        msg_id = self._request_id
        pdu = encode_tlv(
            pdu_type,
            encode_integer(msg_id)
            + encode_integer(0)
            + encode_integer(0)
            + encode_sequence(encode_sequence(encode_oid(oid) + encode_null())),
        )
        scoped_pdu = encode_sequence(
            encode_octet_string(self._engine_id)
            + encode_octet_string(credentials.context_name.encode("utf-8"))
            + pdu
        )
        boots, engine_time = self._engine_clock()
        flags = FLAG_REPORTABLE
        priv_params = b""
        msg_data = scoped_pdu
        if credentials.uses_priv:
            assert self._priv_key is not None
            flags |= FLAG_PRIV
            self._salt += 1
            ciphertext, priv_params = encrypt_scoped_pdu(
                credentials.priv_protocol or "", self._priv_key, scoped_pdu, boots, engine_time, self._salt,
            )
            msg_data = encode_octet_string(ciphertext)
        auth_params = b""
        if credentials.uses_auth:
            flags |= FLAG_AUTH
            auth_params = b"\x00" * AUTH_PROTOCOLS[credentials.auth_protocol or ""][1]
        username = credentials.username.encode("utf-8")
        packet = encode_v3_message(
            msg_id,
            flags,
            encode_usm_security_parameters(self._engine_id, boots, engine_time, username, auth_params, priv_params),
            msg_data,
        )
        if credentials.uses_auth:
            assert self._auth_key is not None
            offset = _auth_params_offset(packet, username, auth_params)
            digest = _auth_digest(credentials.auth_protocol or "", self._auth_key, packet)
            packet = packet[:offset] + digest + packet[offset + len(digest):]
        return msg_id, packet

    def _parse_v3(self, packet: bytes, msg_id: int, *, verify: bool = True) -> "_V3Response":
        root = BerReader(packet).read_tlv()
        reader = BerReader(root.value)
        if decode_integer(reader.expect(0x02).value) != SNMP_VERSION_3:
            raise SnmpError("Unexpected SNMP version in response")
        header = BerReader(reader.expect(0x30).value)
        response_msg_id = decode_integer(header.expect(0x02).value)
        _max_size = header.expect(0x02)
        flags_value = header.expect(0x04).value
        flags = flags_value[0] if flags_value else 0
        if response_msg_id != msg_id:
            raise SnmpError("Mismatched SNMP response")
        params = BerReader(BerReader(reader.expect(0x04).value).expect(0x30).value)
        engine_id = params.expect(0x04).value
        boots = decode_integer(params.expect(0x02).value)
        engine_time = decode_integer(params.expect(0x02).value)
        username = params.expect(0x04).value
        auth_params = params.expect(0x04).value
        priv_params = params.expect(0x04).value
        msg_data = reader.read_tlv()
        credentials = self.v3
        assert credentials is not None
        if verify and flags & FLAG_AUTH:
            if self._auth_key is None or credentials.auth_protocol is None:
                raise SnmpError("Unexpected authenticated SNMPv3 response")
            offset = _auth_params_offset(packet, username, auth_params)
            blanked = packet[:offset] + b"\x00" * len(auth_params) + packet[offset + len(auth_params):]
            expected = _auth_digest(credentials.auth_protocol, self._auth_key, blanked)
            if not hmac.compare_digest(expected, auth_params):
                raise SnmpAuthError("SNMPv3 response failed authentication")
        if msg_data.tag == 0x04:
            if not (flags & FLAG_PRIV) or self._priv_key is None or credentials.priv_protocol is None:
                raise SnmpError("Unexpected encrypted SNMPv3 response")
            plaintext = decrypt_scoped_pdu(
                credentials.priv_protocol, self._priv_key, msg_data.value, priv_params, boots, engine_time,
            )
            try:
                scoped = BerReader(plaintext).read_tlv()
            except SnmpError as exc:
                raise SnmpAuthError("SNMPv3 response could not be decrypted (check the privacy protocol and key)") from exc
        else:
            scoped = msg_data
        if scoped.tag != 0x30:
            raise SnmpAuthError("SNMPv3 response could not be decrypted (check the privacy protocol and key)")
        scoped_reader = BerReader(scoped.value)
        _context_engine_id = scoped_reader.expect(0x04)
        _context_name = scoped_reader.expect(0x04)
        return _V3Response(
            msg_id=response_msg_id,
            flags=flags,
            engine_id=engine_id,
            boots=boots,
            engine_time=engine_time,
            pdu=scoped_reader.read_tlv(),
        )

    def _report_error(self, pdu: BerNode) -> int | None:
        """Return the usmStats counter number a Report carries, if any."""
        try:
            pdu_reader = BerReader(pdu.value)
            for _ in range(3):
                pdu_reader.expect(0x02)
            varbinds = BerReader(pdu_reader.expect(0x30).value)
            varbind = BerReader(varbinds.expect(0x30).value)
            oid = decode_oid(varbind.expect(0x06).value)
        except SnmpError:
            return None
        if oid[: len(USM_STATS_PREFIX)] == USM_STATS_PREFIX and len(oid) > len(USM_STATS_PREFIX):
            return oid[len(USM_STATS_PREFIX)]
        return None

    def _request_v3(self, pdu_type: int, oid: tuple[int, ...]) -> "SnmpVarBind":
        last_error: Exception | None = None
        resynced = False
        attempt = 0
        while attempt <= self.retries:
            attempt += 1
            try:
                if self._engine_id is None:
                    self._discover_engine()
                msg_id, packet = self._build_v3_request(pdu_type, oid)
                response = self._parse_v3(self._exchange(packet), msg_id)
                if response.pdu.tag == SNMP_REPORT:
                    counter = self._report_error(response.pdu)
                    if counter == USM_NOT_IN_TIME_WINDOW and not resynced:
                        resynced = True
                        self._sync_engine(response)
                        attempt -= 1
                        continue
                    detail = USM_REPORT_MESSAGES.get(counter or 0, "the agent returned an SNMPv3 report")
                    raise SnmpAuthError(f"SNMPv3 request to {self.host} failed: {detail}")
                return parse_pdu(response.pdu, msg_id)
            except SnmpAuthError:
                raise
            except (OSError, TimeoutError, SnmpError) as exc:
                last_error = exc
        hint = " (check the SNMPv3 privacy protocol and key)" if self.v3 is not None and self.v3.uses_priv else ""
        raise TimeoutError(f"SNMP request to {self.host} timed out{hint}") from last_error


@dataclass(frozen=True)
class SnmpVarBind:
    oid: tuple[int, ...]
    value_type: int
    value: Any | None


def probe_snmp_v2c(
    host: str,
    community: str | SnmpV3Credentials,
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
    return parse_pdu(reader.read_tlv(), request_id)


def parse_pdu(pdu: BerNode, request_id: int) -> SnmpVarBind:
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

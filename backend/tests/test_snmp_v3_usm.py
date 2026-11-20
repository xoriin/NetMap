"""SNMPv3 USM: RFC 3414 key vectors, privacy round trips and a client exchange against an in-process agent.

Interop with a real net-snmp agent was checked by hand; these tests keep the wire format pinned."""

import hmac

import pytest

from app.services import snmp
from app.services.snmp import (
    AUTH_PROTOCOLS,
    FLAG_AUTH,
    FLAG_PRIV,
    OID_SYS_NAME,
    PRIV_PROTOCOLS,
    SNMP_GET_RESPONSE,
    SNMP_REPORT,
    USM_STATS_PREFIX,
    BerReader,
    SnmpAuthError,
    SnmpClient,
    SnmpV3Credentials,
    decode_integer,
    decrypt_scoped_pdu,
    encode_integer,
    encode_octet_string,
    encode_oid,
    encode_sequence,
    encode_tlv,
    encode_usm_security_parameters,
    encode_v3_message,
    encrypt_scoped_pdu,
    localize_key,
    localized_priv_key,
    password_to_key,
)

RFC_ENGINE_ID = bytes.fromhex("000000000000000000000002")


def test_rfc3414_md5_key_localisation():
    key = password_to_key("maplesyrup", "MD5")
    assert key.hex() == "9faf3283884e92834ebc9847d8edd963"
    assert localize_key(key, RFC_ENGINE_ID, "MD5").hex() == "526f5eed9fcce26f8964c2930787d82b"


def test_rfc3414_sha_key_localisation():
    key = password_to_key("maplesyrup", "SHA")
    assert key.hex() == "9fb5cc0381497b3793528939ff788d5d79145211"
    assert localize_key(key, RFC_ENGINE_ID, "SHA").hex() == "6695febc9288e36282235fc7151f128497b38f3f"


@pytest.mark.parametrize("priv_protocol", sorted(PRIV_PROTOCOLS))
def test_privacy_round_trip(priv_protocol):
    key = localized_priv_key("privpass456", RFC_ENGINE_ID, "SHA", priv_protocol)
    assert len(key) == PRIV_PROTOCOLS[priv_protocol]
    plaintext = encode_sequence(encode_octet_string(b"scoped pdu payload"))
    ciphertext, params = encrypt_scoped_pdu(priv_protocol, key, plaintext, 3, 1234, 99)
    assert plaintext not in ciphertext
    decrypted = decrypt_scoped_pdu(priv_protocol, key, ciphertext, params, 3, 1234)
    assert decrypted[: len(plaintext)] == plaintext


def test_credentials_repr_hides_keys():
    credentials = SnmpV3Credentials("u", "authPriv", "SHA", "auth-secret-1", "AES", "priv-secret-1")
    assert "auth-secret-1" not in repr(credentials) and "priv-secret-1" not in repr(credentials)


class FakeAgent:
    """Just enough of an SNMPv3 agent to answer a GET for sysName."""

    def __init__(self, user: SnmpV3Credentials, *, engine_id=b"\x80\x00\x1f\x88\x04netmap", boots=7, engine_time=500):
        self.user = user
        self.engine_id = engine_id
        self.boots = boots
        self.engine_time = engine_time
        self.stale_once = False
        self.requests: list[bytes] = []
        self.contexts: list[bytes] = []
        if user.uses_auth:
            self.auth_key = localize_key(password_to_key(user.auth_key, user.auth_protocol), engine_id, user.auth_protocol)
        if user.uses_priv:
            self.priv_key = localized_priv_key(user.priv_key, engine_id, user.auth_protocol, user.priv_protocol)

    def _report(self, msg_id: int, counter: int) -> bytes:
        pdu = encode_tlv(
            SNMP_REPORT,
            encode_integer(msg_id) + encode_integer(0) + encode_integer(0)
            + encode_sequence(encode_sequence(encode_oid(USM_STATS_PREFIX + (counter, 0)) + encode_tlv(0x41, b"\x01"))),
        )
        scoped = encode_sequence(encode_octet_string(self.engine_id) + encode_octet_string(b"") + pdu)
        params = encode_usm_security_parameters(self.engine_id, self.boots, self.engine_time, b"", b"", b"")
        return encode_v3_message(msg_id, 0, params, scoped)

    def __call__(self, packet: bytes) -> bytes:
        self.requests.append(packet)
        reader = BerReader(BerReader(packet).read_tlv().value)
        reader.expect(0x02)
        header = BerReader(reader.expect(0x30).value)
        msg_id = decode_integer(header.expect(0x02).value)
        header.expect(0x02)
        flags = header.expect(0x04).value[0]
        params = BerReader(BerReader(reader.expect(0x04).value).expect(0x30).value)
        engine_id = params.expect(0x04).value
        boots = decode_integer(params.expect(0x02).value)
        engine_time = decode_integer(params.expect(0x02).value)
        username = params.expect(0x04).value
        auth_params = params.expect(0x04).value
        priv_params = params.expect(0x04).value
        msg_data = reader.read_tlv()
        if not engine_id:
            return self._report(msg_id, 4)  # usmStatsUnknownEngineIDs
        if username != self.user.username.encode():
            return self._report(msg_id, 3)
        if self.user.uses_auth:
            assert flags & FLAG_AUTH
            assert len(auth_params) == AUTH_PROTOCOLS[self.user.auth_protocol][1]
            blanked = packet.replace(auth_params, b"\x00" * len(auth_params), 1)
            expected = snmp._auth_digest(self.user.auth_protocol, self.auth_key, blanked)
            if not hmac.compare_digest(expected, auth_params):
                return self._report(msg_id, 5)  # usmStatsWrongDigests
        if self.stale_once:
            self.stale_once = False
            self.engine_time += 1000
            return self._report(msg_id, 2)  # usmStatsNotInTimeWindows
        if self.user.uses_priv:
            assert flags & FLAG_PRIV and msg_data.tag == 0x04
            scoped_bytes = decrypt_scoped_pdu(
                self.user.priv_protocol, self.priv_key, msg_data.value, priv_params, boots, engine_time,
            )
            scoped = BerReader(scoped_bytes).read_tlv()
        else:
            scoped = msg_data
        scoped_reader = BerReader(scoped.value)
        scoped_reader.expect(0x04)
        self.contexts.append(scoped_reader.expect(0x04).value)
        request_pdu = BerReader(scoped_reader.read_tlv().value)
        request_id = decode_integer(request_pdu.expect(0x02).value)
        pdu = encode_tlv(
            SNMP_GET_RESPONSE,
            encode_integer(request_id) + encode_integer(0) + encode_integer(0)
            + encode_sequence(encode_sequence(encode_oid(OID_SYS_NAME) + encode_octet_string(b"core-sw1"))),
        )
        scoped_out = encode_sequence(encode_octet_string(self.engine_id) + encode_octet_string(b"") + pdu)
        out_flags, out_priv, body = 0, b"", scoped_out
        if self.user.uses_priv:
            ciphertext, out_priv = encrypt_scoped_pdu(
                self.user.priv_protocol, self.priv_key, scoped_out, self.boots, self.engine_time, 4242,
            )
            out_flags |= FLAG_PRIV
            body = encode_octet_string(ciphertext)
        out_auth = b""
        if self.user.uses_auth:
            out_flags |= FLAG_AUTH
            out_auth = b"\x00" * AUTH_PROTOCOLS[self.user.auth_protocol][1]
        params_out = encode_usm_security_parameters(
            self.engine_id, self.boots, self.engine_time, self.user.username.encode(), out_auth, out_priv,
        )
        response = encode_v3_message(msg_id, out_flags, params_out, body)
        if self.user.uses_auth:
            digest = snmp._auth_digest(self.user.auth_protocol, self.auth_key, response)
            response = response.replace(out_auth, digest, 1)
        return response


def _client(credentials: SnmpV3Credentials, agent: FakeAgent, monkeypatch) -> SnmpClient:
    monkeypatch.setattr(snmp, "resolve_snmp_host", lambda host: host)
    client = SnmpClient("192.0.2.10", credentials, timeout_seconds=1, retries=1)
    monkeypatch.setattr(client, "_exchange", agent)
    return client


LEVELS = [
    SnmpV3Credentials("plain", "noAuthNoPriv"),
    SnmpV3Credentials("authonly", "authNoPriv", "MD5", "authpass123"),
    SnmpV3Credentials("authonly", "authNoPriv", "SHA-512", "authpass123"),
    SnmpV3Credentials("secure", "authPriv", "SHA", "authpass123", "DES", "privpass456"),
    SnmpV3Credentials("secure", "authPriv", "SHA-256", "authpass123", "AES", "privpass456"),
    SnmpV3Credentials("secure", "authPriv", "SHA-384", "authpass123", "AES-256", "privpass456", "vlan10"),
]


@pytest.mark.parametrize("credentials", LEVELS, ids=lambda c: f"{c.security_level}-{c.auth_protocol}-{c.priv_protocol}")
def test_client_get_over_v3(credentials, monkeypatch):
    agent = FakeAgent(credentials)
    client = _client(credentials, agent, monkeypatch)
    assert client.get(OID_SYS_NAME) == b"core-sw1"
    assert len(agent.requests) == 2  # discovery, then the authenticated request
    assert agent.contexts == [credentials.context_name.encode()]
    for secret in (credentials.auth_key, credentials.priv_key):
        if secret:
            assert secret.encode() not in agent.requests[1]
    if credentials.uses_priv:
        assert b"core-sw1" not in agent.requests[1]


def test_client_resyncs_once_when_not_in_time_window(monkeypatch):
    credentials = LEVELS[4]
    agent = FakeAgent(credentials)
    agent.stale_once = True
    client = _client(credentials, agent, monkeypatch)
    assert client.get(OID_SYS_NAME) == b"core-sw1"
    assert len(agent.requests) == 3


def test_wrong_auth_key_is_a_clear_error(monkeypatch):
    agent = FakeAgent(LEVELS[4])
    wrong = SnmpV3Credentials("secure", "authPriv", "SHA-256", "not-the-key", "AES", "privpass456")
    client = _client(wrong, agent, monkeypatch)
    with pytest.raises(SnmpAuthError) as caught:
        client.get(OID_SYS_NAME)
    assert "not-the-key" not in str(caught.value)
    assert len(agent.requests) == 2  # auth failures are not retried


def test_unknown_user_is_a_clear_error(monkeypatch):
    agent = FakeAgent(LEVELS[4])
    client = _client(SnmpV3Credentials("nobody", "noAuthNoPriv"), agent, monkeypatch)
    with pytest.raises(SnmpAuthError):
        client.get(OID_SYS_NAME)


def test_v2c_client_is_unchanged(monkeypatch):
    monkeypatch.setattr(snmp, "resolve_snmp_host", lambda host: host)
    client = SnmpClient("192.0.2.10", "public")
    assert client.v3 is None and client.community == "public"

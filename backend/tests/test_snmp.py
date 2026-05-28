import unittest
from unittest.mock import patch

from app.schemas.discovery import DiscoveryHost
from app.services.discovery.scanner import enrich_hosts_from_snmp_arp
from app.services.snmp import (
    OID_IP_NET_TO_MEDIA_PHYS_ADDRESS,
    SnmpArpEntry,
    encode_integer,
    encode_octet_string,
    encode_oid,
    encode_sequence,
    encode_tlv,
    mac_bytes_to_text,
    parse_response,
    read_snmp_arp_table,
)


class SnmpTests(unittest.TestCase):
    def test_parse_response_decodes_integer_varbind(self) -> None:
        packet = snmp_response_packet(1234, (1, 3, 6, 1, 2, 1, 1, 3, 0), encode_tlv(0x43, b"\x00\x00\x27\x10"))

        varbind = parse_response(packet, 1234)

        self.assertEqual(varbind.oid, (1, 3, 6, 1, 2, 1, 1, 3, 0))
        self.assertEqual(varbind.value, 10_000)

    def test_mac_bytes_to_text_normalizes_mac(self) -> None:
        self.assertEqual(mac_bytes_to_text(b"\xaa\xbb\xcc\x00\x11\x22"), "AA:BB:CC:00:11:22")

    def test_read_snmp_arp_table_maps_ip_suffix_to_mac(self) -> None:
        class FakeClient:
            def walk(self, _base_oid):
                return [
                    (
                        OID_IP_NET_TO_MEDIA_PHYS_ADDRESS + (7, 192, 168, 20, 15),
                        b"\xaa\xbb\xcc\x00\x11\x22",
                    )
                ]

        with patch("app.services.snmp.vendor_for_mac", return_value="ExampleVendor"):
            entries = read_snmp_arp_table(FakeClient())  # type: ignore[arg-type]

        self.assertEqual(entries[0].ip_address, "192.168.20.15")
        self.assertEqual(entries[0].mac_address, "AA:BB:CC:00:11:22")
        self.assertEqual(entries[0].interface_index, 7)
        self.assertEqual(entries[0].vendor, "ExampleVendor")

    @patch("app.services.snmp.snmp_arp_map")
    def test_discovery_enrichment_uses_snmp_arp_map_for_missing_mac(self, mock_arp_map) -> None:
        mock_arp_map.return_value = {
            "192.168.20.15": SnmpArpEntry(
                ip_address="192.168.20.15",
                mac_address="AA:BB:CC:00:11:22",
                vendor="ExampleVendor",
                interface_index=7,
            )
        }

        hosts = enrich_hosts_from_snmp_arp(
            [DiscoveryHost(ip_address="192.168.20.15", status="online")],
            ["192.168.1.1"],
            "public",
        )

        self.assertEqual(hosts[0].mac_address, "AA:BB:CC:00:11:22")
        self.assertEqual(hosts[0].vendor, "ExampleVendor")


def snmp_response_packet(request_id: int, oid: tuple[int, ...], value: bytes) -> bytes:
    return encode_sequence(
        encode_integer(1)
        + encode_octet_string(b"public")
        + encode_tlv(
            0xA2,
            encode_integer(request_id)
            + encode_integer(0)
            + encode_integer(0)
            + encode_sequence(encode_sequence(encode_oid(oid) + value)),
        )
    )


if __name__ == "__main__":
    unittest.main()

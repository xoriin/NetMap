import subprocess
import unittest
from unittest.mock import patch

from app.services.discovery.scanner import (
    DiscoveryTarget,
    enrich_hosts_from_neighbor_table,
    mac_prefixes,
    read_neighbor_table,
    parse_nmap_xml,
    discovery_process_timeout_seconds,
    ping_host_timeout_seconds,
    port_scan_host_timeout_seconds,
    run_nmap_scan,
    validate_target,
)


class DiscoveryScannerTests(unittest.TestCase):
    def test_validate_target_converts_full_ipv4_range_to_nmap_safe_cidrs(self) -> None:
        target = validate_target("192.168.0.1-192.168.0.150", confirm_large_scan=False)

        self.assertEqual(target.nmap_target, "192.168.0.1-192.168.0.150")
        self.assertEqual(target.host_count, 150)
        self.assertEqual(
            target.command_targets(),
            (
                "192.168.0.1/32",
                "192.168.0.2/31",
                "192.168.0.4/30",
                "192.168.0.8/29",
                "192.168.0.16/28",
                "192.168.0.32/27",
                "192.168.0.64/26",
                "192.168.0.128/28",
                "192.168.0.144/30",
                "192.168.0.148/31",
                "192.168.0.150/32",
            ),
        )

    def test_validate_target_converts_any_private_ipv4_range_to_nmap_safe_cidrs(self) -> None:
        target = validate_target("10.10.1.250-10.10.2.5", confirm_large_scan=False)

        self.assertEqual(target.nmap_target, "10.10.1.250-10.10.2.5")
        self.assertEqual(target.host_count, 12)
        self.assertEqual(
            target.command_targets(),
            (
                "10.10.1.250/31",
                "10.10.1.252/30",
                "10.10.2.0/30",
                "10.10.2.4/31",
            ),
        )

    def test_validate_target_converts_private_ipv6_range_to_nmap_safe_cidrs(self) -> None:
        target = validate_target("fd00::1-fd00::4", confirm_large_scan=False)

        self.assertEqual(target.nmap_target, "fd00::1-fd00::4")
        self.assertEqual(target.host_count, 4)
        self.assertEqual(
            target.command_targets(),
            (
                "fd00::1/128",
                "fd00::2/127",
                "fd00::4/128",
            ),
        )

    def test_validate_target_rejects_ranges_that_cross_public_space(self) -> None:
        with self.assertRaises(ValueError) as exc:
            validate_target("192.168.255.250-192.169.0.10", confirm_large_scan=True)

        self.assertIn("Public IP scanning is blocked", str(exc.exception))

    def test_ping_scan_timeout_scales_for_subnet_targets(self) -> None:
        timeout_seconds = discovery_process_timeout_seconds(
            DiscoveryTarget(nmap_target="10.30.20.0/24", host_count=256),
            "ping",
        )
        self.assertGreaterEqual(timeout_seconds, 190)

    def test_ping_host_timeout_is_trimmed_for_multi_host_scans(self) -> None:
        timeout_seconds = ping_host_timeout_seconds(
            DiscoveryTarget(nmap_target="10.30.20.0/24", host_count=256)
        )
        self.assertEqual(timeout_seconds, 12)

    def test_port_host_timeout_is_trimmed_for_multi_host_scans(self) -> None:
        timeout_seconds = port_scan_host_timeout_seconds(
            DiscoveryTarget(nmap_target="10.30.20.0/24", host_count=256)
        )
        self.assertEqual(timeout_seconds, 20)

    @patch("app.core.capabilities.shutil.which", return_value="/usr/bin/nmap")
    @patch("app.services.discovery.scanner.subprocess.run")
    def test_run_nmap_scan_uses_scaled_timeout_for_ping_sweep(self, mock_run, _mock_which) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="<nmaprun></nmaprun>",
            stderr="",
        )

        run_nmap_scan(DiscoveryTarget(nmap_target="10.30.20.0/24", host_count=256), "ping")

        _, kwargs = mock_run.call_args
        self.assertEqual(kwargs["timeout"], 190)
        command = mock_run.call_args.args[0]
        self.assertIn("-n", command)
        self.assertIn("-T3", command)
        self.assertIn("--host-timeout", command)
        self.assertIn("12s", command)

    @patch("app.core.capabilities.shutil.which", return_value="/usr/bin/nmap")
    @patch("app.services.discovery.scanner.subprocess.run")
    def test_run_nmap_scan_passes_range_cidrs_as_separate_targets(self, mock_run, _mock_which) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="<nmaprun></nmaprun>",
            stderr="",
        )
        target = validate_target("192.168.0.1-192.168.0.3", confirm_large_scan=False)

        run_nmap_scan(target, "ping")

        command = mock_run.call_args.args[0]
        self.assertIn("192.168.0.1/32", command)
        self.assertIn("192.168.0.2/31", command)
        self.assertNotIn("192.168.0.1-192.168.0.3", command)

    @patch("app.core.capabilities.shutil.which", return_value="/usr/bin/nmap")
    @patch("app.services.discovery.scanner.subprocess.run")
    def test_run_nmap_scan_returns_actionable_timeout_error(self, mock_run, _mock_which) -> None:
        mock_run.side_effect = subprocess.TimeoutExpired(
            cmd=["nmap"],
            timeout=190,
        )

        with self.assertRaises(RuntimeError) as exc:
            run_nmap_scan(DiscoveryTarget(nmap_target="10.30.20.0/24", host_count=256), "ping")

        self.assertIn("timed out after 190 seconds", str(exc.exception))

    def test_parse_nmap_xml_derives_vendor_from_mac_prefix_database(self) -> None:
        mac_prefixes.cache_clear()
        xml = """
        <nmaprun>
          <host>
            <status state="up"/>
            <address addr="192.168.1.10" addrtype="ipv4"/>
            <address addr="AA:BB:CC:00:11:22" addrtype="mac"/>
          </host>
        </nmaprun>
        """

        with patch("app.services.discovery.scanner.MAC_PREFIX_FILES", ()):
            with patch("app.services.discovery.scanner.mac_prefixes", return_value={"AABBCC": "ExampleVendor"}):
                hosts = enrich_hosts_from_neighbor_table(parse_nmap_xml(xml))

        self.assertEqual(hosts[0].vendor, "ExampleVendor")

    @patch("app.services.discovery.scanner.read_neighbor_table", return_value={"192.168.1.10": "AA:BB:CC:00:11:22"})
    def test_enrich_hosts_from_neighbor_table_fills_missing_mac(self, _mock_neighbors) -> None:
        xml = """
        <nmaprun>
          <host>
            <status state="up"/>
            <address addr="192.168.1.10" addrtype="ipv4"/>
          </host>
        </nmaprun>
        """

        with patch("app.services.discovery.scanner.mac_prefixes", return_value={"AABBCC": "ExampleVendor"}):
            hosts = enrich_hosts_from_neighbor_table(parse_nmap_xml(xml))

        self.assertEqual(hosts[0].mac_address, "AA:BB:CC:00:11:22")
        self.assertEqual(hosts[0].vendor, "ExampleVendor")

    @patch("app.services.discovery.scanner.shutil.which", return_value="/usr/sbin/ip")
    @patch("app.services.discovery.scanner.subprocess.run")
    def test_read_neighbor_table_accepts_list_state_from_ip_json(self, mock_run, _mock_which) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='[{"dst":"192.168.1.10","lladdr":"aa:bb:cc:00:11:22","state":["REACHABLE"]}]',
            stderr="",
        )

        neighbors = read_neighbor_table()

        self.assertEqual(neighbors["192.168.1.10"], "AA:BB:CC:00:11:22")

    @patch("app.services.discovery.scanner.shutil.which", return_value="/usr/sbin/ip")
    @patch("app.services.discovery.scanner.subprocess.run")
    def test_read_neighbor_table_skips_failed_list_state_from_ip_json(self, mock_run, _mock_which) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='[{"dst":"192.168.1.10","lladdr":"aa:bb:cc:00:11:22","state":["FAILED"]}]',
            stderr="",
        )

        self.assertEqual(read_neighbor_table(), {})


if __name__ == "__main__":
    unittest.main()

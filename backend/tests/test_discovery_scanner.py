import subprocess
import unittest
from unittest.mock import patch

from app.services.discovery.scanner import (
    DiscoveryTarget,
    discovery_process_timeout_seconds,
    ping_host_timeout_seconds,
    port_scan_host_timeout_seconds,
    run_nmap_scan,
)


class DiscoveryScannerTests(unittest.TestCase):
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

    @patch("app.services.discovery.scanner.shutil.which", return_value="/usr/bin/nmap")
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

    @patch("app.services.discovery.scanner.shutil.which", return_value="/usr/bin/nmap")
    @patch("app.services.discovery.scanner.subprocess.run")
    def test_run_nmap_scan_returns_actionable_timeout_error(self, mock_run, _mock_which) -> None:
        mock_run.side_effect = subprocess.TimeoutExpired(
            cmd=["nmap"],
            timeout=190,
        )

        with self.assertRaises(RuntimeError) as exc:
            run_nmap_scan(DiscoveryTarget(nmap_target="10.30.20.0/24", host_count=256), "ping")

        self.assertIn("timed out after 190 seconds", str(exc.exception))


if __name__ == "__main__":
    unittest.main()

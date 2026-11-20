"""A failed `sudo nmap` must end the scan with a clear error, not an XML parse error."""

import subprocess
from unittest.mock import patch

import pytest

from app.services.discovery.scanner import DiscoveryTarget, run_nmap_scan

TARGET = DiscoveryTarget(nmap_target="10.30.20.0/24", host_count=256)


def _run(returncode: int, stdout: str, stderr: str):
    completed = subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)
    with patch("app.core.capabilities.shutil.which", return_value="/usr/bin/nmap"), \
            patch("app.services.discovery.scanner._run_nmap_process", return_value=completed):
        return run_nmap_scan(TARGET, "ping")


def test_sudo_without_an_account_names_the_puid_and_read_only_cause():
    with pytest.raises(RuntimeError) as caught:
        _run(1, "", "sudo: you do not exist in the passwd database\n")

    message = str(caught.value)
    assert "ParseError" not in type(caught.value).__name__
    assert "PUID" in message
    assert "read-only" in message


def test_other_nonzero_exit_without_results_reports_trimmed_stderr():
    with pytest.raises(RuntimeError) as caught:
        _run(1, "", "  Failed to open device eth9\n")

    assert str(caught.value) == "Nmap scan failed: Failed to open device eth9"


def test_nonzero_exit_without_output_has_a_generic_message():
    with pytest.raises(RuntimeError) as caught:
        _run(1, "", "")

    assert str(caught.value) == "Nmap scan failed (exit code 1)"


def test_empty_output_with_exit_zero_is_a_failure():
    with pytest.raises(RuntimeError) as caught:
        _run(0, "", "")

    assert str(caught.value) == "Nmap scan failed: no scan results were returned"


def test_truncated_xml_is_a_failure_not_a_parse_error():
    with pytest.raises(RuntimeError) as caught:
        _run(0, '<?xml version="1.0"?><nmaprun><host>', "")

    assert str(caught.value) == "Nmap scan failed: the scan results could not be read"


def test_long_stderr_is_trimmed():
    with pytest.raises(RuntimeError) as caught:
        _run(1, "", "x" * 2000)

    assert len(str(caught.value)) <= len("Nmap scan failed: ") + 300


def test_complete_results_still_parse():
    hosts = _run(0, "<nmaprun></nmaprun>", "")
    assert hosts == []

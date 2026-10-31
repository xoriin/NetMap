"""Discovery runs nmap with -n and resolves names with bounded parallel PTR lookups (#36)."""
from __future__ import annotations

import subprocess
import sys
import time

import pytest

from app.schemas.discovery import DiscoveryHost
from app.services.discovery import scanner
from app.services.discovery.scanner import DiscoveryTarget


def test_nmap_runs_without_reverse_dns_and_reports_progress(monkeypatch) -> None:
    calls: dict = {}

    def fake_process(command, timeout_seconds, on_progress=None, cancel_event=None):
        calls["command"] = command
        on_progress(256)
        return subprocess.CompletedProcess(command, 0, "<nmaprun></nmaprun>", "")

    seen: list[int] = []
    monkeypatch.setattr(scanner, "require_command", lambda *args: "/usr/bin/nmap")
    monkeypatch.setattr(scanner, "_run_nmap_process", fake_process)
    scanner.run_nmap_scan(DiscoveryTarget(nmap_target="10.30.20.0/24", host_count=256), "ping", on_progress=seen.append)
    assert "-n" in calls["command"]
    assert "-v" in calls["command"]
    assert seen == [256]


def test_nmap_process_streams_a_progress_count_per_address() -> None:
    script = "import sys,time\nfor i in range(3):\n    print('<host><status state=\"down\"/></host>', flush=True)\n    time.sleep(0.05)\n"
    seen: list[int] = []
    completed = scanner._run_nmap_process([sys.executable, "-c", script], 10, seen.append)
    assert completed.returncode == 0
    assert seen == [1, 2, 3]
    assert completed.stdout.count("<status") == 3


def test_nmap_process_times_out() -> None:


    with pytest.raises(subprocess.TimeoutExpired):
        scanner._run_nmap_process([sys.executable, "-c", "import time; time.sleep(5)"], 0.3)


def test_reverse_lookups_run_in_parallel_within_a_budget(monkeypatch) -> None:
    def fake_lookup(ip):
        if ip == "192.168.1.1":
            return ("router.lan.", [], [ip])
        if ip == "192.168.1.2":
            raise OSError("no PTR")
        time.sleep(2)
        return ("slow.lan", [], [ip])

    monkeypatch.setattr(scanner.socket, "gethostbyaddr", fake_lookup)
    hosts = [
        DiscoveryHost(ip_address="192.168.1.1"),
        DiscoveryHost(ip_address="192.168.1.2"),
        DiscoveryHost(ip_address="192.168.1.3"),
        DiscoveryHost(ip_address="192.168.1.4", hostname="kept.lan"),
    ]
    started = time.monotonic()
    resolved = scanner.resolve_hostnames(hosts, budget_seconds=0.5)
    assert time.monotonic() - started < 1.5
    assert [host.hostname for host in resolved] == ["router.lan", None, None, "kept.lan"]


def test_resolver_made_names_are_not_hostnames(monkeypatch) -> None:
    names = {"10.0.0.1": "_gateway", "10.0.0.2": "_outbound.", "10.0.0.3": "nas.lan"}
    monkeypatch.setattr(scanner.socket, "gethostbyaddr", lambda ip: (names[ip], [], [ip]))
    hosts = [DiscoveryHost(ip_address=ip) for ip in names]
    assert [host.hostname for host in scanner.resolve_hostnames(hosts)] == [None, None, "nas.lan"]

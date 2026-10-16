"""Fast guards for the real-container gate; Docker execution belongs to image CI."""
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "smoke-image.py"
spec = importlib.util.spec_from_file_location("image_smoke", SCRIPT)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def test_scenarios_cover_legacy_and_unset_values_without_conflating_them():
    cases = {name: (env, secure, warnings) for name, env, secure, warnings in smoke.scenarios()}
    assert len(cases) == 5
    unset, secure, warnings = cases["https-flags-unset"]
    assert "AUTH_COOKIE_SECURE" not in unset and "SECURE_HSTS_ENABLED" not in unset
    assert secure is True and warnings == 1
    legacy, secure, warnings = cases["https-legacy-false"]
    assert legacy["AUTH_COOKIE_SECURE"] == legacy["SECURE_HSTS_ENABLED"] == "false"
    assert secure is False and warnings == 2


def test_startup_crash_fails_instead_of_accepting_an_image_build(monkeypatch):
    def docker(*args):
        return json.dumps({"Running": False, "ExitCode": 3}) if args[0] == "inspect" else "startup failed"
    monkeypatch.setattr(smoke, "docker", docker)
    with pytest.raises(RuntimeError, match=r"exited \(3\).*",):
        smoke.wait_ready("smoke-container")


@pytest.mark.parametrize("changes", [
    {"integrity": "corrupt"}, {"marker": "lost"}, {"user": None},
    {"user": ["image_smoke_user", "Viewer", 0]}, {"migrations": []},
])
def test_upgrade_rejects_corruption_data_loss_and_missing_migrations(monkeypatch, changes):
    result = {"integrity": "ok", "marker": "preserve", "user": ["image_smoke_user", "SuperAdmin", 0], "migrations": ["old", "new"]} | changes
    responses = iter([json.dumps(result), json.dumps(["old", "new"])])
    monkeypatch.setattr(smoke, "execute", lambda *args: next(responses))
    with pytest.raises(RuntimeError):
        smoke.verify_upgrade("smoke", "preserve", ["old"])


def test_upgrade_requires_the_candidate_migrations_not_only_old_history(monkeypatch):
    responses = iter([
        json.dumps({"integrity": "ok", "marker": "preserve", "user": ["image_smoke_user", "SuperAdmin", 0], "migrations": ["old"]}),
        json.dumps(["old", "new"]),
    ])
    monkeypatch.setattr(smoke, "execute", lambda *args: next(responses))
    with pytest.raises(RuntimeError, match="all registered migrations"):
        smoke.verify_upgrade("smoke", "preserve", ["old"])


def test_volume_cleanup_targets_only_its_own_unique_volume_even_on_failure(monkeypatch):
    calls = []
    monkeypatch.setattr(smoke, "docker", lambda *args: calls.append(args))
    with pytest.raises(ValueError), smoke.volume() as name:
        assert name.startswith("netmap-upgrade-smoke-")
        raise ValueError("failed check")
    assert calls == [("volume", "create", name), ("volume", "rm", name)]


def test_publication_requires_both_image_smoke_platforms():
    workflow = (SCRIPT.parents[1] / ".github/workflows/docker-aio.yml").read_text()
    assert "arch: [amd64, arm64]" in workflow
    assert "needs: [tests, image-smoke, release-guard]" in workflow
    assert "needs.image-smoke.result == 'success'" in workflow
    assert 'scripts/smoke-image.py netmap:compatibility --previous-image "$IMAGE_NAME:latest"' in workflow

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check-release.py"
_spec = importlib.util.spec_from_file_location("check_release", SCRIPT)
check_release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_release)

READY_CHANGELOG = "# Changelog\n\n## Unreleased\n\n## [1.7.0] - 2026-10-20\n\n### Added\n- Something.\n\n## [1.6.0] - 2026-08-25\n\n### Added\n- Older.\n"
MAIN_LOGO = 'DEFAULT_LOGO_URL = "https://raw.githubusercontent.com/xoriin/NetMap/main/frontend/public/brand/email-logo.png"\n'


def _repo(tmp_path, *, version="1.7.0", changelog=READY_CHANGELOG, logo=MAIN_LOGO):
    (tmp_path / "VERSION").write_text(version + "\n")
    (tmp_path / "CHANGELOG.md").write_text(changelog)
    logo_file = tmp_path / check_release.LOGO_SOURCE
    logo_file.parent.mkdir(parents=True)
    logo_file.write_text(logo)
    return tmp_path


def test_a_ready_release_has_no_problems(tmp_path):
    assert check_release.problems(_repo(tmp_path), "v1.7.0") == []


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"version": "1.6.0"}, "VERSION is '1.6.0', expected '1.7.0'"),
        ({"changelog": READY_CHANGELOG.replace("## [1.7.0]", "## [1.7.1]")}, "no non-empty ## [1.7.0] section"),
        ({"changelog": "## Unreleased\n\n## [1.7.0] - 2026-10-20\n\n## [1.6.0] - 2026-08-25\n- Older.\n"}, "no non-empty ## [1.7.0] section"),
        ({"changelog": READY_CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- Pending fix.\n")}, "entries under ## Unreleased"),
        ({"logo": MAIN_LOGO.replace("/main/", "/test/")}, "still points at the test branch"),
    ],
)
def test_each_unready_condition_is_reported(tmp_path, overrides, expected):
    found = check_release.problems(_repo(tmp_path, **overrides), "v1.7.0")
    assert len(found) == 1 and expected in found[0]


def test_the_current_tree_is_not_mistaken_for_a_release(tmp_path):
    root = SCRIPT.parents[1]
    version = (root / "VERSION").read_text().strip()
    assert check_release.problems(root, "v99.0.0")
    assert any("VERSION" in p for p in check_release.problems(root, f"v{version}.1"))

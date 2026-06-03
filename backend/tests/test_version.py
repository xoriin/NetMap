from pathlib import Path
from unittest.mock import patch

from app.api.v1.system import _version_tuple
from app.core.config import installed_app_channel, installed_app_version


def test_installed_version_prefers_version_file_over_environment(tmp_path: Path) -> None:
    version_file = tmp_path / "VERSION"
    version_file.write_text("1.2.3\n")

    with patch("app.core.config.VERSION_FILE_CANDIDATES", (version_file,)):
        assert installed_app_version("9.9.9") == "1.2.3"


def test_installed_version_falls_back_to_configured_value_when_file_missing(tmp_path: Path) -> None:
    with patch("app.core.config.VERSION_FILE_CANDIDATES", (tmp_path / "missing",)):
        assert installed_app_version("9.9.9") == "9.9.9"


def test_installed_channel_reads_channel_file(tmp_path: Path) -> None:
    channel_file = tmp_path / "VERSION_CHANNEL"
    channel_file.write_text("Test\n")

    with patch("app.core.config.VERSION_CHANNEL_FILE_CANDIDATES", (channel_file,)):
        assert installed_app_channel() == "Test"


def test_version_tuple_allows_ahead_of_latest_comparison() -> None:
    assert _version_tuple("1.2.7") > _version_tuple("1.2.6")  # type: ignore[operator]

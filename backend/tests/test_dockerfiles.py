import re
import tomllib
from pathlib import Path

import pytest

DOCKER = Path(__file__).resolve().parents[2] / "docker"


def _pip_packages(dockerfile: str) -> dict[str, str]:
    text = (DOCKER / dockerfile).read_text()
    specs = re.findall(r'^\s+"([A-Za-z][^"]*)"\s*\\?$', text, re.MULTILINE)
    return {re.split(r"[\[<>=~!]", spec, maxsplit=1)[0].lower(): spec for spec in specs}


def test_the_standalone_backend_image_installs_the_same_packages_as_the_aio_image():
    assert _pip_packages("backend.Dockerfile") == _pip_packages("aio.Dockerfile")


@pytest.mark.parametrize("requirement", ["mako>=1.4.2", "pillow>=13.0.0", "certifi>=2026.10.19"])
def test_security_floors_are_enforced_in_development_and_both_images(requirement):
    # Keep independently resolved image installs aligned with the audited dev requirements.
    project = tomllib.loads((DOCKER.parent / "backend" / "pyproject.toml").read_text())
    assert requirement in project["project"]["dependencies"]
    for dockerfile in ("aio.Dockerfile", "backend.Dockerfile"):
        assert _pip_packages(dockerfile).get(requirement.split(">=")[0]) == requirement

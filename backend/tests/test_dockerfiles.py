import re
from pathlib import Path

DOCKER = Path(__file__).resolve().parents[2] / "docker"


def _pip_packages(dockerfile: str) -> dict[str, str]:
    text = (DOCKER / dockerfile).read_text()
    specs = re.findall(r'^\s+"([A-Za-z][^"]*)"\s*\\?$', text, re.MULTILINE)
    return {re.split(r"[\[<>=~!]", spec, maxsplit=1)[0].lower(): spec for spec in specs}


def test_the_standalone_backend_image_installs_the_same_packages_as_the_aio_image():
    assert _pip_packages("backend.Dockerfile") == _pip_packages("aio.Dockerfile")

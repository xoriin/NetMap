import re
from pathlib import Path

import pytest

TEMPLATE = Path(__file__).resolve().parents[2] / "docker" / "aio-nginx.conf.template"


def _location(name: str) -> str:
    if not TEMPLATE.exists():
        pytest.skip("nginx template is not part of this checkout")
    match = re.search(r"location " + re.escape(name) + r" \{(.*?)\n    \}", TEMPLATE.read_text(), re.S)
    assert match, f"location {name} missing"
    return match.group(1)


def test_hashed_assets_are_cached_for_a_year_and_never_fall_back_to_the_page():
    block = _location("/assets/")
    assert 'Cache-Control "public, max-age=31536000, immutable"' in block
    assert "try_files $uri =404;" in block


def test_the_page_itself_is_always_revalidated():
    block = _location("/")
    assert 'Cache-Control "no-cache"' in block
    assert "try_files $uri $uri/ /index.html;" in block


def test_api_responses_get_no_static_cache_header():
    assert "Cache-Control" not in _location("/api/")

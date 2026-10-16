#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services.changelog import extract_release_section  # noqa: E402

LOGO_SOURCE = Path("backend/app/services/email_templates.py")


def problems(root: Path, tag: str) -> list[str]:
    version = tag.removeprefix("v")
    found = []

    version_file = root / "VERSION"
    current = version_file.read_text(encoding="utf-8").strip() if version_file.exists() else ""
    if current != version:
        found.append(f"VERSION is {current or 'missing'!r}, expected {version!r}")

    changelog_file = root / "CHANGELOG.md"
    changelog = changelog_file.read_text(encoding="utf-8") if changelog_file.exists() else ""
    section = extract_release_section(changelog, tag) or ""
    if not section.partition("\n")[2].strip():
        found.append(f"CHANGELOG.md has no non-empty ## [{version}] section")
    unreleased = re.search(r"^## Unreleased[ \t]*\n(.*?)(?=^## |\Z)", changelog, re.MULTILINE | re.DOTALL)
    if unreleased and unreleased.group(1).strip():
        found.append("CHANGELOG.md still has entries under ## Unreleased")

    logo = root / LOGO_SOURCE
    if logo.exists() and "/NetMap/test/" in logo.read_text(encoding="utf-8"):
        found.append(f"{LOGO_SOURCE} DEFAULT_LOGO_URL still points at the test branch")

    return found


def main() -> int:
    parser = argparse.ArgumentParser(description="Refuse to publish a release tag whose files are not release-ready.")
    parser.add_argument("tag", help="Release tag (e.g. v1.7.0)")
    parser.add_argument("--root", type=Path, default=ROOT, help="Repository root (default: this checkout)")
    args = parser.parse_args()

    found = problems(args.root, args.tag)
    for problem in found:
        print(f"::error::{problem}")
    if not found:
        print(f"{args.tag} is release-ready")
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Keep workflow tokens read-only unless a job needs an explicit write grant."""

import re
from pathlib import Path

import pytest

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"


@pytest.mark.parametrize("workflow", sorted(WORKFLOWS.glob("*.yml")), ids=lambda p: p.name)
def test_workflows_default_to_read_only_contents(workflow):
    # Match a top-level block, so a single protected job cannot mask an unsafe
    # inherited default for sibling jobs or reusable workflow calls.
    match = re.search(r"^permissions:\n((?:[ \t]+[^\n]*\n)+)", workflow.read_text(), re.M)
    assert match is not None, f"{workflow.name} needs explicit default token permissions"
    assert match.group(1).strip() == "contents: read"


def test_only_release_publication_can_write_repository_contents():
    workflow = (WORKFLOWS / "docker-aio.yml").read_text()
    jobs = dict(re.findall(r"^  ([\w-]+):\n(.*?)(?=^  [\w-]+:|\Z)", workflow.split("\njobs:\n", 1)[1], re.M | re.S))
    writers = {name for name, body in jobs.items() if re.search(r"^      \w+: write$", body, re.M)}
    assert writers == {"release"}
    assert "contents: write" in jobs["release"]
    assert "if: startsWith(github.ref, 'refs/tags/v')" in jobs["release"]

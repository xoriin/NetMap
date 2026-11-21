"""Guards for the all-in-one container settings.

The shipped compose files keep Docker's default capabilities and a writable
root until 2.0, so upgrades need no compose edits. The image still supports a
read-only root with minimal capabilities for anyone who opts in.
"""

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
DOCKER = ROOT / "docker"
SHIPPED_COMPOSE = ("docker-compose.yml", "docker-compose.example.yml", "docker-compose.build.yml")


def _aio_services():
    found = []
    for name in SHIPPED_COMPOSE:
        path = ROOT / name
        if not path.exists():
            continue
        service = (yaml.safe_load(path.read_text()).get("services") or {}).get("netmap")
        if service is not None:  # dev/ keeps a separate two-service compose.yml
            found.append(pytest.param(service, id=name))
    return found


@pytest.mark.parametrize("service", _aio_services())
def test_shipped_compose_keeps_default_capabilities_and_a_writable_root(service):
    # cap_drop: ALL without CHOWN/SETUID/SETGID stops every released image from starting.
    assert "cap_drop" not in service
    assert "cap_add" not in service
    assert "read_only" not in service
    # no-new-privileges blocks `sudo nmap`, so discovery scans would fail.
    assert not any("no-new-privileges" in opt for opt in service.get("security_opt", []))


def test_example_compose_exists_with_the_aio_service():
    assert _aio_services(), "docker-compose.example.yml must define the netmap service"


def test_image_user_matches_the_documented_puid_pgid():
    dockerfile = (DOCKER / "aio.Dockerfile").read_text()
    assert "addgroup --system --gid 1000 netmap" in dockerfile
    assert "adduser --system --uid 1000 --ingroup netmap netmap" in dockerfile


def test_image_keeps_the_pre_1_8_2_identity_with_sudo_for_nmap():
    dockerfile = (DOCKER / "aio.Dockerfile").read_text()
    assert "addgroup --system --gid 101 netmap-legacy" in dockerfile
    assert "adduser --system --uid 100 --ingroup netmap-legacy" in dockerfile
    assert '"netmap-legacy ALL=(root) NOPASSWD: /usr/bin/nmap"' in dockerfile


def test_entrypoint_never_reowns_existing_data_without_puid():
    script = (DOCKER / "aio-entrypoint.sh").read_text()
    # Existing data keeps its owner (upgrade + downgrade safe), with a migration notice.
    assert 'data_uid="$(stat -c %u /app/data/netmap.db)"' in script
    assert "reown_data=0" in script
    assert "set PUID=1000 and PGID=1000, or chown -R 1000:1000" in script
    assert 'if [ "${reown_data}" = 1 ]; then\n    chown -R' in script
    # Known identities run by name so sudo works on a read-only root filesystem.
    assert "app_user=netmap-legacy" in script
    # Unknown IDs on a read-only /etc run numerically and warn instead of exiting.
    assert 'groupmod -o -g "${want_gid}" netmap 2>/dev/null || remapped=0' in script
    assert 'usermod -o -u "${want_uid}" netmap 2>/dev/null || remapped=0' in script
    assert 'setpriv --reuid="${app_uid}" --regid="${app_gid}" --clear-groups "$@"' in script


def test_entrypoint_works_on_a_read_only_root():
    script = (DOCKER / "aio-entrypoint.sh").read_text()
    # Without DAC_OVERRIDE root cannot write into netmap's directory, so netmap creates them.
    assert "as_netmap mkdir -p /tmp/nginx/client_body" in script
    assert "as_app uvicorn app.main:app" in script
    # nginx must not open the packaged error log on the read-only root.
    assert "nginx -e stderr -c /tmp/nginx.generated.conf" in script

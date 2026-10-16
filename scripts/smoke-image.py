#!/usr/bin/env python3
"""Boot real AIO images on disposable storage before publishing them (stdlib only)."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import json
import secrets
import subprocess
import time
import uuid


def docker(*args: str, check: bool = True) -> str:
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=180)
    if check and result.returncode:
        raise RuntimeError(f"docker {args[0]} failed: {result.stderr.strip()}")
    return (result.stdout + (result.stderr if args[0] == "logs" else "")).strip()


def execute(container: str, code: str) -> str:
    return docker("exec", container, "python3", "-c", code)


def wait_ready(container: str, timeout: float = 180) -> None:
    deadline = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < deadline:
        state = json.loads(docker("inspect", "--format", "{{json .State}}", container))
        if not state["Running"]:
            raise RuntimeError(f"container exited ({state['ExitCode']}):\n{docker('logs', '--tail', '60', container)}")
        try:
            execute(container, "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)")
            return
        except RuntimeError as error:
            last_error = str(error)
            time.sleep(1)
    raise RuntimeError(f"API did not become healthy: {last_error}\n{docker('logs', '--tail', '60', container)}")


@contextmanager
def volume():
    name = "netmap-upgrade-smoke-" + uuid.uuid4().hex
    docker("volume", "create", name)
    try:
        yield name
    finally:
        # Only the unique volume created by this invocation is removed.
        docker("volume", "rm", name)


@contextmanager
def running(image: str, storage: str, environment: dict[str, str], platform: str):
    name = "netmap-image-smoke-" + uuid.uuid4().hex
    arguments = ["run", "--detach", "--name", name, "--platform", platform,
                 "--mount", f"type=volume,src={storage},dst=/app/data"]
    for key, value in environment.items():
        arguments.extend(["--env", f"{key}={value}"])
    # No host ports, host network, live storage, restart policy or monitoring targets.
    try:
        docker(*arguments, image)
        wait_ready(name)
        yield name
    finally:
        docker("rm", "--force", "--volumes", name, check=False)


def scenarios() -> list[tuple[str, dict[str, str], bool, int]]:
    return [
        ("fresh-http", {"APP_URL": "http://smoke.invalid"}, False, 0),
        ("https-flags-unset", {"APP_URL": "https://smoke.invalid"}, True, 1),
        ("https-legacy-false", {"APP_URL": "https://smoke.invalid", "AUTH_COOKIE_SECURE": "false",
                               "SECURE_HSTS_ENABLED": "false"}, False, 2),
        ("https-headers-disabled", {"APP_URL": "https://smoke.invalid", "SECURE_HEADERS_ENABLED": "false",
                                   "SECURE_HSTS_ENABLED": "true"}, True, 1),
        ("https-compliant", {"APP_URL": "https://smoke.invalid", "AUTH_COOKIE_SECURE": "true",
                             "SECURE_HSTS_ENABLED": "true"}, True, 0),
    ]


def verify_security(container: str, secure: bool, warning_count: int) -> None:
    result = json.loads(execute(container, """
import json
from app.core.config import settings
from app.core.runtime_security import https_security_warnings
from app.api.v1.auth import _set_auth_cookies
from fastapi import Response
response = Response()
_set_auth_cookies(response, 'smoke-access', 'smoke-refresh')
print(json.dumps({'secure': settings.auth_cookies_secure,
                  'warnings': https_security_warnings(),
                  'cookies': response.headers.getlist('set-cookie')}))
"""))
    if result["secure"] != secure or len(result["warnings"]) != warning_count:
        raise RuntimeError(f"unexpected runtime security configuration: {result}")
    if not result["cookies"] or any(("; secure" in cookie.lower()) != secure for cookie in result["cookies"]):
        raise RuntimeError("effective Secure cookie flags do not match the configuration")
    logs = docker("logs", container)
    if any(warning not in logs for warning in result["warnings"]):
        raise RuntimeError("a runtime warning was not emitted at startup")
    # Catch post-readiness exits rather than accepting a momentary health response.
    time.sleep(3)
    wait_ready(container, timeout=15)


def seed(container: str, marker: str) -> list[str]:
    return json.loads(execute(container, f"""
import json, sqlite3
from datetime import datetime, timezone
from app.core.security import hash_password
db = sqlite3.connect('/app/data/netmap.db')
now = datetime.now(timezone.utc).isoformat()
# Use the released database schema, not a current-only ORM initialization helper.
values = dict(username='image_smoke_user', password_hash=hash_password({marker!r}),
              role='SuperAdmin', is_active=0, created_at=now, updated_at=now,
              entity_colors_enabled=1)
columns = [row[1] for row in db.execute('PRAGMA table_info(users)') if row[1] in values]
db.execute('INSERT INTO users (' + ','.join(columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')',
           [values[column] for column in columns])
db.execute('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)',
           ('image_smoke_preservation', {marker!r}, datetime.now(timezone.utc).isoformat()))
db.commit()
print(json.dumps([row[0] for row in db.execute('SELECT name FROM schema_migrations ORDER BY name')]))
"""))


def verify_upgrade(container: str, marker: str, old_migrations: list[str]) -> None:
    result = json.loads(execute(container, """
import json, sqlite3
db = sqlite3.connect('/app/data/netmap.db')
print(json.dumps({'integrity': db.execute('PRAGMA integrity_check').fetchone()[0],
 'marker': db.execute("SELECT value FROM system_settings WHERE key='image_smoke_preservation'").fetchone()[0],
 'user': db.execute("SELECT username, role, is_active FROM users WHERE username='image_smoke_user'").fetchone(),
 'migrations': [row[0] for row in db.execute('SELECT name FROM schema_migrations ORDER BY name')]}))
"""))
    if result["integrity"] != "ok" or result["marker"] != marker:
        raise RuntimeError("upgrade corrupted or lost persisted data")
    if result["user"] != ["image_smoke_user", "SuperAdmin", 0]:
        raise RuntimeError("upgrade lost or changed the existing user")
    if not set(old_migrations).issubset(result["migrations"]):
        raise RuntimeError("upgrade lost migration history")
    # Compare against the actual candidate registry, not a stale hard-coded high-water mark.
    expected = json.loads(execute(container, r"""
import json, re
from pathlib import Path
print(json.dumps(re.findall(r'_run_migration\(conn, inspector, "([^"]+)"', Path('app/db/session.py').read_text())))
"""))
    if not expected or not set(expected).issubset(result["migrations"]):
        raise RuntimeError("candidate did not record all registered migrations")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--previous-image", required=True, help="Previously published stable image (normally :latest)")
    parser.add_argument("--platform", default="linux/amd64")
    args = parser.parse_args()
    environment = {"APP_ENV": "production", "APP_PORT": "8080",
                   "SECRET_KEY": secrets.token_urlsafe(48),
                   "MASTER_KEY": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
                   "TRUSTED_HOSTS": '["127.0.0.1","localhost","smoke.invalid"]'}
    for label, settings, secure, warnings in scenarios():
        with volume() as storage, running(args.image, storage, environment | settings, args.platform) as container:
            verify_security(container, secure, warnings)
        print(f"PASS {args.platform}: {label}", flush=True)
    docker("pull", "--platform", args.platform, args.previous_image)
    print(f"Upgrade baseline: {docker('image', 'inspect', '--format', '{{json .RepoDigests}}', args.previous_image)}", flush=True)
    legacy = environment | {"APP_URL": "https://smoke.invalid", "AUTH_COOKIE_SECURE": "false", "SECURE_HSTS_ENABLED": "false"}
    marker = secrets.token_hex(16)
    with volume() as storage:
        with running(args.previous_image, storage, legacy, args.platform) as previous:
            old_migrations = seed(previous, marker)
        with running(args.image, storage, legacy, args.platform) as candidate:
            verify_security(candidate, False, 2)
            verify_upgrade(candidate, marker, old_migrations)
        # Restart tests migration idempotence against the already upgraded database.
        with running(args.image, storage, legacy, args.platform) as candidate:
            verify_upgrade(candidate, marker, old_migrations)
    print(f"PASS {args.platform}: stable-image upgrade, preserved data, integrity and restart", flush=True)


if __name__ == "__main__":
    main()

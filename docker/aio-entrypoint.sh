#!/usr/bin/env bash
set -euo pipefail

# Run a command as the netmap user. When the container itself was started as a
# non-root user (compose `user:`), there is nothing to drop.
as_netmap() {
  if [ "$(id -u)" = 0 ]; then
    setpriv --reuid=netmap --regid=netmap --init-groups "$@"
  else
    "$@"
  fi
}

# Remap the internal netmap user to match the host's PUID/PGID if provided.
# This lets the container write to bind-mounted volumes owned by the host user.
# Skip it when the IDs already match (the image user is 1000:1000), so a
# read-only root filesystem never needs to rewrite /etc/passwd or /etc/group.
if [ "$(id -u)" = 0 ]; then
  if [ -n "${PGID:-}" ] && [ "${PGID}" != "$(id -g netmap)" ]; then
    groupmod -o -g "${PGID}" netmap \
      || echo "netmap: could not change the netmap group to PGID ${PGID} (read-only root filesystem?); keeping GID $(id -g netmap)" >&2
  fi
  if [ -n "${PUID:-}" ] && [ "${PUID}" != "$(id -u netmap)" ]; then
    usermod -o -u "${PUID}" netmap \
      || echo "netmap: could not change the netmap user to PUID ${PUID} (read-only root filesystem?); keeping UID $(id -u netmap)" >&2
  fi
fi

chown -R netmap:netmap /app/data 2>/dev/null || echo "netmap: skipping chown of /app/data (not permitted); assuming already writable" >&2
# nginx temp paths live under /tmp so the root filesystem can be read-only.
# Root creates the parent (a fresh tmpfs has none), hands it to netmap, and the
# netmap user creates the rest, so no DAC_OVERRIDE capability is needed.
mkdir -p /tmp/nginx
chown -R netmap:netmap /tmp/nginx 2>/dev/null || echo "netmap: skipping chown of /tmp/nginx (not permitted); assuming already writable" >&2
as_netmap mkdir -p /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi

envsubst '${APP_PORT}' < /etc/netmap/aio-nginx.conf.template > /tmp/nginx.generated.conf

# Trust X-Forwarded-For / X-Forwarded-Proto only from TRUSTED_PROXY_IPS (JSON
# list or comma-separated addresses/CIDRs). Invalid entries are skipped.
python3 - > /tmp/nginx-realip.conf <<'PY'
import ipaddress
import json
import os
import sys

raw = os.environ.get("TRUSTED_PROXY_IPS", "").strip()
try:
    entries = json.loads(raw) if raw.startswith("[") else raw.split(",")
except ValueError:
    entries = []
networks = []
for entry in entries:
    try:
        networks.append(str(ipaddress.ip_network(str(entry).strip(), strict=False)))
    except ValueError:
        if str(entry).strip():
            print(f"netmap: ignoring invalid TRUSTED_PROXY_IPS entry {entry!r}", file=sys.stderr)
for network in networks:
    print(f"set_real_ip_from {network};")
if networks:
    print("real_ip_header X-Forwarded-For;")
    print("real_ip_recursive on;")
print("geo $realip_remote_addr $netmap_trusted_upstream {")
print("  default 0;")
for network in networks:
    print(f"  {network} 1;")
print("}")
PY

# A restarted container can retain the old Unix socket even though no Uvicorn
# process is listening on it. Never let nginx mistake that stale path for a
# ready backend.
# The socket belongs to netmap and /tmp is sticky, so netmap removes it.
as_netmap rm -f /tmp/uvicorn.sock 2>/dev/null || rm -f /tmp/uvicorn.sock

as_netmap uvicorn app.main:app \
  --uds /tmp/uvicorn.sock \
  --proxy-headers \
  --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" \
  --log-level "${LOG_LEVEL:-info}" &
uvicorn_pid="$!"

# Database migrations complete during application startup, before Uvicorn
# creates its socket. Keep nginx stopped until the backend is genuinely ready
# so its health endpoint cannot proxy to a missing socket during upgrades.
startup_deadline=$((SECONDS + 300))
while [ ! -S /tmp/uvicorn.sock ]; do
  if ! kill -0 "$uvicorn_pid" 2>/dev/null; then
    echo "netmap: backend exited before creating /tmp/uvicorn.sock" >&2
    if wait "$uvicorn_pid"; then
      exit 0
    else
      exit $?
    fi
  fi
  if (( SECONDS >= startup_deadline )); then
    echo "netmap: backend did not become ready within 300 seconds" >&2
    kill -TERM "$uvicorn_pid" 2>/dev/null || true
    wait "$uvicorn_pid" 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done

# -e stderr: never open the packaged /var/log/nginx/error.log (read-only root).
nginx -e stderr -c /tmp/nginx.generated.conf -g "daemon off;" &
nginx_pid="$!"

shutdown() {
  kill -TERM "$uvicorn_pid" "$nginx_pid" 2>/dev/null || true
  wait "$uvicorn_pid" "$nginx_pid" 2>/dev/null || true
}

trap shutdown TERM INT

print_startup_banner() {
  local banner_width=76
  local banner_border banner_line line_length left_padding right_padding
  local banner_lines=(
    ''
    '       (O)         _   _      _   __  __             '
    '      /   \       | \ | | ___| |_|  \/  | __ _ _ __  '
    '     /     \      |  \| |/ _ \ __| |\/| |/ _` | `_ \ '
    '    /       \     | |\  |  __/ |_| |  | | (_| | |_) |'
    '  (O)-------(O)   |_| \_|\___|\__|_|  |_|\__,_| .__/ '
    '                                               |_|    '
    ''
    "netmap: startup complete — ready on port ${APP_PORT}"
    'Documentation: https://docs.netmap.dev/'
    ''
  )

  printf -v banner_border '%*s' "$banner_width" ''
  banner_border=${banner_border// /-}
  printf '\n+%s+\n' "$banner_border"
  for banner_line in "${banner_lines[@]}"; do
    line_length=${#banner_line}
    left_padding=$(( (banner_width - line_length) / 2 ))
    right_padding=$(( banner_width - line_length - left_padding ))
    printf '|%*s%s%*s|\n' "$left_padding" '' "$banner_line" "$right_padding" ''
  done
  printf '+%s+\n\n' "$banner_border"
}

# Confirm the public container endpoint can traverse nginx and reach Uvicorn
# before announcing readiness. This is the same path Docker health-checks.
readiness_deadline=$((SECONDS + 15))
while true; do
  if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${APP_PORT}/api/health', timeout=1).read()" >/dev/null 2>&1; then
    print_startup_banner
    break
  fi
  if ! kill -0 "$uvicorn_pid" 2>/dev/null || ! kill -0 "$nginx_pid" 2>/dev/null; then
    echo "netmap: a service exited before the health endpoint became ready" >&2
    shutdown
    exit 1
  fi
  if (( SECONDS >= readiness_deadline )); then
    echo "netmap: health endpoint did not become ready within 15 seconds" >&2
    shutdown
    exit 1
  fi
  sleep 0.25
done

while true; do
  if ! kill -0 "$uvicorn_pid" 2>/dev/null; then
    shutdown
    wait "$uvicorn_pid"
    exit $?
  fi
  if ! kill -0 "$nginx_pid" 2>/dev/null; then
    shutdown
    wait "$nginx_pid"
    exit $?
  fi
  sleep 1
done

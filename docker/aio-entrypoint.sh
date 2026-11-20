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

# Choose the identity the backend runs as:
#   1. explicit PUID/PGID win;
#   2. otherwise existing data keeps its current owner (installs from before
#      1.8.2 ran as 100:101), so an upgrade never re-owns it and a downgrade
#      still works;
#   3. otherwise (a fresh install) the image user, 1000:1000.
# Known identities run by name (netmap, or netmap-legacy for 100:101), so sudo
# and nmap work even on a read-only root filesystem. Any other identity is
# added by remapping netmap, which needs a writable /etc; when /etc is
# read-only the backend still runs as that numeric ID, but without an account
# sudo refuses it, so discovery scans are unavailable until the IDs change.
app_user=""
app_uid=""
app_gid=""
if [ "$(id -u)" = 0 ]; then
  default_uid="$(id -u netmap)"
  default_gid="$(id -g netmap)"
  want_uid="${PUID:-}"
  want_gid="${PGID:-}"
  reown_data=1
  if [ -z "${want_uid}" ] && [ -z "${want_gid}" ] && [ -e /app/data/netmap.db ]; then
    data_uid="$(stat -c %u /app/data/netmap.db)"
    data_gid="$(stat -c %g /app/data/netmap.db)"
    if [ "${data_uid}" != 0 ] && { [ "${data_uid}" != "${default_uid}" ] || [ "${data_gid}" != "${default_gid}" ]; }; then
      want_uid="${data_uid}"
      want_gid="${data_gid}"
      reown_data=0
      echo "netmap: existing data in /app/data is owned by ${data_uid}:${data_gid}, so NetMap keeps running as ${data_uid}:${data_gid}. New installs run as 1000:1000; to move to it, set PUID=1000 and PGID=1000, or chown -R 1000:1000 the data directory." >&2
    fi
  fi
  want_uid="${want_uid:-${default_uid}}"
  want_gid="${want_gid:-${default_gid}}"

  if [ "${want_uid}" = "${default_uid}" ] && [ "${want_gid}" = "${default_gid}" ]; then
    app_user=netmap
  elif [ "${want_uid}" = "$(id -u netmap-legacy)" ] && [ "${want_gid}" = "$(id -g netmap-legacy)" ]; then
    app_user=netmap-legacy
  else
    remapped=1
    if [ "${want_gid}" != "${default_gid}" ]; then
      groupmod -o -g "${want_gid}" netmap 2>/dev/null || remapped=0
    fi
    if [ "${remapped}" = 1 ] && [ "${want_uid}" != "${default_uid}" ]; then
      usermod -o -u "${want_uid}" netmap 2>/dev/null || remapped=0
    fi
    if [ "${remapped}" = 1 ]; then
      app_user=netmap
    else
      echo "netmap: WARNING: cannot create an account for ${want_uid}:${want_gid} on a read-only root filesystem. NetMap runs as ${want_uid}:${want_gid}, but discovery scans (sudo nmap) are unavailable. To restore them, use PUID=1000/PGID=1000 (chown -R 1000:1000 the data directory) or remove read_only." >&2
    fi
  fi
  app_uid="${want_uid}"
  app_gid="${want_gid}"

  if [ "${reown_data}" = 1 ]; then
    chown -R "${app_uid}:${app_gid}" /app/data 2>/dev/null || echo "netmap: skipping chown of /app/data (not permitted); assuming already writable" >&2
  fi
else
  echo "netmap: started as $(id -u):$(id -g); PUID/PGID are ignored and /app/data must already be writable" >&2
fi

# Run a command as the backend identity chosen above.
as_app() {
  if [ "$(id -u)" != 0 ]; then
    "$@"
  elif [ -n "${app_user}" ]; then
    setpriv --reuid="${app_user}" --regid="${app_user}" --init-groups "$@"
  else
    setpriv --reuid="${app_uid}" --regid="${app_gid}" --clear-groups "$@"
  fi
}

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
# The socket belongs to the backend identity and /tmp is sticky, so it removes it.
as_app rm -f /tmp/uvicorn.sock 2>/dev/null || rm -f /tmp/uvicorn.sock

# Uvicorn makes the socket 0666, so nginx workers (netmap) reach it whatever
# identity the backend runs as.
as_app uvicorn app.main:app \
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

#!/usr/bin/env bash
set -euo pipefail

# Remap the internal netmap user to match the host's PUID/PGID if provided.
# This lets the container write to bind-mounted volumes owned by the host user.
if [ -n "${PGID:-}" ]; then
  groupmod -o -g "${PGID}" netmap
fi
if [ -n "${PUID:-}" ]; then
  usermod -o -u "${PUID}" netmap
fi

chown -R netmap:netmap /app/data 2>/dev/null || echo "netmap: skipping chown of /app/data (not permitted); assuming already writable" >&2
mkdir -p /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi
chown -R netmap:netmap /tmp/nginx 2>/dev/null || echo "netmap: skipping chown of /tmp/nginx (not permitted); assuming already writable" >&2

envsubst '${APP_PORT}' < /etc/netmap/aio-nginx.conf.template > /tmp/nginx.generated.conf

# A restarted container can retain the old Unix socket even though no Uvicorn
# process is listening on it. Never let nginx mistake that stale path for a
# ready backend.
rm -f /tmp/uvicorn.sock

gosu netmap uvicorn app.main:app \
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

nginx -c /tmp/nginx.generated.conf -g "daemon off;" &
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

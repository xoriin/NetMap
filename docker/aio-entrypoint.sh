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

gosu netmap uvicorn app.main:app \
  --uds /tmp/uvicorn.sock \
  --proxy-headers \
  --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" \
  --log-level "${LOG_LEVEL:-info}" &
uvicorn_pid="$!"

# Wait for the socket file to appear before starting nginx.
for _i in $(seq 1 30); do
  [ -S /tmp/uvicorn.sock ] && break
  sleep 0.5
done

nginx -c /tmp/nginx.generated.conf -g "daemon off;" &
nginx_pid="$!"

shutdown() {
  kill -TERM "$uvicorn_pid" "$nginx_pid" 2>/dev/null || true
  wait "$uvicorn_pid" "$nginx_pid" 2>/dev/null || true
}

trap shutdown TERM INT

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

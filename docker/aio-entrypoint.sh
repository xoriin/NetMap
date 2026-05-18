#!/usr/bin/env bash
set -euo pipefail

mkdir -p /app/data /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi

uvicorn app.main:app \
  --host 127.0.0.1 \
  --port 8000 \
  --proxy-headers \
  --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" \
  --log-level "${LOG_LEVEL:-info}" &
uvicorn_pid="$!"

nginx -g "daemon off;" &
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

#!/bin/sh
set -eu

export BACKEND_URL="${BACKEND_URL:-http://backend:8000}"
mkdir -p /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi
envsubst '${BACKEND_URL}' < /etc/nginx/templates/netmap.conf.template > /tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g "daemon off;"

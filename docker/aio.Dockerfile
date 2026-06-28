FROM node:22-alpine AS frontend-builder

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM python:3.12-slim AS runtime

ARG APP_VERSION=dev
ARG APP_CHANNEL=
ENV APP_VERSION=$APP_VERSION
ENV APP_CHANNEL=$APP_CHANNEL

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV APP_ENV=production
ENV APP_PORT=8080
ENV DATA_DIR=/app/data
ENV DATABASE_URL=sqlite:////app/data/netmap.db
ENV SYSLOG_HOST=0.0.0.0
ENV SYSLOG_UDP_PORT=1514
ENV SYSLOG_TCP_PORT=1514

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash \
       ca-certificates \
       gettext-base \
       gosu \
       iproute2 \
       iputils-ping \
       libcap2-bin \
       nginx \
       nmap \
       sudo \
       tini \
       traceroute \
       tzdata \
  && rm -rf /var/lib/apt/lists/* \
  && setcap cap_net_raw+ep /bin/ping \
  && echo "netmap ALL=(root) NOPASSWD: /usr/bin/nmap" > /etc/sudoers.d/netmap-nmap \
  && chmod 440 /etc/sudoers.d/netmap-nmap

RUN addgroup --system netmap && adduser --system --ingroup netmap netmap

WORKDIR /app

COPY backend/pyproject.toml .
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir \
       "fastapi>=0.115.0" \
       "uvicorn[standard]~=0.30.0" \
       "pydantic-settings~=2.4" \
       "sqlalchemy~=2.0" \
       "alembic~=1.13" \
       "argon2-cffi~=25.1" \
       "cryptography>=48.0.1" \
       "defusedxml~=0.7.1" \
       "PyJWT~=2.10" \
       "starlette>=1.3.1" \
       "dnspython~=2.7" \
       "reportlab~=4.4" \
       "apprise~=1.9"

COPY backend/app ./app
COPY VERSION /app/VERSION
COPY --from=frontend-builder /app/dist /usr/share/nginx/html
COPY docker/aio-nginx.conf.template /etc/netmap/aio-nginx.conf.template
COPY docker/aio-entrypoint.sh /usr/local/bin/netmap-aio-entrypoint

RUN mkdir -p /app/data /tmp/nginx \
  && chown -R netmap:netmap /app /tmp/nginx /usr/share/nginx/html \
  && chmod +x /usr/local/bin/netmap-aio-entrypoint \
  && mkdir -p /app/docker \
  && ln -sf /usr/local/bin/netmap-aio-entrypoint /app/docker/aio-entrypoint.sh \
  && test -x /usr/local/bin/netmap-aio-entrypoint \
  && test -x /app/docker/aio-entrypoint.sh \
  && test -f /etc/netmap/aio-nginx.conf.template

EXPOSE 8080 1514/tcp 1514/udp
VOLUME ["/app/data"]

HEALTHCHECK --interval=20s --timeout=5s --retries=3 --start-period=15s \
  CMD sh -c 'python3 -c "import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:${APP_PORT}/api/health\", timeout=5)"'

ENTRYPOINT ["tini", "--", "/usr/local/bin/netmap-aio-entrypoint"]

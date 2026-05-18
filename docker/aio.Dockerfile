FROM node:22-alpine AS frontend-builder

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV APP_ENV=production
ENV DATA_DIR=/app/data
ENV DATABASE_URL=sqlite:////app/data/netmap.db
ENV SYSLOG_HOST=0.0.0.0
ENV SYSLOG_UDP_PORT=1514
ENV SYSLOG_TCP_PORT=1514

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash \
       ca-certificates \
       iputils-ping \
       libcap2-bin \
       nginx \
       nmap \
       tini \
       traceroute \
  && rm -rf /var/lib/apt/lists/* \
  && setcap cap_net_raw+eip /usr/bin/nmap

RUN addgroup --system netmap && adduser --system --ingroup netmap netmap

WORKDIR /app

COPY backend/pyproject.toml .
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir \
       "fastapi~=0.115.0" \
       "uvicorn[standard]~=0.30.0" \
       "pydantic-settings~=2.4" \
       "sqlalchemy~=2.0" \
       "alembic~=1.13" \
       "argon2-cffi~=25.1" \
       "defusedxml~=0.7.1" \
       "python-jose[cryptography]~=3.3" \
       "dnspython~=2.7" \
       "reportlab~=4.4"

COPY backend/app ./app
COPY --from=frontend-builder /app/dist /usr/share/nginx/html
COPY docker/aio-nginx.conf /etc/nginx/nginx.conf
COPY docker/aio-entrypoint.sh /app/docker/aio-entrypoint.sh

RUN mkdir -p /app/data /tmp/nginx \
  && chown -R netmap:netmap /app /tmp/nginx /usr/share/nginx/html \
  && chmod +x /app/docker/aio-entrypoint.sh

USER netmap

EXPOSE 8080 1514/tcp 1514/udp
VOLUME ["/app/data"]

HEALTHCHECK --interval=20s --timeout=5s --retries=3 --start-period=15s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=5)"

ENTRYPOINT ["tini", "--", "/app/docker/aio-entrypoint.sh"]

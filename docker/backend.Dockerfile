FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV DATA_DIR=/app/data

RUN apt-get update \
  && apt-get install -y --no-install-recommends nmap iproute2 iputils-ping traceroute libcap2-bin \
  && rm -rf /var/lib/apt/lists/* \
  && setcap cap_net_raw+eip /usr/bin/nmap
RUN addgroup --system netmap && adduser --system --ingroup netmap netmap

WORKDIR /app

# Install only dependencies — NOT the app package itself.
# The app code is provided at runtime via COPY (prod) or volume mount (dev).
# This prevents the stale pip-installed package from shadowing the live code.
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

RUN mkdir -p /app/data && chown -R netmap:netmap /app
USER netmap

EXPOSE 8000
# python -m uvicorn ensures the working directory (/app) is on sys.path,
# so the volume-mounted app/ is always preferred over any cached packages.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

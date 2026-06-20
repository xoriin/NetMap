<div align="center">
  <img src="frontend/public/favicon.svg" width="96" alt="NetMap"/>
  <h1>NetMap</h1>
  <p>Self-hosted network visibility and operations for home labs and small environments.</p>

  [![Docker Pulls](https://img.shields.io/docker/pulls/xoriin/netmap?logo=docker&logoColor=white&color=1d9ab0)](https://hub.docker.com/r/xoriin/netmap)
  [![Image Size](https://img.shields.io/docker/image-size/xoriin/netmap/latest?logo=docker&logoColor=white&color=1d6472)](https://hub.docker.com/r/xoriin/netmap)
  [![Version](https://img.shields.io/github/v/tag/xoriin/netmap?label=version&logo=github&logoColor=white&color=1d9ab0)](https://github.com/xoriin/netmap/tags)
  [![Build](https://img.shields.io/github/actions/workflow/status/xoriin/netmap/docker-aio.yml?label=build&logo=github-actions&logoColor=white)](https://github.com/xoriin/netmap/actions/workflows/docker-aio.yml)
  [![Stars](https://img.shields.io/github/stars/xoriin/netmap?logo=github&logoColor=white&color=091420)](https://github.com/xoriin/netmap/stargazers)
  [![Issues](https://img.shields.io/github/issues/xoriin/netmap?logo=github&logoColor=white&color=1d6472)](https://github.com/xoriin/netmap/issues)
  [![Last Commit](https://img.shields.io/github/last-commit/xoriin/netmap?logo=github&logoColor=white&color=1d9ab0)](https://github.com/xoriin/netmap/commits/main)
  [![License](https://img.shields.io/badge/license-GPL--3.0-091420)](LICENSE)
</div>

---

NetMap is a self-hosted tool that gives you a proper overview of your home lab or small network. Map out your devices, track IPs, watch for things going down, and dig into firewall logs — all from one place, running on your own hardware.

It started as a personal project to scratch an itch: one application that actually knows what's on your network, where it sits, and whether it's behaving. Built to drop straight into a Compose stack alongside your other self-hosted services with no cloud accounts, no subscriptions, and no phoning home.

Everything runs in a single container. The web UI, API, database, and syslog receiver are all bundled together — nothing to orchestrate beyond the one service.

---

## Screenshots

<img src="https://github.com/user-attachments/assets/ffd0c6d9-072f-41c1-bd4e-15c3737ede6b" width="800" alt="Overview" />
<img src="https://github.com/user-attachments/assets/f58ae91d-6b8e-40cb-95e5-f0a9975e97a6" width="800" alt="Topology" />
<img src="https://github.com/user-attachments/assets/b6a666bb-ca75-4732-9416-4da65afcecfe" width="800" alt="Monitoring" />
<img src="https://github.com/user-attachments/assets/13713071-f86e-432c-a503-d6069616109b" width="800" alt="IPAM" />

---

## Contents

- [Screenshots](#screenshots)
- [Features](#-features)
- [Installation](#-installation)
  - [Quick start](#quick-start)
  - [Full compose file](#full-compose-file)
  - [Generating secrets](#generating-secrets)
  - [First login](#first-login)
- [Configuration reference](#️-configuration-reference)
- [Ports](#-ports)
- [Upgrading](#-upgrading)
- [Account lockout recovery](#-account-lockout-recovery)
- [Reverse proxy setup](#-reverse-proxy-setup)
- [Firewall syslog ingestion](#-firewall-syslog-ingestion)
- [Alert notifications](#-alert-notifications)
- [Access control](#-access-control)
- [How it works](#️-how-it-works)
- [Tech stack](#-tech-stack)
- [API](#-api)
- [License](#license)

---

## ✨ Features

### Topology canvas
Draw your network visually. Add devices, draw links between them, group things into VLANs or logical clusters, and annotate everything. The canvas uses a force-directed layout that you can manually arrange and lock — positions are persisted so it looks exactly the same every time you come back. Supports multiple named sites so you can separate a home network, a lab VLAN, and an off-site location without cluttering a single view.

### Device inventory
A searchable, filterable table of every device you've added. Bulk-edit device types, statuses, and sites in one go. Device types include server, workstation, laptop, switch, router, firewall, access point, camera, phone, VPN, and cloud endpoint — each with a matching icon on the topology canvas. Custom icon packs are also supported if you want to extend the defaults.

### Monitoring
Continuous background polling for every device in your inventory:
- **Live ping** — ICMP round-trip with RTT history graphed per device
- **TCP port checks** — define one or more ports per device and watch their status independently
- **Heartbeat strip** — last 30 poll results shown inline as a colour-coded bar so you can spot intermittent outages at a glance
- **Uptime tracking** — rolling calculation of availability percentage
- Monitoring interval is configurable per instance; the background thread runs independently of API request load

### IPAM (IP address management)
- Define subnets and assign them to VLANs
- Track individual IP allocations with notes, device associations, and assignment type (static / DHCP / reserved)
- Import DHCP leases directly from your router's lease file
- Visual IP grid shows at a glance which addresses in a subnet are in use, available, or reserved — with per-cell tooltips showing the full record
- Conflict detection flags duplicate assignments before they cause problems

### Firewall logs
- Receive syslog over UDP and TCP (port 5514 by default) from pfSense, OPNsense, Unifi, or any RFC-5424/3164-compatible source
- Live-tail the stream in the browser, search by IP, protocol, port, or action
- Each event is matched against your device inventory and linked so you can jump straight to a device's topology card from a log line
- Configurable sender allowlist so only your firewall can submit logs
- Retention window keeps the database lean (default: 7 days)

### Network discovery
Run an Nmap scan against a subnet and import discovered hosts straight into your inventory. Detected hostnames, MAC addresses, and open ports are pre-populated on the new device record. Scans run in the background and their status is visible in the UI — you don't have to sit and wait.

### Built-in network tools
No more SSHing into a jump box to run a quick check. NetMap includes:
- **Ping** — ICMP to any host (private targets by default; public targets can be enabled by a SuperAdmin)
- **Traceroute** — hop-by-hop path to a host
- **TCP connect** — test whether a port is reachable
- **DNS lookup** — forward and reverse resolution
- **Subnet calculator** — break down any CIDR block into its address range, broadcast, usable hosts, and more

### Alerts
Configure rules that fire when a device goes down, comes back up, or trips a monitoring threshold. Each rule can fan out to multiple channels:
- **ntfy** — push to any ntfy topic (self-hosted or ntfy.sh)
- **Telegram** — bot message to a chat or channel
- **Signal** — via a Signal API relay
- **Email** — SMTP with TLS

Rules have a configurable cooldown period so you don't get paged every 30 seconds for a flappy device.

### Access control
Four built-in roles with granular permission sets — no one gets more access than they need:

| Role | What they can do |
|------|-----------------|
| **SuperAdmin** | Full access: manage users, roles, system settings, and all data |
| **NetworkAdmin** | Manage topology, devices, IPAM, and monitoring. Cannot manage users or roles |
| **SecurityAnalyst** | Read-only on topology and inventory; full access to firewall logs and the security workspace |
| **Viewer** | Read-only everywhere |

Role permissions are customisable in Admin → Roles if the defaults don't match your setup.

### Exports & reporting
- PDF reports for device inventory and monitoring summaries
- CSV and JSON exports for any table view
- Full database backup and restore through the admin UI
- Audit log of all write operations (who changed what, and when)

---

## 🚀 Installation

### Quick start

You need Docker and Docker Compose. That's it.

**1. Create a directory for NetMap:**

```bash
mkdir -p /opt/netmap && cd /opt/netmap
```

**2. Create a `docker-compose.yml`:**

```yaml
services:
  netmap:
    image: xoriin/netmap:latest
    container_name: netmap
    environment:
      PUID: 1000
      PGID: 1000
      TZ: "America/New_York"
      SECRET_KEY: "replace-with-generated-secret"
      MASTER_KEY: "replace-with-generated-fernet-key"
      TRUSTED_HOSTS: '["*"]'
    volumes:
      - /opt/netmap/data:/app/data
    ports:
      - "8080:8080"
      - "5514:1514/udp"
      - "5514:1514/tcp"
    cap_add:
      - NET_RAW
    restart: unless-stopped
```

**3. Generate your secrets** (run once, paste the output into the compose file):

```bash
# SECRET_KEY
python3 -c "import secrets; print(secrets.token_urlsafe(48))"

# MASTER_KEY
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

> **Important:** Keep both keys stable. Changing `SECRET_KEY` invalidates all active sessions. Changing `MASTER_KEY` makes any encrypted data stored by NetMap unreadable.

**4. Start the container:**

```bash
docker compose up -d
```

**5. Open the UI:**

```
http://localhost:8080
```

On first run you'll be prompted to create your admin account. Once that's done, you're in.

---

### Full compose file

The quick start above uses sensible defaults. Here's the full compose file with every option exposed and commented:

```yaml
services:
  netmap:
    image: xoriin/netmap:latest
    container_name: netmap
    environment:
      APP_ENV: production
      DATABASE_URL: sqlite:////app/data/netmap.db
      DATA_DIR: /app/data

      # Match these to your host user so the bind mount is writable.
      # Run `id` in a terminal to find your UID and GID.
      PUID: 1000
      PGID: 1000

      # Container timezone — affects log timestamps and scheduled tasks.
      # Use a tz database name, e.g. Europe/London, America/New_York.
      # TZ: UTC

      # Port the web UI listens on. Change if 8080 is already taken.
      APP_PORT: 8080

      # Public URL for password-reset links in emails.
      # Set this if you're behind a reverse proxy.
      # APP_URL: http://netmap.example.com:8080

      # Required — generate these before first start (see above).
      SECRET_KEY: "replace-with-generated-secret"
      MASTER_KEY: "replace-with-generated-fernet-key"

      # ["*"] works for LAN installs and anything behind a reverse proxy.
      # Lock to your exact hostname for internet-facing deployments.
      TRUSTED_HOSTS: '["*"]'

      # Set true once TLS is terminating in front of this container.
      SECURE_HSTS_ENABLED: "false"
      AUTH_COOKIE_SECURE: "false"

      # IPs/CIDRs of your reverse proxy so forwarded headers are trusted.
      TRUSTED_PROXY_IPS: '["127.0.0.1"]'

      LOG_LEVEL: info

      # How long to keep monitoring events and firewall logs (days).
      EVENT_RETENTION_DAYS: "7"
      FIREWALL_LOG_RETENTION_DAYS: "7"

      # Syslog receiver — disable if you don't use it.
      SYSLOG_ENABLED: "true"
      SYSLOG_UDP_ENABLED: "true"
      SYSLOG_TCP_ENABLED: "true"
      SYSLOG_HOST: 0.0.0.0
      SYSLOG_UDP_PORT: "1514"
      SYSLOG_TCP_PORT: "1514"
      # Only accept logs from these IPs/subnets (unset = accept all):
      # SYSLOG_SENDER_ALLOWLIST: '["192.168.1.1","10.0.0.0/8"]'

      # Active tools (ping, traceroute, TCP) are private-target-only by default.
      # Set to "true" to allow public targets; SuperAdmins can also change this
      # at runtime in Admin → System.
      ACTIVE_NETWORK_PUBLIC_TARGETS_ENABLED: "false"

    volumes:
      - /opt/netmap/data:/app/data  # change the host path to suit your setup

    ports:
      - "8080:8080"       # Web UI and API
      - "5514:1514/udp"   # Syslog UDP
      - "5514:1514/tcp"   # Syslog TCP

    cap_drop:
      - ALL
    cap_add:
      - NET_RAW            # Required for ICMP ping and traceroute
    security_opt:
      - no-new-privileges:true

    restart: unless-stopped

    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "5"
```

---

### Generating secrets

If you don't have Python installed locally, you can generate the keys inside a temporary container:

```bash
# SECRET_KEY
docker run --rm python:3.12-slim python3 -c "import secrets; print(secrets.token_urlsafe(48))"

# MASTER_KEY
docker run --rm python:3.12-slim python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

---

### First login

1. Navigate to `http://<your-host>:8080`
2. NetMap detects no users exist and redirects to account setup
3. Enter a username and password for your SuperAdmin account
4. You're in — start adding devices or run a discovery scan to populate your inventory automatically

---

## ⚙️ Configuration reference

All configuration is done via environment variables in your compose file. There is no config file to edit inside the container.

| Variable | Default | Description |
|----------|---------|-------------|
| `TZ` | `UTC` | Container timezone. Use a tz database name (e.g. `Europe/London`, `America/New_York`). Affects log timestamps and scheduled tasks. |
| `SECRET_KEY` | — | **Required.** Signs session tokens. Generate once, keep stable. |
| `MASTER_KEY` | — | **Required.** Fernet key for encrypting stored secrets. Generate once, never change. |
| `PUID` | `1000` | UID the container process runs as. Match your host user for correct bind mount permissions. |
| `PGID` | `1000` | GID the container process runs as. |
| `APP_PORT` | `8080` | Port the web UI and API listen on. |
| `APP_URL` | *(derived)* | Public URL used in password-reset emails. Set this if you're behind a reverse proxy. |
| `TRUSTED_HOSTS` | `["*"]` | JSON array of accepted `Host` header values. Use `["*"]` for LAN; lock down for internet-facing. |
| `CORS_ORIGINS` | *(derived from APP_URL)* | JSON array of allowed CORS origins. |
| `SECURE_HSTS_ENABLED` | `false` | Set `true` to send HSTS headers. Enable only when TLS is terminating upstream. |
| `AUTH_COOKIE_SECURE` | `false` | Set `true` to mark auth cookies as `Secure`. Enable with HTTPS. |
| `TRUSTED_PROXY_IPS` | `["127.0.0.1"]` | IPs/CIDRs of upstream proxies whose forwarded headers are trusted. |
| `LOG_LEVEL` | `info` | Uvicorn log level: `debug`, `info`, `warning`, `error`, `critical`. |
| `EVENT_RETENTION_DAYS` | `7` | Days to keep monitoring poll events. |
| `FIREWALL_LOG_RETENTION_DAYS` | `7` | Days to keep syslog events. |
| `SYSLOG_ENABLED` | `true` | Enable/disable the syslog receiver entirely. |
| `SYSLOG_UDP_ENABLED` | `true` | Enable/disable UDP syslog. |
| `SYSLOG_TCP_ENABLED` | `true` | Enable/disable TCP syslog. |
| `SYSLOG_UDP_PORT` | `1514` | Internal UDP port (map it to `5514` externally in compose). |
| `SYSLOG_TCP_PORT` | `1514` | Internal TCP port. |
| `SYSLOG_SENDER_ALLOWLIST` | *(unset = accept all)* | JSON array of IPs or CIDRs allowed to send logs. |
| `ACTIVE_NETWORK_PUBLIC_TARGETS_ENABLED` | `false` | Allow ping/traceroute/TCP to public internet addresses. |
| `ACCESS_TOKEN_MINUTES` | `15` | Lifetime of JWT access tokens. |
| `IDLE_TIMEOUT_MINUTES` | `15` | Session idle timeout before re-authentication is required. |
| `REFRESH_TOKEN_DAYS` | `7` | Refresh token lifetime. |
| `AUTH_MAX_FAILED_ATTEMPTS` | `5` | Failed login attempts before lockout. |
| `AUTH_LOCKOUT_MINUTES` | `15` | Duration of account lockout after failed attempts. |

---

## 🔌 Ports

| Container port | Protocol | What it's for |
|----------------|----------|---------------|
| `8080` | TCP | Web UI and REST API (configurable via `APP_PORT`) |
| `1514` | UDP | Syslog ingest (map to `5514` externally by convention) |
| `1514` | TCP | Syslog ingest |

The `NET_RAW` capability is required for ICMP ping and traceroute. Without it those tools will silently fail.

---

## 💾 Upgrading

Pull the latest image and recreate the container. The database schema is migrated automatically on startup — no manual steps required.

```bash
cd /opt/netmap
docker compose pull
docker compose up -d
```

Back up your data directory before upgrading if you want a rollback option:

```bash
cd /opt/netmap
cp -r data data.bak-$(date +%Y%m%d)
```

NetMap also has a built-in backup tool under Admin → Database that exports the full database to a downloadable file.

---

## 🔓 Account lockout recovery

If a SuperAdmin account is locked out after too many failed login attempts, the in-app unlock button (Admin → Users → Unlock) requires an active admin session and cannot be used while locked. Recovery is done directly against the database from the Docker host.

Run this on the machine running the container (replace `netmap` with your container name if you changed it):

```bash
docker exec netmap python3 -c "
import sqlite3
conn = sqlite3.connect('/app/data/netmap.db')
conn.execute(\"UPDATE login_throttle_state SET failed_attempts=0, locked_until=NULL WHERE subject LIKE 'user:%'\")
conn.commit()
conn.close()
print('Done.')
"
```

This clears the lockout for all users. To target a specific account, replace `LIKE 'user:%'` with `= 'user:yourusername'` (the username is always stored lowercase in the lockout table).

> **Note:** Restarting the container does not clear lockouts — they are persisted in the database by design.

---

## 🔒 Reverse proxy setup

NetMap works out of the box behind nginx, Caddy, Traefik, Nginx Proxy Manager, and any other standard reverse proxy. Proxy to port `8080` and leave everything else at defaults for a LAN install.

**For an HTTPS/public-facing install**, make these additional changes once TLS is working:

```yaml
environment:
  APP_URL: "https://netmap.example.com"
  TRUSTED_HOSTS: '["netmap.example.com"]'
  CORS_ORIGINS: '["https://netmap.example.com"]'
  SECURE_HSTS_ENABLED: "true"
  AUTH_COOKIE_SECURE: "true"
  TRUSTED_PROXY_IPS: '["127.0.0.1"]'  # add your proxy's IP if not localhost
```

**Example Caddy config:**

```
netmap.example.com {
    reverse_proxy localhost:8080
}
```

**Example nginx location block:**

```nginx
server {
    listen 443 ssl;
    server_name netmap.example.com;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

---

## 📡 Firewall syslog ingestion

Point your firewall's remote logging at your NetMap host on port `5514`.

**pfSense / OPNsense:**
System → Logging → Remote → add a new target with your NetMap host IP and port `5514`, protocol UDP or TCP.

**Unifi / UnifiOS:**
Settings → System → Remote Logging → enable syslog, set the server to your NetMap host and port `5514`.

**Any RFC-5424 or RFC-3164 compatible source works.** Once logs are flowing they appear in the Security workspace where you can live-tail, search, and filter them. Each event is automatically matched against your device inventory by IP address so you can jump straight to a device record from a log entry.

To restrict which IPs can send logs:

```yaml
SYSLOG_SENDER_ALLOWLIST: '["192.168.1.1", "10.0.0.0/8"]'
```

Leave it unset to accept from anywhere on your network.

---

## 🔔 Alert notifications

Alerts fire when a monitored device changes state (online → offline, offline → online) or when a monitoring threshold is breached. Configure rules in Admin → Alerts.

Each rule specifies:
- Which devices or groups it applies to
- Which event types it triggers on
- One or more notification channels
- A cooldown period (minimum time between repeated alerts for the same device)

**Supported channels:**

| Channel | What you need |
|---------|--------------|
| **ntfy** | A topic URL on ntfy.sh or your self-hosted ntfy instance. Optional access token for private topics. |
| **Telegram** | A bot token and a chat/channel ID. Create a bot via [@BotFather](https://t.me/BotFather). |
| **Signal** | A Signal API relay URL (e.g. [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)). |
| **Email** | SMTP hostname, port, sender address, and credentials. TLS is supported. |

---

## 👥 Access control

User management lives in Admin → Users. Invite users by creating their account and assigning a role — they set their password on first login.

| Role | Topology | Inventory | IPAM | Monitoring | Firewall logs | Tools | Admin |
|------|----------|-----------|------|------------|---------------|-------|-------|
| **SuperAdmin** | ✓ full | ✓ full | ✓ full | ✓ full | ✓ full | ✓ full | ✓ full |
| **NetworkAdmin** | ✓ full | ✓ full | ✓ full | ✓ full | read | ✓ full | — |
| **SecurityAnalyst** | read | read | read | read | ✓ full | ✓ | — |
| **Viewer** | read | read | read | read | read | — | — |

Role permissions are editable in Admin → Roles if you need something different from the defaults.

---

## 🏗️ How it works

NetMap is a single all-in-one container running three cooperating processes managed by `tini`:

```
┌─────────────────────────────────────────┐
│  Container (aio)                        │
│                                         │
│  ┌──────────┐   ┌──────────────────┐   │
│  │  nginx   │   │  uvicorn         │   │
│  │  :8080   │──▶│  FastAPI :8000   │   │
│  │  (static)│   │  (API + WS)      │   │
│  └──────────┘   └────────┬─────────┘   │
│                           │             │
│               ┌───────────┼──────────┐  │
│               │           │          │  │
│          ┌────▼───┐  ┌────▼────┐ ┌──▼──┐│
│          │Monitor │  │ Syslog  │ │SQLite││
│          │thread  │  │ server  │ │ DB  ││
│          └────────┘  └─────────┘ └─────┘│
└─────────────────────────────────────────┘
```

- **nginx** serves the pre-built React bundle as static files and reverse-proxies `/api/*` requests to uvicorn. This avoids CORS issues and lets nginx handle static asset caching efficiently.
- **uvicorn** runs the FastAPI application on an internal port. All API logic, authentication, database access, and WebSocket connections go through here.
- **Monitoring thread** — a Python background thread (`threading.Thread`) wakes on a configurable interval and ICMP-pings every device that has monitoring enabled. Results are written to the SQLite database and pushed to any connected WebSocket clients in real time.
- **Syslog server** — a second background component binds UDP/TCP ports and parses incoming syslog frames. Parsed events are stored in SQLite and broadcast to the security workspace via WebSocket.
- **SQLite** — the only persistence layer. The schema is managed through an in-house migration runner that applies numbered SQL migration files in order on startup, so upgrades are automatic and require no external tooling.

**Authentication** uses short-lived JWT access tokens (default 15 min) rotated via HTTP-only refresh tokens (default 7 days). Passwords are hashed with Argon2id. CSRF protection is applied to all state-changing endpoints via a double-submit cookie pattern.

**The frontend** is a single React application compiled to a static bundle at build time. It talks exclusively to `/api/v1/*` and uses WebSockets for live monitoring updates and syslog tailing. There is no server-side rendering — the API is the only backend surface.

---

## 🧰 Tech stack

### Backend

| Library | Purpose |
|---------|---------|
| **Python 3.12** | Runtime |
| **FastAPI** | Web framework and API routing |
| **uvicorn** | ASGI server |
| **SQLAlchemy 2** | ORM and database abstraction |
| **SQLite** | Embedded database (no separate DB server required) |
| **Argon2-cffi** | Password hashing (Argon2id) |
| **python-jose** | JWT signing and verification |
| **pydantic-settings** | Environment variable parsing and validation |
| **dnspython** | DNS lookups for the built-in tools |
| **defusedxml** | Safe XML parsing (used in syslog processing) |
| **reportlab** | PDF report generation |
| **nmap** | Network discovery scans (system package) |
| **iputils-ping / traceroute** | ICMP ping and traceroute (system packages) |

### Frontend

| Library | Purpose |
|---------|---------|
| **React 18** | UI framework |
| **TypeScript 5** | Type-safe JavaScript |
| **Vite 7** | Build tool and dev server |
| **Cytoscape.js** | Interactive topology canvas (graph rendering and layout) |
| **Tabler Icons** | Icon set used throughout the UI |
| **Lucide React** | Supplementary icon set |
| **DOMPurify** | Sanitises any HTML before rendering to prevent XSS |

### Infrastructure

| Component | Purpose |
|-----------|---------|
| **nginx** | Serves static frontend assets; reverse-proxies API requests |
| **tini** | PID 1 init process — reaps zombie processes correctly |
| **gosu** | Drops privileges from root to the configured PUID/PGID at startup |
| **Docker** | Container runtime |

---

## 🌐 API

The full REST API is documented at `/api/docs` (Swagger UI) once the container is running. Every operation available in the UI is also available through the API with the same authentication — log in via `/api/v1/auth/login` to get a session token and use it in the `Authorization: Bearer <token>` header.

The OpenAPI schema is available at `/api/openapi.json` if you want to generate a client in another language.

---

## License

GPL-3.0 — see [LICENSE](LICENSE) for details.

---

Parts of this project were built with assistance from [Claude](https://claude.ai) (Anthropic). All code is reviewed and owned by the project author.

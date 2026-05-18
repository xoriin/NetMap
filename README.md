<div align="center">
  <img src="frontend/public/favicon.svg" width="96" alt="NetMap"/>
  <h1>NetMap</h1>
  <p>Self-hosted network visibility and operations for home labs and small environments.</p>

  [![Docker Pulls](https://img.shields.io/docker/pulls/xoriin/netmap?logo=docker&logoColor=white&color=1d9ab0)](https://hub.docker.com/r/xoriin/netmap)
  [![Image Size](https://img.shields.io/docker/image-size/xoriin/netmap/latest?logo=docker&logoColor=white&color=1d6472)](https://hub.docker.com/r/xoriin/netmap)
  [![License](https://img.shields.io/badge/license-MIT-091420)](LICENSE)
</div>

---

NetMap is a self-hosted tool that gives you a proper overview of your home lab or small network. Map out your devices, track IPs, watch for things going down, and dig into firewall logs — all from one place, running on your own hardware.

It's built to be pulled from Docker Hub and dropped into a Compose stack alongside your other self-hosted services. No cloud accounts, no subscriptions, just a container and a compose file.

## ✨ What's inside

- 🗺️ **Topology canvas** — draw out your network with devices, links, groups, and VLANs. Layouts are saved so it looks the same every time you come back
- 📋 **Device inventory** — keep track of everything on your network with a searchable, filterable device list and bulk edit support
- 📡 **Monitoring** — live ping status, uptime graphs, RTT history, and TCP port checks across your whole fleet
- 🌐 **IPAM** — subnet tracking, IP address inventory, DHCP lease import, and conflict detection so you know what's using what
- 🔥 **Firewall logs** — pull in syslog over UDP or TCP, search through it, and tail it live. Events link back to devices on your topology
- 🔍 **Network discovery** — scan your network with Nmap and import what you find straight into the inventory
- 🛠️ **Built-in tools** — DNS lookup, ping, traceroute, TCP checks, and a subnet calculator without needing to SSH anywhere
- 🔔 **Alerts** — get notified when devices go down or come back up via ntfy, Telegram, Signal, or email
- 👥 **Access control** — four roles (SuperAdmin, NetworkAdmin, SecurityAnalyst, Viewer) so you can share access without giving everyone full control
- 📊 **Exports** — PDF reports, CSV and JSON exports, and a full audit log

## 🚀 Getting started

You'll need Docker and Docker Compose. That's it.

**1. Create a folder for NetMap and drop in a `docker-compose.yml`:**

```yaml
services:
  netmap:
    image: xoriin/netmap:latest
    container_name: netmap
    environment:
      SECRET_KEY: replace-with-a-long-random-secret
      MASTER_KEY: replace-with-a-fernet-key
      TRUSTED_HOSTS: '["*"]'
    volumes:
      - /mnt/change/this/netmap:/app/data
    ports:
      - "8080:8080"
      - "5514:1514/udp"
      - "5514:1514/tcp"
    restart: unless-stopped
```

**2. Generate your secrets** (run these once and paste the output in):

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

**3. Edit the volume path** to point at wherever you want your data to live on the host.

**4. Start it up:**

```bash
docker compose up -d
```

Open `http://localhost:8080` — on first run you'll be prompted to create your admin account.

> A full compose file with all available options is included as `docker-compose.yml` in this repo.

## 💾 Data & upgrades

Everything NetMap stores (database, backups) lives in `/app/data` inside the container, mapped to whatever host path you set in the volume. Back that folder up before upgrading.

Upgrading is just:

```bash
docker compose pull && docker compose up -d
```

## 🔒 Behind a reverse proxy

Works out of the box with nginx, Caddy, Traefik, Nginx Proxy Manager, and friends. For most installs `TRUSTED_HOSTS: '["*"]'` is fine. If you're exposing it publicly, swap that for your actual hostname and set `SECURE_HSTS_ENABLED: "true"`.

## 📡 Firewall syslog

Point your firewall or log forwarder at your NetMap host on port `5514` (UDP or TCP). Events show up in the Security workspace and link to devices on your topology map. You can restrict which IPs are allowed to send logs with `SYSLOG_SENDER_ALLOWLIST`.

## License

MIT

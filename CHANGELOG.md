# Changelog

## [1.2.7] - 2026-06-03

### Discovery
- Discovery now recognizes existing devices by normalized MAC address when a DHCP/Wi-Fi device returns at a new IP.
- Discovery import can explicitly update the IP address for a MAC-matched device when "Update IP when MAC matches" is selected.

### Monitoring
- Cleaned up the selected-device RTT chart with a lighter line, subtle guide grid, smaller endpoint marker, and dark-mode chart colors.
- Inventory uses the shared Monitoring-style live status pill, while Topology no longer shows a map-level Live/Paused pill.
- Monitoring device analysis now normalizes SQLite-returned timestamps as UTC before Python-side comparisons, preventing 500 errors from mixed naive/aware datetimes.

### Security / Syslog
- OpenWrt banIP firewall prefixes now parse action, chain/context, and feed/list metadata.
- Corrupt `firewall.db` files encountered during retention cleanup are now recreated automatically instead of leaving startup maintenance errors in the logs.
- Firewall retention cleanup now skips overlapping in-process runs and defers gracefully when SQLite reports `database is locked`, avoiding startup maintenance tracebacks while retrying on the next retention pass.
- Security raw-log search now matches individual prefix terms instead of requiring the full query as an exact phrase.
- Security filters now use draft values with an explicit Search button or Enter key; quick filters and clickable event cells still apply immediately.
- Active network tool subprocess execution now allowlists ping/traceroute commands and rejects control characters in command arguments.

### Exports / Operations
- Network report PDF generation now skips malformed or unreadable `firewall.db` summary data instead of returning HTTP 500.
- Dev and test builds now track candidate `1.2.7` while production remains `1.2.6`.

---

## [1.2.6] - 2026-06-01

### Discovery
- Added discovery result review for rescans: scan results now show whether each host is new, already known, or has changed inventory fields.
- Discovery import can now add only new devices, fill missing hostname/MAC/vendor values, or explicitly override selected existing fields.
- Discovery can enrich missing MAC/vendor details from router or L3-switch SNMP ARP tables, including a default ARP source from the selected VLAN/group gateway when available.

### SNMP
- Added an SNMPv2c probe tool for system identity, interface state, and ARP table reads.
- Added encrypted SNMP credential profiles managed from Admin -> Credentials.
- Devices can be assigned SNMP profiles, and router/L3-switch details can preview and apply ARP-table enrichment to matching inventory devices.

### Monitoring
- Added the first named service-check foundation: TCP service checks can be managed globally or per device through Monitoring.
- Monitor history now stores richer service result metadata while retaining compatibility with existing port-result rows.
- Admin live-ping changes now update the app shell immediately; Inventory, Topology, and Monitoring clearly show when live polling is disabled.

### Version Display
- Dev and test builds can display channel labels such as `Dev: 1.2.6` or `Test: 1.2.6` when a `VERSION_CHANNEL` file is present.
- Version checking now treats a local candidate version ahead of the latest production tag as up to date.

---

## [1.2.5] - 2026-05-27

### Docker / Runtime
- Fixed startup 502s where nginx could not reach `/tmp/uvicorn.sock` while firewall search-index maintenance ran during FastAPI startup.

---

## [1.2.4] - 2026-05-27

### Topology
- Topology layouts and display preferences now autosave per user and sync across devices.
- Fixed layout reloads overwriting saved node positions with stale canvas state.
- Link creation now uses a searchable endpoint picker.
- Map labels and link selection are easier to use on dense topology views.
- Firewall activity is no longer aggregated across all devices when the topology page opens; selected-device activity loads on demand.
- Updating VLAN DNS settings no longer crashes when IPAM contains separate subnet rows matching the same VLAN and CIDR.

### Performance
- Workspaces now load on demand, so heavier pages like Topology are not bundled into the initial app load.

### Docker / Runtime
- Corrupt `firewall.db` startup state is recovered automatically by recreating only the firewall/syslog event database.

---

## [1.2.3] - 2026-05-25

### Security / Session
- Firewall raw-log search index recovery now rebuilds malformed FTS state before running index health checks, preventing damaged search indexes from blocking application startup.

---

## [1.2.2] - 2026-05-25

### Docker / Runtime
- Added a backwards-compatible AIO entrypoint path so containers still start when an environment references the previous `/app/docker/aio-entrypoint.sh` location.

### Security / Session
- Firewall raw-log search index startup now detects malformed FTS state and rebuilds the derived index instead of blocking application startup.

---

## [1.2.1] - 2026-05-25

### Topology
- Saved topology layouts now persist reliably per user after Docker image upgrades.
- Group anchor positions are preserved with device positions, and invalid saved coordinates are ignored instead of breaking the topology page.

### Docker / Runtime
- AIO image startup files now install to fixed runtime paths and are verified during the image build to prevent missing-entrypoint startup failures.

### Security / Session
- Notification delivery failures now return sanitized messages to the UI while detailed diagnostics stay in server logs.

### Network Tools
- Ping and traceroute target handling now resolves hostnames before execution and passes normalized targets safely to subprocesses.

---

## [1.2.0] - 2026-05-24

### Favourites
- Favourites are now per-user rather than global; each account maintains its own starred device set stored in a new `user_device_favourites` table.
- Favourite state is fetched once per session and overlaid in the frontend, keeping the global monitoring cache intact.

### Admin
- Added SuperAdmin login-lockout unlock controls for user accounts.
- Added a System diagnostics panel with database sizes, WAL sizes, monitoring cache/status counters, syslog retention details, process PID, and manual refresh.
- App name setting now correctly updates the brand name displayed on the login screen (was previously hardcoded to "NetMap").

### Monitoring / Performance
- Heartbeat queries use `ROW_NUMBER()` window function for more efficient per-device latest-event retrieval.
- Monitoring poll uses a `changed_since` cursor so only devices with status changes are returned on subsequent polls, reducing payload size.
- Device status event aggregation and IP pre-parsing moved to SQL, reducing Python-side processing.

### Backend / Performance
- Discovery scans now support private IPv4 and IPv6 `start-end` ranges by converting validated ranges to nmap-safe CIDR targets while preserving the displayed input.
- IPAM subnet utilization now uses per-request numeric IP indexes and binary-search counts instead of repeatedly scanning all known IPs per subnet.
- Firewall `raw_log` search now uses SQLite FTS5 with startup-created sync triggers and existing-row rebuild support.
- Added SuperAdmin-only `/api/v1/system/diagnostics` for lightweight runtime diagnostics.

### Docker / Runtime
- Moved the AIO image entrypoint to `/usr/local/bin/netmap-aio-entrypoint` and nginx template to `/etc/netmap/aio-nginx.conf.template`; the image build now verifies both files exist to prevent startup failures from a missing `/app/docker/aio-entrypoint.sh`.

### Security / Session
- Logout and idle cleanup can revoke sessions via the refresh cookie without requiring a still-valid access token.
- CSRF cleanup clears the root-path cookie used by the SPA.

### Network Tools
- Bounded DNS, ping, traceroute, hostname resolution, and active tool subprocess timeouts to avoid tying up backend workers.

### Topology
- Group boxes no longer drift downward on the map when the spacing or per-row slider is dragged.

---

## [1.1.0] - 2026-05-23

### Inventory
- Redesigned header: icon-box stat chips, merged filter/bulk-edit row, quick status-filter dropdown
- Pagination with per-page selector (persists via `localStorage`)
- DeviceTypeIcon in table, bulk-edit type dropdown, and device details panel
- VLAN and Location cells show small coloured icons

### IPAM
- Removed Conflicts stat chip; conflicts banner is now full-width
- Subnets table fills page width (removed grid wrapper)
- Reservations panel: subnet filter dropdown, delete button on existing reservations, table header icons
- Free-address hover changed from purple to teal; added "click to reserve" hint text

### UI / General
- Light mode panel headers softened to `#edf3f7` across overview, monitoring, and IPAM
- Cancel button styling fixed consistently across all modal and popup contexts
- Topology toolbar dark mode polish

### Frontend (internal)
- `main.tsx` (12,790 lines) fully split into ~55 focused modules
- `src/utils/` — IP math, formatters, sort, topology, relationships, security, CSV, monitoring, download
- `src/components/` — 13 atom components (Modal, DashStat, HealthDonut, IpGrid, HeartbeatBar, etc.)
- `src/features/` — auth views, device/topology/IPAM forms and panels, all 12 workspace pages
- `src/App.tsx`, `src/Sidebar.tsx`, `src/views/` — shell extracted; `main.tsx` is now a 10-line entry point

---

## [1.0.5] - 2026-05-20

- Separate `firewall.db` to isolate syslog flood writes from main app
- SQLite WAL mode + `busy_timeout=5000` on both databases
- nmap discovery runs via `sudo` inside the container
- CSRF cookie `path` fixed to `"/"` so the SPA can read it on all routes
- Syslog blank-entry filter (skips events where all parsed fields are None)
- Firewall logs UI rework: action pills, quick filter buttons, dark mode variants
- Version display reads `/app/VERSION` file; version checker uses GitHub tags API
- Timezone support added to container
- Firewall live-tail fix
- Discovery scan auto-populates group IP range
- UI consistency pass across pages

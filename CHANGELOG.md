# Changelog

## [1.5.0] - 2026-08-02

### Community acknowledgements
- Thanks to @WindowsStar for suggesting [DHCP-aware monitoring](https://github.com/xoriin/NetMap/issues/20), [HTTP/HTTPS monitors](https://github.com/xoriin/NetMap/issues/21), a distinct [paused-device health state](https://github.com/xoriin/NetMap/issues/22), and [expected-offline monitoring](https://github.com/xoriin/NetMap/issues/26).
- Thanks to @MFKDGAF for suggesting [external IP tracking](https://github.com/xoriin/NetMap/issues/23) and for highlighting where the [network-discovery documentation](https://github.com/xoriin/NetMap/issues/27) needed to be clearer.

### Added
- **Endpoint heartbeats in the Monitoring table** — standalone HTTP/HTTPS endpoints now show their latest 30 check results inline, matching the at-a-glance heartbeat treatment used by inventory devices without requiring the endpoint popup.
- **External IP address management** — IPAM now tracks provider-assigned public allocations alongside internal subnets without mixing their data. Choose **Add subnet → External range** and enter either a CIDR or a start–end range containing at least two usable addresses. Each allocation records provider/account references, owner, service, status, tags, notes, utilization, and a paged per-address map. Public-range validation rejects private or special-purpose records, overlapping allocations are blocked, and resizing cannot orphan an existing assignment. Migration `0061_external_ip_tracking`.
- **DHCP-aware service checks** — Monitoring can safely validate an inventory device acting as an IPv4 DHCP server. The device-scoped check sends `DHCPINFORM` to UDP 67 and requires a matching `DHCPACK`; it never discovers, requests, renews, reserves, or releases an address. Probe failures now retain a clear diagnostic in the device monitoring drilldown, and the all-in-one image includes only the low-port bind capability required for the DHCP client reply.
- **Expected device state monitoring** — writable users can mark a device as expected online or expected offline from its Monitoring popup using the themed **Upside down** switch. Fleet health, status details, filtering, alerts, and row state distinguish a deliberately offline device from an unexpected outage.
- **Device type filter in Inventory** — a device type picker sits alongside the group, location, and status filters. It lists only the types actually present in your inventory rather than all built-ins, with the same icons and colours as the table.
- **Device type icons and colours in the device dialog** — the Add/Edit Device window's Device type picker now shows each type's icon and colour instead of a plain dropdown.
- **Colour-coded VLAN/group, location, and device type columns in Inventory** — these columns now show coloured chips instead of inline dropdowns and plain text, so the table reads at a glance. Colours are managed in Admin → Device icons (a colour picker beside each device type, plus a Group & location colours panel); anything without an explicit colour gets a stable automatic colour derived from its name. Device type chips tint their existing icon rather than adding a separate swatch. The same chips appear in the device details panel, and the group/location filter dropdowns above the table show matching swatches. Per-device group and location are still changed from the device details panel (double-click the field) or the Inventory bulk-edit menu. Migration `0057_topology_group_color`.
- **Turn colour-coded columns off** — Profile → Appearance has an on/off switch for the coloured chips. It's a per-account preference stored on the server, so it follows you across browsers and devices and doesn't affect anyone else. When off, the chips stay the same shape and size but render neutral grey, so nothing shifts in the table. Migration `0058_user_entity_colors`.
- **Bulk-edit dropdowns match the table** — the VLAN / Group, Device type, and Location pickers in Inventory's Bulk menu now show the same colour swatches and device-type icons as the table rows, so a value is recognisable at a glance instead of by reading each label.
- **Resizable Inventory columns** — the Inventory table's columns can be dragged to resize like the Monitoring fleet table, with widths saved per browser; double-click any divider to restore the default layout.
- **Advanced HTTP/HTTPS monitor options** — standalone monitors now support flexible accepted status codes and ranges, custom headers, JSON/form/text/XML request bodies, Basic/Bearer/OAuth2 client-credentials/mTLS authentication, encrypted write-only secrets, proxies, custom CAs, redirect limits, separate retry intervals, cache busting, inverted monitors, keyword assertions, JSON-path assertions, descriptions, tags, response-size diagnostics, and TLS issuer/expiry tracking. The polished add/edit dialog uses focused General, Request, Validation, and Security folder tabs attached directly to one shared settings window—the same visual construction as the Monitoring Devices/Monitors switcher—and reveals only options relevant to the selected method and authentication type. The monitor overview shows assertion, request, authentication, and certificate health at a glance. Admin → Alerts adds a certificate-expiry trigger that can target one monitor or all monitors. Existing monitors retain their configured status range through migration `0056_monitor_http_options`.
- **API keys for external access** — external scripts and integrations can now call the NetMap REST API with registered API keys instead of a browser session. Create keys from Profile → API keys (name + optional 30/90/365-day expiry; the key is shown once at creation), send them in an `X-API-Key` header, and revoke them at any time; SuperAdmins can view and revoke any user's keys from Admin → Security → API Keys. A key carries exactly its owner's role permissions (evaluated live, so role changes apply immediately), every existing `/api/v1` endpoint works over API keys with the same JSON responses and permission gates as the web app, and keys are stored only as HMAC-SHA256 hashes — never in plaintext. Built-in abuse protection: per-key request rate limiting (default 120 requests/minute, configurable via `API_KEY_RATE_LIMIT_*`) and automatic lockout of sources repeatedly presenting invalid keys, both persistent across restarts. Key lifecycle events (create/revoke/lockout) are audit-logged. The syslog live-event WebSocket still requires a session token (documented limitation). See `docs/API_ACCESS.md` for a usage guide. Migrations `0045_api_keys`, `0046_api_key_rate_limit`.
- **Shareable topology layouts** — the Topology toolbar gains a Layouts manager: save the current canvas arrangement under a name, load or delete saved layouts, and share a layout with other users via a short share code. Another user enters the code to import their own independent copy (positions and display preferences). Codes can be revoked at any time; imported copies are unaffected. Migration `0048_layout_share_codes`.
- **What's New shown once per user** — the post-update What's New popup is now acknowledged per user account on the server instead of per browser, so it no longer re-appears in new browsers, devices, or after cleared site data — and each user on a shared machine gets their own one-time showing. It can still be reopened any time from Admin → Version → What's New. Migration `0047_user_whats_new_ack`.
- **Interactive offline bar on Overview** — the offline-devices banner now expands in place (like the IPAM conflicts banner) into a detail panel listing each offline device with its IP, type, group, and last-checked time, plus a jump to Inventory.
- **Topology: find device** — a search box in the topology toolbar filters by name, hostname, or IP; picking a match pans and zooms to the device with a highlight pulse.
- **Topology: path highlighting** — a new Path mode highlights the shortest link path between two clicked devices and dims everything else, making "what does this depend on?" answerable at a glance. Click the background or exit Path mode to clear.
- **Topology: status-change pulses** — devices whose live status changed since the previous poll briefly pulse amber, so an outage or recovery draws the eye without hunting for colour changes.
- **Topology: link speeds** — links can carry a speed (10 Mbps – 100 Gbps) set in the link form; edges render thicker for faster links and the speed appears in the edge label. Migration `0049_relationship_link_speed`.
- **Topology: mini-map** — a corner overview shows all node positions and the current viewport rectangle; click anywhere on it to pan the main canvas. Built in-house, no new dependencies.
- **Topology: shared-layout preview** — before importing a shared layout code, a Preview button shows the layout's name, node count, last update, and a dot-plot of its arrangement.
- **Topology: bulk select and assign** — shift-drag box-selects multiple devices; a floating action bar assigns the selection to a group and/or site in one operation (dragging one selected node moves the whole selection, as before).
- **Ping-loss percentage alert rule** — Admin → Alerts now offers a "Ping loss above threshold" trigger: fires when a device's ICMP probe failure rate over a configurable trailing window (default 60 minutes) reaches a configurable percentage threshold, reusing the existing notification channels and cooldown. Migration `0050_alert_rule_ping_loss`.
- **IP reservation expiry reminders** — Admin → System can enable a background check that notifies configured notification channels a set number of days before an IPAM reservation's expiry date (default 3 days), so reservations don't lapse unnoticed.
- **PDF export for the topology canvas** — the Topology toolbar's export menu gains a PDF option alongside PNG/SVG, rendering the canvas — including zone, device, and edge labels — as a single-page landscape PDF with no new dependency.
- **Dedicated login history view in Admin Security** — the Login & Audit History panel gains an "All activity" / "Login history" toggle; login history shows time, user, result (success, failed, blocked by rate limit, blocked by SSO requirement, or logout), and source IP for each event.
- **Support contact info in Admin System settings** — SuperAdmins can set a support email and/or URL that's appended to password-reset emails ("Need help? Contact …"), giving users somewhere to turn if a reset doesn't work.
- **Restore dry-run validation** — Admin → System → Database backup & restore now validates an uploaded backup file before touching the live database: signature, SQLite integrity check, expected-table check, and a preview of device/user/subnet/table counts and file size. Restoring is only offered after validation passes, and now requires typing `restore` to confirm — this replaces the live database entirely and cannot be undone.
- **HTTP/HTTPS monitoring** — service checks (Monitoring → service checks) gain full HTTP/HTTPS support: request method (GET/HEAD/POST/PUT/DELETE/OPTIONS/PATCH), an expected response-status range (default 200–399, configurable), an optional per-check timeout override, an opt-in "verify TLS certificate" toggle (checks default to unverified since self-signed certs are common on LAN devices), and a "follow redirects" toggle. Every check now records response time and — for HTTP/HTTPS — the returned status code, shown in the Monitoring table's service badges and the device drilldown panel. Migration `0052_service_check_http_options`.
- **Service check alert rules** — Admin → Alerts gains two new triggers: "Service check goes down" fires the moment a specific (or any) service check transitions from up to down, and "Service check response time above threshold" fires when a check's response time exceeds a configurable millisecond threshold. Both can be scoped to one service check or left to apply fleet-wide, and reuse the existing notification channels and cooldown. Migration `0053_alert_rule_service_check`.
- **Scheduled backups with retention** — Admin → System gains a background backup schedule: enable it, pick an interval (6h/12h/daily/weekly) and how many backups to keep, and NetMap writes a signed backup to disk on that cadence, automatically deleting the oldest copies beyond the retention count. The same panel lists existing scheduled backups with size and timestamp, and lets you download or delete any of them.
- **Login history CSV export** — the Login History view in Admin → Security gains an Export CSV button, downloading the currently filtered (all-users or single-user) login history as a CSV with time, user, result, and source IP.
- **Clear all network changes** — the Network changes dialog (Overview and Inventory) gains a Clear all button that resolves every pending change at once, with a typed confirmation for 5 or more. Rows are also clickable now — new device, IP change, and field change rows jump to Inventory, disappeared-device rows jump to Monitoring — making the list feel interactive instead of a static log.
- **Standalone HTTP/HTTPS uptime monitoring** — Monitoring now supports Uptime-Kuma-style monitors that track any HTTP/HTTPS endpoint independently of inventory devices: method, expected status range, timeout, TLS verification, redirect following, retries-before-down, and a per-monitor check interval (20s–1h). Monitors are checked by a dedicated background scheduler, keep 30 days of check history, and report 24h/7d uptime and average response time. The Monitoring page gains a "Monitors" tab — styled as a folder tab attached directly to the existing Devices table panel rather than a separate page — with its own stat row, add/edit/pause/delete controls, and a drilldown showing a heartbeat strip and recent check history per monitor. Two new alert rule triggers, "Standalone monitor goes down" and "Standalone monitor response time above threshold", reuse the existing notification channels and cooldown and can be scoped to one monitor or fleet-wide. Migrations `0054_alert_rule_monitor` plus the new `monitors`/`monitor_check_history` tables.
- **Monitoring device table gains a fixed sticky header** — the Devices table on the Monitoring page now scrolls within its own panel (column headers stay pinned) instead of the whole page scrolling past the header row.

### Fixed
- **Container readiness waits for the backend** — nginx no longer starts before Uvicorn has created its Unix socket, eliminating transient `/api/health` 502 responses during slow database maintenance. Startup allows up to five minutes for the backend, fails clearly if it exits, and prints `netmap: startup complete` only after the full nginx-to-Uvicorn health path responds successfully.
- **Inventory latency matches Monitoring** — the Inventory Latency column now shows the same 24-hour average RTT used by Monitoring and refreshes its values in place.
- **IPAM map legend colours are visible** — the portalled subnet-detail window now carries the IPAM status palette into its legend, so Device, DHCP lease/range, Reserved, Gateway, Free, and Net/Broadcast keys remain distinct in both themes.
- **Topology group headers stay clear of device icons** — group cards now reserve a dedicated title/count inset large enough for the rendered device frames and labels at normal canvas zoom, and the pointer-transparent header layer remains above device overlays so nearby status dots or icons cannot clip its text.
- **API keys can be identified without exposing them** — Profile and Admin Security show only a password-style mask plus the final four characters of each key, never its lookup prefix or secret. New key suffixes are stored at creation; existing keys acquire the suffix after their next successful use. Migration `0060_api_key_display_suffix`.
- **Monitoring filters and favourites are consistent with Inventory** — device-type and status selectors use the same icon/colour-aware control treatment as Inventory, Monitoring device types come from the same canonical inventory data, and the fixed favourite column now stays at the left edge in both tables.
- **Discovery documentation now points to the actual workflow** — the README directs users to Inventory → Scan or Topology → Scan, clarifies that Nmap is bundled inside the NetMap container, distinguishes discovery from CSV/JSON import, and explains the host-networking/SNMP options for MAC discovery.
- **Inventory bulk menu closes when you click away** — the Bulk menu previously stayed open until you clicked its own button again; it now dismisses on an outside click or Escape. Escape closes an open dropdown inside the menu first, rather than the whole menu.
- **Popups now share one readable application-wide palette** — Add/Edit Device, Location, Discovery Scan, Add/Edit Link, VLAN, IPAM, Admin, confirmation, Monitoring, and other shared dialogs now inherit the same lifted navy hierarchy introduced by the monitor editor: distinct header/footer and section surfaces, darker inputs, blue-grey borders, brighter labels, muted supporting text, and restrained focus states. The palette is defined through shared `--nm-modal-*` tokens and `components.css`, with a canonical example and agent rules documented to prevent workspace-specific popup colours from drifting apart.
- **Monitoring tab colours now match Inventory** — the Devices/Monitors switcher and the General/Request/Validation/Security monitor-editor tabs use the same restrained teal hover and selected states as the Inventory quick-filter tabs, plus the standard accent focus ring. Their default outlines and attached panel seams now use the softer standard border so the controls do not look individually boxed in. The monitor editor now follows the readable Monitoring popup palette as well: a lifted navy header and form surface, darker inputs, blue-grey field borders, brighter labels, and quieter supporting text. The shared states adapt consistently in light and dark mode.
- **Monitor editor stays still while changing tabs** — the Add/Edit Monitor dialog now keeps a stable responsive height, with General, Request, Validation, and Security scrolling inside the shared settings window instead of resizing and re-centering the entire popup whenever their content heights differ.
- **General monitor setup no longer needs its own scrollbar** — identity fields now use a compact name/method and description/tags layout, retry timing sits alongside the other schedule values, and status validation, inversion, and cache busting live under their relevant Validation or Request tabs. General remains fully visible at normal dialog sizes while advanced tabs retain scrolling when conditional settings require it.
- **Monitors tab layout and HTTP overview** — Devices and Monitors remain separate rendered views, with background-free rounded tabs attached to the active table window. The Monitors window now has a dedicated table header like Devices: endpoint count, status selector, name/URL search, and **Add monitor** in the top-right action area. Its responsive table keeps metric/action columns readable, lets URL consume available space, and scrolls instead of crushing cells. Clicking a monitor opens the same hero-style drilldown used by devices, tailored for HTTP: uptime and latest response summary, success/failure rate, fastest/slowest/p95 response, common/latest HTTP status, failure streak, request/TLS/redirect configuration, heartbeat, and recent response history. The popup is portalled outside the scroll-heavy table tree and uses a non-blurred dimmer so opening and scrolling it does not force the browser to continuously repaint the table beneath it.
- **Monitoring page loads faster** — the device list endpoint's 24-hour and 7-day uptime rollups had to read a row from the table for every history record they aggregated, which on a week of fleet history meant hundreds of thousands of scattered reads on each uncached load; a wider index now answers both from the index alone, and the heartbeat query no longer builds full ORM objects for records it only reads a few fields from. The page also paints its summary cards and toolbar as soon as the fleet summary arrives instead of waiting for the slower per-device rollups. Migration `0055_monitor_history_uptime_index`.
- **Monitoring page no longer scrolls as a whole** — the device table's panel was sized with a hardcoded estimate of the height of the page header, stat cards, and offline-alert bar above it. Whenever that estimate was wrong — the alert bar appearing, stat cards wrapping on a narrow window — the panel overshot the viewport and reaching the bottom of the table scrolled the entire page, pushing the pagination controls out of reach. The panel is now sized from the space actually left over, so only the table scrolls and the pagination bar stays put.
- **Monitoring column resizing only resizes the column being dragged** — shrinking a column in the Devices or Monitors table handed the freed space to the other columns, so neighbouring columns visibly moved during a drag. Each column now keeps its width until it is dragged itself, and the table scrolls sideways when the columns outgrow the panel. Double-clicking any column divider resets every column to its default width.
- **"Database is locked" errors under concurrent load** — saving a topology layout (or any other write) could intermittently fail with a 500 while background work held the SQLite write lock. Four causes were addressed: the standalone monitor service no longer keeps a database connection checked out while it runs HTTP probes and sends notifications; the daily history-retention purges (device monitor history, monitor check history, notification deliveries) now delete in small committed batches instead of one long transaction that blocked every other writer; the lock wait was raised from 5 to 20 seconds; and the connection pool was enlarged so the request threadpool no longer competes with background services for connections.
- **Topology autosave no longer writes an audit entry every few seconds** — dragging the canvas autosaves roughly every two seconds, and each save was recording a `topology.layout_saved` audit row, adding write pressure and burying real activity in Admin → Security's audit log. Explicit named-layout saves are still audited.
- **Overview and Inventory summary cards now clickable, matching Monitoring** — Inventory's Devices/Online/Offline cards apply the matching status filter (click again to clear), same as Monitoring already did. Overview's Total devices card jumps to Inventory, Online jumps to Monitoring, and Offline expands the offline-devices panel in place — previously only Monitoring's cards responded to clicks.
- **Overview's Users card replaced with Avg RTT** — the account-count card wasn't a useful at-a-glance network health signal; it now shows fleet-wide average response time (same data already used by Monitoring) and jumps to Monitoring on click.
- **Overview's remaining summary cards now clickable** — Groups / VLANs jumps to the VLANs workspace, Links jumps to Topology, completing click-through navigation for every card in the row.
- **Paused devices no longer counted as offline on Overview** — devices with monitoring paused (or a non-active lifecycle) were appearing in the Overview offline bar and offline counts. They are now tracked as their own "Paused" category in the health donut and breakdown, and the reachability percentage is measured against actively monitored devices only.
- **Fewer false-positive network-change observations** — when a previously "disappeared" device comes back in a later scheduled sweep, its open observation is now resolved automatically; devices that recently went through a disappear-and-return cycle (typical wifi clients) don't re-raise a disappeared alert for 7 days; and resolving a "new device" observation now permanently dismisses that hardware (by MAC; 14 days by IP when no MAC is known) instead of re-alerting every time it rejoins the network.
- **Network-changes review readability** — long entries in the changes-detected review dialog (new devices, previously discovered hosts) now wrap instead of being cut off with an ellipsis.
- **Container startup tolerant of restricted chown on bind mounts** — if the container can't `chown` `/app/data` or `/tmp/nginx` (some rootless or managed bind-mount setups reject it), startup now logs a warning and continues instead of failing, assuming the mount is already writable.
- **Announcement banner misaligned on Topology, Inventory, and Security** — the announcement banner shown below the page header was offset from the content beneath it on these three routes (a fixed side margin didn't account for each route's own container padding). It now lines up exactly with the page content on all three, in both themes.

### Security
- **Upgraded `postcss` to 8.5.25** — resolves the source-map path traversal and arbitrary `.map` file disclosure advisory GHSA-r28c-9q8g-f849 in the frontend build toolchain.
- **Upgraded `Pillow` to 12.3.0** — resolves 13 advisories (CVE-2026-59197/59198/59199/59205/54060/55379/55380 and others): heap out-of-bounds read/write bugs in `ImageFilter.RankFilter`, `Image.paste()`/`Image.crop()`, `ImageCmsTransform.apply()`, and McIdas AREA file loading; decompression-bomb-check bypasses in `BdfFontFile`, `GdImageFile`, `FontFile.compile()`, and `PdfParser.PdfStream.decode()`; a JPEG2000 tiled-decode memory-growth DoS; an `EpsImagePlugin` infinite-loop DoS; and an OS command injection in `ImageShow.WindowsViewer.get_command()`. Pillow is a transitive dependency (via `reportlab` for PDF export) — the app has no direct `PIL` imports.
- **Upgraded `pydantic-settings` to 2.14.2** — resolves `NestedSecretsSettingsSource` following symlinks outside `secrets_dir`, which could read arbitrary local files and bypass `secrets_dir_max_size` (GHSA-4xgf-cpjx-pc3j). NetMap's `Settings` does not use `secrets_dir`, so this dependency was not actually reachable, but the fix is applied regardless.
- **Upgraded `dompurify` to 3.4.12** — resolves `CUSTOM_ELEMENT_HANDLING` bypassing the `afterSanitizeElements` hook for allowed custom elements (GHSA-c2j3-45gr-mqc4).

## [1.4.0] - 2026-07-05

### Added
- **Single sign-on via OpenID Connect (OIDC)** — NetMap can now authenticate against any OIDC provider (Authentik, Authelia, Keycloak, Zitadel, Okta, Microsoft Entra ID, Google Workspace) using Authorization Code + PKCE. Configure via environment variables (`OIDC_ENABLED`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, …) or in-app under Admin → Security → Single Sign-On (DB settings override env; the client secret is stored encrypted and is write-only in the API). The login screen gains a "Continue with SSO" button alongside the existing username/password form. Security baseline: signed ID-token verification via provider JWKS (asymmetric algorithms only), issuer/audience checks, state + nonce validation bound to the browser with a single-use server-side transaction, PKCE S256, verified-email enforcement, optional email-domain allowlist — and no provider tokens ever reach the browser; a successful callback issues the normal NetMap session cookies. Includes identity linking by provider subject with optional first-time linking by verified email, optional auto-provisioning with a conservative default role (never SuperAdmin), group/role claim mapping with local-role precedence by default and explicit opt-in for provider-managed roles or SuperAdmin grants, an Admin "Test provider" diagnostic action, per-user auth-source (SSO) badges in Admin → Users, audit events for every provision/link/login/settings change, and an optional "Require SSO" mode with guard rails (provider must verify and an active SuperAdmin must exist) that always preserves SuperAdmin local login as the emergency recovery path. Migrations `0043_oidc_login_states`, `0044_external_identities`.
- **Toast notifications** — actions across the app (deletes, saves, imports) now confirm success or surface failures in a bottom-right toast stack instead of failing silently or relying on scattered inline text.
- **Styled destructive-action confirmations** — deleting devices, links, groups, locations, subnets, reservations, DHCP leases, schedules, roles, and saved searches now opens a consistent danger-styled dialog with consequence text; bulk device deletes of 5+ require typing `delete` to confirm.
- **Workspace crash containment** — an unexpected error in one workspace now shows a retryable fault card while the rest of NetMap keeps working, instead of a white screen.
- **Loading skeletons** — workspaces show shimmer skeleton layouts while data loads (route changes, VLANs, IPAM) instead of blank panels or plain "Loading…" text.
- **Response-time (RTT) threshold alert rules** — Admin → Alerts now offers a "Response time above threshold" trigger with a configurable millisecond threshold (per device or fleet-wide). The background monitor fires the rule when a device's probe RTT exceeds the threshold, reusing the existing notification channels and cooldown; a persistent high-latency condition re-alerts once per cooldown period. Migration `0036_alert_rule_threshold_ms` adds `alert_rules.threshold_ms`.
- **Pause monitoring per device** — devices can be paused from the device form or the Pause/Resume button in device details. Paused devices are skipped by live/background probes (no false offline alerts), show a gray "paused" status in Monitoring (with a Paused filter and fleet paused count), and stay in inventory/topology. Migration `0037_device_monitoring_fields`.
- **Device lifecycle states** — devices carry a lifecycle of planned / active / retired / ignored. Only active devices are monitored; the rest render as paused in Monitoring and show a lifecycle badge in device details.
- **Flapping detection** — devices whose status changes 4+ times within an hour get a "flapping" badge in the Monitoring table, and a new "Device is flapping" alert rule trigger fires through the normal notification channels with per-rule cooldown.
- **Notification delivery history** — every alert notification attempt is recorded (rule, target, sent/failed, provider error summary) and shown in Admin → Alerts → Delivery history. Records are pruned after 30 days. Migration `0039_notification_deliveries`.
- **Generic webhook notification method** — Admin → Notifications now offers "Generic webhook": NetMap POSTs `{"title": "NetMap", "message": …}` as JSON to any HTTP(S) endpoint, with an optional bearer token. Respects the private-target egress blocking setting.
- **IPAM next-available-IP** — the Reserve IP dialog can fill in the next free address of the selected subnet with one click, skipping used IPs, the gateway, and the DHCP pool.
- **IP reservation expiry dates** — new reservations default to an expiry 90 days from today, expired reservations are flagged in the reservations table, and a "Clear expired" action removes them in bulk. Migration `0040_ip_reservation_expiry`.
- **Saved security searches** — the Security workspace can save the current filter set under a name and re-apply or delete it from a dropdown. Saved per user. Migration `0041_saved_security_searches`.
- **What's new popup** — after login, authenticated users see a once-per-installed-version popup summarising the changelog for the version they're running. It does not prompt when a newer tag is merely available; Admin → Version can reopen it manually. GitHub release notes for `v*` tags are generated from the same `CHANGELOG.md` in CI.
- **Managed custom device types** — Admin → Devices & Icons can add reusable custom device types, edit/rename them, assign a default Tabler icon, and remove unused custom types. Device forms, Inventory bulk actions, Topology, and Overview all consume the same managed type list. Migration `0042_device_types`.
- **Interactive monitoring summary cards** — the Monitored/Online/Offline cards in Monitoring now click to apply the matching status filter (click again to clear).
- **GitHub Actions security scanning** — a new report-only `security-scan.yml` workflow runs Semgrep SAST plus `pip-audit` and `npm audit` on pushes, pull requests, and a weekly schedule. All jobs are non-blocking until the baseline is triaged.
- **Instant Monitoring re-entry** — the Monitoring workspace keeps an in-memory stale-while-revalidate snapshot of the fleet summary, device table, and service checks. Returning to Monitoring renders the last known data immediately, then refreshes with a lightweight delta request when fresh or a full refresh when stale.

### Changed
- **Reorganised the Profile page** — everything now lives in one full-width panel: an identity header (avatar, name, username, role, sign-in method), Account details beside Preferences, then Password with its three fields across, then API keys with its Create button in the section heading. Previously each setting sat in its own card in a two-column grid that left large gaps beside the shorter cards, and username and role appeared as greyed-out form fields. Listed API keys now show a masked key with a button to copy the key prefix.
- **Sidebar collapse control** — the collapse/expand button now stays in the bottom utility area above a subtle separator in both sidebar states, and the collapsed Inventory badge now sits at the icon's top-right corner instead of pushing it off-centre or overlapping it.
- **HTTP/HTTPS monitoring scope clarified** — the current service-check groundwork is no longer described as the finished uptime-monitoring workflow; the dedicated HTTP/HTTPS monitoring method with per-check targeting, response timing, and alert integration remains planned.
- **CI and bundle analysis cleanup** — GitHub workflows now use current major action versions for the Node 24 runner runtime, and normal production frontend builds skip the bundle visualizer unless explicitly run in analyze mode.
- **Browser tab titles now show only the current screen** — authenticated pages use their page name without the `NetMap —` prefix, and login/setup/reset/loading states now show their own tab title instead of inheriting Overview.
- **What's New release notes now render inline Markdown** — changelog bullets in the popup preserve formatting such as links, inline code, emphasis, strikethrough, and bold text while sanitising rendered HTML before display.
- **What's New actions** — the release-notes action now sits to the left of the close action in the popup footer, "Got it" is the primary action, and the Admin → Version "What's new" control now matches the primary admin action buttons.
- **Overview favourites cache** — favourite monitoring rows render from a per-user local snapshot while Overview refreshes live monitoring data in the background, avoiding the empty/loading lag on page entry.
- **Overview card surfaces** — the Overview summary cards and panels now use the same restrained linear-gradient surface treatment as the refreshed admin cards for a more consistent dashboard feel.
- **Admin stat card vibrancy** — the Admin → System cards now use per-card accent gradients, stronger icon tints, and matching hover glow so they feel closer to the Overview cards instead of washed out.
- **OIDC admin form polish** — the SSO checkboxes in Admin → Security now match the System settings layout, with option text beside the checkbox, compact helper text underneath, and clearer spacing before Login & Audit History.
- **Confirmation toasts** — Admin success messages such as "Settings saved", plus Profile and Export confirmations, now use the toast stack instead of full-width success bars. Toast notifications are larger and stay visible longer so saves are harder to miss.
- **Full Tabler icon library for device types** — the device-type icon picker now exposes the installed Tabler outline library in addition to the curated NetMap icon set. The large Tabler metadata files are emitted as lazy JSON assets so the initial app bundle stays small.
- **Unified table row hover across the app** — VLANs, Inventory, Monitoring, IPAM, Security, Overview device lists, audit logs, admin tables, the icon manager, and the topology entity list now share one subtle hover treatment (new `--nm-row-hover` design token) **with the VLAN table's teal left-edge accent** in both themes, replacing a patchwork of per-table hover colours.
- **Tools action buttons calmed down** — Lookup, Ping, Traceroute and the other tool submit buttons use the soft accent treatment (tinted background, teal text) instead of a solid bright block, which was overpowering in dark mode.
- **Unified near-duplicate UI colours onto the design-token palette** — 485 hard-coded colour values that were visually near-identical to an existing theme token now use the token, keeping light and dark mode consistent as the palette evolves. The changes are imperceptible by design and were verified against light/dark screenshot baselines of every workspace.

### Fixed
- **Monitoring drilldown popup surface** — the device drilldown modal now uses the standard app surface colours again instead of the stronger blue-toned background.
- **IPAM subnet address popup surface** — the subnet detail modal that shows the grid/table of IP addresses now uses the lifted neutral surface family from the approved Monitoring drilldown palette, avoiding the overly dark inherited modal background.
- **Monitoring/IPAM table formatting regression** — shared numeric-stability styling no longer turns Monitoring and IPAM table cells into pill-shaped inline elements, restoring normal table layout and dashboard card values.
- **Monitoring status-dot motion** — Monitoring and port-check status dots now use a slower, softer pulse so live state remains visible without drawing as much attention.
- **Device saves now confirm completion** — saving device edits now shows a success toast with the device name, so the details panel no longer feels like the Save action did nothing.
- **Custom device type edits now use a PUT update route** — Admin → Devices & Icons no longer hits a 405 when saving a renamed custom type, and the row closes after the save succeeds.
- **Admin panel spacing and confirmation dialogs** — admin cards keep the subtle linear-gradient accent treatment, success banners have more even spacing from surrounding content, Inventory tables align with the page rail, delivery history has more breathing room below alert rules, the topology grid's top-left corner is square, and destructive confirmation icons sit in the modal title area.
- **IP reservation expiry default setting** — Admin → System can now toggle whether new IPAM reservations prefill a +90 day expiry. Users can still clear the expiry field on a reservation to remove it entirely.
- **Admin settings polish** — the System settings helper text now renders as compact hint text below each related option, and the System stat cards now follow the same card shape and hover feel as the dashboard/monitoring stat cards.
- **Inventory row hover works again** — hover now animates the row itself with the shared teal edge treatment in light and dark mode, so zebra stripes and active-row backgrounds no longer hide the mouseover state.
- **Dark mode readability fixes across the app** — the NetMap wordmark on the login screen, the sidebar network-changes badge, the sidebar logo hover, primary buttons ("+ Device", "Ports", "+ Add subnet"), and toolbar dropdowns are all readable in dark mode again; plain secondary buttons (e.g. IPAM "Next free"/"Edit") use the raised-blue treatment instead of near-black; Locations cards use the standard panel surface instead of an extra-dark background; and the monitoring device popup shows its status colour bar in dark mode, matching light mode.
- **Saving a security search now uses a styled in-app dialog** with a name field and validation instead of the browser's native prompt window.
- **Custom roles appear in Admin → Users immediately** — the role dropdowns for existing users and the add-user form now list custom groups without first visiting the Groups tab.
- **Admin tabs load faster and independently** — each Admin tab (System, Users, Groups, SNMP Profiles, Notifications, Alerts, Automation, Security) now fetches only its own data when opened, and a slow or failing load in one tab no longer affects the others. The Automation tab also stopped fetching an unused sites list on every visit.
- **Refreshing the browser on the IPAM page** no longer bounces to Overview — the router now restores every route, including `/ipam`.
- **Expired sessions mid-action recover transparently** — if the access token expires while the app is open (e.g. after laptop sleep), the next API call refreshes the session and retries once instead of surfacing a 401 error.
- **Background token refresh no longer flashes the loading screen** — the hourly session refresh (and any transparent 401 recovery) keeps the current page rendered instead of re-running the app bootstrap.
- **Modals are keyboard-trapped and restore focus** — Tab cycles within any open modal, background scrolling is locked, and focus returns to the triggering control on close.
- **Browser tab titles** now reflect the current page (e.g. "NetMap — Monitoring").
- **Scheduled discovery IP conflicts are review-only** — when a scheduled scan finds a MAC-matched device at an IP that already belongs to a *different* inventory device, the move is no longer misattributed as a field change on the occupying device. It now creates an `ip_change` observation against the MAC-matched device for manual review, and the IP is never auto-applied onto an occupied address.
- **Topology link form** endpoint pickers now render above the modal scroll layer with an opaque dropdown surface, preventing the source/target menu from being clipped, hidden, or see-through while creating or editing links.
- **Topology links dropdown** now uses fixed source/target/type columns so long link labels no longer shift row spacing.
- **Device pause controls** now update Topology/Inventory state consistently, show paused devices with neutral gray styling instead of red, and expose Paused in the Inventory status filter.
- **Monitoring drilldown pause control** now lets writable users pause/resume an individual active device from the Monitoring popup, while lifecycle-paused devices explain why they cannot be resumed there.
- **IPAM next-free reservation** is now visible from subnet rows and the subnet detail modal, not only inside the generic reserve dialog.
- **IPAM reserve and next-free actions** now use the secondary button treatment from the unified UI styles; the subnet popup keeps "Reserve next IP" in the top bar beside close.
- **Pause controls** in device details, Inventory details, and the Monitoring popup now use the shared secondary button treatment from the design-system preview.
- **Dark-mode secondary buttons** now use the same raised blue family as the Monitoring popup header, so pause/resume controls remain visible before hover without clashing with the modal surface.
- **Device detail status dots** now strobe subtly with a status-coloured glow so the selected device state feels live and interactive.
- **Monitoring status dots** now use a stronger status-coloured strobe in the device table and popup header, while respecting reduced-motion preferences.
- **Monitoring offline alert spacing** now has more even top/bottom padding so the alert bar feels balanced.
- **Monitoring summary cards** no longer show the active filter ring on the default Monitored card; only explicit status filters stay highlighted.
- **Paused device status** now uses a non-pulsing neutral gray treatment across Monitoring, Inventory/detail badges, topbar paused state, and topology labels.
- **Scheduled discovery disappeared-host alerts** now require three consecutive missed scheduled scans before opening a network-change observation, reducing noise from devices that only intermittently respond.

## [1.3.1] - 2026-06-28

### Security
- **Replaced `python-jose` with `PyJWT`** to remove the unmaintained `ecdsa` dependency.
- **Pinned `cryptography>=48.0.1`**, **`starlette>=1.3.1`**, upgraded DOMPurify, and upgraded Vite/plugin-react to address dependency advisories.
- **Password changes and resets now revoke active sessions**, invalidate sibling reset tokens, and require `APP_URL` before sending reset links.
- **RBAC checks tightened** for alert management, IPAM mutations, syslog WebSockets, and configurable `security_view` access.
- **Network tools hardened** against DNS rebinding; `X-Forwarded-For` parsing now uses the rightmost forwarded address.
- **Discovery/SNMP safeguards added** with manual scheduled-discovery single-flight enforcement and an SNMP walk wall-clock deadline.
- **Syslog TCP connection handling fixed** to avoid tracking unbounded per-connection thread references.

### Added
- **Overview favourites drilldown:** clicking a favourite device now opens a monitoring detail popup directly on Overview.
- **Monitoring favourites filter:** a star toggle filters the Monitoring device table to favourites only.
- **TCP/UDP service checks:** monitored port targets can now be TCP or UDP.
- **TCP/UDP tools port check:** the Tools port checker now supports both TCP and UDP.
- **Radial group layout:** topology groups can be arranged with a radial group layout option.

### Changed
- **Inventory default page size** now defaults to 25 rows and migrates old auto-saved 10-row preferences to 25 once, while preserving later manual choices.
- **Port-check naming** now uses generic "Port check" labels and API action names instead of TCP-only wording.
- **Upgrade docs** now `cd /opt/netmap` before pull, recreate, and backup commands.

### Fixed
- **Primary button styling** no longer gets overridden in modal headers.
- **Overview favourites popup** keeps users on Overview instead of navigating to Monitoring.
- **Alert monitor service checks** now honour the configured TCP/UDP check type.

## [1.3.0] - 2026-06-18

### Security
- **Replaced `python-jose` with `PyJWT`** — eliminates the unmaintained `ecdsa` dependency that had no available patch for a Minerva timing attack (CVE). `PyJWT 2.x` uses the `cryptography` backend directly.
- **Pinned `cryptography>=48.0.1`** to resolve the bundled vulnerable OpenSSL advisory.
- **Pinned `starlette>=1.3.1`** to address several Starlette advisories (form-body limit bypass, HTTP method dispatch, path poisoning).
- **Upgraded `dompurify` to 3.4.11** — resolves all six open DOMPurify advisories (IN_PLACE bypasses, hook mutation, cross-realm sanitisation, Trusted Types).
- **Upgraded `vite` to 8.x and `@vitejs/plugin-react` to 6.x** — resolves two Vite Windows dev-server advisories and brings in `esbuild 0.28.x` and `@babel/core 7.29.7+`.
- **XFF header parsing** now takes the rightmost entry from `X-Forwarded-For` instead of the leftmost, preventing attackers from spoofing their IP for rate-limiting and audit attribution.
- **Session revocation on password change/reset** — changing a password, completing a self-service reset, or an admin resetting a user's password now revokes all active refresh tokens for that user.
- **Sibling reset tokens invalidated** — issuing or consuming a password-reset link now invalidates all other pending reset tokens for that user, preventing a stale link from overriding the final password.
- **Password-reset links require `APP_URL`** — reset emails are only sent when `APP_URL` is explicitly configured; the `Host` header is no longer used as a fallback (prevents host-header poisoning).
- **Syslog WebSocket authenticates before reserving the shared slot** — unauthenticated connections can no longer exhaust the connection quota; the slot is only claimed after a valid token is presented.
- **Syslog WebSocket honours the configurable `security_view` permission** — access now uses the RBAC permission cache instead of hardcoded role names.
- **Alert routes use `alert_write` permission** — alert rule management now checks the correct configurable permission instead of `topology_write`.
- **IPAM mutation routes use `ipam_write` permission** — subnet, reservation, DHCP import, and VLAN-import routes now check the configurable `ipam_write` permission via the shared permission dependency, removing the hardcoded NetworkAdmin role bypass.
- **Syslog TCP thread leak fixed** — per-connection threads are no longer appended to the service's tracked thread list, preventing unbounded memory growth under sustained connection churn.
- **DNS rebinding mitigated in network tools** — `ping`, `traceroute`, and `tcp_port_check` now resolve the hostname once and validate the resulting IP before passing it to the subprocess or socket, eliminating the time-of-check/time-of-use gap.
- **Manual scheduled discovery enforces single-flight** — the HTTP endpoint now uses the same lock+set guard as the scheduler loop, preventing concurrent nmap processes for the same schedule from being spawned via rapid API calls.
- **SNMP walk has a wall-clock deadline** — `SnmpClient.walk()` now accepts a `max_wall_seconds` parameter (default 30 s) and stops after that time, preventing a slow or controlled target from holding a worker thread indefinitely.

## [1.3.0] - 2026-06-16

### Changed
- **IP address placeholders** across discovery, device forms, VLAN/IPAM fields, and network tools now use generic `192.168.1.x` examples.
- **Inter font bundled:** The UI now ships Inter (weights 400–600) via `@fontsource/inter` instead of relying on a system-installed font. Typography is consistent across browsers and containers; body text uses weight 400 with antialiasing for a lighter feel.
- **Consistent modals and controls:** Shared modal shell, buttons, search inputs, and status pills are now used across IPAM, Inventory, Monitoring, Topology, Locations, Admin, and related panels — dialogs, toolbars, and forms behave the same way throughout the app.
- **Primary action buttons** use a deeper teal instead of the brighter accent, so `+ Device` and other primary CTAs are less visually loud.
- **Discovery scan SNMP** is now a dedicated toggle button with a labelled configuration panel, instead of a checkbox buried in the form. Post-scan actions separate "Import selected" (primary) from "Update existing" (secondary).
- **Sidebar:** Overview uses a home icon (Monitoring keeps the activity chart icon). The NetMap brand navigates to Overview; collapse is a compact icon on the right.
- **Announcement banner (MOTD)** uses a purple alert style to distinguish it from offline and network-update notices.

### Added
- **Overview — Recently updated:** Users with write access can add a device or run a network scan from the Recently updated panel header (and empty state).
- **Overview favourites drilldown:** Clicking a favourite device on the Overview page now opens a monitoring detail popup without leaving Overview.
- **VLAN filter** in the Monitoring workspace: a dropdown next to the site filter lets you narrow the device list by VLAN ID.
- **Favourites filter** in the Monitoring workspace: a star toggle now filters the device table to favourites only, matching Inventory.

### Fixed
- **Icon Manager server-pack path** no longer shows the internal `dev/` prefix in the help text.
- **Search box focus rings** in Inventory, Locations, and Monitoring now align with the outer search container instead of glowing around the inner input only.
- **Monitoring search** no longer shows a double border from overlapping wrapper and input styles.
- **Monitoring "Reset columns"** removed — column widths are fixed by default.
- **Locations "View larger map" link** no longer has a pill background behind the text.
- **Discovery scan modal actions** no longer sit on a shaded footer bar.
- **Monitoring search** shows a single outer border (no double-border from wrapper + input).
- **Topology ribbon toolbar** normalises button, select, and status chip heights; `+ Device` matches other controls.
- **Inventory MOTD spacing** tightened so the announcement bar sits closer to the stat cards below it.
- **Inventory table** uses the full panel width on wide (1440p) screens with rebalanced column proportions.
- **IPAM subnet drilldown tabs** no longer cause a horizontal scrollbar; tabs use an equal-width grid within the modal.
- **IPAM subnet drilldown address table** no longer inherits the monitoring table’s 1580px minimum width. Columns are equal thirds; IP addresses are left-aligned, Status and Label are centred. Label shows inventory display names (with hostname fallback for registered devices; DHCP entries match inventory by MAC when possible).
- **Overview favourites row** alignment: uptime, RTT, and star columns line up correctly; RTT hides on narrow viewports without breaking the grid.
- **Inventory default page size** now migrates old auto-saved 10-row preferences to 25 rows once, while still allowing users to choose 10 rows afterward.
- **Monitoring group dropdown** was missing groups for devices whose group was set via a topology group relationship rather than the denormalised string field. The monitoring API now falls back to the `TopologyGroup` table by FK when the string field is null.
- **Topology sidebar** open/close no longer recentres or pans the map. Previously `cy.fit()` was being called on sidebar toggle, which would jump the viewport. The sidebar now only calls `cy.resize()` (resize without refit).
- **Topology zone backgrounds** no longer flicker every 30 seconds during live status polling. The zone style effect had `filteredGraph` in its dependency array; since the style values don't depend on device data, it was needlessly re-applying styles on every status poll.
- **Monitoring probe reliability:** ICMP failure messages are now logged at `WARNING` level (visible at the default `info` log level) instead of `DEBUG`, making it easier to diagnose devices showing offline. The probe also logs raw ping output when ICMP succeeds but returns zero replies. The `received` field is now handled null-safely so a parse failure no longer silently shadows the underlying error.
- **ICMP monitoring now works correctly:** `apt-get install iputils-ping` runs `setcap cap_net_raw+ep /bin/ping || true` in its postinstall script — the `|| true` meant `setcap` silently failed in Docker's build sandbox (which doesn't grant `CAP_SETFCAP`), leaving the `ping` binary with no file capability. The Dockerfile now installs `libcap2-bin` and runs `setcap cap_net_raw+ep /bin/ping` explicitly in the same `RUN` layer, which runs with the full build-time capability set and correctly stamps the capability on the binary. Previously only TCP fallback was ever used for monitoring probes.

---

## [1.2.9] - 2026-06-15

### Fixed
- Corrected version identifier to resolve a false "update available" notification caused by a duplicate tag during the 1.2.8 release.

---

## [1.2.8] - 2026-06-14

### Added
- **LLDP Neighbours tool** (Tools workspace): queries a device's LLDP-MIB over SNMP to discover adjacent devices on each switch port. Results are matched to inventory by MAC, management IP, or hostname; unmatched neighbours are flagged. One-click topology link creation from matched pairs.
- **OS field** on devices: stores the operating system string (e.g. "Ubuntu 24.04", "Cisco IOS"), editable inline in device details or via the Add/Edit form. SNMP enrichment preview now suggests `sysDescr` as the OS and `sysName` as the hostname for the source device when those fields are blank.
- **Created timestamp** in device details (read-only).
- **Port ranges and comma-separated ports** in service checks: the port field now accepts `443`, `67,68`, `8080-8090`, or any combination — one check entry is created per port under the same label.
- **Last poll relative time**: the topbar "Last poll" indicator now shows a live "(X min ago)" note that updates every 30 seconds.
- **Service check device picker**: the "Specific device" form now includes a searchable dropdown so you no longer need to pre-click a device in the table before adding a scoped check. The dropdown has an embedded search field that filters in real time.
- **IPAM range reservations**: the Reserve IP dialog now accepts a range in the IP address field (e.g. `192.168.1.10-35`). Entering a range shows a live count preview and creates all IPs in sequence on submit. MAC address field is hidden in range mode.

### Changed
- **Admin Credentials tab renamed to "SNMP Profiles"** for clarity — the tab manages SNMP community strings and auth profiles, not user credentials.
- **Automation tab change observations** now use the card-row layout (type badge, summary, identity, schedule name, Acknowledge/Resolve actions), matching the discovery modal style.
- **Port Monitoring modal** (formerly "Service Checks"): renamed, widened, and redesigned to a horizontal two-column layout with the form on the left and the active-checks list on the right. The device picker supports multi-selection with a live search bar and scrollable device list.
- **IPAM reserved colour** changed from purple to deep teal to better match the green/teal palette.
- **IPAM DHCP range pill** in dark mode is now muted (dimmer border and text) to reduce visual noise.
- **IPAM free-cell hover** colour changed to `#2dba7c` (device green) with matching legend and tooltip dot.
- **Login screen** now displays the app favicon (with dark rounded background) in place of the generic network icon, on both the left branding panel and the login form header. The left panel has a soft teal glow behind the icon.
- Dark mode is now the default theme for new installations and users who have not previously set a preference.
- Frontend `npm run dev` now uses port 5173 and proxies `/api` to the local AIO container on `127.0.0.1:8090` by default, so CSS/React changes can be hot-reloaded from VS Code without rebuilding the container.

### Fixed
- **Public IP monitoring**: registered devices with public IPs were always probed as offline. The background monitor now probes all registered devices regardless of the public-targets gate (that restriction applies only to interactive Tools pings).
- **Monitoring panel height**: the Devices panel no longer has a fixed 520 px cap — it expands to fill available viewport height.
- **Monitoring table spacing**: the device column now uses aligned lanes for device identity, a compact heartbeat strip, and a lighter mini RTT graph, while uptime, RTT, service, checked, and favourite columns stay compact on the right.
- **Monitoring "X minutes ago" timezone offset**: `func.max(checked_at)` from SQLite returns a naive datetime; JavaScript was parsing it as local time, producing large offsets for non-UTC users. Fixed by applying `_as_utc()` to all three `checked_at` datetime fields in the monitoring API response.
- **Port checks now run in parallel**: sequential 2-second TCP timeouts across all devices × all port targets could push the effective monitor cycle far beyond the configured interval. Checks now run concurrently (up to 12 connections), matching the existing ICMP approach.

---

## [1.2.7] - 2026-06-03

### Discovery
- Added scheduled discovery scans with review-only network-change observations for new devices, MAC-matched IP changes, changed device fields, and disappeared hosts.
- Discovery schedules can run automatically or on demand, retain normal scan records, optionally notify through saved notification profiles, and avoid silently mutating inventory.
- Discovery now recognizes existing devices by normalized MAC address when a DHCP/Wi-Fi device returns at a new IP.
- Discovery import can explicitly update the IP address for a MAC-matched device when "Update IP when MAC matches" is selected.

### Monitoring
- Cleaned up the selected-device RTT chart with a lighter line, subtle guide grid, smaller endpoint marker, and dark-mode chart colors.
- Inventory uses the shared Monitoring-style live status pill, while Topology no longer shows a map-level Live/Paused pill.
- Monitoring device analysis now normalizes SQLite-returned timestamps as UTC before Python-side comparisons, preventing 500 errors from mixed naive/aware datetimes.
- Persisted monitoring status now feeds the shared frontend graph and Topology canvas, so status changes update node badges, details, and graph colors consistently instead of only the Inventory table.
- Background monitoring now falls back to a short TCP reachability probe when ICMP ping is unavailable, avoiding all devices being marked `unknown` in restricted container runtimes.
- Fixed a bug where the port-target DB query ran outside its SQLAlchemy session context, causing every monitor cycle to raise an error and never write device status or history rows to the database.
- Reduced the initial startup delay before the first monitor cycle from 30 seconds to 5 seconds so status indicators appear promptly after the container starts.
- Reduced the per-device ICMP probe from 2 packets / 2-second timeout to 1 packet / 1-second timeout, halving the check duration for offline devices without affecting cycle reliability.
- Favourite device status dots on the Overview page now reflect the live polling state from the shared graph rather than the one-time snapshot loaded on mount.

### Topology
- Scaled the topology group background slider so the UI still runs 0-100% while the effective background opacity stays capped at 10%.

### Security / Syslog
- OpenWrt banIP firewall prefixes now parse action, chain/context, and feed/list metadata.
- Corrupt `firewall.db` files encountered during retention cleanup are now recreated automatically instead of leaving startup maintenance errors in the logs.
- Firewall retention cleanup now skips overlapping in-process runs and defers gracefully when SQLite reports `database is locked`, avoiding startup maintenance tracebacks while retrying on the next retention pass.
- Security raw-log search now matches individual prefix terms instead of requiring the full query as an exact phrase.
- Security filters now use draft values with an explicit Search button or Enter key; quick filters and clickable event cells still apply immediately.
- Active network tool subprocess execution now allowlists ping/traceroute commands and rejects control characters in command arguments.

### Admin
- Added an Automation tab to the Admin panel with scheduled scan management (create, enable/pause, run on demand, delete) and a change observations panel (new device, IP change, field change, disappeared) with acknowledge and resolve actions.

### UI / General
- Overview panel headers are now consistent: top-row panels (Network health, Device types, Top groups) all use the standard header height, and the bottom-row Favourites header uses the compact variant so it aligns with Recently updated.
- Monitoring table now has a status filter dropdown (All / Online / Offline / Warning / Unknown) and a sortable status column header (asc = online first, desc = offline first).
- Topology entity dropdowns (Devices, Links, Groups) now have a sticky search bar that clears automatically when switching sections; items filter in real time against name, IP, link endpoints/type, or group name.
- Hovering a row in the entity panel now illuminates the corresponding node/edge on the canvas via a Cytoscape shadow glow (teal for devices and their connected edges, purple for group zones and member nodes, teal for link endpoints).
- Topology entity dropdown rows glow on hover via a subtle ring box-shadow (teal for devices/links, purple for groups).
- Search bar in dark mode now inherits the dropdown background seamlessly instead of rendering with a distinct white box.
- Fixed topology groups dropdown rendering the visibility eye button on a blank second line by correcting the grid column count from 3 to 4.
- Fixed topology links dropdown arrow asymmetry by centering the arrow glyph and widening its column from 14px to 22px.

### Exports / Operations
- Dev AIO compose now defaults `TRUSTED_HOSTS` to `["*"]` so local dev images can be opened through LAN IPs or hostnames without the SPA startup API calls returning 400.
- Network report PDF generation now skips malformed or unreadable `firewall.db` summary data instead of returning HTTP 500.
- Topology PNG export now renders via SVG→canvas using the same drawing logic as the SVG download; device icons, group zone boxes and labels, device name labels, and link labels (with background pill matching live-map style) all export correctly. Export is theme-aware (light/dark mode colours). Edge lines clip to each node's bounding-box boundary so connections to large zone groups terminate at the zone border rather than the center.
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

import { expect, test } from "@playwright/test";
import type { SystemDiagnostics } from "../../src/api/client";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const settings = {
  app_name: "NetMap", login_message: "", announcement: "", support_email: "", support_url: "",
  live_ping_enabled: true, monitor_interval_seconds: 120, idle_timeout_minutes: 15,
  active_network_public_targets_enabled: false, ip_reservation_default_expiry_enabled: true,
  ip_reservation_reminder_enabled: false, ip_reservation_reminder_days: 3, ip_reservation_reminder_channels: [],
  backup_schedule_enabled: true, backup_schedule_interval_hours: 24, backup_retention_count: 7,
};

const syslogStatus = {
  enabled: true, udp_enabled: true, tcp_enabled: true, tls_enabled: false, udp_port: 1514, tcp_port: 1514, tls_port: 6514,
  retention_days: 7, allowlist_enabled: false, total_events: 17960, retention_last_run_at: null, retention_last_deleted: 0,
  retention_last_error: null, last_event_received_at: null, received_packets: 18420, stored_events: 17960, dropped_unparsed: 380,
  denied_senders: 80, last_packet_at: null, last_packet_sender: null, last_stored_at: null, last_stored_sender: null,
  last_drop_at: null, last_drop_sender: null, last_drop_raw: null, last_denied_at: null, last_denied_sender: null,
};

const databaseFile = { exists: true, bytes: 1000000, wal_bytes: 0, shm_bytes: 0, total_bytes: 1000000 };
const cache = { cached: true, age_seconds: 1, hits: 1, misses: 0 };
const diagnostics: SystemDiagnostics = {
  generated_at: "2026-10-25T10:00:00Z", database: { main: databaseFile, firewall: databaseFile },
  monitoring: { last_checked_at: null, device_status_counts: { online: 2 }, cache: { ttl_seconds: 30, fleet_summary: cache, device_summaries: cache } },
  syslog: { total_events: 0, retention_last_run_at: null, retention_last_deleted: 0, retention_last_error: null, last_event_received_at: null }, process: { pid: 1 },
};

const devices = [mockDevice({ id: 1, topology_group: "Core" }), mockDevice({ id: 2, hostname: "switch-01", topology_group: "Core" })];
const routes = ["/overview", "/inventory#devices", "/inventory#cloud-assets", "/monitoring", "/monitoring#endpoints", "/monitoring#status-pages", "/topology", "/vlans", "/locations", "/ipam", "/security", "/tools", "/exports", "/admin#users", "/admin#system", "/admin#devices-icons", "/admin#cloud-providers", "/profile"];
const HEADERS = ".nm-app-panel-header, .topology-toolbar--ribbon, .security-results-meta, .tools-side-header";

for (const theme of ["light", "slate", "zinc"] as const) {
  for (const route of routes) {
    test(`every panel header on ${route} carries an icon well in ${theme} mode`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", error => { errors.push(error.message); console.log(`${route}: ${error.message}`); });
      page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await setupCoreMocks(page);
      await setupTopologyMocks(page, devices);
      await setupInventoryMocks(page, devices);
      await setupMonitoringMocks(page, [mockMonitoringDevice()]);
      await page.addInitScript((t) => {
        localStorage.setItem("netmap.theme", t === "light" ? "light" : "dark");
        localStorage.setItem("netmap.dark_style", t === "zinc" ? "zinc" : "slate");
      }, theme);
      await page.route("**/api/v1/exports/summary", route => route.fulfill({ json: { inventory_rows: 2, firewall_events: 0, exports_last_30_days: 0, last_export_at: null, last_export_type: null, last_export_detail: null } }));
      for (const path of ["admin/cloud-providers", "auth/users", "ipam/external/addresses"]) await page.route(`**/api/v1/${path}`, route => route.fulfill({ json: [] }));
      await page.route("**/api/v1/ipam/summary", route => route.fulfill({ json: { total_hosts: 100, used: 25, free: 75, subnet_count: 0, conflict_count: 0, dhcp_lease_count: 0, reservation_count: 0 } }));
      for (const path of ["ipam/subnets", "ipam/conflicts", "ipam/dhcp-leases", "ipam/reservations", "tools/snmp/profiles"]) await page.route(`**/api/v1/${path}`, route => route.fulfill({ json: [] }));
      await page.route("**/api/v1/admin/settings", route => route.fulfill({ json: settings }));
      for (const path of ["admin/notification-profiles", "exports/scheduled-backups", "status-pages", "status-pages/incidents", "status-pages/maintenance", "syslog/searches"]) await page.route(`**/api/v1/${path}`, route => route.fulfill({ json: [] }));
      await page.route("**/api/v1/admin/role-permissions", route => route.fulfill({ json: { permissions: [], roles: {} } }));
      await page.route("**/api/v1/admin/status-page-default-css", route => route.fulfill({ json: { css: "" } }));
      await page.route("**/api/v1/system/diagnostics", route => route.fulfill({ json: diagnostics }));
      await page.route("**/api/v1/syslog/status", route => route.fulfill({ json: syslogStatus }));
      await page.route("**/api/v1/syslog/events?*", route => route.fulfill({ json: { events: [], total: 0, limit: 100, offset: 0, retention_days: 7 } }));
      await page.goto(route);
      await expect(page.locator(HEADERS).first()).toBeVisible();
      const missing = await page.locator(HEADERS).evaluateAll((headers) => headers
        .filter((header) => (header as HTMLElement).offsetParent && !header.closest(".modal"))
        .filter((header) => !Array.from(header.querySelectorAll("svg")).some((svg) => {
          if (svg.closest("button, a, label, select, input, .nm-search")) return false;
          const square = (node: Element) => {
            const box = node.getBoundingClientRect();
            return [box.width, box.height].every((size) => Math.round(size) >= 28 && Math.round(size) <= 40);
          };
          return square(svg) || square(svg.parentElement!);
        }))
        .map((header) => (header.textContent ?? "").trim().slice(0, 40)));
      expect(missing).toEqual([]);
      const colours = await page.locator(HEADERS).evaluateAll(headers => headers
        .filter(header => (header as HTMLElement).offsetParent && !header.closest(".modal"))
        .map(header => ({ name: header.textContent?.trim().slice(0, 50), background: getComputedStyle(header).backgroundColor })));
      const allowed = theme === "light" ? ["rgb(47, 68, 91)"] : theme === "zinc" ? ["rgb(31, 31, 35)"] : ["rgb(22, 32, 51)"];
      for (const header of colours) expect(allowed, `${route}: ${header.name}`).toContain(header.background);
      expect(errors).toEqual([]);
      if (process.env.NETMAP_SURFACE_SCREENSHOTS) await page.screenshot({ path: `/tmp/netmap-page-${route.replace(/[^a-z0-9]/gi, "-")}-${theme}.png`, fullPage: true });
    });
  }
}

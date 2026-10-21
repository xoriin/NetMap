import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDevice, mockUser, setupCoreMocks, setupInventoryMocks, setupTopologyMocks } from "./helpers/api-mocks";

type Theme = "light" | "dark";

async function setTheme(page: Page, theme: Theme) {
  await page.addInitScript((selected) => window.localStorage.setItem("netmap.theme", selected), theme);
}

async function rowToken(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--nm-table-row-bg)";
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
}

async function expectRowSurface(page: Page, row: Locator) {
  await row.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const token = await rowToken(page);
  expect(token).not.toBe("rgba(0, 0, 0, 0)");
  await expect(row).toHaveCSS("background-color", token);
  await row.hover();
  await expect(row).not.toHaveCSS("background-color", token);
  await page.mouse.move(0, 0);
}

const syslogStatus = {
  enabled: true, udp_enabled: true, tcp_enabled: true, tls_enabled: false,
  udp_port: 1514, tcp_port: 1514, tls_port: 6514, retention_days: 7,
  allowlist_enabled: false, total_events: 1, received_packets: 1, stored_events: 1,
  dropped_unparsed: 0, denied_senders: 0, retention_last_run_at: null, retention_last_deleted: 0,
  retention_last_error: null, last_event_received_at: null, last_packet_at: null,
  last_packet_sender: null, last_stored_at: null, last_stored_sender: null, last_drop_at: null,
  last_drop_sender: null, last_drop_raw: null, last_denied_at: null, last_denied_sender: null,
};

async function setupSecurity(page: Page) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [mockDevice({ hostname: "edge-router", ip_address: "10.0.0.1" })]);
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: syslogStatus }));
  await page.route("**/api/v1/syslog/events*", (route) => route.fulfill({ json: {
    retention_days: 7, total: 1, offset: 0, limit: 100, events: [{
      id: 7, received_at: "2026-08-01T10:05:00Z", event_time: null, source_host: "firewall",
      src_ip: "10.0.0.1", dst_ip: "1.1.1.1", src_port: 52100, dst_port: 443, protocol: "tcp",
      action: "pass", interface: "wan", direction: "out", rule_id: "42", tracker_id: null,
      reason: "match", raw_log: "filterlog: pass",
    }],
  } }));
  await page.route("**/api/v1/syslog/searches", (route) => route.fulfill({ json: [] }));
}

async function setupAdmin(page: Page) {
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [{
    ...mockUser, display_name: "Network Administrator", avatar_data: null, auth_source: "local",
  }] }));
  await page.route("**/api/v1/admin/settings", (route) => route.fulfill({ json: {
    app_name: "NetMap", login_message: "", announcement: "", support_email: "", support_url: "",
    live_ping_enabled: true, monitor_interval_seconds: 120, idle_timeout_minutes: 15,
    active_network_public_targets_enabled: false, ip_reservation_default_expiry_enabled: true,
    ip_reservation_reminder_enabled: false, ip_reservation_reminder_days: 3, ip_reservation_reminder_channels: [],
    backup_schedule_enabled: false, backup_schedule_interval_hours: 24, backup_retention_count: 7,
  } }));
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: syslogStatus }));
  await page.route("**/api/v1/admin/oidc-settings", (route) => route.fulfill({ json: {
    enabled: false, issuer: "", client_id: "", client_secret_set: false, redirect_url: "",
    effective_redirect_url: "", scopes: "openid", allowed_email_domains: "", auto_provision: false,
    provider_name: "SSO", link_by_email: true, allow_unverified_email: false, group_claim: "groups",
    role_mappings: "{}", manage_roles: false, default_role: "Viewer", allow_super_admin: false,
    require_sso: false, env_configured: false,
  } }));
  await page.route("**/api/v1/admin/email-branding", (route) => route.fulfill({ json: {
    email_brand_theme: "login_banner", email_brand_name: "", email_brand_accent: "#1d9ab0", email_brand_logo: "",
    email_brand_footer: "", email_brand_url: "", email_brand_show_support: true,
  } }));
  await page.route("**/api/v1/admin/cloud-providers", (route) => route.fulfill({ json: [
    { id: 1, key: "aws", name: "AWS", aliases: [], icon: "aws", icon_data: null, builtin: true },
  ] }));
  await page.route("**/api/v1/admin/notification-profiles", (route) => route.fulfill({ json: [
    { id: 3, name: "Ops ntfy", provider: "ntfy", enabled: true, config: {}, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" },
  ] }));
  await page.route("**/api/v1/alerts/rules", (route) => route.fulfill({ json: [{
    id: 5, name: "Core offline", enabled: true, event_type: "device_offline", device_id: null,
    port_target_id: null, monitor_id: null, channels: ["profile:3"], cooldown_minutes: 15,
    threshold_ms: null, loss_pct_threshold: null, loss_window_minutes: null, open_incident: false,
    incident_min_failures: 1, last_triggered_at: null, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z",
  }] }));
  await page.route("**/api/v1/audit/logs*", (route) => route.fulfill({ json: {
    total: 1, limit: 50, offset: 0,
    records: [{ id: 9, created_at: "2026-08-01T10:00:00Z", action: "device.update", actor_user_id: 1, target: "router-01", detail: "renamed" }],
  } }));
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`data-table body rows use --nm-table-row-bg (${theme})`, () => {
    test("Security events", async ({ page }) => {
      await setupSecurity(page);
      await setTheme(page, theme);
      await page.goto("/security");
      await expectRowSurface(page, page.locator(".security-row").first());
    });

    test("VLANs", async ({ page }) => {
      await setupCoreMocks(page);
      await setupTopologyMocks(page, [mockDevice({ topology_group: "Servers" })]);
      await page.route("**/api/v1/topology/groups*", (route) => route.fulfill({ json: [{
        id: 20, name: "Servers", display_name: "Servers", vlan_id: "20", ip_range: "10.30.20.0/24",
        gateway: "10.30.20.1", dns_servers: "", description: "", color: null,
      }] }));
      await setTheme(page, theme);
      await page.goto("/vlans");
      await expectRowSurface(page, page.locator(".vlan-row").first());
    });

    test("Inventory devices", async ({ page }) => {
      const devices = [mockDevice({ id: 1 }), mockDevice({ id: 2, hostname: "switch-01", ip_address: "192.168.1.2" })];
      await setupCoreMocks(page);
      await setupTopologyMocks(page, devices);
      await setupInventoryMocks(page, devices);
      await setTheme(page, theme);
      await page.goto("/inventory");
      await expectRowSurface(page, page.locator(".inventory-row:not(.active)").first());
    });

    for (const [section, selector] of [
      ["Users", ".admin-users-table--accounts .admin-users-row"],
    ] as const) {
      test(`Admin ${section} (${selector})`, async ({ page }) => {
        await setupAdmin(page);
        await setTheme(page, theme);
        await page.goto("/admin");
        await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: section, exact: true }).click();
        await expectRowSurface(page, page.locator(selector).first());
      });
    }
  });
}

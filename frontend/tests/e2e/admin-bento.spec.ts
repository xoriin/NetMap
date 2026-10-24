import { expect, test, type Page } from "@playwright/test";
import { mockUser, setupCoreMocks } from "./helpers/api-mocks";

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

const cache = { cached: true, age_seconds: 4, hits: 10, misses: 2 };
const diagnostics = {
  generated_at: "2026-10-24T09:41:00Z",
  database: {
    main: { exists: true, bytes: 48_200_000, wal_bytes: 3_100_000, shm_bytes: 0, total_bytes: 51_300_000 },
    firewall: { exists: true, bytes: 212_600_000, wal_bytes: 0, shm_bytes: 0, total_bytes: 212_600_000 },
  },
  monitoring: { last_checked_at: "2026-10-24T09:40:00Z", device_status_counts: { online: 72, offline: 5, unknown: 8 }, cache: { ttl_seconds: 30, fleet_summary: cache, device_summaries: cache } },
  syslog: { total_events: 17960, retention_last_run_at: null, retention_last_deleted: 0, retention_last_error: null, last_event_received_at: null },
  process: { pid: 1 },
};

const backups = Array.from({ length: 10 }, (_, i) => ({
  filename: `netmap-backup-2026-10-${String(15 + i).padStart(2, "0")}.db`,
  size_bytes: (50 + i) * 1_000_000,
  created_at: `2026-10-${String(15 + i).padStart(2, "0")}T02:00:00Z`,
}));

const profiles = [
  { id: 1, name: "Ops email", provider: "smtp", enabled: true, config: { method: "smtp" }, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" },
  { id: 2, name: "On-call ntfy", provider: "ntfy", enabled: true, config: { method: "ntfy" }, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" },
  { id: 3, name: "Team Discord", provider: "apprise", enabled: false, config: { method: "discord" }, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" },
];

function deliveries() {
  const rows = [];
  const now = Date.now();
  let id = 1;
  for (let day = 0; day < 14; day += 1) {
    for (let n = 0; n < 3; n += 1) {
      rows.push({ id: id++, rule_name: "Core switch down", device_id: 1, target: n === 2 ? "profile:2" : "profile:1", status: day === 1 && n === 0 ? "failed" : "sent", detail: day === 1 && n === 0 ? "SMTP timeout" : "", sent_at: new Date(now - day * 86_400_000 - n * 60_000).toISOString() });
    }
  }
  return rows;
}

async function setupMocks(page: Page, theme: "light" | "slate" | "zinc", motion = false) {
  if (!motion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [{ ...mockUser, avatar_data: null, auth_source: "local" }] }));
  await page.route("**/api/v1/admin/settings", (route) => route.fulfill({ json: settings }));
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: syslogStatus }));
  await page.route("**/api/v1/system/diagnostics", (route) => route.fulfill({ json: diagnostics }));
  await page.route("**/api/v1/exports/scheduled-backups", (route) => route.fulfill({ json: backups }));
  await page.route("**/api/v1/admin/notification-profiles", (route) => route.fulfill({ json: profiles }));
  await page.route("**/api/v1/alerts/deliveries*", (route) => route.fulfill({ json: deliveries() }));
  await page.route("**/api/v1/admin/email-branding", (route) => route.fulfill({ json: { email_brand_theme: "login_banner", email_brand_name: "", email_brand_accent: "#1d9ab0", email_brand_logo: "", email_brand_footer: "", email_brand_url: "", email_brand_show_support: true } }));
  await page.route("**/api/v1/admin/email-branding/preview", (route) => route.fulfill({ json: { html: "<!doctype html><html><body>NetMap</body></html>" } }));
  await page.addInitScript((value) => {
    localStorage.setItem("netmap.theme", value === "light" ? "light" : "dark");
    localStorage.setItem("netmap.dark_style", value === "zinc" ? "zinc" : "slate");
  }, theme);
}

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

test("light mode panels carry the stronger element shadow", async ({ page }) => {
  await setupMocks(page, "light");
  await page.goto("/admin#system");
  const shadow = await page.locator(".admin-settings-card").evaluate((node) => getComputedStyle(node).boxShadow);
  expect(shadow).toContain("rgba(15, 35, 52, 0.14) 0px 12px 28px 0px");
});

test("light nested Admin section headers use the dark panel-header colour with white text and icon", async ({ page }) => {
  await setupMocks(page, "light");
  await page.goto("/admin#system");
  const title = page.getByRole("region", { name: "Identity and support", exact: true }).locator(":scope > .admin-task-title");
  await expect(title).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(title).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(title.locator("svg")).toHaveCSS("color", "rgb(255, 255, 255)");
});

for (const [theme, header] of [["slate", "rgb(29, 37, 54)"], ["zinc", "rgb(31, 31, 35)"]] as const) {
  test(`dark nested Admin section headers keep the module header colour in ${theme}`, async ({ page }) => {
    await setupMocks(page, theme);
    await page.goto("/admin#system");
    const title = page.getByRole("region", { name: "Identity and support", exact: true }).locator(":scope > .admin-task-title");
    await expect(title).toHaveCSS("background-color", header);
  });
}

test("System puts App settings under the version row with the charts stacked on the right", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await setupMocks(page, "slate");
  await page.goto("/admin#system");
  await expect(page.locator(".admin-version-hero")).toBeVisible();
  const version = await box(page, ".admin-bento");
  const appSettings = await box(page, ".admin-settings-card");
  const storage = await box(page, '[aria-label="Storage"]');
  const devices = await box(page, '[aria-label="Device status at last check"]');
  const backupsPanel = await box(page, '[aria-label="Backup size, last 10"]');
  const syslog = await box(page, '[aria-label="Syslog configuration"]');
  expect(appSettings.y).toBeGreaterThan(version.y + version.height);
  expect(storage.x).toBeGreaterThan(appSettings.x + appSettings.width);
  expect(Math.abs(storage.y - appSettings.y)).toBeLessThanOrEqual(1);
  expect(devices.y).toBeGreaterThan(storage.y + storage.height);
  expect(backupsPanel.y).toBeGreaterThan(devices.y + devices.height);
  expect(syslog.y).toBeGreaterThan(backupsPanel.y + backupsPanel.height);
  await expect(page.locator(".admin-stats .dash-stat")).toHaveCount(6);
  await expect(page.locator('[aria-label="Storage"] .nm-chart-seg')).toHaveCount(3);
  await expect(page.locator('[aria-label="Device status at last check"] .nm-chart-seg')).toHaveCount(3);
  await expect(page.locator('[aria-label="Backup size, last 10"] .nm-chart-col')).toHaveCount(10);
  await expect(page.locator('[aria-label="Syslog configuration"] .nm-stackbar > span')).toHaveCount(3);
});

test("Syslog sections sit 24px apart", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await setupMocks(page, "light");
  await page.goto("/admin#system");
  const gaps = await page.locator('[aria-label="Syslog configuration"] .admin-task-stack').evaluate((node) => {
    const rects = [...node.children].map((child) => child.getBoundingClientRect());
    return rects.slice(1).map((rect, i) => Math.round(rect.top - rects[i].bottom));
  });
  expect(gaps).toEqual([24, 24]);
});

test("chart tooltips show the hovered value", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await setupMocks(page, "slate");
  await page.goto("/admin#system");
  await page.locator('[aria-label="Device status at last check"] .nm-chart-seg').first().focus();
  await expect(page.locator(".hb-tooltip-card")).toContainText("Online");
  await expect(page.locator(".hb-tooltip-card")).toContainText("72");
});

test("entrance motion plays once and is off under reduced motion", async ({ page }) => {
  await setupMocks(page, "slate", true);
  await page.goto("/admin#system");
  await expect(page.locator(".nm-motion")).toHaveCount(1);
  expect(await page.locator(".admin-settings-card").evaluate((node) => getComputedStyle(node).animationName)).toBe("nm-rise");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const name = await page.locator(".admin-settings-card").evaluate((node) => getComputedStyle(node).animationName);
  expect(name).toBe("none");
});

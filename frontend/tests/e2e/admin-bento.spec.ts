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

test("Devices & icons caps the type chart to the summary cards and scrolls inside it", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await setupMocks(page, "slate");
  const types = Array.from({ length: 14 }, (_, i) => `type-${i + 1}`);
  await page.route("**/api/v1/admin/device-types", (route) => route.fulfill({ json: types.map((value) => ({ id: null, value, label: value, icon: "server", is_builtin: false, color: null })) }));
  await page.route("**/api/v1/topology/graph*", (route) => route.fulfill({ json: { devices: types.flatMap((type, i) => Array.from({ length: i + 1 }, (_, n) => ({ id: i * 100 + n, device_type: type, status: "active" }))), links: [], groups: [], sites: [] } }));
  await page.goto("/admin#devices-icons");
  const hero = page.getByRole("region", { name: "Devices by Type", exact: true });
  await expect(hero.locator(".nm-bar-list li")).toHaveCount(14);
  const heroBox = (await hero.boundingBox())!;
  const cards = (await page.locator(".nm-bento-stats").first().boundingBox())!;
  expect(Math.abs(heroBox.y + heroBox.height - (cards.y + cards.height))).toBeLessThanOrEqual(1);
  const scroll = await hero.locator(".nm-chart-body").evaluate((body) => ({ client: body.clientHeight, full: body.scrollHeight, overflow: getComputedStyle(body).overflowY }));
  expect(scroll.full).toBeGreaterThan(scroll.client);
  expect(scroll.overflow).toBe("auto");
});

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

test("light mode panels carry the stronger element shadow", async ({ page }) => {
  await setupMocks(page, "light");
  await page.goto("/admin#system");
  const shadow = await page.locator(".admin-settings-card").evaluate((node) => getComputedStyle(node).boxShadow);
  expect(shadow).toContain("rgba(15, 35, 52, 0.11) 0px 8px 22px 0px");
});

test("light nested Admin section headers use the dark panel-header colour with white text and icon", async ({ page }) => {
  await setupMocks(page, "light");
  await page.goto("/admin#system");
  const title = page.getByRole("region", { name: "Identity and Support", exact: true }).locator(":scope > .admin-task-title");
  await expect(title).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(title).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(title.locator("svg")).toHaveCSS("color", "rgb(255, 255, 255)");
});

for (const [theme, header] of [["slate", "rgb(29, 37, 54)"], ["zinc", "rgb(31, 31, 35)"]] as const) {
  test(`dark nested Admin section headers keep the module header colour in ${theme}`, async ({ page }) => {
    await setupMocks(page, theme);
    await page.goto("/admin#system");
    const title = page.getByRole("region", { name: "Identity and Support", exact: true }).locator(":scope > .admin-task-title");
    await expect(title).toHaveCSS("background-color", header);
  });
}

test("System puts App settings under the version row with the charts stacked on the right", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await setupMocks(page, "slate");
  await page.goto("/admin#system");
  await expect(page.locator(".admin-version-hero")).toBeVisible();
  const version = await box(page, ".nm-bento");
  const appSettings = await box(page, ".admin-settings-card");
  const storage = await box(page, '[aria-label="Storage"]');
  const devices = await box(page, '[aria-label="Device Status at Last Check"]');
  const backupsPanel = await box(page, '[aria-label="Backup Size, Last 10"]');
  const syslog = await box(page, '[aria-label="Syslog Configuration"]');
  expect(appSettings.y).toBeGreaterThan(version.y + version.height);
  expect(storage.x).toBeGreaterThan(appSettings.x + appSettings.width);
  expect(Math.abs(storage.y - appSettings.y)).toBeLessThanOrEqual(1);
  expect(devices.y).toBeGreaterThan(storage.y + storage.height);
  expect(backupsPanel.y).toBeGreaterThan(devices.y + devices.height);
  expect(syslog.y).toBeGreaterThan(backupsPanel.y + backupsPanel.height);
  await expect(page.locator(".nm-bento-stats .dash-stat")).toHaveCount(6);
  await expect(page.locator('[aria-label="Storage"] .nm-chart-seg')).toHaveCount(3);
  await expect(page.locator('[aria-label="Device Status at Last Check"] .nm-chart-seg')).toHaveCount(3);
  await expect(page.locator('[aria-label="Backup Size, Last 10"] .nm-chart-col')).toHaveCount(10);
  await expect(page.locator('[aria-label="Syslog Configuration"] .nm-stackbar > span')).toHaveCount(3);
});

test("Syslog sections sit 12px apart", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await setupMocks(page, "light");
  await page.goto("/admin#system");
  const gaps = await page.locator('[aria-label="Syslog Configuration"] .admin-task-stack').evaluate((node) => {
    const rects = [...node.children].map((child) => child.getBoundingClientRect());
    return rects.slice(1).map((rect, i) => Math.round(rect.top - rects[i].bottom));
  });
  expect(gaps).toEqual([12, 12]);
});

test("chart tooltips show the hovered value", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await setupMocks(page, "slate");
  await page.goto("/admin#system");
  await page.locator('[aria-label="Device Status at Last Check"] .nm-chart-seg').first().focus();
  await expect(page.locator(".hb-tooltip-card")).toContainText("Online");
  await expect(page.locator(".hb-tooltip-card")).toContainText("72");
});

test("hovering a column lights up and lifts only its bars, not the space around them", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await setupMocks(page, "slate", true);
  await page.goto("/admin#notifications");
  const column = page.locator(".nm-chart-col", { has: page.locator("path") }).first();
  await column.locator(".nm-chart-hit").hover();
  await expect(column).toHaveClass(/is-active/);
  await page.waitForTimeout(400);
  const layers = await column.evaluate((node) => {
    const children = [...node.children];
    const hit = node.querySelector(".nm-chart-hit")!;
    const bg = node.querySelector(".nm-chart-col-bg");
    const firstPath = node.querySelector("path")!;
    return {
      hitFill: getComputedStyle(hit).fill,
      bgFill: bg ? getComputedStyle(bg).fill : null,
      bgBeforeBars: bg ? children.indexOf(bg) < children.indexOf(firstPath) : false,
      barOpacity: getComputedStyle(firstPath).opacity,
      barFilter: getComputedStyle(firstPath).filter,
      barLift: getComputedStyle(firstPath).translate,
    };
  });
  expect(layers.hitFill, "the hit area above the bars stays transparent").toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
  expect(layers.bgFill, "no band is painted behind the hovered column").toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
  expect(layers.barFilter, "the hovered bars brighten").toContain("brightness");
  expect(layers.barLift, "the hovered bars lift").toMatch(/-\d/);
  expect(layers.barOpacity).toBe("1");
});

test("Notifications keeps services inside the methods panel beside type and failure cards of equal height", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await setupMocks(page, "slate");
  await page.goto("/admin#notifications");
  const methods = page.locator('[aria-label="Notification Methods"]');
  await expect(methods.locator(".admin-services")).toBeVisible();
  await expect(page.locator('[aria-label="Deliveries, last 14 days"] .nm-chart-col')).toHaveCount(14);
  await expect(page.locator('[aria-label="Methods by Type"] .nm-chart-seg')).toHaveCount(3);
  await expect(page.locator('[aria-label="Recent Failures"] li')).toHaveCount(1);
  await expect(page.locator(".notif-method-row .nm-sparkbars")).toHaveCount(3);
  const methodsBox = await box(page, '[aria-label="Notification Methods"]');
  const types = await box(page, '[aria-label="Methods by Type"]');
  const failures = await box(page, '[aria-label="Recent Failures"]');
  expect(types.x).toBeGreaterThan(methodsBox.x + methodsBox.width);
  expect(Math.abs(types.y - methodsBox.y)).toBeLessThanOrEqual(1);
  expect(Math.abs((failures.y + failures.height) - (methodsBox.y + methodsBox.height))).toBeLessThanOrEqual(1);
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

for (const theme of ['light', 'slate', 'zinc']) {
  test(`column totals have cornered nonzero badges and themed shading in ${theme}`, async ({ page }) => {
    await setupMocks(page, theme);
    const samples = [{ ...backups[0], size_bytes: 0 }, { ...backups[1], size_bytes: 12_000_000 }];
    await page.route('**/api/v1/exports/scheduled-backups', route => route.fulfill({ json: samples }));
    await page.goto('/admin#system');
    const chart = page.locator('[data-chart-id="admin.system.backups"]');
    await chart.scrollIntoViewIfNeeded();
    await expect(chart.locator('.nm-chart-value')).toHaveText(['12 MB']);
    await expect(chart.locator('.nm-chart-value-bg')).toHaveCount(1);
    await expect(chart.locator('.nm-chart-value-bg')).toHaveAttribute('rx', '4');
    const paint = await chart.evaluate(el => {
      const value = el.querySelector('.nm-chart-value-bg')!;
      const bar = el.querySelector('.nm-chart-col path')!;
      const header = el.closest('section')!.querySelector('.nm-app-panel-header')!;
      return { value: getComputedStyle(value).fill, shadow: getComputedStyle(bar).filter, header: getComputedStyle(header).backgroundColor };
    });
    if (theme === 'light') {
      expect(paint.header).toBe('rgb(47, 68, 91)');
      expect(paint.shadow).toContain('drop-shadow');
      expect(paint.shadow).not.toContain('rgba(0, 0, 0, 0)');
    } else {
      const channels = await chart.locator('.nm-chart-value-bg').evaluate(el => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!; ctx.fillStyle = getComputedStyle(el).fill; ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      });
      const track = theme === 'slate' ? [52, 67, 91] : [63, 63, 70];
      channels.forEach((value, index) => expect(value).toBeGreaterThan(track[index]));
    }
    await page.getByRole('button', { name: 'Visual options: Scheduled backup sizes in MB, oldest to newest', exact: true }).click();
    await chart.getByLabel('Show legend', { exact: true }).check();
    await expect(chart.locator('.nm-personal-plot .nm-chart-value')).toHaveText(['12 MB']);
    await expect(chart.locator('.nm-personal-plot .nm-chart-value-bg')).toHaveAttribute('rx', '4');
    await chart.getByLabel('Show values', { exact: true }).uncheck();
    await expect(chart.locator('.nm-chart-value-bg')).toHaveCount(0);
    await chart.getByLabel('Show values', { exact: true }).check();
    await chart.getByRole('button', { name: 'Close visual options', exact: true }).click();
    await chart.locator('xpath=ancestor::section[1]').screenshot({ path: test.info().outputPath(`column-values-${theme}.png`) });
  });
}

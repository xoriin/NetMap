import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, mockUser, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";
import { mockAddress, openExternalIps, setupExternalIps } from "./helpers/external-ip";
import { waitForPagePreload } from "./helpers/page-preload";

// Headless Chromium hides scrollbars by default, which would mask the gutter beside a table header.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

type Style = "light" | "slate" | "zinc";
const iso = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const devices = Array.from({ length: 12 }, (_, i) => mockDevice({ id: i + 1, display_name: `Device ${i + 1}` }));
const monitors = [1, 2].map((id) => ({
  id, name: `API ${id}`, enabled: true, last_status: "online", avg_response_time_24h: 40, uptime_24h: 99.9, uptime_7d: 99,
  url: "https://example.com/health", last_checked_at: iso(0.1), heartbeat: [], certificate_expiry_days: 14,
  last_cert_expires_at: iso(-200), last_cert_issuer: "R11", tags: [],
}));
const statusPage = {
  id: 1, slug: "ops", name: "Ops", title: null, visibility: "public", heartbeat_window: "1h",
  logo: null, accent: null, custom_css: null, created_at: iso(48), updated_at: iso(1),
};

async function boot(page: Page, style: Style) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices, []);
  await setupMonitoringMocks(page, devices.map((d, i) => mockMonitoringDevice({ device_id: i + 1, display_name: d.display_name, avg_rtt_24h: i + 1, uptime_24h: 1, health_status: "healthy" })));
  await page.route("**/api/v1/monitors", (route) => route.fulfill({ json: monitors }));
  await page.route("**/api/v1/status-pages**", (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v1\/status-pages\/?/, "");
    if (path === "") return route.fulfill({ json: [statusPage] });
    if (path === "1/preview") return route.fulfill({ json: {
      ...statusPage, title: "Ops", groups: [], incidents: [], notices: [], maintenance: [], past: [],
      summary: { state: "empty", label: "No systems configured", counts: {} },
      generated_at: new Date().toISOString(), valid_until: new Date(Date.now() + 30_000).toISOString(),
    } });
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: {
    enabled: true, udp_enabled: true, tcp_enabled: true, tls_enabled: false, udp_port: 1514, tcp_port: 1514, tls_port: 6514,
    retention_days: 7, allowlist_enabled: true, total_events: 0, received_packets: 0, stored_events: 0, dropped_unparsed: 0,
    denied_senders: 0, retention_last_run_at: null, retention_last_deleted: 0, retention_last_error: null, last_event_received_at: null,
  } }));
  await page.route("**/api/v1/syslog/events*", (route) => route.fulfill({ json: { retention_days: 7, total: 0, offset: 0, limit: 100, events: [] } }));
  await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [
    { ...mockUser, avatar_data: null, auth_source: "local" },
    { ...mockUser, id: 2, username: "viewer", role: "Viewer", avatar_data: null, auth_source: "local" },
  ] }));
  await page.route("**/api/v1/alerts/rules", (route) => route.fulfill({ json: [
    { id: 1, name: "Core switch down", enabled: true, event_type: "device_offline", channels: [], cooldown_minutes: 15, last_triggered_at: iso(2) },
  ] }));
  await page.addInitScript((value) => {
    localStorage.setItem("netmap.theme", value === "light" ? "light" : "dark");
    localStorage.setItem("netmap.dark_style", value === "zinc" ? "zinc" : "slate");
  }, style);
  await page.setViewportSize({ width: 2000, height: 1150 });
}

/** Content taller than the wrapper must never add a vertical scrollbar beside the table header. */
async function expectHeaderSpansWrapper(table: Locator, name: string) {
  await expect(table).toBeVisible();
  // Measure after the idle page preload, so a late feature stylesheet cannot add a gutter afterwards.
  await waitForPagePreload(table.page());
  const gap = await table.evaluate(async (tableEl) => {
    let wrap = tableEl.parentElement!;
    while (getComputedStyle(wrap).overflowX === "visible") wrap = wrap.parentElement!;
    wrap.style.maxHeight = `${Math.max(40, wrap.clientHeight - 6)}px`;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const head = tableEl.querySelector("thead")!.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(wrap).borderRightWidth) || 0;
    return { header: box.right - border - head.right, scrollbar: wrap.offsetWidth - wrap.clientWidth - border - (parseFloat(getComputedStyle(wrap).borderLeftWidth) || 0) };
  });
  expect(gap.scrollbar, `${name} vertical scrollbar`).toBe(0);
  expect(gap.header, `${name} header gap`).toBeLessThanOrEqual(1);
}

for (const style of ["light", "slate", "zinc"] as const) {
  test(`Monitoring and External IP table headers reach the right edge in ${style}`, async ({ page }) => {
    await boot(page, style);
    await page.goto("/monitoring#devices");
    await expectHeaderSpansWrapper(page.locator(".mon-view-window table").first(), "Devices");
    await page.goto("/monitoring#endpoints");
    await expectHeaderSpansWrapper(page.locator(".monitors-table-wrap table"), "Endpoints");
    await page.goto("/monitoring#status-pages");
    await expectHeaderSpansWrapper(page.locator(".status-pages-table-wrap table"), "Status pages");
    await setupExternalIps(page, { addresses: [mockAddress({ id: 1, ip_address: "203.0.113.10" }), mockAddress({ id: 2, ip_address: "203.0.113.11" })] });
    await page.goto("/ipam");
    await openExternalIps(page);
    await expectHeaderSpansWrapper(page.locator(".external-ip-table-wrap table"), "External IPs");
  });

  test(`Status pages scrolls to content below a long table in ${style}`, async ({ page }) => {
    await boot(page, style);
    const many = Array.from({ length: 40 }, (_, i) => ({ ...statusPage, id: i + 1, slug: `page-${i + 1}`, name: `Page ${i + 1}` }));
    await page.route("**/api/v1/status-pages", (route) => route.fulfill({ json: many }));
    await page.goto("/monitoring#status-pages");
    await expect(page.locator(".status-pages-table-wrap tbody tr")).toHaveCount(40);
    const workspace = page.locator(".workspace");
    await page.mouse.move(1100, 700);
    await page.mouse.wheel(0, 5000);
    await expect.poll(() => workspace.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1)).toBe(true);
  });

  test(`Security hero headers sit inside their panels in ${style}`, async ({ page }) => {
    await boot(page, style);
    await page.goto("/security");
    for (const name of ["Traffic Mix", "Top Sources"]) {
      const panel = page.getByRole("region", { name, exact: true });
      const box = (await panel.boundingBox())!;
      const head = (await panel.locator(".security-panel-header").boundingBox())!;
      expect(head.y).toBeGreaterThanOrEqual(box.y);
      expect(head.x).toBeGreaterThanOrEqual(box.x);
      expect(head.x + head.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      await expect(panel.locator(".security-panel-header strong")).toBeInViewport({ ratio: 1 });
    }
  });

  test(`Admin side-column bar lists start a full inset below their header in ${style}`, async ({ page }) => {
    await boot(page, style);
    for (const [route, name] of [["/admin#users", "Users by Role"], ["/admin#alerts", "Rules by Trigger"]] as const) {
      await page.goto(route);
      const panel = page.getByRole("region", { name, exact: true });
      const head = (await panel.locator(".nm-app-panel-header").boundingBox())!;
      const list = (await panel.locator(".nm-bar-list").boundingBox())!;
      expect(list.y - (head.y + head.height)).toBeGreaterThanOrEqual(15.5);
    }
  });
}

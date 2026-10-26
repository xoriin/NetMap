import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";
import { waitForPagePreload } from "./helpers/page-preload";

// Headless Chromium hides scrollbars by default, which would mask a reserved gutter.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const iso = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const devices = Array.from({ length: 40 }, (_, i) => mockDevice({ id: i + 1, display_name: `Device ${i + 1}` }));
const monitors = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1, name: `API ${i + 1}`, enabled: true, last_status: "online", avg_response_time_24h: 40, uptime_24h: 99.9, uptime_7d: 99,
  url: `https://example.com/health/${i + 1}`, last_checked_at: iso(0.1), heartbeat: [], certificate_expiry_days: 14,
  last_cert_expires_at: iso(-200), last_cert_issuer: "R11", tags: [],
}));
const statusPages = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1, slug: `page-${i + 1}`, name: `Page ${i + 1}`, title: null, visibility: "public", heartbeat_window: "1h",
  logo: null, accent: null, custom_css: null, created_at: iso(48), updated_at: iso(1),
}));

async function boot(page: Page, style: "light" | "slate" | "zinc") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices, []);
  await setupMonitoringMocks(page, devices.map((d, i) => mockMonitoringDevice({ device_id: i + 1, display_name: d.display_name, health_status: "healthy" })));
  await page.route("**/api/v1/monitors", (route) => route.fulfill({ json: monitors }));
  await page.route("**/api/v1/status-pages", (route) => route.fulfill({ json: statusPages }));
  await page.addInitScript((value) => {
    localStorage.setItem("netmap.theme", value === "light" ? "light" : "dark");
    localStorage.setItem("netmap.dark_style", value === "zinc" ? "zinc" : "slate");
  }, style);
  await page.setViewportSize({ width: 1440, height: 900 });
}

const views = [
  ["devices", "Devices", ".mon-view-window table"],
  ["endpoints", "Endpoints", ".monitors-table-wrap table"],
  ["status-pages", "Status pages", ".status-pages-table-wrap table"],
] as const;

for (const style of ["light", "slate", "zinc"] as const) {
  test(`Monitoring table headers end level with their rows and wrapper in ${style}`, async ({ page }) => {
    await boot(page, style);
    for (const [hash, name, selector] of views) {
      await page.goto(`/monitoring#${hash}`);
      const table = page.locator(selector).first();
      await expect(table.locator("tbody tr").first()).toBeVisible();
      await waitForPagePreload(page);
      const edges = await table.evaluate((tableEl) => {
        let wrap = tableEl.parentElement!;
        while (getComputedStyle(wrap).overflowX === "visible") wrap = wrap.parentElement!;
        wrap.scrollLeft = wrap.scrollWidth;
        const inner = wrap.getBoundingClientRect().right - (parseFloat(getComputedStyle(wrap).borderRightWidth) || 0);
        return {
          wrap: inner,
          header: tableEl.querySelector("thead tr")!.getBoundingClientRect().right,
          row: tableEl.querySelector("tbody tr")!.getBoundingClientRect().right,
        };
      });
      expect(Math.abs(edges.wrap - edges.header), `${name} header to wrapper edge`).toBeLessThanOrEqual(1);
      expect(Math.abs(edges.row - edges.header), `${name} header to row edge`).toBeLessThanOrEqual(1);
    }
  });
}

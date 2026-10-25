import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

for (const theme of ["light", "slate", "zinc"]) {
  test(`Status pages fill the service chart width with legend bars in ${theme}`, async ({ page }) => {
    await page.route("**/api/v1/**", route => route.fulfill({ json: [] }));
    await setupCoreMocks(page);
    await setupTopologyMocks(page);
    await setupMonitoringMocks(page);
    await page.addInitScript(theme => {
      localStorage.setItem("netmap.theme", theme === "light" ? "light" : "dark");
      localStorage.setItem("netmap.dark_style", theme === "zinc" ? "zinc" : "slate");
    }, theme);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/api/v1/status-pages", route => route.fulfill({ json: [{
      id: 1, name: "Customer services", slug: "customer", visibility: "public", heartbeat_window: "24h",
      updated_at: "2026-10-25T00:00:00Z", created_at: "2026-10-25T00:00:00Z", title: null,
    }] }));
    await page.route("**/api/v1/status-pages/1/preview?*", route => route.fulfill({ json: {
      summary: { counts: { operational: 34, degraded: 3, down: 1, maintenance: 2, unknown: 2 } },
    } }));
    await page.goto("/monitoring#status-pages");
    const chart = page.getByRole("region", { name: "Service health across pages", exact: true });
    await expect(chart.locator(".dash-donut-label")).toHaveText("Services");
    await expect(chart.locator(".nm-chart-legend-label")).toHaveText(["Healthy", "Degraded", "Unavailable", "Maintenance", "No data"]);
    await expect(chart.locator(".nm-chart-legend strong")).toHaveText(["34", "3", "1", "2", "2"]);
    await expect(chart.locator(".nm-chart-legend-track")).toHaveCount(5);
    await expect(page.locator(".dash-stat", { hasText: "Monitored services" })).toContainText("42");
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const ring = (await chart.locator(".nm-donut-ring").boundingBox())!;
      const legend = (await chart.locator(".nm-chart-legend").boundingBox())!;
      const body = (await chart.locator(".nm-chart-body").boundingBox())!;
      expect(legend.x).toBeGreaterThanOrEqual(ring.x + ring.width);
      expect(legend.x + legend.width).toBeLessThanOrEqual(body.x + body.width);
      expect(body.x + body.width - legend.x - legend.width).toBeLessThanOrEqual(20);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`status-${width}.png`) });
    }
    await page.route("**/api/v1/status-pages/1/preview?*", route => route.fulfill({ json: {
      summary: { counts: { operational: 1, degraded: 0, down: 0, maintenance: 0, unknown: 0 } },
    } }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await expect(chart.locator(".nm-chart-legend-track")).toHaveCount(1);
    const single = await chart.locator(".nm-chart-legend-track").evaluate(track => ({
      track: track.getBoundingClientRect().width,
      fill: track.querySelector("i")!.getBoundingClientRect().width,
      rightGap: track.closest(".nm-chart-body")!.getBoundingClientRect().right - track.closest("li")!.getBoundingClientRect().right,
    }));
    expect(Math.abs(single.track - single.fill)).toBeLessThanOrEqual(1);
    expect(single.rightGap).toBeLessThanOrEqual(20);
    await page.screenshot({ path: test.info().outputPath("status-single-service.png") });
    // This workspace-level choice must not remove share bars from other rings.
    await page.goto("/monitoring#devices");
    await expect(page.getByRole("region", { name: "Fleet health", exact: true }).locator(".nm-chart-legend-track").first()).toBeVisible();
    await page.route("**/api/v1/status-pages", route => route.fulfill({ json: [] }));
    await page.goto("/monitoring#status-pages");
    await expect(chart).toContainText("No monitored services on any status page yet.");
    await page.route("**/api/v1/status-pages", route => route.fulfill({ status: 500, json: { detail: "Status pages unavailable" } }));
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Status pages unavailable");
  });

}

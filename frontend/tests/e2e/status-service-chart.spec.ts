import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

for (const theme of ["light", "slate", "zinc"]) {
  test(`Status pages default to independent service bars without a duplicate legend in ${theme}`, async ({ page }) => {
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
    let saved: Record<string, unknown> = {};
    await page.route('**/api/v1/auth/me/chart-views**', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: saved });
      const id = new URL(route.request().url()).pathname.split('/chart-views/')[1];
      saved[id] = route.request().postDataJSON();
      return route.fulfill({ json: saved[id] });
    });
    await page.goto("/monitoring#status-pages");
    const chart = page.getByRole("region", { name: "Service Health Across Pages", exact: true });
    await expect(chart.locator(".dash-donut-label")).toHaveText("Services");
    await expect(chart.locator(".nm-bar-list-label")).toHaveText(["Healthy", "Degraded", "Unavailable", "Maintenance", "No data"]);
    await expect(chart.locator(".nm-bar-list strong")).toHaveText(["34", "3", "1", "2", "2"]);
    await expect(chart.locator('.nm-chart-legend-track')).toHaveCount(0);
    await expect(chart.locator('.nm-bar-list-track')).toHaveCount(5);
    await chart.getByRole('button', { name: /^Visual options:/ }).click();
    await chart.getByLabel('Show bars', { exact: true }).check();
    await expect(chart.getByLabel('Show legend', { exact: true })).toHaveCount(0);
    await chart.getByRole('button', { name: 'Save my view', exact: true }).click();
    await expect(chart.getByRole('status')).toHaveText('My view saved');
    await chart.getByRole('button', { name: 'Close visual options', exact: true }).click();
    await expect(chart.locator('.nm-bar-list-track')).toHaveCount(5);
    await expect(page.locator(".dash-stat", { hasText: "Monitored services" })).toContainText("42");
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const ring = (await chart.locator(".nm-personal-ring, .nm-donut-ring").boundingBox())!;
      const legend = (await chart.locator(".nm-bar-list").boundingBox())!;
      const body = (await chart.locator(".nm-chart-body").boundingBox())!;
      if (width > 390) expect(legend.x).toBeGreaterThanOrEqual(ring.x + ring.width);
      else expect(legend.y).toBeGreaterThanOrEqual(ring.y + ring.height);
      expect(legend.x + legend.width).toBeLessThanOrEqual(body.x + body.width);
      expect(body.x + body.width - legend.x - legend.width).toBeGreaterThanOrEqual(32);
      expect(body.x + body.width - legend.x - legend.width).toBeLessThanOrEqual(64);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`status-${width}.png`) });
    }
    await page.route("**/api/v1/status-pages/1/preview?*", route => route.fulfill({ json: {
      summary: { counts: { operational: 1, degraded: 0, down: 0, maintenance: 0, unknown: 0 } },
    } }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await expect(chart.locator(".nm-bar-list-track")).toHaveCount(1);
    const single = await chart.locator(".nm-bar-list-track").evaluate(track => ({
      track: track.getBoundingClientRect().width,
      fill: track.querySelector("i")!.getBoundingClientRect().width,
      rightGap: track.closest(".nm-chart-body")!.getBoundingClientRect().right - track.closest("li")!.getBoundingClientRect().right,
    }));
    expect(Math.abs(single.track - single.fill)).toBeLessThanOrEqual(1);
    expect(single.rightGap).toBeGreaterThanOrEqual(32);
    expect(single.rightGap).toBeLessThanOrEqual(64);
    await page.screenshot({ path: test.info().outputPath("status-single-service.png") });
    // Optional bars stay local to this chart.
    await page.goto("/monitoring#devices");
    await expect(page.getByRole("region", { name: "Fleet Health", exact: true }).locator(".nm-chart-legend")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Fleet Health", exact: true }).locator(".nm-bar-list")).toBeVisible();
    await page.route("**/api/v1/status-pages", route => route.fulfill({ json: [] }));
    await page.goto("/monitoring#status-pages");
    await expect(chart).toContainText("No monitored services on any status page yet.");
    await page.route("**/api/v1/status-pages", route => route.fulfill({ status: 500, json: { detail: "Status pages unavailable" } }));
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Status pages unavailable");
  });

}

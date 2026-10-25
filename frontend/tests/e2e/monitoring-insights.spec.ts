import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const names = ["VPN edge", "Branch NAS", "Wi-Fi AP", "App server", "Core switch", "Gateway"];
const latency = [126, 89, 52, 34, 18, 9];
const uptime = [96.4, 93.2, 98.1, 99.2, 100, 99.8];

async function boot(page: Page, theme: string) {
  await page.route("**/api/v1/**", route => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, names.map((display_name, i) => mockDevice({ id: i + 1, display_name })));
  await setupMonitoringMocks(page, names.map((display_name, i) => mockMonitoringDevice({
    device_id: i + 1, display_name, avg_rtt_24h: latency[i], uptime_24h: uptime[i] / 100,
  })));
  await page.addInitScript(theme => {
    localStorage.setItem("netmap.theme", theme === "light" ? "light" : "dark");
    localStorage.setItem("netmap.dark_style", theme === "zinc" ? "zinc" : "slate");
  }, theme);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

for (const theme of ["light", "slate", "zinc"]) {
  test(`Monitoring ranks devices in area insights above the table in ${theme}`, async ({ page }) => {
    await boot(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/monitoring#devices");
    const high = page.getByRole("region", { name: "Highest latency, last 24 h", exact: true });
    const low = page.getByRole("region", { name: "Least uptime, last 24 h", exact: true });
    await expect(high.locator(".nm-chart-area")).toBeVisible();
    await expect(low.locator(".nm-chart-area")).toBeVisible();
    await expect(high.locator(".nm-chart-hit").first()).toHaveAttribute("aria-label", "VPN edge: Average RTT 126 ms");
    await expect(low.locator(".nm-chart-hit").first()).toHaveAttribute("aria-label", "Branch NAS: Uptime 93.2%");
    await expect(high.locator(".nm-chart-area")).toHaveCSS("fill-opacity", "0.16");
    await expect(high.locator(".nm-chart-line")).toHaveCSS("stroke-width", "1.75px");
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await high.scrollIntoViewIfNeeded();
      const a = (await high.boundingBox())!, b = (await low.boundingBox())!;
      const table = (await page.locator(".mon-view-window--devices").boundingBox())!;
      expect(a.y + a.height).toBeLessThanOrEqual(table.y);
      expect(b.y + b.height).toBeLessThanOrEqual(table.y);
      expect(table.y - Math.max(a.y + a.height, b.y + b.height)).toBeGreaterThanOrEqual(15);
      if (width > 760) expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
      else expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`monitoring-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await high.locator(".nm-chart-hit").first().focus();
    await expect(page.locator(".hb-tooltip-card")).toContainText("VPN edge");
    await expect(page.locator(".hb-tooltip-card")).toContainText("126 ms");
    // Empty datasets never pass an empty row list to the shared area renderer.
    await setupMonitoringMocks(page, []);
    await page.reload();
    await expect(high).toContainText("No latency recorded yet.");
    await expect(low).toContainText("No uptime recorded yet.");
    await expect(high.locator("svg")).toHaveCount(1); // Header icon only.
    const longName = "Branch file server with a very long descriptive device name";
    await setupMonitoringMocks(page, [
      mockMonitoringDevice({ device_id: 1, display_name: longName, avg_rtt_24h: 0, uptime_24h: 0 }),
      mockMonitoringDevice({ device_id: 2, display_name: "No observations", avg_rtt_24h: null, uptime_24h: null }),
    ]);
    await page.reload();
    await expect(high.locator(".nm-chart-hit")).toHaveCount(1);
    await expect(low.locator(".nm-chart-hit")).toHaveCount(1);
    await expect(low.locator(".nm-chart-hit")).toHaveAttribute("aria-label", `${longName}: Uptime 0%`);
    await high.locator(".nm-chart-hit").focus();
    await expect(page.locator(".hb-tooltip-card")).toContainText(longName);
    await expect(page.locator(".hb-tooltip-card")).toContainText("0 ms");
    expect(errors).toEqual([]);
  });
}

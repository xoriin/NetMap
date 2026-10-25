import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const names = ["VPN edge", "Branch NAS", "Wi-Fi AP", "App server", "Core switch", "Gateway"];
const latency = [126, 89, 52, 34, 18, 9];
const vlans = ["20", "20", "30", "30", "30", null];

async function boot(page: Page, theme: string) {
  await page.route("**/api/v1/**", route => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, names.map((display_name, i) => mockDevice({ id: i + 1, display_name })));
  await setupMonitoringMocks(page, names.map((display_name, i) => mockMonitoringDevice({
    device_id: i + 1, display_name, avg_rtt_24h: latency[i], vlan_id: vlans[i],
  })));
  const views: Record<string, unknown> = {};
  await page.route("**/api/v1/auth/me/chart-views**", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: views });
    const id = new URL(route.request().url()).pathname.split("/chart-views/")[1];
    if (route.request().method() === "DELETE") { delete views[id]; return route.fulfill({ status: 204 }); }
    views[id] = route.request().postDataJSON();
    return route.fulfill({ json: views[id] });
  });
  await page.addInitScript(theme => {
    localStorage.setItem("netmap.theme", theme === "light" ? "light" : "dark");
    localStorage.setItem("netmap.dark_style", theme === "zinc" ? "zinc" : "slate");
  }, theme);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  return views;
}

for (const theme of ["light", "slate", "zinc"]) {
  test(`Monitoring VLAN visual switches graphics and remembers or resets its choice in ${theme}`, async ({ page }) => {
    const views = await boot(page, theme);
    await page.goto("/monitoring#devices");
    const panel = page.getByRole("region", { name: "Devices by VLAN", exact: true });
    const open = panel.getByRole("button", { name: "Visual options: Devices per VLAN", exact: true });
    await expect(panel.locator(".nm-bar-list-label")).toHaveText(["VLAN 30", "VLAN 20", "No VLAN"]);
    await open.click();
    for (const name of ["Ring", "Pie", "Bars", "Columns", "Stacked bar", "Line", "Area", "Dot plot", "Treemap", "Gauge", "Number", "Data table"]) {
      const choice = panel.getByRole("group", { name: "Visual type", exact: true }).getByRole("button", { name, exact: true });
      await expect(choice).toBeEnabled();
      await choice.click();
      await expect(choice).toHaveAttribute("aria-pressed", "true");
    }
    await panel.getByRole("button", { name: "Ring", exact: true }).click();
    await expect(panel.locator(".nm-personal-ring-centre strong")).toHaveText("6");
    await panel.getByRole("button", { name: "Save my view", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("My view saved");
    expect(views["monitoring.device-vlans"]).toMatchObject({ type: "ring" });
    await page.reload();
    await expect(panel.locator(".nm-personal-ring-centre strong")).toHaveText("6");
    await open.click();
    await panel.getByRole("button", { name: "Columns", exact: true }).click();
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(panel.locator(".nm-personal-ring-centre strong")).toHaveText("6");
    // Empty filtered data retains both the owner and its header options.
    await page.getByPlaceholder("Search devices…", { exact: true }).fill("no matching device");
    await expect(panel.locator(".nm-personal-ring")).toHaveCount(0);
    await expect(open).toBeEnabled();
    await open.click();
    await panel.getByRole("button", { name: "Reset this chart", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Default view restored");
    await panel.getByRole("button", { name: "Close visual options", exact: true }).click();
    await page.getByPlaceholder("Search devices…", { exact: true }).fill("");
    await expect(panel.locator(".nm-bar-list-label")).toHaveText(["VLAN 30", "VLAN 20", "No VLAN"]);
    await expect(panel.locator(".nm-bar-list strong")).toHaveText(["3", "2", "1"]);
    await expect(page.getByRole("region", { name: "Highest Latency", exact: true }).locator(".nm-bar-list")).toBeVisible();
  });

  test(`Monitoring ranks devices in bar insights above the table in ${theme}`, async ({ page }) => {
    await boot(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/monitoring#devices");
    const high = page.getByRole("region", { name: "Highest Latency", exact: true });
    const low = page.getByRole("region", { name: "Devices by VLAN", exact: true });
    await expect(high.locator(".nm-bar-list")).toBeVisible();
    await expect(low.locator(".nm-bar-list")).toBeVisible();
    await expect(high.locator(".nm-bar-list li").first()).toHaveAttribute("aria-label", "VPN edge: 126 ms");
    await expect(low.locator(".nm-bar-list li").first()).toHaveAttribute("aria-label", "VLAN 30: 3");
    await expect(high.locator(".nm-bar-list-track").first()).toHaveCSS("height", "8px");
    await expect(high.locator(".nm-bar-list")).toHaveCSS("row-gap", "9px");
    await expect(low.locator(".nm-bar-list-label")).toHaveText(["VLAN 30", "VLAN 20", "No VLAN"]);
    await expect(low.locator(".nm-bar-list strong")).toHaveText(["3", "2", "1"]);
    await expect(low.locator(".nm-bar-list-track i").first()).toHaveAttribute("style", /width: 100%/);
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
    await high.locator(".nm-bar-list li").first().focus();
    await expect(page.locator(".hb-tooltip-card")).toContainText("VPN edge");
    await expect(page.locator(".hb-tooltip-card")).toContainText("126 ms");
    // Empty datasets keep the explicit no-observations messages.
    await setupMonitoringMocks(page, []);
    await page.reload();
    await expect(high).toContainText("No latency recorded yet.");
    await expect(low).toContainText("No monitored devices yet.");
    await expect(high.getByRole("button", { name: /^Visual options:/ })).toBeEnabled();
    await expect(low.getByRole("button", { name: "Visual options: Devices per VLAN", exact: true })).toBeEnabled();
    const longName = "Branch file server with a very long descriptive device name";
    await setupMonitoringMocks(page, [
      mockMonitoringDevice({ device_id: 1, display_name: longName, avg_rtt_24h: 0, vlan_id: "20" }),
      mockMonitoringDevice({ device_id: 2, display_name: "No observations", avg_rtt_24h: null, vlan_id: "20" }),
    ]);
    await page.reload();
    await expect(high.locator(".nm-bar-list li")).toHaveCount(1);
    await expect(low.locator(".nm-bar-list li")).toHaveCount(1);
    await expect(low.locator(".nm-bar-list li")).toHaveAttribute("aria-label", "VLAN 20: 2");
    await high.locator(".nm-bar-list li").focus();
    await expect(page.locator(".hb-tooltip-card")).toContainText(longName);
    await expect(page.locator(".hb-tooltip-card")).toContainText("0 ms");
    await setupMonitoringMocks(page, [mockMonitoringDevice({ vlan_id: null })]);
    await page.reload();
    await expect(low.locator(".nm-bar-list-label")).toHaveText(["No VLAN"]);
    await expect(low.locator(".nm-bar-list strong")).toHaveText(["1"]);
    expect(errors).toEqual([]);
  });
}

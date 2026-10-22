import { expect, test } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const devices = [mockDevice({ id: 1, topology_group: "Core" }), mockDevice({ id: 2, hostname: "switch-01", topology_group: "Core" })];
const routes = ["/overview", "/inventory#devices", "/monitoring", "/monitoring#endpoints", "/monitoring#status-pages", "/topology", "/vlans", "/locations", "/security", "/tools", "/exports", "/admin#users", "/admin#system", "/profile"];
const HEADERS = ".nm-app-panel-header, .topology-toolbar--ribbon, .security-results-meta, .tools-side-header";

for (const theme of ["light", "dark"] as const) {
  for (const route of routes) {
    test(`every panel header on ${route} carries an icon well in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await setupCoreMocks(page);
      await setupTopologyMocks(page, devices);
      await setupInventoryMocks(page, devices);
      await setupMonitoringMocks(page, [mockMonitoringDevice()]);
      await page.addInitScript((t) => localStorage.setItem("netmap.theme", t), theme);
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
    });
  }
}

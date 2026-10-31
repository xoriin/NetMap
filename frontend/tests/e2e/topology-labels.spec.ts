import { test, expect, type Locator } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks, mockDevice } from "./helpers/api-mocks";

const LONG = "This is a really long display name to see if it fits";

async function clipped(locator: Locator) {
  return locator.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
}

test.describe("Topology long names", () => {
  test.beforeEach(async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page, [
      mockDevice({ id: 1, hostname: "router-01", display_name: LONG, ip_address: "10.30.20.10", topology_group: "Core" }),
      mockDevice({ id: 2, hostname: "switch-01", ip_address: "10.30.20.11", topology_group: "Core" }),
    ], []);
    await page.goto("/topology");
  });

  test("map labels wrap instead of cutting the name off", async ({ page }) => {
    const label = page.locator(".topology-overlay-node[title^='This is a really'] .topology-overlay-label");
    await expect(label).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: "test-results/topology-labels-map.png" });
    await expect(label).toContainText(LONG);
    expect(await clipped(label)).toBe(false);
    for (const line of await label.locator("span").all()) expect(await clipped(line)).toBe(false);
  });

  test("the device list and details panel show the whole name", async ({ page }) => {
    await page.locator(".topo-stat-btn--devices").click();
    const name = page.locator(".topo-entity-row .topo-entity-name", { hasText: "This is a really" });
    await expect(name).toBeVisible();
    await page.screenshot({ path: "test-results/topology-labels-list.png" });
    expect(await clipped(name)).toBe(false);
    await name.click();
    const heading = page.locator(".topology-details-panel .details-heading h3");
    await expect(heading).toHaveText(LONG);
    await page.screenshot({ path: "test-results/topology-labels-details.png" });
    expect(await clipped(heading)).toBe(false);
    const box = await heading.boundingBox();
    const panel = await page.locator(".topology-details-panel").boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
  });
});

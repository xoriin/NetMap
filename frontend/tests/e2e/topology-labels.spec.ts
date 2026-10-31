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

test.describe("Topology display reset", () => {
  test("Reset to defaults returns the selected group's display settings to the defaults", async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page, [
      mockDevice({ id: 1, hostname: "router-01", ip_address: "10.0.0.1", topology_group: "Core" }),
      mockDevice({ id: 2, hostname: "switch-01", ip_address: "10.0.0.2", topology_group: "Core" }),
    ], []);
    await page.goto("/topology");
    await page.getByRole("button", { name: "Display" }).click();
    const panel = page.locator(".toolbar-display-panel");
    const reset = panel.getByRole("button", { name: "Reset to defaults" });
    const nodeSize = panel.locator("label", { hasText: "Node size" });
    const labels = panel.locator("label", { hasText: "Device labels" });
    await expect(reset).toBeDisabled();
    const resetBox = (await reset.boundingBox())!;
    const selectBox = (await panel.locator("select").boundingBox())!;
    expect(Math.abs(resetBox.x - selectBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(resetBox.width - selectBox.width)).toBeLessThanOrEqual(1);
    await expect(nodeSize.locator("span")).toHaveText("125%");
    const defaultLabelSize = await labels.locator("span").textContent();

    await nodeSize.locator("input").fill("160");
    await labels.locator("input").fill("22");
    await panel.getByRole("button", { name: "Radial" }).click();
    await expect(nodeSize.locator("span")).toHaveText("160%");
    await expect(labels.locator("span")).toHaveText("22px");
    await expect(reset).toBeEnabled();
    await page.screenshot({ path: "test-results/topology-display-changed.png" });

    await reset.click();
    await expect(nodeSize.locator("span")).toHaveText("125%");
    await expect(labels.locator("span")).toHaveText(defaultLabelSize!);
    await expect(panel.getByRole("button", { name: "Grid" })).toHaveClass(/nm-btn--active/);
    await expect(panel.locator("label", { hasText: "Per row" })).toBeVisible();
    await expect(reset).toBeDisabled();
    await expect(page.locator(".topology-overlay-label").first()).toHaveCSS("font-size", `${parseInt(defaultLabelSize!, 10)}px`);
    await page.screenshot({ path: "test-results/topology-display-reset.png" });
  });
});

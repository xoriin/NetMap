import { test, expect } from "@playwright/test";
import {
  setupCoreMocks,
  setupTopologyMocks,
  mockDevice,
  mockRelationship,
} from "./helpers/api-mocks";

test.describe("Topology workspace", () => {
  test.beforeEach(async ({ page }) => {
    const devices = [
      mockDevice({ id: 1, hostname: "router-01", ip_address: "192.168.1.1", topology_group: "Core" }),
      mockDevice({ id: 2, hostname: "switch-01", ip_address: "192.168.1.2", topology_group: "Core" }),
    ];
    const relationships = [
      mockRelationship({ id: 1, source_device_id: 1, target_device_id: 2, relationship_type: "uplink" }),
    ];

    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices, relationships);
    await page.goto("/topology");
  });

  test("renders the topology canvas and overlay layer", async ({ page }) => {
    await expect(page.locator(".graph-canvas")).toBeVisible();
    await expect(page.locator(".topology-overlay-layer")).toBeVisible();
  });

  test("overlay device nodes are present for each device", async ({ page }) => {
    const overlayNodes = page.locator(".topology-overlay-node");
    await expect(overlayNodes).toHaveCount(2, { timeout: 8000 });
  });

  // Selecting a device via the entity list is the stable, user-visible path
  // (canvas-coordinate clicks against cytoscape are timing/position dependent).
  async function openDevicesList(page: import("@playwright/test").Page) {
    const devicesBtn = page.locator(".topo-stat-btn--devices");
    await devicesBtn.waitFor({ state: "visible", timeout: 8000 });
    await devicesBtn.click();
  }

  test("selecting a device opens the details panel", async ({ page }) => {
    await openDevicesList(page);
    const row = page.locator(".topo-entity-row", { hasText: "router-01" }).first();
    await row.waitFor({ state: "visible", timeout: 8000 });
    await row.click();
    await expect(page.locator(".details-panel")).toBeVisible({ timeout: 4000 });
  });

  test("selecting a device marks its overlay node as selected", async ({ page }) => {
    await openDevicesList(page);
    const row = page.locator(".topo-entity-row", { hasText: "router-01" }).first();
    await row.waitFor({ state: "visible", timeout: 8000 });
    await row.click();
    const selectedNode = page.locator(".topology-overlay-node.selected");
    await expect(selectedNode).toHaveCount(1, { timeout: 4000 });
    await expect(selectedNode).toHaveAttribute("title", "router-01");
  });

  test("selecting a second device changes selection", async ({ page }) => {
    await openDevicesList(page);
    const firstRow = page.locator(".topo-entity-row", { hasText: "router-01" }).first();
    await firstRow.waitFor({ state: "visible", timeout: 8000 });
    await firstRow.click();
    await expect(page.locator(".topology-overlay-node.selected")).toHaveAttribute("title", "router-01", { timeout: 4000 });

    // Selecting a row closes the entity list; reopen it for the second pick.
    await openDevicesList(page);
    const secondRow = page.locator(".topo-entity-row", { hasText: "switch-01" }).first();
    await secondRow.click();
    await expect(page.locator(".topology-overlay-node.selected")).toHaveCount(1, { timeout: 4000 });
    await expect(page.locator(".topology-overlay-node.selected")).toHaveAttribute("title", "switch-01");
  });

  test("overlay device node titles match hostnames", async ({ page }) => {
    const nodes = page.locator(".topology-overlay-node");
    await nodes.first().waitFor({ state: "visible", timeout: 8000 });

    const titles = await nodes.evaluateAll((els) =>
      els.map((el) => el.getAttribute("title"))
    );
    expect(titles).toContain("router-01");
    expect(titles).toContain("switch-01");
  });

  test("no overlay nodes rendered when graph is empty", async ({ page }) => {
    // Re-route topology/graph to return empty
    await page.route("**/api/v1/topology/graph", (route) =>
      route.fulfill({ json: { devices: [], relationships: [] } })
    );
    await page.reload();

    await expect(page.locator(".empty-graph")).toBeVisible({ timeout: 8000 });
    await expect(page.locator(".topology-overlay-node")).toHaveCount(0);
  });
  test("every scroll-wheel tick zooms the canvas by the same small step", async ({ page }) => {
    const node = page.locator(".topology-overlay-node").first();
    await expect(node).toBeVisible({ timeout: 8000 });
    const zoom = () => node.evaluate((el) => Number((el as HTMLElement).style.getPropertyValue("--topology-device-zoom")));
    const box = (await page.locator(".graph-canvas").boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height - 20);

    for (const deltaY of [-100, -100, -100, -100, -100, -100, -100, -100, -33.3333, -33.3333, -33.3333]) {
      const before = await zoom();
      await page.mouse.wheel(0, deltaY);
      await expect.poll(zoom).not.toBe(before);
      expect((await zoom()) / before).toBeCloseTo(2 ** (-deltaY * 0.002), 2);
    }
  });
});

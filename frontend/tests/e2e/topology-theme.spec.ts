import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockRelationship, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function setupThemedTopology(page: Page, theme: "light" | "dark", width = 1920) {
  await page.setViewportSize({ width, height: width < 1500 ? 900 : 1080 });
  await setupCoreMocks(page);
  await setupTopologyMocks(
    page,
    [
      mockDevice({ id: 1, hostname: "router-01", ip_address: "192.168.1.1", topology_group: "Core" }),
      mockDevice({ id: 2, hostname: "switch-01", ip_address: "192.168.1.2", topology_group: "Core", monitor_status: "offline" }),
    ],
    [mockRelationship({ id: 1, source_device_id: 1, target_device_id: 2, link_speed_mbps: 2500 })],
  );
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("netmap.theme", selectedTheme);
  }, theme);
  await page.goto("/topology");
  await page.locator(".topology-workspace-frame").waitFor({ state: "visible", timeout: 8000 });
  await expect(page.locator(".topology-overlay-node")).toHaveCount(2, { timeout: 8000 });
}

for (const theme of ["light", "dark"] as const) {
  test(`Topology chrome uses the approved solid hierarchy in ${theme} mode`, async ({ page }) => {
    await setupThemedTopology(page, theme);

    const frame = page.locator(".topology-workspace-frame");
    const ribbon = frame.locator(".topology-toolbar--ribbon");
    await expect(frame).toHaveCSS("background-image", "none");
    await expect(ribbon).toHaveCSS("min-height", "44px");
    await expect(ribbon).toHaveCSS("backdrop-filter", "none");
    await expect(ribbon.locator(".topology-ribbon-icon")).toBeVisible();
    await expect(ribbon.locator(".topology-ribbon-identity")).toContainText("Network map");
    const graph = frame.locator(".graph-surface");
    await expect(graph).toBeVisible();
    await expect(graph).toHaveCSS("background-color", theme === "dark" ? "rgb(8, 21, 33)" : "rgb(232, 240, 245)");
    const canvasControls = graph.locator(".topology-canvas-controls");
    await expect(canvasControls).toBeVisible();
    await expect(canvasControls.getByRole("button", { name: "Find" })).toBeVisible();
    await expect(canvasControls.getByRole("button", { name: "Path" })).toBeVisible();
    await expect(canvasControls.getByRole("button", { name: "Layouts" })).toBeVisible();
    await expect(ribbon.locator(".topology-canvas-controls")).toHaveCount(0);
    await expect(graph.locator(".topology-device-icon-frame")).toHaveCount(2);
    await expect(graph.locator(".topology-overlay-node.status-online")).toHaveCount(1);
    await expect(graph.locator(".topology-overlay-node.status-offline")).toHaveCount(1);
    const groupHeader = graph.locator(".topology-group-header");
    await expect(groupHeader).toContainText("Core");
    await expect(groupHeader.locator(".topology-group-header__count")).toHaveText("1");
    const headerClearance = await graph.evaluate((surface) => {
      const header = surface.querySelector<HTMLElement>(".topology-group-header")?.getBoundingClientRect();
      const frames = Array.from(surface.querySelectorAll<HTMLElement>(".topology-device-icon-frame"))
        .map((element) => element.getBoundingClientRect());
      return header && frames.length > 0
        ? Math.min(...frames.map((frame) => frame.top)) - header.bottom
        : null;
    });
    expect(headerClearance).not.toBeNull();
    expect(headerClearance ?? 0).toBeGreaterThanOrEqual(4);
    const linkLabel = graph.locator(".topology-link-label");
    await expect(linkLabel).toContainText("uplink");
    await expect(linkLabel.locator("strong")).toHaveText("2.5 Gbps");
    const frameBorders = await graph.locator(".topology-device-icon-frame").evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).borderColor),
    );
    expect(new Set(frameBorders).size).toBe(1);
    await expect(graph.locator(".topology-overlay-label").first()).toHaveCSS("border-top-style", "solid");

    const entityPanel = page.locator(".topo-entity-panel");
    const layout = page.locator("#topology");
    const [entityBox, layoutBox] = await Promise.all([entityPanel.boundingBox(), layout.boundingBox()]);
    expect(entityBox).not.toBeNull();
    expect(layoutBox).not.toBeNull();
    expect(entityBox?.y ?? 0).toBeGreaterThan(layoutBox?.y ?? 0);

    await entityPanel.locator(".topo-stat-btn--devices").click();
    const entityList = entityPanel.locator(".topo-entity-list");
    await expect(entityList).toBeVisible();
    await expect(entityList).toHaveCSS("background-image", "none");
  });
}

test("Topology details and floating controls remain integrated with the canvas", async ({ page }) => {
  await setupThemedTopology(page, "dark");

  const findButton = page.getByRole("button", { name: "Find" });
  await findButton.click();
  await expect(page.getByPlaceholder("Name, hostname or IP…")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Name, hostname or IP…")).toHaveCount(0);

  const entityPanel = page.locator(".topo-entity-panel");
  await entityPanel.locator(".topo-stat-btn--devices").click();
  await entityPanel.locator(".topo-entity-row", { hasText: "router-01" }).click();

  const details = page.locator(".topology-details-panel");
  await expect(details).toBeVisible();
  await expect(details).toHaveCSS("background-image", "none");
  await expect(details.locator(".details-heading")).toHaveCSS("min-height", "44px");
  await expect(details.locator(".device-detail-tabs")).toBeVisible();

  await page.getByRole("button", { name: "Path" }).click();
  const pathBar = page.locator(".topo-pathbar");
  await expect(pathBar).toBeVisible();
  await expect(pathBar).toHaveCSS("background-image", "none");

  const graph = page.locator(".graph-surface");
  const detailsBox = await details.boundingBox();
  const graphBox = await graph.boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(graphBox).not.toBeNull();
  expect((graphBox?.x ?? 0) + (graphBox?.width ?? 0)).toBeLessThanOrEqual((detailsBox?.x ?? 0) + 1);
});

test("Link details use the finished route hierarchy without moving canvas selectors", async ({ page }) => {
  await setupThemedTopology(page, "dark");

  const entityPanel = page.locator(".topo-entity-panel");
  const before = await entityPanel.boundingBox();
  await entityPanel.locator(".topo-stat-btn--relationships").click();
  await entityPanel.locator(".topo-entity-row--relationship").click();

  const linkDetails = page.locator(".relationship-detail");
  await expect(linkDetails).toBeVisible();
  await expect(linkDetails.locator(".relationship-detail__heading")).toContainText("Link details");
  await expect(linkDetails.locator(".relationship-endpoint")).toHaveCount(2);
  await expect(linkDetails.locator(".relationship-summary-card")).toContainText(["Link typeuplink", "Capacity2.5 Gbps"]);
  await expect(linkDetails.locator(".relationship-direction-row")).toHaveCount(2);
  await expect(linkDetails.locator(".relationship-state-pill.is-allowed")).toHaveCount(2);
  await expect(linkDetails.getByRole("button", { name: "Edit link" })).toBeVisible();
  await expect(linkDetails.getByRole("button", { name: "Delete link" })).toBeVisible();

  const after = await entityPanel.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
});

test("Topology device marks follow canvas zoom and use the expanded size range", async ({ page }) => {
  await setupThemedTopology(page, "dark");

  const displayButton = page.getByRole("button", { name: "Display" });
  await displayButton.click();
  const sizeSlider = page.locator(".toolbar-display-panel label", { hasText: "Node size" }).locator('input[type="range"]');
  await expect(sizeSlider).toHaveAttribute("min", "75");
  await expect(sizeSlider).toHaveAttribute("max", "180");
  const labelSlider = page.locator(".toolbar-display-panel label", { hasText: "Device labels" }).locator('input[type="range"]');
  await expect(labelSlider).toHaveAttribute("min", "10");
  await expect(labelSlider).toHaveAttribute("max", "28");

  const firstNode = page.locator(".topology-overlay-node").first();
  const beforeLayout = await firstNode.getAttribute("style");
  const radialButton = page.getByRole("button", { name: "Radial" });
  await radialButton.click();
  await expect(radialButton).toHaveClass(/nm-btn--active/);
  await expect.poll(() => firstNode.getAttribute("style")).not.toBe(beforeLayout);

  const gridButton = page.getByRole("button", { name: "Grid", exact: true });
  await gridButton.click();
  await expect(gridButton).toHaveClass(/nm-btn--active/);
  await expect.poll(async () => {
    const boxes = await page.locator(".topology-overlay-node").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }));
    return boxes.length === 2
      && Math.abs(boxes[0].y - boxes[1].y) <= 2
      && Math.abs(boxes[0].x - boxes[1].x) >= 50;
  }).toBe(true);

  await displayButton.click();

  const node = page.locator(".topology-overlay-node").first();
  const before = Number(await node.evaluate((element) => element.style.getPropertyValue("--topology-device-zoom")));
  const graph = page.locator(".graph-surface");
  await graph.hover({ position: { x: 500, y: 350 } });
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => Number(await node.evaluate((element) => element.style.getPropertyValue("--topology-device-zoom")))).not.toBe(before);
});

test("Topology device label sizes can be adjusted independently per group", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [
    mockDevice({ id: 1, hostname: "router-01", ip_address: "192.168.1.1", topology_group: "Core" }),
    mockDevice({ id: 2, hostname: "switch-01", ip_address: "192.168.2.1", topology_group: "Edge" }),
  ]);
  await page.goto("/topology");
  await expect(page.locator(".topology-overlay-node")).toHaveCount(2, { timeout: 8000 });

  await page.getByRole("button", { name: "Display" }).click();
  const groupSelect = page.locator(".toolbar-display-panel select");
  const labelSlider = page.locator(".toolbar-display-panel label", { hasText: "Device labels" }).locator('input[type="range"]');
  const coreLabel = page.locator('.topology-overlay-node[title="router-01"] .topology-overlay-label');
  const edgeLabel = page.locator('.topology-overlay-node[title="switch-01"] .topology-overlay-label');

  await groupSelect.selectOption("Core");
  await labelSlider.fill("24");
  await expect(coreLabel).toHaveCSS("font-size", "24px");
  await expect(edgeLabel).toHaveCSS("font-size", "13px");

  await groupSelect.selectOption("Edge");
  await expect(labelSlider).toHaveValue("13");
  await labelSlider.fill("18");
  await expect(edgeLabel).toHaveCSS("font-size", "18px");
  await expect(coreLabel).toHaveCSS("font-size", "24px");
});

test("Topology announcement and map share the narrow full-bleed canvas gutter", async ({ page }) => {
  await setupCoreMocks(page);
  await page.route("**/api/v1/admin/settings/public", (route) => route.fulfill({
    json: { app_name: "NetMap", idle_timeout_minutes: 15, announcement: "Planned maintenance" },
  }));
  await page.route("**/api/v1/admin/public-settings", (route) => route.fulfill({
    json: { app_name: "NetMap", idle_timeout_minutes: 15, announcement: "Planned maintenance" },
  }));
  await setupTopologyMocks(page, [mockDevice()], []);
  await page.goto("/topology");

  const banner = page.locator(".dash-alert--announcement");
  const frame = page.locator(".topology-workspace-frame");
  await expect(banner).toBeVisible();
  const [bannerBox, frameBox] = await Promise.all([banner.boundingBox(), frame.boundingBox()]);
  expect(bannerBox).not.toBeNull();
  expect(frameBox).not.toBeNull();
  expect(Math.abs((bannerBox?.x ?? 0) - (frameBox?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((frameBox?.width ?? 0) - (bannerBox?.width ?? 0))).toBeLessThanOrEqual(1);
});

test("Topology ribbon wraps cleanly at laptop width without covering the canvas", async ({ page }) => {
  await setupThemedTopology(page, "dark", 1280);

  const ribbon = page.locator(".topology-toolbar--ribbon");
  const graph = page.locator(".graph-surface");
  const entityPanel = page.locator(".topo-entity-panel");
  const [ribbonBox, graphBox, entityBox] = await Promise.all([
    ribbon.boundingBox(),
    graph.boundingBox(),
    entityPanel.boundingBox(),
  ]);
  expect(ribbonBox).not.toBeNull();
  expect(graphBox).not.toBeNull();
  expect(entityBox).not.toBeNull();
  expect((ribbonBox?.y ?? 0) + (ribbonBox?.height ?? 0)).toBeLessThanOrEqual((graphBox?.y ?? 0) + 1);
  expect(entityBox?.y ?? 0).toBeGreaterThanOrEqual((graphBox?.y ?? 0) + 8);

  const documentWidths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(documentWidths.scroll).toBeLessThanOrEqual(documentWidths.client);
});


/**
 * Link labels are HTML overlay elements, not cytoscape-drawn labels, so the
 * toolbar's "Link labels" slider only reached the cytoscape stylesheet (used
 * for PNG/PDF export) and never resized what is actually on screen.
 */
test("Topology link labels resize with the Link labels slider", async ({ page }) => {
  await setupThemedTopology(page, "dark");

  const label = page.locator(".topology-link-label").first();
  await expect(label).toBeVisible();
  const before = await label.evaluate((el) => getComputedStyle(el).fontSize);

  await page.getByRole("button", { name: "Display" }).click();
  const slider = page.locator(".toolbar-display-panel label", { hasText: "Link labels" })
    .locator('input[type="range"]');
  await expect(slider).toHaveAttribute("min", "10");
  await expect(slider).toHaveAttribute("max", "24");
  await slider.fill("24");

  await expect.poll(async () => label.evaluate((el) => getComputedStyle(el).fontSize)).not.toBe(before);
  await expect(label).toHaveCSS("font-size", "24px");
  // The speed chip inside the label must scale with it, not stay at 11px.
  const speed = label.locator("strong");
  if (await speed.count()) await expect(speed).toHaveCSS("font-size", "24px");
});

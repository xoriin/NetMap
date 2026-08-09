import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockRelationship, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function setupOverview(page: Page, theme: "light" | "dark", announcement: string | null = null) {
  await setupCoreMocks(page, announcement);
  await setupTopologyMocks(page, [
    mockDevice({ id: 1, hostname: "gateway-01", device_type: "router", vendor: "NetMap", topology_group: "Core", lifecycle: "active" }),
    mockDevice({ id: 2, hostname: "switch-01", device_type: "switch", vendor: "NetMap", topology_group: "Core", lifecycle: "active" }),
    mockDevice({ id: 3, hostname: "server-01", device_type: "server", vendor: "Example", topology_group: "Servers", monitor_status: "offline", lifecycle: "active" }),
  ], [mockRelationship({ source_device_id: 1, target_device_id: 2 })]);
  await page.route("**/api/v1/admin/device-types", (route) => route.fulfill({ json: [
    { id: null, value: "router", label: "Router", icon: "router", is_builtin: true, color: "#ef4444" },
    { id: null, value: "switch", label: "Switch", icon: "switch", is_builtin: true, color: "#22c55e" },
    { id: null, value: "server", label: "Server", icon: "server", is_builtin: true, color: "#3b82f6" },
  ] }));
  await page.route("**/api/v1/topology/groups*", (route) => route.fulfill({ json: [
    { id: 1, name: "Core", display_name: null, color: "#f97316" },
    { id: 2, name: "Servers", display_name: null, color: "#8b5cf6" },
  ] }));
  await page.route("**/api/v1/monitoring/summary", (route) => route.fulfill({
    json: { total_devices: 3, online: 2, offline: 1, warning: 0, avg_rtt_ms: 12.4 },
  }));
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("netmap.theme", selectedTheme);
  }, theme);
  await page.goto("/overview");
  await page.locator(".overview-workspace").waitFor({ state: "visible", timeout: 8000 });
}

for (const theme of ["light", "dark"] as const) {
  test(`Overview uses the approved solid panel hierarchy in ${theme} mode`, async ({ page }) => {
    await setupOverview(page, theme);

    const panels = page.locator(".overview-panel");
    await expect(panels).toHaveCount(5);
    await expect(panels.first()).toHaveCSS("background-image", "none");
    await expect(panels.first()).toHaveCSS("background-color", theme === "dark" ? "rgb(21, 33, 46)" : "rgb(249, 251, 253)");

    const headers = page.locator(".overview-panel-header");
    await expect(headers).toHaveCount(5);
    await expect(headers.first()).toHaveCSS("min-height", "44px");
    await expect(page.locator(".overview-panel-identity")).toHaveCount(5);
    await expect(page.locator(".overview-panel-icon").first()).toHaveCSS("width", "30px");

    const stat = page.locator(".dash-stat").first();
    await expect(stat).toHaveCSS("background-image", "none");

    const favouriteSearch = page.locator(".overview-fav-search");
    await expect(favouriteSearch).toBeVisible();
    await expect(favouriteSearch.locator("input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    const typeRows = page.locator(".overview-panel", { hasText: "Device types" }).locator(".dash-breakdown-row");
    await expect(typeRows).toHaveCount(3);
    await expect(typeRows.filter({ hasText: "Router" }).locator(".overview-device-type-fill")).toHaveCSS("--overview-type-color", "#ef4444");
    await expect(typeRows.filter({ hasText: "Switch" }).locator(".overview-device-type-fill")).toHaveCSS("--overview-type-color", "#22c55e");
    await expect(typeRows.filter({ hasText: "Server" }).locator(".overview-device-type-fill")).toHaveCSS("--overview-type-color", "#3b82f6");

    const groupRows = page.locator(".overview-panel", { hasText: "Top groups" }).locator(".dash-breakdown-row");
    await expect(groupRows).toHaveCount(2);
    await expect(groupRows.nth(0).locator(".dash-breakdown-label")).toHaveText("Core");
    await expect(groupRows.nth(0).locator(".overview-group-fill")).toHaveCSS("--overview-group-color", "#f97316");
    await expect(groupRows.nth(1).locator(".dash-breakdown-label")).toHaveText("Servers");
    await expect(groupRows.nth(1).locator(".overview-group-fill")).toHaveCSS("--overview-group-color", "#8b5cf6");

    // The stat card and panel speak expected-vs-observed health, not raw
    // reachability — a device that is expected to be offline is not listed.
    await page.getByRole("button", { name: /Unexpected/ }).click();
    await expect(page.locator(".overview-offline-panel")).toBeVisible();
    await expect(page.locator(".overview-offline-panel .overview-panel-identity")).toContainText("Unexpected device states");
  });
}

// Regression for GitHub #29: a device marked "expected offline" read green in
// Inventory and Monitoring but red on Overview, because Overview judged raw
// reachability instead of observed-vs-expected health.
test("Overview counts an expected-offline device as healthy", async ({ page }) => {
  await setupCoreMocks(page, null);
  await setupTopologyMocks(page, [
    mockDevice({ id: 1, hostname: "gateway-01", device_type: "router", topology_group: "Core", lifecycle: "active" }),
    mockDevice({
      id: 2,
      hostname: "upside-down",
      device_type: "server",
      topology_group: "Core",
      lifecycle: "active",
      monitor_status: "offline",
      expected_status: "offline",
    }),
  ], []);
  await page.goto("/overview");
  await page.locator(".overview-workspace").waitFor({ state: "visible", timeout: 8000 });

  const expectedCard = page.locator(".dash-stat", { hasText: "Expected" }).first();
  const unexpectedCard = page.locator(".dash-stat", { hasText: "Unexpected" }).first();
  await expect(expectedCard.locator(".dash-stat-value")).toHaveText("2");
  await expect(unexpectedCard.locator(".dash-stat-value")).toHaveText("0");

  // No red alert bar, and the device reads as deliberately offline.
  await expect(page.locator(".dash-alert--overview-bar")).toHaveCount(0);
  const row = page.locator(".dash-device-row", { hasText: "upside-down" }).first();
  await expect(row.locator(".nm-status")).toHaveText("expected offline");
  await expect(row.locator(".dash-status-dot--online")).toHaveCount(1);
});

// Paused devices must not fall through to an unstyled pill/invisible dot — the
// dash-status-dot--* and nm-status--* vocabularies had no "paused" variant.
test("Overview renders a paused device with visible status marks", async ({ page }) => {
  await setupCoreMocks(page, null);
  await setupTopologyMocks(page, [
    mockDevice({ id: 1, hostname: "retired-01", device_type: "server", topology_group: "Core", monitoring_paused: true }),
  ], []);
  await page.goto("/overview");
  await page.locator(".overview-workspace").waitFor({ state: "visible", timeout: 8000 });

  const row = page.locator(".dash-device-row", { hasText: "retired-01" }).first();
  await expect(row.locator(".nm-status--paused")).toHaveText("paused");
  await expect(row.locator(".nm-status--paused")).toHaveCSS("border-style", "dashed");
  await expect(row.locator(".dash-status-dot--paused")).not.toHaveCSS("box-shadow", "none");
});

test("Overview panels and header controls reflow without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await setupOverview(page, "dark");

  const favouritesHeader = page.locator(".overview-panel-header", { hasText: "Favourites" });
  await expect(favouritesHeader).toHaveCSS("flex-direction", "column");
  const [headerBox, searchBox] = await Promise.all([
    favouritesHeader.boundingBox(),
    favouritesHeader.locator(".overview-fav-search").boundingBox(),
  ]);
  expect(headerBox).not.toBeNull();
  expect(searchBox).not.toBeNull();
  expect(searchBox!.width).toBeGreaterThan(0);
  expect(searchBox!.width).toBeLessThanOrEqual(headerBox!.width);

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
});

test("MOTD and summary cards share the canonical workspace anchor", async ({ page }) => {
  await setupOverview(page, "dark", "Planned maintenance");

  const motd = page.locator(".dash-alert--announcement");
  await expect(motd).toBeVisible();
  const [workspaceBox, motdBox, summaryBox] = await Promise.all([
    page.locator(".workspace").boundingBox(),
    motd.boundingBox(),
    page.locator(".overview-workspace > .nm-summary-band").boundingBox(),
  ]);

  expect(workspaceBox).not.toBeNull();
  expect(motdBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(Math.abs(motdBox!.x - summaryBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((motdBox!.x + motdBox!.width) - (summaryBox!.x + summaryBox!.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(motdBox!.x - workspaceBox!.x - 24)).toBeLessThanOrEqual(1);
  expect(Math.abs(summaryBox!.y - (motdBox!.y + motdBox!.height) - 16)).toBeLessThanOrEqual(1);
});

import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockRelationship, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function setupOverview(page: Page, theme: "light" | "dark", announcement: string | null = null) {
  await setupCoreMocks(page, announcement);
  await setupTopologyMocks(page, [
    mockDevice({ id: 1, hostname: "gateway-01", device_type: "router", vendor: "NetMap", os: "RouterOS", topology_group: "Core", lifecycle: "active" }),
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

test("route controls preserve native link and new-tab semantics", async ({ page }) => {
  await setupOverview(page, "dark");

  const inventory = page.getByRole("link", { name: "Inventory", exact: true });
  await expect(inventory).toHaveAttribute("href", "/inventory");
  await expect(inventory).toHaveCSS("display", "flex");

  const modifiedClick = await inventory.evaluate((element) => {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    return {
      dispatched: element.dispatchEvent(event),
      defaultPrevented: event.defaultPrevented,
      tagName: element.tagName,
    };
  });
  expect(modifiedClick).toEqual({ dispatched: true, defaultPrevented: false, tagName: "A" });
  await expect(page).toHaveURL(/\/overview$/);

  await inventory.click();
  await expect(page).toHaveURL(/\/inventory$/);
  await expect(page.getByRole("link", { name: "Cloud assets", exact: true })).toHaveAttribute("href", "/inventory#cloud");
});

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
    await expect(page.locator(".dash-device-row", { hasText: "gateway-01" }).first().locator(".dash-device-meta")).toContainText("RouterOS");

    const groupRows = page.locator(".overview-panel", { hasText: "Top groups" }).locator(".dash-breakdown-row");
    await expect(groupRows).toHaveCount(2);
    await expect(groupRows.nth(0).locator(".dash-breakdown-label")).toHaveText("Core");
    await expect(groupRows.nth(0).locator(".overview-group-fill")).toHaveCSS("--overview-group-color", "#f97316");
    await expect(groupRows.nth(1).locator(".dash-breakdown-label")).toHaveText("Servers");
    await expect(groupRows.nth(1).locator(".overview-group-fill")).toHaveCSS("--overview-group-color", "#8b5cf6");

    // The stat card and panel speak expected-vs-observed health, not raw
    // reachability — a device that is expected to be offline is not listed.
    await page.getByRole("button", { name: /Offline/ }).click();
    await expect(page.locator(".overview-offline-panel")).toBeVisible();
    await expect(page.locator(".overview-offline-panel .overview-panel-identity")).toContainText("Offline devices");
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

  const onlineCard = page.locator(".dash-stat", { hasText: "Online" }).first();
  const offlineCard = page.locator(".dash-stat", { hasText: "Offline" }).first();
  await expect(onlineCard.locator(".dash-stat-value")).toHaveText("2");
  await expect(offlineCard.locator(".dash-stat-value")).toHaveText("0");

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

// GitHub #31: favourited standalone endpoints appear on Overview alongside
// favourited devices, without being counted as inventory devices.
test("Overview lists favourited endpoints in the favourites panel", async ({ page }) => {
  await setupCoreMocks(page, null);
  await setupTopologyMocks(page, [
    mockDevice({ id: 1, hostname: "gateway-01", device_type: "router", topology_group: "Core", lifecycle: "active" }),
  ], []);
  await setupMonitoringMocks(page, []);
  await page.route("**/api/v1/monitors", (route) => route.fulfill({
    json: [
      {
        id: 7, name: "Status page", url: "https://status.example.com/", enabled: true,
        last_status: "online", uptime_24h: 99.9, uptime_7d: 99.5, avg_response_time_24h: 42.5,
        heartbeat: ["online", "online", "online"], is_favourite: true,
      },
      {
        id: 8, name: "Unstarred API", url: "https://api.example.com/", enabled: true,
        last_status: "offline", uptime_24h: 10, uptime_7d: 20, avg_response_time_24h: null,
        heartbeat: [], is_favourite: false,
      },
    ],
  }));
  await page.goto("/overview");
  await page.locator(".overview-workspace").waitFor({ state: "visible", timeout: 8000 });

  const favPanel = page.locator(".overview-panel", { hasText: "Favourites" }).first();
  await expect(favPanel.getByText("Status page")).toBeVisible();
  await expect(favPanel.getByText("Unstarred API")).toHaveCount(0);
  await expect(favPanel.locator(".dash-fav-rtt").filter({ hasText: "42.5 ms" })).toBeVisible();
  await expect(favPanel.locator(".dash-fav-divider")).toHaveCount(0);

  // The endpoint must not inflate the device stat cards.
  const totalCard = page.locator(".dash-stat", { hasText: "Total devices" }).first();
  await expect(totalCard.locator(".dash-stat-value")).toHaveText("1");

  await favPanel.getByText("Status page").click();
  await expect(page).toHaveURL(/\/monitoring#endpoints$/);
  await expect(page.locator(".mon-view-window--endpoints")).toBeVisible();
});

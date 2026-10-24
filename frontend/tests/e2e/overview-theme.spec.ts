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
    let defaultPrevented = true;
    const stopNewTab = (seen: Event) => {
      defaultPrevented = seen.defaultPrevented;
      seen.preventDefault();
    };
    window.addEventListener("click", stopNewTab, { once: true });
    element.dispatchEvent(event);
    return { defaultPrevented, tagName: element.tagName };
  });
  expect(modifiedClick).toEqual({ defaultPrevented: false, tagName: "A" });
  await expect(page).toHaveURL(/\/overview$/);

  await inventory.click();
  await expect(page).toHaveURL(/\/inventory$/);
  // Arriving at a section drops its sub-nav down, and those sub-items are real links
  // too. ("Cloud assets" used to be the probe here; that page no longer exists.)
  await expect(
    page.locator('[aria-label="Inventory sections"]').getByRole("link", { name: "Devices", exact: true }),
  ).toHaveAttribute("href", "/inventory#devices");
});

for (const theme of ["light", "dark"] as const) {
  test(`Overview uses the approved solid panel hierarchy in ${theme} mode`, async ({ page }) => {
    await setupOverview(page, theme);

    const panels = page.locator(".overview-panel");
    await expect(panels).toHaveCount(2);
    await expect(panels.first()).toHaveCSS("background-image", "none");
    await expect(panels.first()).toHaveCSS("background-color", theme === "dark" ? "rgb(22, 29, 46)" : "rgb(254, 254, 254)");

    const headers = page.locator(".overview-panel-header");
    await expect(headers).toHaveCount(2);
    await expect(headers.first()).toHaveCSS("min-height", "44px");
    await expect(page.locator(".overview-panel-identity")).toHaveCount(2);
    await expect(page.locator(".overview-panel-icon").first()).toHaveCSS("width", "30px");

    const insights = page.locator(".overview-workspace .nm-insight");
    await expect(insights).toHaveCount(6);
    for (const insight of await insights.all()) await expect(insight).toHaveCSS("background-image", "none");

    const stat = page.locator(".dash-stat").first();
    await expect(stat).toHaveCSS("background-image", "none");
    await expect(page.locator(".nm-bento-stats .dash-stat")).toHaveCount(6);
    await expect(page.locator(".nm-bento-stats .dash-stat", { hasText: "Groups / VLANs" }).locator(".dash-stat-sub")).toHaveText("Core is the largest");

    const favouriteSearch = page.locator(".overview-fav-search");
    await expect(favouriteSearch).toBeVisible();
    await expect(favouriteSearch.locator("input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    const typeRows = page.getByRole("region", { name: "Device types", exact: true }).locator(".nm-bar-list li");
    await expect(typeRows).toHaveCount(3);
    await expect(typeRows.filter({ hasText: "Router" }).locator(".nm-bar-list-track > i")).toHaveCSS("background-color", "rgb(239, 68, 68)");
    await expect(typeRows.filter({ hasText: "Switch" }).locator(".nm-bar-list-track > i")).toHaveCSS("background-color", "rgb(34, 197, 94)");
    await expect(typeRows.filter({ hasText: "Server" }).locator(".nm-bar-list-track > i")).toHaveCSS("background-color", "rgb(59, 130, 246)");
    await expect(page.locator(".dash-device-row", { hasText: "gateway-01" }).first().locator(".dash-device-meta")).toContainText("RouterOS");

    const groupRows = page.getByRole("region", { name: "Top groups", exact: true }).locator(".nm-bar-list li");
    await expect(groupRows).toHaveCount(2);
    await expect(groupRows.nth(0).locator(".nm-bar-list-label")).toHaveText("Core");
    await expect(groupRows.nth(0).locator(".nm-bar-list-track > i")).toHaveCSS("background-color", "rgb(249, 115, 22)");
    await expect(groupRows.nth(1).locator(".nm-bar-list-label")).toHaveText("Servers");
    await expect(groupRows.nth(1).locator(".nm-bar-list-track > i")).toHaveCSS("background-color", "rgb(139, 92, 246)");

    // The stat card and panel speak expected-vs-observed health, not raw
    // reachability — a device that is expected to be offline is not listed.
    const outages = page.getByRole("region", { name: "Current outages", exact: true });
    await page.getByRole("button", { name: /Offline/ }).click();
    await expect(outages).toBeInViewport();
    await expect(page.locator("#overview-outages")).toBeFocused();
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
    page.locator(".overview-workspace > .nm-bento").boundingBox(),
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

for (const theme of ["light", "dark"] as const) {
  test(`unstarred endpoint outages refresh on an open Overview in ${theme}`, async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page, [mockDevice({ id: 1, monitor_status: "online", lifecycle: "active" })]);
    await setupMonitoringMocks(page);
    let status = "online";
    let fail = false;
    await page.route("**/api/v1/monitors", (route) => fail ? route.fulfill({ status: 503, json: { detail: "Unavailable" } }) : route.fulfill({ json: [
      { id: 9, name: "Customer portal", url: "https://portal.example.com", enabled: true, last_status: status, heartbeat: [], is_favourite: false, last_checked_at: "2026-09-10T09:00:00Z" },
      { id: 10, name: "Paused endpoint", url: "https://paused.example.com", enabled: false, last_status: "offline", heartbeat: [], is_favourite: false },
    ] }));
    await page.addInitScript((value) => localStorage.setItem("netmap.theme", value), theme);
    await page.clock.install();
    await page.goto("/overview");
    await expect(page.locator(".overview-workspace")).toBeVisible();
    status = "offline";
    await page.clock.fastForward(30_000);
    await expect(page.locator(".dash-alert--overview-bar")).toContainText("1 endpoint offline");
    await expect(page.locator(".dash-alert--overview-bar")).not.toContainText("Paused endpoint");
    await page.locator(".dash-alert--overview-bar").getByRole("button", { name: /View/ }).click();
    const outage = page.getByRole("region", { name: "Current outages", exact: true });
    await expect(outage.getByRole("link", { name: /Customer portal/ })).toHaveAttribute("href", "/monitoring#endpoints");
    await expect(outage).toHaveCSS("background-image", "none");
    await page.screenshot({ path: `/tmp/netmap-overview-${theme}.png`, fullPage: true });
    fail = true;
    await page.clock.fastForward(30_000);
    await expect(page.getByRole("alert").filter({ hasText: "Endpoint status could not" })).toBeVisible();
    fail = false; status = "online";
    await page.clock.fastForward(30_000);
    await expect(page.locator(".dash-alert--overview-bar")).toHaveCount(0);
  });
}

for (const style of ["light", "slate", "zinc"] as const) {
  test(`Shared bar tracks and labels use the approved brightness in ${style}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("netmap.dark_style", value), style === "zinc" ? "zinc" : "slate");
    await setupOverview(page, style === "light" ? "light" : "dark");
    const distribution = style === "light" ? "rgb(211, 211, 211)" : style === "slate" ? "rgb(52, 67, 91)" : "rgb(63, 63, 70)";
    for (const width of [1600, 820, 430]) {
      await page.setViewportSize({ width, height: 1100 });
      const tracks = page.locator(".overview-workspace .nm-bar-list-track");
      await expect(tracks.first()).toBeVisible();
      for (const track of await tracks.all()) await expect(track).toHaveCSS("background-color", distribution);
      await page.screenshot({ path: `/tmp/shared-bars-${style}-${width}.png`, fullPage: true });
    }
    await expect(page.locator(".overview-fav-search input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });
}

for (const style of ["light", "slate", "zinc"] as const) {
  test(`interactive summary cards respond to hover, keyboard and reduced motion in ${style}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("netmap.dark_style", value), style === "zinc" ? "zinc" : "slate");
    await setupOverview(page, style === "light" ? "light" : "dark");
    const card = page.locator(".dash-stat--clickable").first();
    await card.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    const before = (await card.boundingBox())!;
    await card.hover();
    await expect(card).not.toHaveCSS("transform", "none");
    await expect.poll(async () => Math.round(before.y - (await card.boundingBox())!.y)).toBe(3);
    await expect(card.locator(".dash-stat-icon")).not.toHaveCSS("transform", "none");
    await card.click();
    await expect(page).toHaveURL(/inventory/);
    await page.goto("/overview");
    await card.focus();
    await expect(card).toHaveCSS("outline-style", "solid");
    await expect(card).toHaveCSS("outline-width", "2px");
    await card.press("Enter");
    await expect(page).toHaveURL(/inventory/);
    await page.goto("/overview");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await card.hover();
    await expect(card).toHaveCSS("transform", "none");
    await expect(card).toHaveCSS("transition-duration", "0s");
  });
}

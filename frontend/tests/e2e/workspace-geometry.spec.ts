import { expect, test, type Page } from "@playwright/test";
import {
  mockDevice,
  setupCoreMocks,
  setupInventoryMocks,
  setupMonitoringMocks,
  setupTopologyMocks,
} from "./helpers/api-mocks";

const standardRoutes = [
  ["/overview", ".overview-workspace"],
  ["/vlans", ".vlan-workspace"],
  ["/locations", ".locations-workspace"],
  ["/monitoring", ".workspace > .dash-layout"],
  ["/ipam", ".ipam-workspace"],
  ["/tools", ".tools-workspace"],
  ["/security", ".security-layout"],
  ["/exports", ".exports-layout"],
  ["/admin", ".admin-layout"],
  ["/profile", ".profile-layout"],
] as const;

async function setupWorkspaceMocks(page: Page, theme: "light" | "dark") {
  // Registered first because Playwright gives later, more specific handlers
  // precedence. This keeps every lazy workspace deterministic without hiding
  // a request behind a real backend dependency.
  await page.route("**/api/v1/**", (route) => {
    const url = route.request().url();
    const wantsObject = /summary|status|settings|version|analysis|whats-new/.test(url);
    void route.fulfill({ json: wantsObject ? {} : [] });
  });

  const devices = [mockDevice()];
  await setupCoreMocks(page, "Planned maintenance");
  await setupTopologyMocks(page, devices, []);
  await setupInventoryMocks(page, devices);
  await setupMonitoringMocks(page, []);
  await page.route("**/api/v1/ipam/summary*", (route) => route.fulfill({
    json: {
      total_subnets: 0,
      total_ips: 0,
      used_ips: 0,
      reserved_ips: 0,
      dhcp_leases: 0,
      conflicts: 0,
      utilization_pct: 0,
    },
  }));
  await page.route("**/api/v1/admin/settings", (route) => route.fulfill({
    json: {
      app_name: "NetMap",
      login_message: "",
      announcement: "Planned maintenance",
      live_ping_enabled: true,
      monitor_interval_seconds: 300,
      idle_timeout_minutes: 15,
      active_network_public_targets_enabled: false,
    },
  }));
  await page.route("**/api/v1/exports/summary", (route) => route.fulfill({ json: {
    inventory_rows: 1,
    firewall_events: 0,
    exports_last_30_days: 0,
    last_export_at: null,
    last_export_type: null,
    last_export_detail: null,
  } }));
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: {
    enabled: true,
    udp_enabled: true,
    tcp_enabled: false,
    tls_enabled: false,
    udp_port: 1514,
    tcp_port: 1514,
    tls_port: 6514,
    retention_days: 7,
    allowlist_enabled: false,
    total_events: 0,
    received_packets: 0,
    stored_events: 0,
    dropped_unparsed: 0,
    denied_senders: 0,
  } }));
  await page.route("**/api/v1/syslog/events*", (route) => route.fulfill({ json: {
    retention_days: 7,
    total: 0,
    offset: 0,
    limit: 100,
    events: [],
  } }));
  await page.route("**/api/v1/syslog/searches", (route) => route.fulfill({ json: [] }));
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("netmap.theme", selectedTheme);
  }, theme);
}

async function expectAlignedEdges(page: Page, first: string, second: string, label = `${first} and ${second}`) {
  const [firstBox, secondBox] = await Promise.all([
    page.locator(first).boundingBox(),
    page.locator(second).boundingBox(),
  ]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(Math.abs(firstBox!.x - secondBox!.x), `${label} left edges`).toBeLessThanOrEqual(1);
  expect(
    Math.abs((firstBox!.x + firstBox!.width) - (secondBox!.x + secondBox!.width)),
    `${label} right edges; first=${JSON.stringify(firstBox)}, second=${JSON.stringify(secondBox)}`,
  ).toBeLessThanOrEqual(1);
}

for (const theme of ["light", "dark"] as const) {
  test(`standard workspaces keep the MOTD on the shared content anchor in ${theme} mode`, async ({ page }) => {
    await setupWorkspaceMocks(page, theme);

    for (const [route, contentSelector] of standardRoutes) {
      await page.goto(route);
      const banner = page.locator(".workspace > .dash-alert--announcement");
      const workspaceContent = page.locator(contentSelector);
      await expect(banner, `${route} should render the global MOTD`).toBeVisible({ timeout: 10_000 });
      await expect(workspaceContent, `${route} should render its workspace`).toBeVisible({ timeout: 10_000 });
      await expectAlignedEdges(page, ".workspace > .dash-alert--announcement", contentSelector, route);

      const gap = await page.evaluate((selector) => {
        const bannerBox = document.querySelector<HTMLElement>(".workspace > .dash-alert--announcement")!.getBoundingClientRect();
        const contentBox = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return contentBox.top - bannerBox.bottom;
      }, contentSelector);
      expect(gap, `${route} should use the 16px workspace section gap`).toBeCloseTo(16, 0);
    }
  });
}

test("full-bleed workspaces keep their documented MOTD anchors at desktop and narrow widths", async ({ page }) => {
  await setupWorkspaceMocks(page, "dark");

  for (const width of [1440, 700]) {
    await page.setViewportSize({ width, height: 900 });

    await page.goto("/inventory");
    await expect(page.locator(".inventory-surface")).toBeVisible({ timeout: 10_000 });
    await expectAlignedEdges(page, ".dash-alert--announcement", ".inventory-stats", `/inventory at ${width}px`);
    await expectAlignedEdges(page, ".dash-alert--announcement", ".inventory-surface", `/inventory at ${width}px`);
    const inventoryGap = await page.evaluate(() => {
      const banner = document.querySelector<HTMLElement>(".dash-alert--announcement")!.getBoundingClientRect();
      const summary = document.querySelector<HTMLElement>(".inventory-stats")!.getBoundingClientRect();
      return summary.top - banner.bottom;
    });
    expect(inventoryGap).toBeCloseTo(16, 0);

    await page.goto("/topology");
    await expect(page.locator(".topology-workspace-frame")).toBeVisible({ timeout: 10_000 });
    await expectAlignedEdges(page, ".dash-alert--announcement", ".topology-workspace-frame", `/topology at ${width}px`);
    const topologyGap = await page.evaluate(() => {
      const banner = document.querySelector<HTMLElement>(".dash-alert--announcement")!.getBoundingClientRect();
      const frame = document.querySelector<HTMLElement>(".topology-workspace-frame")!.getBoundingClientRect();
      return frame.top - banner.bottom;
    });
    expect(topologyGap).toBeCloseTo(8, 0);
  }
});

test("workspace panel headers use the canonical height, inset, and icon well", async ({ page }) => {
  await setupWorkspaceMocks(page, "light");
  const routes = [
    ["/overview", ".overview-panel-header", ".overview-panel-icon"],
    ["/inventory", ".inventory-panel-header", ".inv-panel-title-icon"],
    ["/vlans", ".vlan-toolbar", ".vlan-panel-icon"],
    ["/locations", ".locations-panel-header", ".locations-panel-icon"],
    ["/monitoring", ".mon-device-window-header", ".mon-panel-icon"],
    ["/ipam", ".ipam-panel-header", ".ipam-panel-icon"],
    ["/tools", ".tool-card-header", ".tool-panel-icon"],
    ["/security", ".security-panel-header", ".security-panel-icon"],
    ["/exports", ".exports-panel-header", ".exports-panel-icon"],
    ["/admin", ".admin-system-card-header", ".admin-panel-icon"],
    ["/profile", ".profile-panel-header", ".profile-panel-icon"],
  ] as const;

  for (const [route, headerSelector, iconSelector] of routes) {
    await page.goto(route);
    const header = page.locator(headerSelector).first();
    await expect(header, `${route} should expose a canonical panel header`).toBeVisible({ timeout: 10_000 });
    const metrics = await header.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        minHeight: style.minHeight,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
      };
    });
    expect(metrics, `${route} panel header geometry`).toEqual({
      minHeight: "44px",
      paddingLeft: "18px",
      paddingRight: "18px",
    });

    const icon = page.locator(iconSelector).first();
    if (await icon.count()) {
      await expect(icon, `${route} panel icon`).toHaveCSS("width", "30px");
      await expect(icon, `${route} panel icon`).toHaveCSS("height", "30px");
    }
  }
});

import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  mockDevice,
  mockMonitoringDevice,
  setupCoreMocks,
  setupInventoryMocks,
  setupMonitoringMocks,
  setupTopologyMocks,
} from "./helpers/api-mocks";
import { setupExternalIps } from "./helpers/external-ip";

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

async function expectSectionGap(page: Page, first: string, second: string, label = `${first} and ${second}`) {
  const [firstBox, secondBox] = await Promise.all([
    page.locator(first).boundingBox(),
    page.locator(second).boundingBox(),
  ]);
  expect(firstBox, `${label} first surface should render`).not.toBeNull();
  expect(secondBox, `${label} second surface should render`).not.toBeNull();
  const gap = secondBox!.y - (firstBox!.y + firstBox!.height);
  expect(gap, `${label} should use the 16px workspace section gap`).toBeCloseTo(16, 0);
}

test("shared controls and feedback are owned by the shared component stylesheet", () => {
  const components = readFileSync(new URL("../../src/styles/components.css", import.meta.url), "utf8");
  const monitoring = readFileSync(new URL("../../src/styles/monitoring.css", import.meta.url), "utf8");
  for (const selector of [/^\.nm-btn \{/m, /^\.nm-input,/m, /^\.nm-search \{/m, /^\.nm-alert \{/m, /^\.nm-status \{/m]) {
    expect(components, `${selector} should be owned by components.css`).toMatch(selector);
    expect(monitoring, `${selector} must not be redeclared by Monitoring`).not.toMatch(selector);
  }
});

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

for (const theme of ["light", "dark"] as const) {
  test(`summary cards share one canonical geometry in ${theme} mode`, async ({ page }) => {
    await setupWorkspaceMocks(page, theme);
    const routes = ["/overview", "/inventory", "/locations", "/monitoring", "/ipam", "/tools", "/security", "/exports"];

    for (const width of [1440, 700]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of routes) {
        await page.goto(route);
        const card = page.locator(".nm-summary-band .dash-stat").first();
        await expect(card, `${route} at ${width}px should use DashStat`).toBeVisible({ timeout: 10_000 });
        await expect(card).toHaveCSS("min-height", "86px");
        await expect(card.locator(".dash-stat-icon")).toHaveCSS("width", "36px");
        await expect(card.locator(".dash-stat-icon")).toHaveCSS("height", "36px");
        await expect(card.locator(".dash-stat-label")).toHaveCSS("font-size", "10px");
      }
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`conditional outage banners preserve the workspace rhythm in ${theme} mode`, async ({ page }) => {
    await setupWorkspaceMocks(page, theme);
    const offlineDevice = mockDevice({ monitor_status: "offline", status: "active", expected_status: "online" });
    const unexpectedDevice = mockMonitoringDevice({ status: "offline", expected_status: "online", health_status: "unhealthy" });
    await setupTopologyMocks(page, [offlineDevice], []);
    await setupMonitoringMocks(page, [unexpectedDevice]);

    await page.goto("/overview");
    await expect(page.locator(".overview-workspace > .dash-alert--overview-bar")).toBeVisible({ timeout: 10_000 });
    await expectSectionGap(page, ".overview-workspace > .nm-summary-band", ".overview-workspace > .dash-alert--overview-bar", "Overview outage banner");

    await page.goto("/monitoring");
    await expect(page.locator(".dash-layout > .dash-alert")).toBeVisible({ timeout: 10_000 });
    await expectSectionGap(page, ".dash-layout > .nm-summary-band", ".dash-layout > .dash-alert", "Monitoring unexpected-state banner");
    await expectSectionGap(page, ".dash-layout > .dash-alert", ".dash-layout > .mon-content", "Monitoring content after unexpected-state banner");
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`summary bands keep the canonical gap before their primary surface in ${theme} mode`, async ({ page }) => {
    await setupWorkspaceMocks(page, theme);
    const renderLoopWarnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("Maximum update depth exceeded")) {
        renderLoopWarnings.push(message.text());
      }
    });
    const routes = [
      ["/overview", ".nm-summary-band", ".dash-grids"],
      ["/inventory", ".nm-summary-band", ".topology-content"],
      ["/locations", ".nm-summary-band", ".locations-panel"],
      ["/monitoring#endpoints", ".nm-summary-band", ".mon-content"],
      ["/ipam", ".nm-summary-band", ".ipam-reservations-panel"],
      ["/tools", ".nm-summary-band", ".tools-console-grid"],
      ["/security", ".nm-summary-band", ".security-content"],
      ["/exports", ".nm-summary-band", ".exports-console-grid"],
    ] as const;

    const measuredGaps: Record<string, number> = {};
    for (const width of [1440, 700]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [route, summarySelector, surfaceSelector] of routes) {
        await page.goto(route);
        await expect(page.locator(summarySelector), `${route} should render its summary band`).toBeVisible({ timeout: 10_000 });
        await expect(page.locator(surfaceSelector), `${route} should render its primary surface`).toBeVisible({ timeout: 10_000 });
        measuredGaps[`${route} at ${width}px`] = await page.evaluate(({ firstSelector, secondSelector }) => {
          const firstBox = document.querySelector<HTMLElement>(firstSelector)!.getBoundingClientRect();
          const secondBox = document.querySelector<HTMLElement>(secondSelector)!.getBoundingClientRect();
          return secondBox.top - firstBox.bottom;
        }, { firstSelector: summarySelector, secondSelector: surfaceSelector });
      }
    }
    expect(measuredGaps).toEqual(Object.fromEntries(
      [1440, 700].flatMap((width) => routes.map(([route]) => [`${route} at ${width}px`, 16])),
    ));
    expect(renderLoopWarnings, "workspace navigation should not trigger React render loops").toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`External IPAM keeps its cards on the shared workspace anchor in ${theme} mode`, async ({ page }) => {
    await setupExternalIps(page, { theme });

    for (const width of [1440, 700]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".external-ip-workspace")).toBeVisible();
      await expectAlignedEdges(page, ".ipam-workspace", ".external-ip-workspace", `External IPAM shell at ${width}px`);
      await expectAlignedEdges(page, ".external-ip-workspace", ".external-ip-workspace .ipam-stats", `External IPAM cards at ${width}px`);
      await expectAlignedEdges(page, ".external-ip-workspace", ".external-ip-panel", `External IPAM panel at ${width}px`);

      const topOffset = await page.evaluate(() => {
        const workspace = document.querySelector<HTMLElement>(".ipam-workspace")!.getBoundingClientRect();
        const external = document.querySelector<HTMLElement>(".external-ip-workspace")!.getBoundingClientRect();
        return external.top - workspace.top;
      });
      expect(topOffset, `External IPAM should not add a route-specific top offset at ${width}px`).toBeCloseTo(0, 0);
      await expectSectionGap(page, ".external-ip-workspace .nm-summary-band", ".external-ip-panel", `External IPAM at ${width}px`);
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

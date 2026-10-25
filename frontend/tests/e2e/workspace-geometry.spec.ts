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
    const routes = ["/overview", "/inventory", "/locations", "/monitoring", "/ipam", "/tools", "/security"];

    for (const width of [1440, 820]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of routes) {
        await page.goto(route);
        const card = page.locator(".nm-summary-band .dash-stat").first();
        await expect(card, `${route} at ${width}px should use DashStat`).toBeVisible({ timeout: 10_000 });
        await expect(card).toHaveCSS("min-height", "86px");
        await expect(card.locator(".dash-stat-icon")).toHaveCSS("width", "36px");
        await expect(card.locator(".dash-stat-icon")).toHaveCSS("height", "36px");
        await expect(card.locator(".dash-stat-value")).toHaveCSS("font-size", "24px");
        await expect(card.locator(".dash-stat-label")).toHaveCSS("font-size", "11px");
        await expect(page.locator(".nm-summary-band:not(.nm-bento-stats) .dash-stat-sub"), `${route} at ${width}px should not render subtext outside a bento`).toHaveCount(0);
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
    await expectSectionGap(page, ".overview-workspace > .nm-bento", ".overview-workspace > .dash-alert--overview-bar", "Overview outage banner");

    await page.goto("/monitoring");
    await expect(page.locator(".dash-layout > .dash-alert")).toBeVisible({ timeout: 10_000 });
    await expectSectionGap(page, ".dash-layout > .nm-bento", ".dash-layout > .dash-alert", "Monitoring unexpected-state banner");
    await expectSectionGap(page, ".dash-layout > .dash-alert", ".dash-layout > .mon-device-insights", "Monitoring insights after unexpected-state banner");
    await expectSectionGap(page, ".dash-layout > .mon-device-insights", ".dash-layout > .mon-content", "Monitoring table after device insights");
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
      ["/overview", ".overview-workspace > .nm-bento", ".overview-workspace > .nm-pair"],
      ["/inventory", ".nm-summary-band", ".topology-content"],
      ["/locations", ".locations-workspace > .nm-bento", ".locations-workspace > .nm-console"],
      ["/monitoring#endpoints", ".dash-layout > .nm-bento", ".mon-content"],
      ["/ipam", ".ipam-bento", ".ipam-subnets-panel-wrap"],
      ["/tools", ".tools-workspace > .nm-bento", ".tools-console-grid"],
      ["/security", ".nm-summary-band", ".security-content"],
      // Exports keeps its summary in the context column; its section gaps are
      // covered with the task/context reflow in exports-theme.spec.ts.
    ] as const;

    const measuredGaps: Record<string, number> = {};
    for (const width of [1440, 820]) {
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
      [1440, 820].flatMap((width) => routes.map(([route]) => [`${route} at ${width}px`, 16])),
    ));
    expect(renderLoopWarnings, "workspace navigation should not trigger React render loops").toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`External IPAM keeps its cards on the shared workspace anchor in ${theme} mode`, async ({ page }) => {
    await setupExternalIps(page, { theme });

    for (const width of [1440, 820]) {
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

  for (const width of [1440, 820]) {
    await page.setViewportSize({ width, height: 900 });

    await page.goto("/inventory");
    await expect(page.locator(".inventory-surface")).toBeVisible({ timeout: 10_000 });
    await expectAlignedEdges(page, ".dash-alert--announcement", ".inventory-bento", `/inventory at ${width}px`);
    await expectAlignedEdges(page, ".dash-alert--announcement", ".inventory-surface", `/inventory at ${width}px`);
    const inventoryGap = await page.evaluate(() => {
      const banner = document.querySelector<HTMLElement>(".dash-alert--announcement")!.getBoundingClientRect();
      const summary = document.querySelector<HTMLElement>(".inventory-bento")!.getBoundingClientRect();
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

for (const style of ["slate", "zinc"] as const) {
  test(`Shared dark editable fields keep one surface across workspaces in ${style}`, async ({ page }) => {
    await setupWorkspaceMocks(page, "dark");
    await page.addInitScript(value => localStorage.setItem("netmap.dark_style", value), style);
    const expected = style === "slate" ? "rgb(18, 22, 36)" : "rgb(22, 22, 24)";
    for (const route of ["/overview", "/inventory", "/locations", "/tools", "/security", "/exports", "/admin#system", "/profile"]) {
      await page.goto(route);
      await expect(page.locator(".workspace > :last-child")).toBeVisible();
      const mismatches = await page.locator('.workspace input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="color"]):not([type="range"]):not([type="hidden"]):visible').evaluateAll((fields, colour) => fields.flatMap(field => {
        const bg = getComputedStyle(field).backgroundColor;
        return bg === colour || bg === "rgba(0, 0, 0, 0)" ? [] : [{ field: field.outerHTML.slice(0, 160), background: bg }];
      }), expected);
      expect(mismatches, route).toEqual([]);
    }
  });
}

test("page content cap grows with the screen and stays centred while the top bar and Topology keep full width", async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  await setupWorkspaceMocks(page, "dark");
  const contentBox = () => page.locator(".workspace").evaluate((node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight), width: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
  });
  for (const route of ["/overview", "/ipam", "/locations", "/monitoring", "/tools", "/security"]) {
    await page.goto(route);
    await expect(page.locator(".nm-summary-band").first()).toBeVisible({ timeout: 10_000 });
    const box = await contentBox();
    expect(box.width, route).toBe(1800);
    expect(Math.abs(box.left - box.right), route).toBeLessThanOrEqual(1);
    await expect(page.locator(".app-topbar")).toHaveCSS("padding-left", "28px");
  }
  // 1080p is unaffected (the cap is never reached), 1440p widens to 80vw, very wide screens stop at 2400px.
  for (const [viewport, expected] of [[1920, 1640], [2560, 2048], [3840, 2400]] as const) {
    await page.setViewportSize({ width: viewport, height: 1000 });
    await page.goto("/overview");
    await expect(page.locator(".nm-summary-band").first()).toBeVisible({ timeout: 10_000 });
    const box = await contentBox();
    expect(Math.round(box.width), `${viewport}px viewport`).toBe(expected);
    expect(Math.abs(box.left - box.right), `${viewport}px viewport`).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 2200, height: 1000 });
  await page.goto("/topology");
  await expect(page.locator("#topology")).toBeVisible();
  await expect(page.locator(".workspace")).toHaveCSS("padding-left", "0px");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overview");
  await expect(page.locator(".workspace")).toHaveCSS("padding-left", "24px");
});


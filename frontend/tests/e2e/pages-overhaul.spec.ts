import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, mockUser, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const iso = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();

const sites = [
  { id: 1, name: "brisbane-hq", display_name: "Brisbane HQ", description: "Primary office", address: "123 Main Street", color: "#2d9d78" },
  { id: 2, name: "sydney-edge", display_name: "Sydney Edge", description: "Branch", address: null, color: null },
].map((site) => ({ ...site, created_at: iso(500), updated_at: iso(5) }));

const groups = [
  { id: 1, name: "Servers", vlan_id: "20", ip_range: "10.30.20.0/24" },
  { id: 2, name: "Wi-Fi", vlan_id: "30", ip_range: "10.30.30.0/23" },
].map((group) => ({ ...group, display_name: group.name, gateway: null, dns_servers: null, description: "", color: null }));

const devices = [
  mockDevice({ id: 1, display_name: "Core Router", device_type: "router", topology_group: "Servers", site_id: 1 }),
  mockDevice({ id: 2, display_name: "NAS-01", device_type: "server", topology_group: "Servers", site_id: 1, monitor_status: "offline", expected_status: "online" }),
  mockDevice({ id: 3, display_name: "AP Lobby", device_type: "access_point", topology_group: "Wi-Fi", site_id: 2 }),
];

const monitorDevices = [
  mockMonitoringDevice({ device_id: 1, display_name: "Core Router", avg_rtt_24h: 1.2, uptime_24h: 100, health_status: "healthy" }),
  mockMonitoringDevice({ device_id: 2, display_name: "NAS-01", avg_rtt_24h: 9.4, uptime_24h: 97.5, health_status: "unhealthy", status: "offline" }),
];

const monitors = [
  { id: 1, name: "Public API", enabled: true, last_status: "online", avg_response_time_24h: 40, uptime_24h: 99.9, last_cert_expires_at: iso(-24 * 12), last_cert_issuer: "R11" },
  { id: 2, name: "Auth (SSO)", enabled: true, last_status: "offline", avg_response_time_24h: 139, uptime_24h: 91.2, last_cert_expires_at: null, last_cert_issuer: null },
].map((monitor) => ({ ...monitor, url: "https://example.com/health", last_checked_at: iso(0.1), uptime_7d: 99, heartbeat: [], certificate_expiry_days: 14, tags: [] }));

async function boot(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices, []);
  await setupMonitoringMocks(page, monitorDevices);
  await page.route("**/api/v1/topology/sites*", (route) => route.fulfill({ json: sites }));
  await page.route("**/api/v1/topology/groups*", (route) => route.fulfill({ json: groups }));
  await page.route("**/api/v1/monitors", (route) => route.fulfill({ json: monitors }));
  await page.setViewportSize({ width: 1600, height: 1000 });
}

async function barLabels(page: Page, region: string) {
  const rows = page.getByRole("region", { name: region, exact: true }).locator(".nm-bar-list li");
  await expect(rows.first()).toBeVisible();
  return rows.evaluateAll((items) => items.map((row) => [...row.children].map((cell) => cell.textContent?.trim()).filter(Boolean).join(" ")));
}

async function expectSideColumn(page: Page, main: string, side: string) {
  const mainBox = (await page.getByRole("region", { name: main, exact: true }).boundingBox())!;
  const sideBox = (await page.getByRole("region", { name: side, exact: true }).boundingBox())!;
  expect(sideBox.x).toBeGreaterThan(mainBox.x + mainBox.width);
  expect(Math.abs(sideBox.y - mainBox.y)).toBeLessThanOrEqual(1);
}

test("Admin alerts chart deliveries per day and list recently triggered rules", async ({ page }) => {
  await boot(page);
  await page.route("**/api/v1/alerts/rules", (route) => route.fulfill({ json: [
    { id: 1, name: "Core switch down", enabled: true, event_type: "device_offline", channels: [], cooldown_minutes: 15, last_triggered_at: iso(2) },
    { id: 2, name: "Printer offline", enabled: false, event_type: "device_offline", channels: [], cooldown_minutes: 15, last_triggered_at: null },
  ] }));
  await page.route("**/api/v1/alerts/deliveries*", (route) => route.fulfill({ json: [
    { id: 1, rule_name: "Core switch down", device_id: null, target: "profile:1", status: "sent", detail: "ok", sent_at: iso(1) },
    { id: 2, rule_name: "Core switch down", device_id: null, target: "profile:1", status: "failed", detail: "timeout", sent_at: iso(1) },
  ] }));
  await page.goto("/admin#alerts");
  await expect(page.getByRole("region", { name: "Alerts sent, last 14 days", exact: true }).locator(".nm-chart-body svg").first()).toBeVisible();
  await expect(page.locator(".dash-stat", { hasText: "Active" })).toContainText("Printer offline paused");
  await expect(page.locator(".dash-stat", { hasText: "Sent, 14 days" })).toContainText("50.0% delivered");
  expect(await barLabels(page, "Rules by trigger")).toEqual(["Goes offline 2"]);
  await expect(page.getByRole("region", { name: "Recently triggered", exact: true })).toContainText("Core switch down");
  await expectSideColumn(page, "Alert rules", "Rules by trigger");
});

test("Admin SNMP profiles show version tags, separate columns and edit in the side form", async ({ page }) => {
  await boot(page);
  const saved: unknown[] = [];
  await page.route("**/api/v1/tools/snmp/profiles**", async (route) => {
    if (route.request().method() === "PATCH") {
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { id: 1, name: "Core v3 renamed", version: "v3", port: 161, timeout_seconds: 2, retries: 1, created_at: iso(9), updated_at: iso(0) } });
    }
    return route.fulfill({ json: [
      { id: 1, name: "Core v3", version: "v3", port: 161, timeout_seconds: 2, retries: 1, created_at: iso(9), updated_at: iso(9) },
      { id: 2, name: "Lab", version: "v2c", port: 1161, timeout_seconds: 5, retries: 3, created_at: iso(9), updated_at: iso(9) },
    ] });
  });
  await page.goto("/admin#credentials");
  const row = page.locator(".admin-snmp-table .admin-users-row", { hasText: "Lab" });
  await expect(row.locator(".notif-method-tag")).toHaveText("v2c");
  await expect(row.locator(":scope > span")).toHaveText(["v2c", "1161", "5 s", "3"]);
  await expect(page.locator(".dash-stat", { hasText: "SNMPv3" }).locator(".dash-stat-value")).toHaveText("1");
  await page.getByRole("button", { name: "Edit Core v3", exact: true }).click();
  const form = page.getByRole("region", { name: "Edit Core v3", exact: true });
  await form.getByLabel("Name").fill("Core v3 renamed");
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".admin-snmp-table")).toContainText("Core v3 renamed");
  expect(saved).toEqual([{ name: "Core v3 renamed", port: 161, timeout_seconds: 2, retries: 1 }]);
});

test("Admin groups cap long permission lists with their own scroll and count coverage", async ({ page }) => {
  await boot(page);
  const permissions = Array.from({ length: 24 }, (_, i) => ({ key: `area${i % 8}_perm${i}`, label: `Permission ${i + 1}`, description: "Allows something" }));
  await page.route("**/api/v1/admin/role-permissions", (route) => route.fulfill({ json: {
    permissions, roles: { SuperAdmin: [], NetworkAdmin: permissions.slice(0, 22).map((p) => p.key), SecurityAnalyst: [], Viewer: [] },
  } }));
  await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [mockUser] }));
  await page.goto("/admin#groups");
  await expect(page.getByRole("region", { name: "Network Admin", exact: true }).locator(".admin-task-count")).toHaveText("22 of 24");
  const list = page.getByRole("region", { name: "Network Admin", exact: true }).locator(".admin-perm-scroll");
  const box = await list.evaluate((node) => ({ height: node.clientHeight, scroll: node.scrollHeight, overflow: getComputedStyle(node).overflowY }));
  expect(box.height).toBeLessThanOrEqual(330);
  expect(box.scroll).toBeGreaterThan(box.height);
  expect(box.overflow).toBe("auto");
  expect(await barLabels(page, "Permission coverage")).toContain("Network Admin 22");
  await expect(page.locator(".dash-stat", { hasText: "Permissions" })).toContainText("Across 8 areas");
});

test("Tools summarise recent checks from this browser by tool", async ({ page }) => {
  await boot(page);
  await page.addInitScript((ranAt) => {
    const run = (tool: string, target: string) => ({ id: `${tool}-${target}`, tool, target, summary: "ok", status: "success", ranAt, durationMs: 5, inputs: {}, result: null });
    window.localStorage.setItem("netmap.tools.recent_v1", JSON.stringify([run("ping", "10.30.20.10"), run("ping", "10.30.20.11"), run("dns", "example.com")]));
  }, iso(0.05));
  await page.goto("/tools");
  expect(await barLabels(page, "Your recent checks")).toEqual(["Ping Test 2", "DNS Lookup 1"]);
  await expect(page.locator(".dash-stat", { hasText: "Last check" })).toContainText("Ping Test · 10.30.20.10");
});

test("Monitoring endpoints rank average response and list certificates below the table", async ({ page }) => {
  await boot(page);
  await page.goto("/monitoring#endpoints");
  const bars = page.getByRole("region", { name: "Average response, last 24 h", exact: true }).locator(".nm-bar-list li");
  await expect(bars).toHaveCount(2);
  await expect(bars.first()).toContainText("Auth (SSO)");
  await expect(page.locator(".dash-stat", { hasText: "Down" })).toContainText("Auth (SSO)");
  const certs = page.getByRole("region", { name: "Certificates expiring", exact: true });
  await certs.scrollIntoViewIfNeeded();
  await expect(certs).toContainText("Public API");
  const tableBottom = await page.locator(".mon-view-window").evaluate((node) => node.getBoundingClientRect().bottom);
  expect((await certs.boundingBox())!.y).toBeGreaterThan(tableBottom);
});

test("Monitoring devices show fleet health and the slowest devices", async ({ page }) => {
  await boot(page);
  await page.goto("/monitoring#devices");
  await expect(page.getByRole("region", { name: "Fleet health", exact: true }).locator(".dash-donut-svg")).toBeVisible();
  await expect(page.locator(".nm-bento .dash-stat")).toHaveCount(6);
  expect((await barLabels(page, "Highest latency, last 24 h"))[0]).toBe("NAS-01 9.4 ms");
  expect((await barLabels(page, "Least uptime, last 24 h"))[0]).toBe("NAS-01 97.5%");
});

test("Locations count devices per site and list sites that need details", async ({ page }) => {
  await boot(page);
  await page.goto("/locations");
  expect(await barLabels(page, "Devices by location")).toEqual(["Brisbane HQ 2", "Sydney Edge 1"]);
  const needs = page.getByRole("region", { name: "Needs details", exact: true });
  await expect(needs).toContainText("Sydney Edge");
  await expect(needs).toContainText("No address · no colour set");
  await expect(needs).not.toContainText("Brisbane HQ");
  const panel = (await page.locator(".locations-panel").boundingBox())!;
  expect((await needs.boundingBox())!.x).toBeGreaterThan(panel.x + panel.width);
});

test("VLANs count devices per group and summarise address space", async ({ page }) => {
  await boot(page);
  await page.goto("/vlans");
  expect(await barLabels(page, "Devices by VLAN")).toEqual(["Servers · 20 2", "Wi-Fi · 30 1"]);
  await expect(page.locator(".dash-stat", { hasText: "Largest subnet" })).toContainText("/23");
  await expect(page.locator(".dash-stat", { hasText: "Usable addresses" }).locator(".dash-stat-value")).toHaveText("764");
});

test("Overview plays the shared entrance motion and drops it under reduced motion", async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/overview");
  const card = page.locator(".overview-workspace .nm-summary-band .dash-stat").first();
  await expect(card).toBeVisible();
  await expect(page.locator(".overview-workspace")).toHaveClass(/nm-motion/);
  expect(await card.evaluate((node) => getComputedStyle(node).animationName)).toBe("nm-rise");
  const delays = await page.locator(".overview-workspace .nm-summary-band .dash-stat").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationDelay));
  expect(new Set(delays).size).toBe(delays.length);
  const panel = page.locator(".overview-workspace .overview-panel").first();
  expect(await panel.evaluate((node) => getComputedStyle(node).animationName)).toBe("nm-rise");
  expect(await page.locator(".dash-donut-svg .nm-chart-seg").first().evaluate((node) => getComputedStyle(node).animationName)).toBe("nm-sweep");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await card.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
});

test("Overview puts health beside the tiles, outages in the side column and breakdowns below", async ({ page }) => {
  await boot(page);
  await page.goto("/overview");
  const health = page.getByRole("region", { name: "Network health", exact: true });
  await expect(health.locator(".dash-donut-svg")).toBeVisible();
  await expect(health.locator(".nm-chart-legend")).toHaveCount(0);
  const statusColumns = health.locator(".nm-column-chart .nm-chart-col");
  await expect(statusColumns, "statuses with no devices are left out").toHaveCount(2);
  await expect(health.locator(".nm-column-chart .nm-chart-axis")).toHaveText(["Online", "Offline"]);
  await expect(health.locator(".nm-chart-value")).toHaveText(["2", "1"]);
  const shape = await health.locator(".nm-column-chart svg").evaluate((svg) => {
    const bars = [...svg.querySelectorAll<SVGPathElement>(".nm-chart-col path")].map((path) => path.getBBox().height);
    const pills = [...svg.querySelectorAll(".nm-chart-col")].map((col) => {
      const pill = col.querySelector(".nm-chart-value-bg");
      const text = col.querySelector(".nm-chart-value")!;
      return pill ? [...col.children].indexOf(pill) < [...col.children].indexOf(text) : false;
    });
    return { ratio: bars[1] / bars[0], pills };
  });
  expect(shape.ratio, "a square-root scale keeps small statuses readable (linear would be 0.5)").toBeCloseTo(Math.SQRT1_2, 1);
  expect(shape.pills, "each value sits on its own pill").toEqual([true, true]);
  await statusColumns.first().locator(".nm-chart-hit").hover();
  await expect(statusColumns.first().locator("path")).toHaveCSS("fill", "rgb(45, 186, 124)");
  await expect(statusColumns.first().locator(".nm-chart-hit")).toHaveCSS("fill", "rgba(0, 0, 0, 0)");
  const tiles = page.locator(".overview-workspace .nm-bento-stats .dash-stat");
  await expect(tiles).toHaveCount(6);
  expect((await tiles.first().boundingBox())!.x).toBeGreaterThan((await health.boundingBox())!.x + (await health.boundingBox())!.width);
  await expect(tiles.filter({ hasText: "Offline" }).locator(".dash-stat-sub")).toHaveText("NAS-01");
  const outages = page.getByRole("region", { name: "Current outages", exact: true });
  await expect(outages).toContainText("NAS-01");
  const recent = (await page.locator(".overview-panel", { hasText: "Recently updated" }).boundingBox())!;
  expect((await outages.boundingBox())!.x).toBeGreaterThan(recent.x + recent.width);
  expect((await barLabels(page, "Slowest devices, 24 h"))[0]).toBe("NAS-01 9.4 ms");
  expect(await barLabels(page, "Endpoints")).toEqual(["Up 1", "Down 1", "Paused 0"]);
  expect(await barLabels(page, "Top groups")).toEqual(["Servers 2", "Wi-Fi 1"]);
  const pairTop = (await page.getByRole("region", { name: "Device types", exact: true }).boundingBox())!.y;
  expect(pairTop).toBeGreaterThan((await outages.boundingBox())!.y);
});

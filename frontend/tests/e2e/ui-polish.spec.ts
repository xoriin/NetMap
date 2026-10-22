import { expect, test } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const devices = [mockDevice({ id: 1, hostname: "router-01" }), mockDevice({ id: 2, hostname: "switch-01" })];

async function boot(page: import("@playwright/test").Page, theme: "light" | "dark", style = "slate") {
  await page.setViewportSize({ width: 1500, height: 900 });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await setupInventoryMocks(page, devices);
  await setupMonitoringMocks(page, [mockMonitoringDevice()]);
  await page.addInitScript(([t, s]) => { localStorage.setItem("netmap.theme", t); localStorage.setItem("netmap.dark_style", s); }, [theme, style]);
}

test("Overview header links are white in dark mode and turn teal on hover", async ({ page }) => {
  await boot(page, "dark");
  await page.goto("/overview");
  const link = page.locator(".overview-panel-link").first();
  await expect(link).toHaveCSS("color", "rgb(255, 255, 255)");
  await link.hover();
  await expect(link).toHaveCSS("color", "rgb(103, 232, 249)");
});

test("panel headers have no dash between the icon and the title", async ({ page }) => {
  await boot(page, "light");
  for (const route of ["/overview", "/topology", "/vlans", "/locations", "/tools"]) {
    await page.goto(route);
    await expect(page.locator(".nm-app-panel-header, .topology-toolbar--ribbon").first()).toBeVisible();
    const dashes = await page.locator(".nm-app-panel-header, .topology-toolbar--ribbon").evaluateAll((headers) =>
      headers.flatMap((header) => Array.from(header.querySelectorAll("span")).filter((span) => span.textContent?.trim() === "-").map(() => header.textContent?.trim().slice(0, 30))));
    expect(dashes, route).toEqual([]);
  }
});

test("Resolve on discovered changes is not a destructive red button", async ({ page }) => {
  await boot(page, "light");
  await page.route("**/api/v1/discovery/observations*", (route) => route.fulfill({ json: [{ id: 1, status: "open", observation_type: "new_device", ip_address: "192.168.1.3", hostname: "nas-01", mac_address: null, device_id: null, summary: "New device 192.168.1.3", details: {}, first_seen_at: "2026-10-22T09:00:00Z", last_seen_at: "2026-10-22T09:00:00Z" }] }));
  await page.goto("/overview");
  await page.locator(".dash-alert--changes .dash-alert-link").click();
  const resolve = page.getByRole("button", { name: "Resolve", exact: true }).first();
  await expect(resolve).toBeVisible();
  await expect(resolve).not.toHaveClass(/nm-btn--danger/);
});

test("heartbeat beats stay thick on long histories", async ({ page }) => {
  await boot(page, "light");
  await setupMonitoringMocks(page, [mockMonitoringDevice({ device_id: 1, display_name: "Core Router", heartbeat: Array(60).fill("online"), heartbeat_health: Array(60).fill("healthy") })]);
  const history = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, checked_at: new Date(Date.UTC(2026, 9, 22, 0, i)).toISOString(), status: "online", is_healthy: true, latency_ms: 5 }));
  await page.route("**/api/v1/monitoring/devices/*/history?*", (route) => route.fulfill({ json: history }));
  await page.goto("/monitoring");
  const row = page.locator(".mon-row", { hasText: "Core Router" });
  const small = await row.locator(".heartbeat-bar--sm .heartbeat-beat").first().boundingBox();
  expect(small!.width).toBeGreaterThanOrEqual(7);
  await row.click();
  const beats = page.locator(".mon-hero .heartbeat-bar--lg .heartbeat-beat");
  await expect(beats).toHaveCount(60);
  expect((await beats.first().boundingBox())!.width).toBeGreaterThanOrEqual(6);
});

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

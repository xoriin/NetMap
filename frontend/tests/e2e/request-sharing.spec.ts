import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function openOverviewCounting(page: Page, latencyMs = 0) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [mockDevice()]);
  await setupInventoryMocks(page, [mockDevice()]);
  await setupMonitoringMocks(page, [mockMonitoringDevice()]);
  if (latencyMs) {
    await page.route("**/api/v1/monitoring/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      await route.fallback();
    });
  }
  const counts: Record<string, number> = {};
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.startsWith("/api/v1/")) counts[url.pathname + url.search] = (counts[url.pathname + url.search] ?? 0) + 1;
  });
  await page.goto("/overview");
  await expect(page.locator(".dash-stats")).toBeVisible();
  await page.waitForTimeout(1500);
  return counts;
}

test("restoring a session on page load signs in once", async ({ page }) => {
  const counts = await openOverviewCounting(page);
  expect(counts["/api/v1/setup/status"]).toBe(1);
  expect(counts["/api/v1/auth/me"]).toBe(1);
});

test("pages asking for the same data at the same moment share one network call", async ({ page }) => {
  const counts = await openOverviewCounting(page, 300);
  expect(counts["/api/v1/monitoring/summary"]).toBe(1);
  expect(counts["/api/v1/monitoring/devices"]).toBe(1);
});

test("a list reloaded right after a save shows the saved change, not the shared copy", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [mockDevice()]);
  await setupMonitoringMocks(page, [mockMonitoringDevice()]);
  let enabled = true;
  const monitor = () => ({ id: 1, name: "Google", url: "https://www.google.com/", enabled, last_status: "online", last_checked_at: null, uptime_24h: null, uptime_7d: null, avg_response_time_24h: null, heartbeat: [] });
  await page.route("**/api/v1/monitors", (route) => route.fulfill({ json: [monitor()] }));
  await page.route("**/api/v1/monitors/1", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: monitor() });
    enabled = !enabled;
    return route.fulfill({ json: monitor() });
  });
  await page.goto("/monitoring#endpoints");
  const row = page.locator(".monitors-table tbody tr").first();
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row.getByRole("button", { name: "Resume" })).toBeVisible();
});

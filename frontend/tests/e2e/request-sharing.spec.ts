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

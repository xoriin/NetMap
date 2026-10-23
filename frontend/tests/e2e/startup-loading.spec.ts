import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function openOverview(page: Page) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [mockDevice()]);
  await setupInventoryMocks(page, [mockDevice()]);
  await setupMonitoringMocks(page, [mockMonitoringDevice()]);
  const requested = new Map<string, number>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!requested.has(path)) requested.set(path, Date.now());
  });
  await page.goto("/overview");
  await expect(page.locator(".dash-stats")).toBeVisible();
  const onScreen = Date.now();
  const firstRequest = (pattern: RegExp) => [...requested].find(([path]) => pattern.test(path))?.[1];
  return { onScreen, firstRequest };
}

const iconLibrary = /\/assets\/tabler-nodes-outline-[^/]+\.json$/;

test("the full icon library loads after the app is on screen, not before it", async ({ page }) => {
  const { onScreen, firstRequest } = await openOverview(page);
  expect(firstRequest(iconLibrary)).toBeUndefined();
  await expect.poll(() => firstRequest(iconLibrary), { timeout: 6000 }).toBeGreaterThan(onScreen);
});

test("choosing the Tabler icon set still loads it straight away", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("netmap.icon_pack", "tabler-full"));
  const { onScreen, firstRequest } = await openOverview(page);
  expect(firstRequest(iconLibrary)).toBeLessThanOrEqual(onScreen);
});

test("opening Device icons straight after sign-in still lists the full Tabler set", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [mockDevice()]);
  await setupMonitoringMocks(page, [mockMonitoringDevice()]);
  await page.goto("/admin#devices-icons");
  await page.getByRole("button", { name: "Icon packs" }).click();
  const tabler = page.locator(".icon-mgr-pack-row", { hasText: "Tabler Icons" });
  await expect(tabler.locator(".icon-mgr-pack-count")).toHaveText(/^[1-9]\d{3,} icons$/, { timeout: 5000 });
});

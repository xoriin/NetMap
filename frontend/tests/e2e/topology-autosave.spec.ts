import { test, expect } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks, mockDevice } from "./helpers/api-mocks";

test("a failed layout autosave does not raise an unhandled error", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [
    mockDevice({ id: 1, hostname: "router-01", ip_address: "10.0.0.1", topology_group: "Core" }),
    mockDevice({ id: 2, hostname: "switch-01", ip_address: "10.0.0.2", topology_group: "Core" }),
  ], []);
  await page.route("**/api/v1/topology/layouts*", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: [] })
      : route.fulfill({ status: 500, json: { detail: "Database is locked" } })
  );
  await page.goto("/topology");
  await expect(page.locator(".topology-overlay-node[title='router-01']")).toBeVisible({ timeout: 8000 });

  await page.getByRole("button", { name: "Display" }).click();
  const saved = page.waitForResponse((response) => response.url().includes("/topology/layouts") && response.request().method() !== "GET");
  await page.locator(".toolbar-display-panel label", { hasText: "Device labels" }).locator("input").fill("20");
  expect((await saved).status()).toBe(500);
  await page.waitForTimeout(500);

  expect(errors).toEqual([]);
});

import { expect, test } from "@playwright/test";
import { setupCoreMocks } from "./helpers/api-mocks";

test("production builds exclude internal visual preview routes", async ({ page }) => {
  await setupCoreMocks(page);
  await page.goto("/overview");

  await expect(page.getByText("Theme Preview", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Admin Designs", { exact: true })).toHaveCount(0);

  await page.goto("/theme-preview");
  await expect(page.locator(".theme-lab-workspace")).toHaveCount(0);
  await expect(page.locator(".overview-workspace")).toBeVisible();
});

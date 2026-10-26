import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

test("an unrecoverable 401 ends the session with an expiry notice", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  const logouts: string[] = [];
  await page.route("**/api/v1/auth/logout", async (route) => {
    logouts.push(route.request().url());
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/overview");
  await expect(page.locator(".sidebar")).toBeVisible();

  // The server now rejects both the access token and the refresh cookie.
  await page.route("**/api/v1/auth/refresh", (route) => route.fulfill({ status: 401, json: { detail: "Session revoked" } }));
  await page.route("**/api/v1/monitoring/devices*", (route) => route.fulfill({ status: 401, json: { detail: "Token expired" } }));
  await page.evaluate(() => {
    window.history.pushState(null, "", "/inventory");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
  await expect(page.locator(".error-banner")).toHaveText("Session expired. Sign in again.");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  expect(logouts).toHaveLength(1);
});

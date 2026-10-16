import { expect, test, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function openDashboard(page: Page, idleMinutes: number) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/admin/settings/public", (route) => route.fulfill({ json: { app_name: "NetMap", login_message: "", announcement: "" } }));
  await page.route("**/api/v1/admin/settings/app", (route) => route.fulfill({ json: { app_name: "NetMap", idle_timeout_minutes: idleMinutes, announcement: "" } }));
  const logouts: string[] = [];
  await page.route("**/api/v1/auth/logout", async (route) => {
    logouts.push(route.request().url());
    await route.fulfill({ status: 204, body: "" });
  });
  // A revoked session cannot be refreshed back into the dashboard.
  await page.route("**/api/v1/auth/refresh", (route) =>
    logouts.length > 0 ? route.fulfill({ status: 401, json: { detail: "Session revoked" } }) : route.fallback()
  );
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator(".sidebar")).toBeVisible();
  return logouts;
}

test("idle users are signed out when a timeout is set", async ({ page }) => {
  const logouts = await openDashboard(page, 1);
  await page.clock.fastForward(61_000);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(logouts).toHaveLength(1);
});

test("idle users stay signed in when the timeout is disabled", async ({ page }) => {
  const logouts = await openDashboard(page, 0);
  await page.clock.fastForward(3 * 60 * 60_000);
  // Sign-out is asynchronous; give a stray timer time to complete before asserting it never ran.
  await page.waitForTimeout(1_500);
  expect(logouts).toHaveLength(0);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
});

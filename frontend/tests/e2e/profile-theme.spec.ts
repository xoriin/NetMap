import { expect, test, type Page } from "@playwright/test";
import { mockUser, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const profileUser = {
  ...mockUser,
  display_name: "Test User",
  email: "user@example.com",
  avatar_data: null,
  auth_source: "local",
  entity_colors_enabled: true,
};

const apiKeys = [
  {
    id: 1,
    name: "Automation",
    prefix: "AbCdEf123456",
    suffix: "x7Qp",
    created_at: "2026-07-11T00:00:00Z",
    expires_at: null,
    last_used_at: "2026-08-01T00:00:00Z",
    last_used_ip: "10.0.0.10",
    revoked_at: null,
  },
  {
    id: 2,
    name: "Reporting",
    prefix: "GhJkLm789012",
    suffix: null,
    created_at: "2026-07-12T00:00:00Z",
    expires_at: null,
    last_used_at: null,
    last_used_ip: null,
    revoked_at: null,
  },
];

async function setupProfile(page: Page, theme: "light" | "dark" = "dark") {
  await setupCoreMocks(page, "Maintenance window tonight");
  await setupTopologyMocks(page);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: profileUser }));
  await page.route("**/api/v1/api-keys", (route) => route.fulfill({ json: apiKeys }));
  await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
  await page.goto("/profile");
  await page.locator(".profile-layout").waitFor({ state: "visible" });
}

for (const theme of ["light", "dark"] as const) {
  test(`Profile uses the approved account hierarchy in ${theme} mode`, async ({ page }) => {
    await setupProfile(page, theme);

    await expect(page.locator(".profile-identity-panel")).toHaveCSS("background-image", "none");
    await expect(page.locator(".profile-identity-name")).toHaveText("Test User");
    await expect(page.locator(".profile-summary-item")).toHaveCount(4);
    await expect(page.locator(".profile-summary-band")).toContainText("Profile completeness");
    await expect(page.locator(".profile-summary-band")).toContainText("Local password");
    await expect(page.locator(".profile-summary-band")).toContainText("2 keys can access NetMap");
    await expect(page.locator(".profile-panel-header")).toHaveCount(5);
    await expect(page.locator(".profile-panel-header").first()).toHaveCSS("min-height", "44px");
    await expect(page.locator(".profile-key-mask").first()).toHaveText("•••• •••• •••• x7Qp");
    await expect(page.locator(".profile-key-mask").nth(1)).toHaveText("•••• •••• •••• ••••");
    await expect(page.locator(".profile-panel .nm-input").first()).toHaveCSS(
      "background-color",
      theme === "dark" ? "rgb(10, 21, 32)" : "rgb(255, 255, 255)",
    );
  });
}

test("Profile settings reflow without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await setupProfile(page);

  const widths = await page.locator(".profile-layout").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await expect(page.locator(".profile-settings-grid")).toHaveCSS("grid-template-columns", /.+/);
});

test("Profile API key creation keeps the canonical one-time warning", async ({ page }) => {
  await setupProfile(page);

  await page.getByRole("button", { name: "Create API key" }).click();
  const modal = page.getByRole("dialog", { name: "Create API key" });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("shown once after creation");
  await expect(modal.getByLabel("Name")).toBeVisible();
});

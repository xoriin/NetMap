import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

for (const theme of ["light", "dark"] as const) {
  test(`Admin design alternatives render in ${theme} mode`, async ({ page }) => {
    await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
    await setupCoreMocks(page);
    await setupTopologyMocks(page);
    await page.addInitScript((selectedTheme) => {
      window.localStorage.setItem("netmap.theme", selectedTheme);
    }, theme);

    await page.goto("/admin-design-preview");

    const choices = page.getByRole("tablist", { name: "Admin design alternatives" });
    await expect(choices).toBeVisible();
    await expect(choices.getByRole("tab")).toHaveCount(4);
    await expect(page.locator('[data-design="console-top"]')).toBeVisible();
    await expect(page.locator(".admin-design-stat")).toHaveCount(4);

    await choices.getByRole("tab", { name: /Flat workspace/ }).click();
    await expect(page.locator('[data-design="flat"]')).toBeVisible();
    await expect(page.getByLabel("Template administration sections").getByRole("tab")).toHaveCount(9);

    await choices.getByRole("tab", { name: /Admin console/ }).click();
    await expect(page.locator('[data-design="console"]')).toBeVisible();
    await expect(page.getByLabel("Console administration sections").getByRole("button")).toHaveCount(9);

    await choices.getByRole("tab", { name: /Top-nav console/ }).click();
    await expect(page.locator('[data-design="console-top"]')).toBeVisible();
    const topConsoleNav = page.getByLabel("Top console administration sections");
    await expect(topConsoleNav.getByRole("button")).toHaveCount(9);
    const navBox = await topConsoleNav.boundingBox();
    const firstTabBox = await topConsoleNav.getByRole("button").first().boundingBox();
    expect(navBox).not.toBeNull();
    expect(firstTabBox).not.toBeNull();
    if (navBox && firstTabBox) expect(firstTabBox.y - navBox.y).toBeGreaterThanOrEqual(9);

    await choices.getByRole("tab", { name: /Section canvas/ }).click();
    await expect(page.locator('[data-design="sections"]')).toBeVisible();
    await expect(page.locator(".admin-design-form-heading")).toContainText("App settings");

    const stage = page.locator(".admin-design-review-stage");
    await expect(stage).toHaveCSS("background-image", "none");
  });
}

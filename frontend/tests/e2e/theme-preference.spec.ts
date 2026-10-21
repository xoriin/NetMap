import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

for (const theme of ["light", "dark"] as const) {
  test(`first app load follows ${theme} browser preference without saving an override`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await setupCoreMocks(page); await setupTopologyMocks(page, []); await setupMonitoringMocks(page, []);
    await page.goto("/monitoring");
    await expect(page.locator("body")).toHaveClass(theme === "dark" ? /theme-dark/ : /^(?!.*theme-dark)/);
    expect(await page.evaluate(() => localStorage.getItem("netmap.theme"))).toBeNull();
    const changed = theme === "light" ? "dark" : "light";
    await page.emulateMedia({ colorScheme: changed });
    await expect(page.locator("body")).toHaveClass(changed === "dark" ? /theme-dark/ : /^(?!.*theme-dark)/);
    await page.getByRole("button", { name: theme === "dark" ? "Dark mode" : "Light mode", exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem("netmap.theme"))).toBe(theme);
    await page.reload();
    await expect(page.locator("body")).toHaveClass(theme === "dark" ? /theme-dark/ : /^(?!.*theme-dark)/);
  });

  test(`stored ${theme} preference overrides the browser on app load`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme === "light" ? "dark" : "light" });
    await page.addInitScript(value => { if (window === window.top) localStorage.setItem("netmap.theme", value); }, theme);
    await setupCoreMocks(page); await setupTopologyMocks(page, []); await setupMonitoringMocks(page, []);
    await page.goto("/monitoring");
    await expect(page.locator("body")).toHaveClass(theme === "dark" ? /theme-dark/ : /^(?!.*theme-dark)/);
  });
}

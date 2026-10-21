import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

for (const theme of ["light", "dark"] as const) {
  test(`add endpoint starts directly with its settings tabs in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(value => { if (window === window.top) localStorage.setItem("netmap.theme", value); }, theme);
    await setupCoreMocks(page); await setupTopologyMocks(page, []); await setupMonitoringMocks(page, []);
    await page.goto("/monitoring#endpoints");
    await page.getByRole("button", { name: "+ Add endpoint", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Add endpoint" });
    await expect(modal).toBeVisible();
    await expect(modal.locator(".monitor-form-intro")).toHaveCount(0);
    const form = await modal.locator(".monitor-form-shell").boundingBox();
    const tabs = await modal.getByRole("tablist").boundingBox();
    expect(Math.abs(form!.y - tabs!.y)).toBeLessThanOrEqual(1);
    await expect(modal.getByLabel("Enabled", { exact: true })).toBeChecked();
    for (const tab of ["Request", "Validation", "Security", "General"]) {
      await modal.getByRole("tab", { name: tab, exact: true }).click();
      await expect(modal.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
    }
    await page.setViewportSize({ width: 780, height: 900 });
    expect(await modal.evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
  });
}

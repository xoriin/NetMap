import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

for (const theme of ["light", "dark"]) {
  test(`popup header buttons match the close button in ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("netmap.theme", value), theme);
    await setupCoreMocks(page); await setupTopologyMocks(page); await setupInventoryMocks(page); await setupMonitoringMocks(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/monitoring#endpoints");
    await page.getByRole("button", { name: "+ Add endpoint" }).click();
    const actions = page.locator(".modal-header-actions").first();
    const submit = await actions.getByRole("button", { name: "Add endpoint" }).boundingBox();
    const close = await actions.getByRole("button", { name: "Close" }).boundingBox();
    expect(submit?.height).toBe(close?.height);
    expect(close?.width).toBe(close?.height);
    expect(submit?.y).toBe(close?.y);
    const radii = await actions.locator("button").evaluateAll(els => els.map(el => getComputedStyle(el).borderRadius));
    expect(new Set(radii).size).toBe(1);
  });
}

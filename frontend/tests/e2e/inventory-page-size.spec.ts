import { expect, test } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

for (const style of ["light", "slate", "zinc"] as const) {
  test(`device page size uses themed controls and page scrolling in ${style}`, async ({ page }) => {
    const devices = Array.from({ length: 105 }, (_, index) => mockDevice({ id: index + 1, hostname: `device-${String(index + 1).padStart(3, "0")}`, ip_address: `192.168.1.${index + 1}` }));
    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices);
    await setupInventoryMocks(page, devices);
    await setupMonitoringMocks(page);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(style => {
      localStorage.setItem("netmap.theme", style === "light" ? "light" : "dark");
      localStorage.setItem("netmap.dark_style", style === "zinc" ? "zinc" : "slate");
    }, style);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inventory#devices");
    const rows = page.locator(".inventory-table .inventory-row");
    const size = page.getByRole("combobox", { name: "Rows per page" });
    await expect(rows).toHaveCount(25);
    await size.selectOption("100");
    await expect(rows).toHaveCount(100);
    const table = page.locator(".inventory-table");
    expect(await table.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
    expect(await table.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(2000);
    const reference = await page.evaluate(() => {
      const node = document.createElement("select"); node.className = "nm-select";
      document.body.append(node);
      const css = getComputedStyle(node);
      const result = { background: css.backgroundColor, color: css.color };
      node.remove(); return result;
    });
    expect(reference.background).toBe({ light: "rgb(254, 254, 254)", slate: "rgb(18, 22, 36)", zinc: "rgb(22, 22, 24)" }[style]);
    await expect(size).toHaveCSS("background-color", reference.background);
    await expect(size).toHaveCSS("color", reference.color);
    await expect(size.locator("option").first()).toHaveCSS("background-color", reference.background);
    await expect(size.locator("option").first()).toHaveCSS("color", reference.color);
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await size.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
      expect(await table.evaluate(node => node.scrollTop)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`${style}-${width}.png`) });
      await page.locator(".inventory-row-device").last().click();
      await expect(page.getByRole("complementary", { name: "Device overview" })).toBeInViewport();
      await page.getByRole("button", { name: "Close device overview" }).click();
    }
    await size.scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Next ›", exact: true }).click();
    await expect(rows).toHaveCount(5);
    await expect(page.locator(".inv-pagination-info")).toHaveText("Showing 101–105 of 105 devices");
    await size.selectOption("10");
    await expect(rows).toHaveCount(10);
    await expect(page.locator(".inv-pagination-info")).toHaveText("Showing 1–10 of 105 devices");
    expect(await page.evaluate(() => localStorage.getItem("netmap.inventory.pageSize"))).toBe("10");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/monitoring#devices");
    const sibling = page.locator(".inv-pagination-select");
    await expect(sibling).toHaveCSS("background-color", reference.background);
    await expect(sibling).toHaveCSS("color", reference.color);
    await expect(sibling.locator("option").first()).toHaveCSS("background-color", reference.background);
    await sibling.focus();
    await expect(sibling).toBeFocused();
    expect(errors).toEqual([]);
  });
}

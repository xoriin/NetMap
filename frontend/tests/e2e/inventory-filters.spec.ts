import { test, expect } from "@playwright/test";
import {
  setupCoreMocks,
  setupTopologyMocks,
  setupInventoryMocks,
  mockDevice,
} from "./helpers/api-mocks";

/**
 * The bulk menu is a native <details>, which only closes via its own summary.
 * These pin the controlled-dismiss behaviour layered on top of it.
 */
test.describe("Inventory bulk menu", () => {
  test.beforeEach(async ({ page }) => {
    const devices = [
      mockDevice({ id: 1, hostname: "router-01", ip_address: "192.168.1.1" }),
      mockDevice({ id: 2, hostname: "switch-01", ip_address: "192.168.1.2" }),
    ];
    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices);
    await setupInventoryMocks(page, devices);
    await page.goto("/inventory");
  });

  async function openBulkMenu(page: import("@playwright/test").Page) {
    const summary = page.locator(".inv-bulk-menu summary");
    await summary.waitFor({ state: "visible", timeout: 8000 });
    await summary.click();
    await expect(page.locator(".inv-bulk-menu-panel")).toBeVisible();
  }

  test("closes when clicking outside it", async ({ page }) => {
    await openBulkMenu(page);

    // Somewhere clearly outside the menu.
    await page.locator(".inv-panel-title").click();

    await expect(page.locator(".inv-bulk-menu-panel")).toBeHidden();
  });

  test("stays open while using a picker inside it", async ({ page }) => {
    await openBulkMenu(page);

    await page.locator(".inv-bulk-menu-field .nm-swatch-trigger").first().click();
    await expect(page.locator(".inv-bulk-menu .nm-swatch-list")).toBeVisible();
    await expect(page.locator(".inv-bulk-menu-panel")).toBeVisible();
  });

  test("Escape closes an open picker before the menu itself", async ({ page }) => {
    await openBulkMenu(page);
    await page.locator(".inv-bulk-menu-field .nm-swatch-trigger").first().click();
    await expect(page.locator(".inv-bulk-menu .nm-swatch-list")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".inv-bulk-menu .nm-swatch-list")).toBeHidden();
    await expect(page.locator(".inv-bulk-menu-panel")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".inv-bulk-menu-panel")).toBeHidden();
  });
});

test.describe("Inventory device type filter", () => {
  test.beforeEach(async ({ page }) => {
    const devices = [
      mockDevice({ id: 1, hostname: "router-01", ip_address: "192.168.1.1", device_type: "router" }),
      mockDevice({ id: 2, hostname: "switch-01", ip_address: "192.168.1.2", device_type: "switch" }),
      mockDevice({ id: 3, hostname: "switch-02", ip_address: "192.168.1.3", device_type: "switch" }),
    ];
    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices);
    await setupInventoryMocks(page, devices);
    await page.goto("/inventory");
  });

  test("offers only the types actually in use, and filters by them", async ({ page }) => {
    const typeFilter = page.getByRole("button", { name: "Filter by device type" });
    await typeFilter.waitFor({ state: "visible", timeout: 8000 });
    await expect(page.locator(".inventory-row")).toHaveCount(3);

    await typeFilter.click();
    const options = page.locator(".nm-swatch-list .nm-swatch-option");
    // All types + router + switch — no options for the 15 unused built-ins.
    await expect(options).toHaveCount(3);

    await options.filter({ hasText: "Switch" }).click();
    await expect(page.locator(".inventory-row")).toHaveCount(2);
  });
});

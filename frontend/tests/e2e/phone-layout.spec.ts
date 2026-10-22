import { expect, test } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const devices = Array.from({ length: 8 }, (_, i) => mockDevice({ id: i + 1, hostname: `host-${i + 1}`, ip_address: `192.168.1.${i + 1}`, topology_group: "Core" }));

async function boot(page: import("@playwright/test").Page, width = 375) {
  await page.setViewportSize({ width, height: 812 });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await setupInventoryMocks(page, devices);
  await setupMonitoringMocks(page, [mockMonitoringDevice()]);
}

test("phone navigation uses bottom tabs with a More sheet for everything else", async ({ page }) => {
  await boot(page);
  await page.goto("/overview");
  await expect(page.locator(".sidebar")).toBeHidden();
  const tabs = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(tabs).toBeVisible();
  for (const label of ["Home", "Inventory", "Monitor", "Map", "More"]) await expect(tabs.getByText(label, { exact: true })).toBeVisible();
  const bar = await tabs.boundingBox();
  expect(Math.round(bar!.y + bar!.height)).toBe(812);
  await tabs.getByRole("link", { name: "Inventory" }).click();
  await expect(page).toHaveURL(/\/inventory/);
  await expect(tabs.getByRole("link", { name: "Inventory" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Docs" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Sign out" })).toBeVisible();
  await sheet.getByRole("link", { name: "Profile" }).click();
  await expect(page).toHaveURL(/\/profile/);
  await expect(sheet).toBeHidden();
  await tabs.getByRole("button", { name: "More" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "More" })).toBeHidden();
});

test("pages with sub-sections get a section switcher on a phone", async ({ page }) => {
  await boot(page);
  await page.goto("/monitoring");
  const sections = page.getByRole("navigation", { name: "Sections" });
  await sections.getByRole("button", { name: "Endpoints" }).click();
  await expect(page).toHaveURL(/#endpoints/);
  await expect(sections.getByRole("button", { name: "Endpoints" })).toHaveAttribute("aria-current", "page");
});

test("desktop keeps the docked sidebar without phone navigation", async ({ page }) => {
  await boot(page, 1400);
  await page.goto("/overview");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".mobile-tabbar")).toHaveCount(0);
});

for (const route of ["/overview", "/inventory", "/monitoring", "/topology", "/vlans", "/locations", "/tools", "/profile"]) {
  test(`${route} fits a phone screen without sideways page scrolling`, async ({ page }) => {
    await boot(page);
    await page.goto(route);
    await expect(page.locator(".app-topbar")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const [icon, title] = [await page.locator(".app-topbar-icon").boundingBox(), await page.locator(".app-topbar-copy strong").boundingBox()];
    expect(title!.x).toBeGreaterThan(icon!.x + icon!.width);
    expect(Math.abs((title!.y + title!.height / 2) - (icon!.y + icon!.height / 2))).toBeLessThan(6);
  });
}

test("Inventory and Monitoring show devices as cards with filters behind a button on a phone", async ({ page }) => {
  await boot(page);
  await page.goto("/inventory");
  const card = page.locator(".inventory-row").first();
  await expect(card).toBeVisible();
  await expect(page.locator(".inventory-table-header")).toBeHidden();
  const [name, status] = [await card.locator(".inventory-row-device").boundingBox(), await card.locator(".status-pill").boundingBox()];
  expect(Math.abs(name!.y - status!.y)).toBeLessThan(14);
  expect(status!.x + status!.width).toBeLessThanOrEqual(375);
  const groupFilter = page.getByRole("button", { name: /Filter by VLAN \/ group/ });
  await expect(groupFilter).toBeHidden();
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(groupFilter).toBeVisible();
  await page.goto("/monitoring");
  const row = page.locator("tr.mon-row").first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(375);
  expect(box!.height).toBeGreaterThan(70);
  await expect(page.locator(".mon-table--fleet thead")).toBeHidden();
});

test("summary cards become a compact strip on a phone", async ({ page }) => {
  await boot(page);
  await page.goto("/overview");
  const cards = page.locator(".dash-stats > *");
  const [first, second] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
  expect(first!.width).toBeLessThan(170);
});

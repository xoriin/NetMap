import { expect, test } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const devices = Array.from({ length: 8 }, (_, i) => mockDevice({ id: i + 1, hostname: `host-${i + 1}`, ip_address: `192.168.1.${i + 1}`, topology_group: "Core" }));

async function boot(page: import("@playwright/test").Page, width = 375) {
  await page.setViewportSize({ width, height: 812 });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await setupInventoryMocks(page, devices);
  await setupMonitoringMocks(page, [mockMonitoringDevice()]);
  for (const path of ["admin/cloud-providers", "ipam/external/addresses"]) await page.route(`**/api/v1/${path}`, (route) => route.fulfill({ json: [] }));
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

for (const [route, width] of [["/overview", 320], ["/overview", 375], ["/overview", 430], ["/inventory", 375], ["/inventory#cloud-assets", 375], ["/monitoring", 375], ["/tools", 375]] as const) {
  test(`summary cards on ${route} fit a ${width}px phone in a grid with one-line labels`, async ({ page }) => {
    await boot(page, width);
    await page.goto(route);
    const cards = page.locator(".dash-stats > *");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThan(1);
    const boxes = await Promise.all(Array.from({ length: count }, (_, i) => cards.nth(i).boundingBox()));
    for (const box of boxes) {
      expect(box!.x).toBeGreaterThanOrEqual(8);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width - 8);
      expect(box!.height).toBeLessThan(64);
    }
    const band = (await page.locator(".dash-stats").first().boundingBox())!;
    const next = await page.locator(".dash-stats").first().evaluate((el) => (el.nextElementSibling ?? el.parentElement!.nextElementSibling)!.getBoundingClientRect().top);
    expect(next - (band.y + band.height)).toBeGreaterThanOrEqual(8);
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeLessThan(2);
    for (const label of await page.locator(".dash-stats .dash-stat-label").all()) {
      const fontSize = parseFloat(await label.evaluate((el) => getComputedStyle(el).fontSize));
      expect((await label.boundingBox())!.height).toBeLessThan(fontSize * 2);
    }
  });
}

test("device popups open as a full-screen page on a phone", async ({ page }) => {
  await boot(page);
  await page.goto("/monitoring");
  await page.locator("tr.mon-row").first().click();
  const popup = page.locator(".mon-hero").first();
  await expect(popup).toBeVisible();
  const box = await popup.boundingBox();
  expect(Math.round(box!.x)).toBe(0);
  expect(Math.round(box!.width)).toBe(375);
  expect(Math.round(box!.height)).toBe(812);
  await expect(popup.locator(".hb-inspect-hint")).toHaveCount(await popup.locator(".hb-inspect-hint").count());
  for (const hint of await popup.locator(".hb-inspect-hint").all()) await expect(hint).toBeHidden();
  const columns = popup.locator(".mon-hero-col");
  if (await columns.count() > 1) {
    const [first, second] = [await columns.nth(0).boundingBox(), await columns.nth(1).boundingBox()];
    expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
  }
});

test("the Topology toolbar stays compact on a phone so the map keeps the screen", async ({ page }) => {
  await boot(page);
  await page.goto("/topology");
  const toolbar = page.locator(".topology-toolbar--ribbon");
  await expect(toolbar).toBeVisible();
  for (const label of ["PNG", "SVG", "PDF", "Icons"]) await expect(toolbar.getByText(label, { exact: true })).toBeHidden();
  await expect(toolbar.getByRole("button", { name: "Fit" })).toBeVisible();
  expect((await toolbar.boundingBox())!.height).toBeLessThan(170);
});

test("page header controls stay inside the header on a phone instead of covering the page", async ({ page }) => {
  await boot(page);
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: { enabled: true, total_events: 1, stored_events: 1, received_packets: 1, dropped_unparsed: 0, denied_senders: 0, retention_days: 7 } }));
  await page.route("**/api/v1/syslog/events*", (route) => route.fulfill({ json: { retention_days: 7, total: 0, offset: 0, limit: 100, events: [] } }));
  await page.route("**/api/v1/syslog/searches", (route) => route.fulfill({ json: [] }));
  await page.goto("/security");
  const pause = page.getByRole("button", { name: "Pause" });
  await expect(pause).toBeVisible();
  const header = (await page.locator(".app-topbar").boundingBox())!;
  const button = (await pause.boundingBox())!;
  expect(button.y + button.height).toBeLessThanOrEqual(header.y + header.height);
  expect((await page.locator(".dash-stats").boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height);
});

test("Tools tabs sit in one swipeable row on a phone", async ({ page }) => {
  await boot(page);
  await page.goto("/tools");
  const nav = page.locator(".tools-nav");
  await expect(nav).toBeVisible();
  const tabs = nav.locator(".tools-nav-item");
  const [first, last] = [await tabs.first().boundingBox(), await tabs.last().boundingBox()];
  expect(Math.abs(first!.y - last!.y)).toBeLessThan(2);
  expect(await nav.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

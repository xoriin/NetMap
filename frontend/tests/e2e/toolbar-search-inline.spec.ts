import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const devices = Array.from({ length: 12 }, (_, i) => mockDevice({ id: i + 1, hostname: `host-${i}`, ip_address: `192.168.1.${i + 1}` }));
const monitored = Array.from({ length: 6 }, (_, i) => mockMonitoringDevice({ id: i + 1, hostname: `host-${i}`, group_id: (i % 2) + 1, group_name: `Servers ${i}`, site_id: 1, site_name: "Home Lab", vlan_id: "10" }));

async function boot(page: Page, width: number) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await setupInventoryMocks(page, devices);
  await setupMonitoringMocks(page, monitored);
  await page.setViewportSize({ width, height: 1200 });
}

async function centerY(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element is not visible");
  return box.y + box.height / 2;
}

const pages = [
  { name: "Monitoring", path: "/monitoring", header: ".mon-device-window-header", title: ".mon-table-toolbar-meta", search: ".mon-search-wrap" },
  { name: "Inventory", path: "/inventory", header: ".inventory-panel-header", title: ".inv-panel-title", search: ".inv-search-box" },
];

for (const p of pages) {
  test(`${p.name} Devices toolbar is one row at 1920 wide`, async ({ page }) => {
    await boot(page, 1920);
    await page.goto(p.path);
    const header = page.locator(p.header);
    await expect(header.locator(p.search)).toBeVisible();
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(56);
    expect(Math.abs(await centerY(header.locator(p.search)) - await centerY(header.locator(p.title)))).toBeLessThanOrEqual(4);
  });

  for (const width of [1700, 1600, 1500, 1440, 1366, 1280, 1180]) {
    test(`${p.name} Devices search stays in line with the filter buttons at ${width} wide`, async ({ page }) => {
      await boot(page, width);
      await page.goto(p.path);
      const header = page.locator(p.header);
      const search = header.locator(p.search);
      await expect(search).toBeVisible();
      const filters = header.locator(".nm-phone-filters-btn");
      expect(Math.abs(await centerY(search) - await centerY(filters))).toBeLessThanOrEqual(4);
      const headerBox = (await header.boundingBox())!;
      const overflow = await header.evaluate((el) => {
        const right = el.getBoundingClientRect().right;
        return Array.from(el.querySelectorAll("button, .nm-search, .nm-swatch-select")).some((c) => c.getBoundingClientRect().right > right + 1);
      });
      expect(overflow).toBe(false);
      expect((await search.boundingBox())!.width).toBeGreaterThanOrEqual(120);
      expect(headerBox.height).toBeLessThanOrEqual(width >= 1366 ? 110 : 150);
    });
  }
}

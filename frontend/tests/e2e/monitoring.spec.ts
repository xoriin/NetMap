import { test, expect } from "@playwright/test";
import {
  setupCoreMocks,
  setupMonitoringMocks,
  setupTopologyMocks,
  mockMonitoringDevice,
} from "./helpers/api-mocks";

test.describe("Monitoring workspace", () => {
  test.beforeEach(async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page);
    await setupMonitoringMocks(page, [
      mockMonitoringDevice({
        display_name: "Core Router With A Longer Name",
        hostname: "router-core-01",
        ip_address: "192.168.100.1",
      }),
    ]);
    await page.goto("/");
    await page.getByRole("button", { name: "Monitoring", exact: true }).click();
  });

  test("allocates most row width to heartbeat and RTT displays", async ({ page }) => {
    const row = page.locator(".mon-row").first();
    await expect(row).toBeVisible();

    // The inline RTT sparkline moved to the detail panel; rows now show
    // name/IP plus the heartbeat strip, which must dominate the row width.
    const deviceCell = row.locator("td").nth(1);
    const heartbeat = deviceCell.locator(".heartbeat-bar--sm");

    await expect(heartbeat).toBeVisible();

    const widths = await page.evaluate(() => {
      const rowEl = document.querySelector(".mon-row");
      if (!rowEl) return null;
      const cells = Array.from(rowEl.querySelectorAll("td"));
      return {
        device: cells[1]?.getBoundingClientRect().width ?? 0,
        uptime: cells[2]?.getBoundingClientRect().width ?? 0,
        services: cells[5]?.getBoundingClientRect().width ?? 0,
        heartbeat: document.querySelector(".heartbeat-bar--sm")?.getBoundingClientRect().width ?? 0,
      };
    });

    expect(widths).not.toBeNull();
    // Device cell (name + heartbeat strip) must dominate the metadata columns.
    expect(widths!.device).toBeGreaterThan(widths!.uptime * 1.5);
    expect(widths!.device).toBeGreaterThan(widths!.services * 1.5);
    // Heartbeat strip width scales with beat count; require it to fill
    // most of the device cell rather than an absolute pixel width.
    expect(widths!.heartbeat).toBeGreaterThan(widths!.device * 0.4);
    expect(widths!.services).toBeLessThanOrEqual(240);
  });
});

test.describe("Monitoring layout and column sizing", () => {
  test.beforeEach(async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page);
    // Enough rows that the table certainly runs past the bottom of the panel.
    await setupMonitoringMocks(
      page,
      Array.from({ length: 60 }, (_, i) =>
        mockMonitoringDevice({
          device_id: i + 1,
          display_name: `Device ${i + 1}`,
          hostname: `host-${i + 1}`,
          ip_address: `192.168.1.${i + 1}`,
        })
      )
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Monitoring", exact: true }).click();
    await expect(page.locator(".mon-row").first()).toBeVisible();
  });

  test("scrolls the table, not the page", async ({ page }) => {
    const pageOverflow = await page.evaluate(() => ({
      body: document.body.scrollHeight - document.body.clientHeight,
      doc: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(pageOverflow.body).toBeLessThanOrEqual(1);
    expect(pageOverflow.doc).toBeLessThanOrEqual(1);

    // The rows have to actually overflow, or the assertion above proves nothing.
    const body = page.locator(".mon-table-body");
    const overflow = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(overflow).toBeGreaterThan(0);

    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // Scrolling to the end of the table must not have moved the page.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("keeps the pagination footer in view without scrolling", async ({ page }) => {
    const footer = page.locator(".inv-pagination");
    await expect(footer).toBeInViewport();
  });

  async function headerWidths(page: import("@playwright/test").Page) {
    return page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".mon-table--fleet thead th")).map(
        (th) => Math.round(th.getBoundingClientRect().width)
      )
    );
  }

  async function dragDivider(page: import("@playwright/test").Page, handleIdx: number, dx: number) {
    const handle = page.locator(".mon-table--fleet .mon-col-resize-handle").nth(handleIdx);
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
  }

  // Both directions matter and they fail differently. table-layout: fixed grows
  // the table when the columns add up to more than its stated width, so
  // widening a column looks fine even when the width is wrong; it only
  // redistributes when they add up to less, so shrinking one column is what
  // visibly inflates its neighbours.
  for (const [label, dx] of [["widening", 90], ["shrinking", -90]] as const) {
    test(`${label} a column leaves every other column's width untouched`, async ({ page }) => {
      const before = await headerWidths(page);

      // Handle index 1 is the "24 h" column, i.e. header cell 2.
      await dragDivider(page, 1, dx);

      const after = await headerWidths(page);
      expect(after.length).toBe(before.length);
      // The dragged column actually moved...
      expect(Math.abs(after[2] - before[2])).toBeGreaterThan(60);
      // ...and nothing else did.
      for (const i of [0, 1, 3, 4, 5, 6, 7]) {
        expect(Math.abs(after[i] - before[i])).toBeLessThanOrEqual(1);
      }
    });
  }

  test("double-clicking a divider restores the default column widths", async ({ page }) => {
    const before = await headerWidths(page);

    const handle = page.locator(".mon-table--fleet .mon-col-resize-handle").nth(1);
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    expect((await headerWidths(page))[2]).toBeGreaterThan(before[2] + 60);

    await page.locator(".mon-table--fleet .mon-col-resize-handle").nth(1).dblclick();

    const after = await headerWidths(page);
    for (let i = 0; i < before.length; i += 1) {
      expect(Math.abs(after[i] - before[i])).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => window.localStorage.getItem("netmap.mon_col_widths_v8"))).toBeNull();
  });
});

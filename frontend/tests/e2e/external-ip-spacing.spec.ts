import { expect, test } from "@playwright/test";
import { mockAddress, setupExternalIps } from "./helpers/external-ip";

for (const theme of ["light", "dark"] as const) {
  for (const width of [1600, 1280, 780]) {
    test(`external IP actions stay compact at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await setupExternalIps(page, {
        theme,
        locations: [{ id: 1, name: "Production services", account_id: null, region: null }],
        addresses: [
          mockAddress({ label: "Public service", location_id: 1 }),
          mockAddress({ id: 2, ip_address: "203.0.113.11", location_id: 1, device_id: 7 }),
          ...Array.from({ length: 10 }, (_, index) => mockAddress({
            id: index + 3,
            ip_address: `203.0.113.${index + 12}`,
            location_id: 1,
            label: "Production public application gateway",
            owner: "Infrastructure operations team",
            tags: "production,public,gateway",
          })),
        ],
      });

      const header = await page.locator(".external-ip-panel-header").boundingBox();
      for (const control of await page.locator(".external-ip-search, .external-ip-status-filter, .external-ip-header-controls > button, .external-ip-panel-actions > button").all()) {
        const bounds = await control.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(header!.x);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(header!.x + header!.width);
      }

      // Location omits a column; the other grouping lenses include it.
      for (const grouping of ["location", "provider", "status", "none"]) {
        await page.getByLabel("Group by").selectOption(grouping);
        const rows = page.locator(".external-ip-address-row");
        await expect(rows).toHaveCount(12);
        await expect(rows.first().getByRole("button")).toHaveCount(3);
        for (const row of await rows.all()) {
          const cell = row.locator(".external-ip-actions");
          const bounds = await cell.boundingBox();
          const buttons = await cell.locator("button").evaluateAll((nodes) => nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { y: rect.y, left: rect.left, right: rect.right };
          }));
          expect(buttons.length).toBeGreaterThanOrEqual(2);
          expect(Math.max(...buttons.map((b) => b.y)) - Math.min(...buttons.map((b) => b.y))).toBeLessThanOrEqual(1);
          expect(buttons[0].left).toBeGreaterThanOrEqual(bounds!.x + 11);
          expect(buttons.at(-1)!.right).toBeLessThanOrEqual(bounds!.x + bounds!.width - 11);
        }
        const heights = await rows.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        expect(Math.abs(heights[0] - heights[1])).toBeLessThanOrEqual(1);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: `/tmp/netmap-external-spacing-${theme}-${width}.png` });
      // Actions remain reachable inside the table's own scroll viewport.
      await page.locator(".external-ip-address-row").first().getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      if (width === 780) await page.screenshot({ path: `/tmp/netmap-external-spacing-${theme}-${width}-actions.png` });
    });
  }
}

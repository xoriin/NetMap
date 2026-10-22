import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1280, 2048]) {
    test(`endpoint headers align with data at ${width}px in ${theme}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.setViewportSize({ width, height: 1000 });
      await setupCoreMocks(page); await setupTopologyMocks(page); await setupMonitoringMocks(page);
      await page.addInitScript(t => { if (window === window.top) localStorage.setItem("netmap.theme", t); }, theme);
      const longName = "Customer-facing endpoint with a long descriptive name that must stay within its column";
      const longUrl = `https://api.example.com/${"long-path-segment/".repeat(30)}health`;
      await page.route("**/api/v1/monitors", route => route.fulfill({ json: [
        { id: 1, name: "Google", url: "https://www.google.com/", enabled: true, last_status: "online", last_checked_at: "2026-10-22T00:35:47Z", uptime_24h: 99.8, uptime_7d: 99.9, avg_response_time_24h: 456, heartbeat: Array(30).fill("online") },
        { id: 2, name: longName, url: longUrl, enabled: false, last_status: "unknown", last_checked_at: null, uptime_24h: null, uptime_7d: null, avg_response_time_24h: null, heartbeat: [] },
      ] }));
      await page.goto("/monitoring#endpoints");
      const table = page.locator(".monitors-table");
      await expect(table.locator("tbody tr")).toHaveCount(2);
      const headers = table.locator("thead th");
      // Every data column shares the remaining width; long URLs must not absorb
      // the spare desktop space and bunch the metrics up at the right edge.
      const widths = await headers.evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
      const dataWidths = widths.slice(2, 9);
      expect(Math.max(...dataWidths) - Math.min(...dataWidths)).toBeLessThanOrEqual(1);
      expect(widths[0]).toBeCloseTo(90, 0);
      expect(widths[1]).toBeCloseTo(50, 0);
      expect(widths[9]).toBeCloseTo(220, 0);
      await expect(headers.nth(4)).toHaveCSS("text-align", "left");
      for (const index of [5, 6, 7]) await expect(headers.nth(index)).toHaveCSS("text-align", "center");
      const geometry = await table.evaluate(node => {
        const head = [...node.querySelectorAll("thead th")];
        const cells = [...node.querySelectorAll("tbody tr:first-child td")];
        const text = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); };
        return head.map((h,i) => {
          const hb = h.getBoundingClientRect(), cb = cells[i].getBoundingClientRect();
          const ht = text(h), ct = text(cells[i]);
          return { cellEdgeDelta: Math.abs(hb.x-cb.x), widthDelta: Math.abs(hb.width-cb.width), textEdgeDelta: Math.abs(ht.x-ct.x), headerCentreDelta: Math.abs(ht.x+ht.width/2-hb.x-hb.width/2), valueCentreDelta: Math.abs(ct.x+ct.width/2-cb.x-cb.width/2) };
        });
      });
      for (const column of geometry) { expect(column.cellEdgeDelta).toBeLessThanOrEqual(1); expect(column.widthDelta).toBeLessThanOrEqual(1); }
      for (const index of [2, 4, 8]) expect(geometry[index].textEdgeDelta).toBeLessThanOrEqual(1);
      for (const index of [5, 6, 7]) { expect(geometry[index].headerCentreDelta).toBeLessThanOrEqual(1); expect(geometry[index].valueCentreDelta).toBeLessThanOrEqual(1); }
      const heartbeat = table.locator(".heartbeat-bar--sm").first();
      await expect(heartbeat.locator(".heartbeat-beat")).toHaveCount(30);
      const beatFits = await heartbeat.evaluate(bar => {
        const bounds = bar.getBoundingClientRect();
        return [...bar.children].every(beat => {
          const box = beat.getBoundingClientRect();
          return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
        });
      });
      expect(beatFits).toBe(true);
      const longRow = table.locator("tbody tr").nth(1);
      await expect(longRow.locator("td").nth(2)).toHaveCSS("text-overflow", "ellipsis");
      await expect(longRow.locator("td").nth(4)).toHaveCSS("text-overflow", "ellipsis");
      await expect(longRow.locator("td").nth(4)).toHaveAttribute("title", longUrl);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: test.info().outputPath(`endpoint-columns-${width}-${theme}.png`), fullPage: true });
      // Shared Monitoring styles must leave the sibling Devices table usable.
      await page.goto("/monitoring");
      await expect(page.locator(".mon-table--fleet")).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}

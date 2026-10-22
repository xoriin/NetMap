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
      await expect(heartbeat.locator(".heartbeat-beat")).toHaveCount(24);
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

test("the endpoint popup has the interactive heartbeat and RTT graph", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setupCoreMocks(page); await setupTopologyMocks(page); await setupMonitoringMocks(page);
  const monitor = {
    id: 1, name: "Google", url: "https://www.google.com/", enabled: true, last_status: "online", last_checked_at: "2026-10-22T10:00:00Z",
    uptime_24h: 99.8, uptime_7d: 99.9, avg_response_time_24h: 120, heartbeat: Array(24).fill("online"),
    http_method: "GET", accepted_status_codes: "200-299", check_interval_seconds: 60, timeout_seconds: 10, max_retries: 0,
    retry_interval_seconds: 60, verify_tls: true, follow_redirects: true, max_redirects: 5, auth_type: "none", keyword: null,
    json_path: null, cache_bust: false, upside_down: false, consecutive_failures: 0, certificate_expiry_alert: true,
    certificate_expiry_days: 14, last_cert_expires_at: null, last_cert_issuer: null,
  };
  const end = Date.UTC(2026, 9, 22, 10, 0, 0);
  const history = Array.from({ length: 24 }, (_, i) => ({
    id: i + 1, checked_at: new Date(end - (23 - i) * 120_000).toISOString(), status: i === 5 ? "offline" : "online",
    response_time_ms: i === 5 ? null : 100 + (i % 6) * 20, status_code: i === 5 ? 503 : 200, error: i === 5 ? "Service unavailable" : null,
    assertion_detail: null, response_size_bytes: 2048, cert_expires_at: null,
  }));
  await page.route("**/api/v1/monitors", route => route.fulfill({ json: [monitor] }));
  await page.route("**/api/v1/monitors/1/history?*", route => route.fulfill({ json: history }));
  await page.goto("/monitoring#endpoints");
  await page.locator(".monitors-table tbody tr").first().click();
  const beats = page.locator(".mon-hero .heartbeat-bar--lg .heartbeat-beat");
  await expect(beats).toHaveCount(24);
  await beats.nth(5).hover();
  await expect(beats.nth(5)).toHaveClass(/is-active/);
  const card = page.locator(".hb-tooltip-card");
  await expect(card).toContainText("HTTP 503");
  await expect(card).toContainText("Service unavailable");
  await beats.nth(10).hover();
  await expect(card).toContainText("HTTP 200");
  await expect(card).toContainText("ms");

  const plot = page.locator(".mon-hero .mon-sparkline-plot");
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect(plot.locator(".mon-sparkline-readout")).toContainText("ms");
});

import { expect, test, type Page } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function setupSecurity(page: Page, theme: "light" | "dark") {
  await setupCoreMocks(page, "Maintenance window tonight");
  await setupTopologyMocks(page, [mockDevice({ hostname: "edge-router", ip_address: "10.0.0.1" })]);
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: {
    enabled: true, udp_enabled: true, tcp_enabled: true, tls_enabled: false,
    udp_port: 1514, tcp_port: 1514, tls_port: 6514, retention_days: 7,
    allowlist_enabled: true, total_events: 1247, received_packets: 1320,
    stored_events: 1247, dropped_unparsed: 12, denied_senders: 4,
    retention_last_run_at: "2026-08-01T10:00:00Z", retention_last_deleted: 18,
    retention_last_error: null, last_event_received_at: "2026-08-01T10:05:00Z",
    last_packet_at: null, last_packet_sender: null, last_stored_at: null,
    last_stored_sender: null, last_drop_at: null, last_drop_sender: null,
    last_drop_raw: null, last_denied_at: null, last_denied_sender: null,
  } }));
  await page.route("**/api/v1/syslog/events*", (route) => route.fulfill({ json: {
    retention_days: 7, total: 1, offset: 0, limit: 100,
    events: [{
      id: 7, received_at: "2026-08-01T10:05:00Z", event_time: null,
      source_host: "firewall", src_ip: "10.0.0.1", dst_ip: "1.1.1.1",
      src_port: 52100, dst_port: 443, protocol: "tcp", action: "pass",
      interface: "wan", direction: "out", rule_id: "42", tracker_id: null,
      reason: "match", raw_log: "filterlog: pass tcp 10.0.0.1:52100 -> 1.1.1.1:443",
    }],
  } }));
  await page.route("**/api/v1/syslog/searches", (route) => route.fulfill({ json: [] }));
  await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
  await page.goto("/security");
  await page.locator(".security-layout").waitFor({ state: "visible" });
}

for (const theme of ["light", "dark"] as const) {
  test(`Security uses the approved operational hierarchy in ${theme} mode`, async ({ page }) => {
    await setupSecurity(page, theme);

    await expect(page.locator(".security-summary-card")).toHaveCount(4);
    await expect(page.locator(".security-summary-grid")).toContainText("1,247");
    await expect(page.locator(".security-summary-grid")).toContainText("Denied senders");
    await expect(page.locator(".security-filters")).toHaveCSS("background-image", "none");
    await expect(page.locator(".security-results")).toHaveCSS("background-image", "none");
    await expect(page.locator(".security-panel-header")).toContainText("Event filters");
    await expect(page.locator(".security-results-meta")).toContainText("Firewall events");
    await expect(page.locator(".security-results-meta")).toContainText("1 results");
    await expect(page.locator(".security-row")).toContainText("10.0.0.1");
    await expect(page.locator(".security-search input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });
}

test("Security keeps the event table as the scrolling viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 850 });
  await setupSecurity(page, "dark");

  const layout = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace");
    const results = document.querySelector<HTMLElement>(".security-results");
    const table = document.querySelector<HTMLElement>(".security-table");
    const footer = document.querySelector<HTMLElement>(".security-pagination");
    if (!workspace || !results || !table || !footer) return null;
    return {
      workspaceOverflow: getComputedStyle(workspace).overflow,
      tableOverflow: getComputedStyle(table).overflow,
      footerBottom: footer.getBoundingClientRect().bottom,
      resultsBottom: results.getBoundingClientRect().bottom,
    };
  });
  expect(layout).not.toBeNull();
  expect(layout!.workspaceOverflow).toBe("hidden");
  expect(layout!.tableOverflow).toBe("auto");
  expect(Math.abs(layout!.footerBottom - layout!.resultsBottom)).toBeLessThanOrEqual(1);
});

test("Security bands keep one stable workspace anchor and section gap", async ({ page }) => {
  await setupSecurity(page, "dark");
  const geometry = await page.evaluate(() => {
    const selectors = [".dash-alert--announcement", ".security-layout > .form-error", ".security-summary-grid", ".security-content"];
    const boxes = selectors
      .map((selector) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null)
      .filter((box): box is DOMRect => box !== null);
    return boxes.map((box) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom }));
  });
  expect(geometry.length).toBeGreaterThanOrEqual(3);
  geometry.forEach((box) => {
    expect(Math.abs(box.left - geometry[0].left)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.right - geometry[0].right)).toBeLessThanOrEqual(1);
  });
  for (let index = 1; index < geometry.length; index += 1) {
    expect(Math.abs(geometry[index].top - geometry[index - 1].bottom - 16)).toBeLessThanOrEqual(1);
  }
});

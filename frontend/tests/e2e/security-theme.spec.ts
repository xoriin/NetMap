import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { FirewallEvent } from "../../src/api/client";
import { mockDevice, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const baseEvent: FirewallEvent = {
  id: 7, received_at: "2026-08-01T10:05:00Z", event_time: null,
  source_host: "firewall", src_ip: "10.0.0.1", dst_ip: "1.1.1.1",
  src_port: 52100, dst_port: 443, protocol: "tcp", action: "pass",
  interface: "wan", direction: "out", rule_id: "42", tracker_id: null,
  reason: "match", raw_log: "filterlog: pass tcp 10.0.0.1:52100 -> 1.1.1.1:443",
};

async function setupSecurity(page: Page, theme: "light" | "dark", events: FirewallEvent[] = [baseEvent]) {
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
    retention_days: 7, total: events.length, offset: 0, limit: 100, events,
  } }));
  await page.route("**/api/v1/syslog/searches", (route) => route.fulfill({ json: [] }));
  await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
  await page.goto("/security");
  await page.locator(".security-layout").waitFor({ state: "visible" });
}

async function installFirewallSocketMock(page: Page) {
  const sockets: WebSocketRoute[] = [];
  const ready = new WeakSet<WebSocketRoute>();
  const closed = new WeakSet<WebSocketRoute>();
  const activeSocket = () => [...sockets].reverse().find(socket => !closed.has(socket));
  // Route actual browser sockets rather than replacing the WebSocket constructor;
  // page-specific scenarios override the context's shared empty-stream mock.
  await page.routeWebSocket(url => url.pathname === "/api/v1/syslog/events/live", socket => {
    sockets.push(socket);
    socket.onMessage(message => {
      ready.add(socket);
      socket.send(JSON.stringify({ type: message === "ping" ? "heartbeat" : "ready" }));
    });
    socket.onClose(() => { closed.add(socket); });
  });
  await page.exposeFunction("__firewallSocketCount", () => sockets.length);
  await page.exposeFunction("__firewallSocketReady", () => sockets.some(socket => ready.has(socket) && !closed.has(socket)));
  await page.exposeFunction("__emitFirewallEvent", (event: unknown) => activeSocket()?.send(JSON.stringify(event)));
  await page.exposeFunction("__disconnectFirewallSocket", async () => {
    const socket = activeSocket();
    if (socket) {
      closed.add(socket);
      await socket.close({ code: 1011, reason: "Simulated stream outage" });
    }
  });
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

test("Security event columns fill the viewport and saved-search controls span the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupSecurity(page, "dark");

  const geometry = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>(".security-table");
    const header = document.querySelector<HTMLElement>(".security-table-header");
    const saved = document.querySelector<HTMLElement>(".security-saved-searches");
    const select = saved?.querySelector<HTMLElement>("select");
    const saveButton = saved?.querySelector<HTMLElement>("button");
    if (!table || !header || !saved || !select || !saveButton) return null;
    const savedBox = saved.getBoundingClientRect();
    const selectBox = select.getBoundingClientRect();
    const saveBox = saveButton.getBoundingClientRect();
    return {
      tableClientWidth: table.clientWidth,
      headerWidth: header.getBoundingClientRect().width,
      headerScrollWidth: header.scrollWidth,
      savedLeft: savedBox.left,
      savedRight: savedBox.right,
      selectLeft: selectBox.left,
      selectRight: selectBox.right,
      saveLeft: saveBox.left,
      saveRight: saveBox.right,
    };
  });

  expect(geometry).not.toBeNull();
  expect(Math.abs(geometry!.headerWidth - geometry!.tableClientWidth)).toBeLessThanOrEqual(1);
  expect(geometry!.headerScrollWidth).toBeLessThanOrEqual(geometry!.tableClientWidth + 1);
  expect(Math.abs(geometry!.selectLeft - geometry!.savedLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry!.selectRight - geometry!.savedRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry!.saveLeft - geometry!.savedLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry!.saveRight - geometry!.savedRight)).toBeLessThanOrEqual(1);
});

test("Security event column widths resize, persist, and reset", async ({ page }) => {
  await setupSecurity(page, "dark");
  const widths = () => page.locator(".security-table-heading").evaluateAll((headings) =>
    headings.map((heading) => Math.round(heading.getBoundingClientRect().width))
  );
  const before = await widths();
  const handle = page.locator(".security-col-resize-handle").nth(1);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const resized = await widths();
  expect(resized[1]).toBeGreaterThan(before[1] + 60);
  resized.forEach((width, index) => {
    if (index !== 1) expect(Math.abs(width - before[index])).toBeLessThanOrEqual(1);
  });

  await page.reload();
  await page.locator(".security-layout").waitFor({ state: "visible" });
  await expect.poll(async () => (await widths())[1]).toBe(resized[1]);
  await page.locator(".security-col-resize-handle").nth(1).dblclick();
  await expect.poll(async () => (await widths())[1]).toBeLessThan(resized[1] - 40);
  expect(await page.evaluate(() => window.localStorage.getItem("netmap.securityEventColumnWidths.v1"))).toBeNull();
});

test("Security auto-scroll follows committed live rows without reconnecting the stream", async ({ page }) => {
  const events = Array.from({ length: 60 }, (_, index): FirewallEvent => ({
    ...baseEvent,
    id: index + 1,
    received_at: new Date(Date.parse(baseEvent.received_at) - index * 60_000).toISOString(),
    src_port: 52000 + index,
    raw_log: `filterlog: pass event ${index + 1}`,
  }));
  const liveEvent: FirewallEvent = {
    ...baseEvent,
    id: 999,
    received_at: "2026-08-01T10:06:00Z",
    src_ip: "10.0.0.99",
    raw_log: "filterlog: pass live event",
  };

  await installFirewallSocketMock(page);
  await setupSecurity(page, "dark", events);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __firewallSocketReady: () => Promise<boolean> }
  ).__firewallSocketReady())).toBe(true);

  const table = page.locator(".security-table");
  await table.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => table.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.evaluate((event) => (
    window as unknown as { __emitFirewallEvent: (payload: unknown) => Promise<void> }
  ).__emitFirewallEvent(event), liveEvent);
  await expect(page.locator(".security-row").first()).toContainText("10.0.0.99");
  await expect.poll(() => table.evaluate((element) => element.scrollTop)).toBe(0);

  const autoScroll = page.getByRole("checkbox", { name: "Auto-scroll" });
  await autoScroll.uncheck();
  await expect(autoScroll).not.toBeChecked();
  await table.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => table.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.evaluate((event) => (
    window as unknown as { __emitFirewallEvent: (payload: unknown) => Promise<void> }
  ).__emitFirewallEvent(event), { ...liveEvent, id: 1000, src_ip: "10.0.0.100" });
  await expect(page.locator(".security-row").first()).toContainText("10.0.0.100");
  await expect.poll(() => table.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await autoScroll.check();
  await expect(autoScroll).toBeChecked();
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __firewallSocketCount: () => Promise<number> }
  ).__firewallSocketCount())).toBe(1);
});

test("Security reconnects a dropped live stream and reloads events missed while offline", async ({ page }) => {
  const recoveredEvent: FirewallEvent = {
    ...baseEvent,
    id: 2000,
    received_at: "2026-08-01T10:07:00Z",
    src_ip: "10.0.0.200",
    raw_log: "filterlog: recovered after reconnect",
  };
  await installFirewallSocketMock(page);
  await setupSecurity(page, "dark");
  await expect(page.locator(".security-topbar-copy")).toContainText("live stream connected");

  await page.route("**/api/v1/syslog/events*", (route) => route.fulfill({ json: {
    retention_days: 7, total: 1, offset: 0, limit: 100, events: [recoveredEvent],
  } }));
  await page.evaluate(() => (
    window as unknown as { __disconnectFirewallSocket: () => Promise<void> }
  ).__disconnectFirewallSocket());
  await expect(page.locator(".security-topbar-copy")).toContainText("live stream reconnecting");
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __firewallSocketCount: () => Promise<number> }
  ).__firewallSocketCount())).toBeGreaterThan(1);
  await expect(page.locator(".security-topbar-copy")).toContainText("live stream connected");
  await expect(page.locator(".security-row").first()).toContainText("10.0.0.200");
  await expect(page.locator(".form-error")).toHaveCount(0);
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

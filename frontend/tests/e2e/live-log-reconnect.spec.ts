import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { mockTokenPair, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

// The live log stream authenticates with the access token as its first frame.
// The server closes it with 1008 when that token expires or is rejected.

const POLICY_VIOLATION = 1008;

function jwt(expiresInSeconds: number) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "1", type: "access", exp: Math.floor(Date.now() / 1000) + expiresInSeconds })}.sig`;
}

type Stream = { sockets: WebSocketRoute[]; tokens: string[]; refreshes: number; logouts: number };

async function openSecurity(page: Page, initialToken = mockTokenPair.access_token): Promise<Stream> {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/auth/refresh", (route) => route.fulfill({ json: { ...mockTokenPair, access_token: initialToken } }));
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: {
    enabled: true, udp_enabled: true, tcp_enabled: true, tls_enabled: false,
    udp_port: 1514, tcp_port: 1514, tls_port: 6514, retention_days: 7,
    allowlist_enabled: true, total_events: 0, received_packets: 0,
    stored_events: 0, dropped_unparsed: 0, denied_senders: 0,
    retention_last_run_at: null, retention_last_deleted: 0,
    retention_last_error: null, last_event_received_at: null,
    last_packet_at: null, last_packet_sender: null, last_stored_at: null,
    last_stored_sender: null, last_drop_at: null, last_drop_sender: null,
    last_drop_raw: null, last_denied_at: null, last_denied_sender: null,
  } }));
  await page.route("**/api/v1/syslog/events*", (route) => route.fulfill({ json: { retention_days: 7, total: 0, offset: 0, limit: 100, events: [] } }));
  await page.route("**/api/v1/syslog/searches", (route) => route.fulfill({ json: [] }));
  const stream: Stream = { sockets: [], tokens: [], refreshes: 0, logouts: 0 };
  await page.routeWebSocket((url) => url.pathname === "/api/v1/syslog/events/live", (socket) => {
    stream.sockets.push(socket);
    let authenticated = false;
    socket.onMessage((message) => {
      if (authenticated) {
        if (message === "ping") socket.send(JSON.stringify({ type: "heartbeat" }));
        return;
      }
      authenticated = true;
      stream.tokens.push(String(message));
      socket.send(JSON.stringify({ type: "ready" }));
    });
  });
  await page.route("**/api/v1/auth/logout", async (route) => {
    stream.logouts += 1;
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/security");
  await page.locator(".security-layout").waitFor({ state: "visible" });
  await expect.poll(() => stream.tokens).toEqual([initialToken]);
  return stream;
}

async function refreshWith(page: Page, stream: Stream, respond: { status?: number; json: unknown }) {
  await page.route("**/api/v1/auth/refresh", async (route) => {
    stream.refreshes += 1;
    await route.fulfill(respond);
  });
}

test("a 1008 close refreshes the token and reconnects with the new one", async ({ page }) => {
  const stream = await openSecurity(page);
  await refreshWith(page, stream, { json: { ...mockTokenPair, access_token: "rotated-token" } });
  await stream.sockets[0].close({ code: POLICY_VIOLATION, reason: "Token expired" });
  await expect.poll(() => stream.tokens).toEqual([mockTokenPair.access_token, "rotated-token"]);
  expect(stream.refreshes).toBe(1);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign In" })).toHaveCount(0);
});

test("a 1008 close whose refresh is rejected ends the session instead of retrying", async ({ page }) => {
  const stream = await openSecurity(page);
  await refreshWith(page, stream, { status: 401, json: { detail: "Session revoked" } });
  await stream.sockets[0].close({ code: POLICY_VIOLATION, reason: "Token expired" });
  await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
  await expect(page.locator(".error-banner")).toHaveText("Session expired. Sign in again.");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  // Longer than the first backoff: nothing reconnects with the dead token.
  await page.waitForTimeout(2500);
  expect(stream.sockets).toHaveLength(1);
  expect(stream.tokens).toEqual([mockTokenPair.access_token]);
  expect(stream.logouts).toBe(1);
});

test("a 1008 close keeps the stream retrying while the refresh fails transiently", async ({ page }) => {
  const stream = await openSecurity(page);
  await refreshWith(page, stream, { status: 503, json: { detail: "Service unavailable" } });
  await stream.sockets[0].close({ code: POLICY_VIOLATION, reason: "Token expired" });
  await expect.poll(() => stream.refreshes).toBe(1);
  await refreshWith(page, stream, { json: { ...mockTokenPair, access_token: "rotated-token" } });
  await expect.poll(() => stream.tokens, { timeout: 8000 }).toEqual([mockTokenPair.access_token, "rotated-token"]);
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("other close codes reconnect with the same token and no refresh", async ({ page }) => {
  const stream = await openSecurity(page);
  await refreshWith(page, stream, { json: { ...mockTokenPair, access_token: "rotated-token" } });
  await stream.sockets[0].close({ code: 1011, reason: "Simulated stream outage" });
  await expect.poll(() => stream.tokens).toEqual([mockTokenPair.access_token, mockTokenPair.access_token]);
  expect(stream.refreshes).toBe(0);
});

test("an expired in-memory token is refreshed before any reconnect", async ({ page }) => {
  const stale = jwt(-60);
  const stream = await openSecurity(page, stale);
  await refreshWith(page, stream, { json: { ...mockTokenPair, access_token: "rotated-token" } });
  await stream.sockets[0].close({ code: 1011, reason: "Laptop slept" });
  await expect.poll(() => stream.tokens).toEqual([stale, "rotated-token"]);
  expect(stream.refreshes).toBe(1);
});

test("a token with time left is reused on reconnect", async ({ page }) => {
  const fresh = jwt(3600);
  const stream = await openSecurity(page, fresh);
  await refreshWith(page, stream, { json: { ...mockTokenPair, access_token: "rotated-token" } });
  await stream.sockets[0].close({ code: 1011, reason: "Simulated stream outage" });
  await expect.poll(() => stream.tokens).toEqual([fresh, fresh]);
  expect(stream.refreshes).toBe(0);
});

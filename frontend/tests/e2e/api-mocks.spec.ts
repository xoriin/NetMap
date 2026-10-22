import { expect, test } from "@playwright/test";
import { setupCoreMocks } from "./helpers/api-mocks";
import { ApiMockGuard } from "./helpers/api-guard";

test("shared bootstrap reads are mocked without a backend", async ({ page }) => {
  await setupCoreMocks(page);
  await page.route("**/fixture-check", route => route.fulfill({ contentType: "text/html", body: "Fixture check" }));
  await page.goto("/fixture-check");
  const responses = await page.evaluate(async () => {
    const paths = ["admin/device-types", "monitoring/summary"];
    return Promise.all(paths.map(async path => {
      const response = await fetch(`/api/v1/${path}`);
      return { path, status: response.status, body: await response.json().catch(() => null) };
    }));
  });
  expect(responses.map(({ status }) => status)).toEqual([200, 200]);
  expect(responses[0].body).toEqual(expect.arrayContaining([expect.objectContaining({ value: "router" })]));
  expect(responses[1].body).toMatchObject({ total: 0, online: 0, offline: 0 });
  const messages = await page.evaluate(() => new Promise<string[]>(resolve => {
    const socket = new WebSocket(`${location.origin.replace("http", "ws")}/api/v1/syslog/events/live`);
    const received: string[] = [];
    socket.onopen = () => socket.send("mock-access-token");
    socket.onmessage = event => {
      received.push(JSON.parse(event.data).type);
      if (received.length === 1) socket.send("ping");
      else { socket.close(); resolve(received); }
    };
  }));
  expect(messages).toEqual(["ready", "heartbeat"]);
});

test("unmocked reads and writes fail the guard while explicit mocks take precedence", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const guard = new ApiMockGuard();
  try {
    await guard.install(context);
    await guard.install(context);
    const page = await context.newPage();
    await page.route("**/fixture-check", route => route.fulfill({ contentType: "text/html", body: "Fixture check" }));
    await page.route("**/api/v1/known", route => route.fulfill({ json: { mocked: true } }));
    await page.goto("/fixture-check");
    expect(await page.evaluate(async () => (await fetch("/api/v1/known")).json())).toEqual({ mocked: true });
    guard.assertComplete();
    const statuses = await page.evaluate(async () => Promise.all([
      fetch("/api/v1/missing?check=1"),
      fetch("/api/v1/admin/device-types", { method: "POST" }),
    ].map(async response => (await response).status)));
    expect(statuses).toEqual([501, 501]);
    expect(() => guard.assertComplete()).toThrow(/GET \/api\/v1\/missing\?check=1/);
    expect(() => guard.assertComplete()).toThrow(/POST \/api\/v1\/admin\/device-types/);
    expect(await page.evaluate(() => new Promise<number>(resolve => {
      const socket = new WebSocket(`${location.origin.replace("http", "ws")}/api/v1/missing-stream`);
      socket.onclose = event => resolve(event.code);
    }))).toBe(1008);
    expect(() => guard.assertComplete()).toThrow(/WEBSOCKET \/api\/v1\/missing-stream/);
  } finally {
    await context.close();
  }
});

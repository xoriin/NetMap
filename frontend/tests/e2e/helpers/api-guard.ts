import { expect, test, type BrowserContext, type TestInfo } from "@playwright/test";

/** Last-resort failure for requests that escaped the scenario's explicit mocks. */
export class ApiMockGuard {
  private readonly contexts = new WeakSet<BrowserContext>();
  private readonly unexpected = new Set<string>();

  async install(context: BrowserContext) {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    // Page routes take precedence over context routes, including mocks added
    // after setupCoreMocks. The guard never fabricates a successful response.
    await context.route(url => url.pathname.startsWith("/api/"), async route => {
      const request = route.request();
      const url = new URL(request.url());
      const description = `${request.method()} ${url.pathname}${url.search}`;
      this.unexpected.add(description);
      await route.fulfill({ status: 501, json: { detail: `Unmocked API request: ${description}` } });
    });
    await context.routeWebSocket(url => url.pathname.startsWith("/api/"), async socket => {
      const url = new URL(socket.url());
      this.unexpected.add(`WEBSOCKET ${url.pathname}${url.search}`);
      await socket.close({ code: 1008, reason: "Unmocked API WebSocket" });
    });
  }

  assertComplete() {
    expect([...this.unexpected].sort(), "Unexpected API requests: add explicit endpoint mocks").toEqual([]);
  }
}

const guards = new WeakMap<TestInfo, ApiMockGuard>();

export async function guardApiRequests(context: BrowserContext) {
  const info = test.info();
  let guard = guards.get(info);
  if (!guard) {
    guard = new ApiMockGuard();
    guards.set(info, guard);
  }
  await guard.install(context);
}

// Covers all contexts registered by the shared mocks, including secondary
// viewer windows, without changing the suite's Playwright config or imports.
test.afterEach(({}, info) => guards.get(info)?.assertComplete());

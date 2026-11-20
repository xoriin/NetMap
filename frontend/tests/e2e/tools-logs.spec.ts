import { expect, test, type Page, type Request } from "@playwright/test";
import { mockUser, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;

type Entry = {
  id: number;
  timestamp: string;
  level: string;
  logger: string;
  source: string;
  message: string;
  exception: string | null;
};

function iso(secondsAgo: number) {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d+Z$/, ".000Z");
}

function entry(row: Partial<Entry> & Pick<Entry, "id" | "message">): Entry {
  return {
    timestamp: iso(row.id),
    level: "INFO",
    logger: "app.api.v1.app_logs",
    source: "api",
    exception: null,
    ...row,
  };
}

function pageOf(rows: Entry[], extra: Record<string, unknown> = {}) {
  const ids = rows.map((row) => row.id);
  const latest = ids.length ? Math.max(...ids) : 0;
  const oldest = ids.length ? Math.min(...ids) : null;
  return {
    entries: rows,
    order: "desc",
    count: rows.length,
    has_more: false,
    next_since_id: latest,
    next_before_id: null,
    oldest_id: oldest,
    latest_id: latest || null,
    capacity: 5000,
    dropped: 0,
    wrapped: false,
    gap: false,
    sources: ["api", "monitors"],
    loggers: ["app.api.v1.app_logs", "app.services.monitors"],
    levels: [...LEVELS],
    ...extra,
  };
}

function query(request: Request) {
  return new URL(request.url()).searchParams;
}

async function openTools(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("netmap.theme", "dark");
    localStorage.setItem("netmap.dark_style", "slate");
    localStorage.removeItem("netmap.tools.recent_v1");
    localStorage.removeItem("netmap.tools.saved_v1");
  });
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools");
  await page.locator(".tools-workspace").waitFor({ state: "visible" });
}

async function openLogs(page: Page) {
  await openTools(page);
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Logs", exact: true }).or(page.locator(".tool-panel-title", { hasText: "Logs" }))).toBeVisible();
}

test("the Logs tab is hidden after a 403", async ({ page }) => {
  await page.route("**/api/v1/tools/logs**", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", json: { detail: "System diagnostics access" } }),
  );
  await openTools(page);
  await expect(page.getByRole("tab", { name: "Logs", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Logs", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "DNS Lookup", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("filters are passed as query params", async ({ page }) => {
  const requests: URLSearchParams[] = [];
  const first = entry({ id: 2, message: "listener started", source: "api" });
  await page.route("**/api/v1/tools/logs**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    requests.push(query(route.request()));
    return route.fulfill({ json: pageOf([first]) });
  });
  await openLogs(page);
  await expect(page.getByText("listener started")).toBeVisible();
  const form = page.locator("form.tool-form");
  await form.getByRole("combobox", { name: "Level", exact: true }).selectOption("WARNING");
  await form.getByRole("combobox", { name: "Source", exact: true }).selectOption("api");
  await form.getByLabel("Text", { exact: true }).fill("timeout");
  await form.getByLabel("Since", { exact: true }).fill("2026-11-20T10:00");
  await form.getByLabel("Until", { exact: true }).fill("2026-11-20T11:00");
  const hasFilters = (params: URLSearchParams) =>
    params.get("level") === "WARNING"
    && params.get("source") === "api"
    && params.get("q") === "timeout"
    && (params.get("since") ?? "").endsWith("Z")
    && (params.get("until") ?? "").endsWith("Z");
  await expect.poll(() => requests.some(hasFilters)).toBe(true);
  const matched = requests.find(hasFilters)!;
  expect(matched.has("since_id")).toBe(false);
  expect(matched.has("before_id")).toBe(false);
  expect(new Date(matched.get("since")!).toISOString()).toBe(matched.get("since"));
  expect(new Date(matched.get("until")!).toISOString()).toBe(matched.get("until"));
});

test("polling appends new entries with since_id", async ({ page }) => {
  const seen: string[] = [];
  const first = [entry({ id: 2, message: "first line" }), entry({ id: 1, message: "older line" })];
  const newer = [entry({ id: 3, message: "fresh line", level: "WARNING", source: "monitors" })];
  await page.route("**/api/v1/tools/logs**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const params = query(route.request());
    const sinceId = params.get("since_id");
    seen.push(sinceId ?? "initial");
    if (sinceId === "2") return route.fulfill({ json: pageOf(newer, { next_since_id: 3, latest_id: 3 }) });
    return route.fulfill({ json: pageOf(first, { next_since_id: 2, latest_id: 2, oldest_id: 1 }) });
  });
  await openLogs(page);
  await expect(page.getByText("first line")).toBeVisible();
  await expect(page.getByText("fresh line")).toBeVisible({ timeout: 8000 });
  expect(seen).toContain("2");
});

test("has_more on a poll refetches immediately", async ({ page }) => {
  const polls: { sinceId: string; at: number }[] = [];
  const started = Date.now();
  await page.route("**/api/v1/tools/logs**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const sinceId = query(route.request()).get("since_id");
    if (!sinceId) {
      return route.fulfill({ json: pageOf([entry({ id: 2, message: "seed" })], { next_since_id: 2 }) });
    }
    polls.push({ sinceId, at: Date.now() - started });
    if (sinceId === "2") {
      return route.fulfill({
        json: pageOf([entry({ id: 3, message: "batch one" })], { has_more: true, next_since_id: 3, latest_id: 4 }),
      });
    }
    return route.fulfill({ json: pageOf([entry({ id: 4, message: "batch two" })], { next_since_id: 4, latest_id: 4 }) });
  });
  await openLogs(page);
  await expect(page.getByText("seed")).toBeVisible();
  await expect(page.getByText("batch two")).toBeVisible({ timeout: 8000 });
  const first = polls.find((item) => item.sinceId === "2");
  const second = polls.find((item) => item.sinceId === "3");
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(second!.at - first!.at).toBeLessThan(1500);
});

test("a gap response shows the dropped-entries notice", async ({ page }) => {
  await page.route("**/api/v1/tools/logs**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const sinceId = query(route.request()).get("since_id");
    if (sinceId) {
      return route.fulfill({
        json: pageOf([entry({ id: 10, message: "after wrap" })], { gap: true, dropped: 8, wrapped: true, next_since_id: 10, latest_id: 10 }),
      });
    }
    return route.fulfill({ json: pageOf([entry({ id: 2, message: "before wrap" })], { next_since_id: 2 }) });
  });
  await openLogs(page);
  await expect(page.getByText("before wrap")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Some entries were dropped", { timeout: 8000 });
});

test("Load older requests before_id", async ({ page }) => {
  const seen: string[] = [];
  await page.route("**/api/v1/tools/logs**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const params = query(route.request());
    const beforeId = params.get("before_id");
    seen.push(beforeId ?? "initial");
    if (beforeId === "4") {
      return route.fulfill({
        json: pageOf([
          entry({ id: 3, message: "older three" }),
          entry({ id: 2, message: "older two" }),
        ], { has_more: false, next_before_id: null, next_since_id: 5, latest_id: 5, oldest_id: 2 }),
      });
    }
    return route.fulfill({
      json: pageOf([
        entry({ id: 5, message: "newest five" }),
        entry({ id: 4, message: "newer four" }),
      ], { has_more: true, next_before_id: 4, next_since_id: 5, latest_id: 5, oldest_id: 2 }),
    });
  });
  await openLogs(page);
  await expect(page.getByText("newest five")).toBeVisible();
  await page.getByRole("button", { name: "Load older", exact: true }).click();
  await expect(page.getByText("older two")).toBeVisible();
  expect(seen).toContain("4");
});

test("pause stops polling", async ({ page }) => {
  let sinceRequests = 0;
  await page.route("**/api/v1/tools/logs**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (query(route.request()).has("since_id")) sinceRequests += 1;
    return route.fulfill({ json: pageOf([entry({ id: 1, message: "steady" })], { next_since_id: 1 }) });
  });
  await openLogs(page);
  await expect(page.getByText("steady")).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  const atPause = sinceRequests;
  await page.waitForTimeout(4000);
  expect(sinceRequests).toBe(atPause);
});

test("an exception row expands to show the traceback", async ({ page }) => {
  const traceback = "Traceback (most recent call last):\n  File \"app.py\", line 1, in <module>\nRuntimeError: probe failed";
  await page.route("**/api/v1/tools/logs**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: pageOf([
        entry({ id: 2, message: "probe failed", level: "ERROR", exception: traceback }),
        entry({ id: 1, message: "listener started" }),
      ], { next_since_id: 2 }),
    });
  });
  await openLogs(page);
  const row = page.locator("details.dns-detail-row", { hasText: "probe failed" });
  await expect(row).toBeVisible();
  await expect(row.locator("pre")).toBeHidden();
  await row.locator("summary").click();
  await expect(row.locator("pre", { hasText: "RuntimeError: probe failed" })).toBeVisible();
});

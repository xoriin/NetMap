import { expect, test, type Page } from "@playwright/test";
import { setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

// The page clock starts here; scan timestamps are relative to it (with explicit offsets, as the API sends them).
const START = new Date("2026-10-26T10:00:00Z");
const at = (seconds: number) => new Date(START.getTime() + seconds * 1_000).toISOString().replace("Z", "+00:00");

const hosts = [
  { ip_address: "192.168.50.10", hostname: "nas-01", mac_address: null, vendor: null, os: null, status: "up", open_ports: [], existing_device_id: null, import_status: "new", proposed_updates: [] },
  { ip_address: "192.168.50.11", hostname: null, mac_address: null, vendor: null, os: null, status: "up", open_ports: [], existing_device_id: null, import_status: "new", proposed_updates: [] },
];

function scanRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 41, schedule_id: null, target: "192.168.50.0/24", scan_type: "ping", status: "queued",
    host_count: 254, result_count: 0, results: [], error: null,
    created_at: at(0), started_at: null, completed_at: null, progress: null,
    ...overrides,
  };
}

type ScanMock = { posts: number; gets: string[] };

/** POST answers with `post`; each GET answers with the next record in `polls` (the last one repeats). */
async function mockScans(page: Page, post: { status: number; json: unknown }, polls: Array<Record<string, unknown>>) {
  const calls: ScanMock = { posts: 0, gets: [] };
  await page.route(url => url.pathname.startsWith("/api/v1/discovery/scans"), route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === "POST" && pathname === "/api/v1/discovery/scans") {
      calls.posts += 1;
      return route.fulfill(post);
    }
    if (request.method() === "GET" && /^\/api\/v1\/discovery\/scans\/\d+$/.test(pathname)) {
      calls.gets.push(pathname);
      return route.fulfill({ json: polls[Math.min(calls.gets.length - 1, polls.length - 1)] });
    }
    return route.fallback();
  });
  return calls;
}

async function openScanModal(page: Page) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await setupInventoryMocks(page);
  await setupMonitoringMocks(page);
  await page.clock.install({ time: START });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/inventory#devices");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discover devices" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Target").fill("192.168.50.0/24");
  return dialog;
}

async function nextPoll(page: Page, calls: ScanMock, ms = 3_000) {
  const before = calls.gets.length;
  await page.clock.fastForward(ms);
  await expect.poll(() => calls.gets.length).toBeGreaterThan(before);
}

test("an async scan is polled from queued through running to completed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const calls = await mockScans(page, { status: 202, json: scanRecord() }, [
    scanRecord({ status: "running", started_at: at(1), progress: { done: 10, total: 254 } }),
    scanRecord({ status: "completed", started_at: at(1), completed_at: at(6), result_count: 2, results: hosts, progress: { done: 254, total: 254 } }),
  ]);
  const dialog = await openScanModal(page);
  await dialog.getByRole("button", { name: "Start scan" }).click();

  const status = dialog.getByRole("status");
  await expect(status).toContainText("Scan queued");
  await expect(dialog.getByRole("button", { name: "Scanning..." })).toBeDisabled();
  expect(calls.gets).toEqual([]);

  await nextPoll(page, calls);
  await expect(status).toContainText("Scanning network");
  await expect(status).toContainText("You can close this window; the scan keeps running.");
  await expect(status.locator(".scan-progress-detail")).toContainText(/10 of 254 addresses scanned · 0:0\d elapsed/);

  await nextPoll(page, calls);
  await expect(status).toHaveCount(0);
  await expect(dialog.locator(".scan-summary")).toContainText("hosts found from 254 target addresses · ping · completed");
  await expect(dialog.locator(".scan-row input[type=checkbox]:checked")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "Start scan" })).toBeEnabled();
  expect(calls.gets).toEqual(["/api/v1/discovery/scans/41", "/api/v1/discovery/scans/41"]);

  // Polling stopped at the terminal status.
  await page.clock.fastForward(10_000);
  await page.waitForTimeout(200);
  expect(calls.gets).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("polling backs off from 3 to 5 seconds after a minute", async ({ page }) => {
  const calls = await mockScans(page, { status: 202, json: scanRecord({ status: "running", started_at: at(0) }) }, [
    scanRecord({ status: "running", started_at: at(0), progress: { done: 20, total: 254 } }),
  ]);
  const dialog = await openScanModal(page);
  await dialog.getByRole("button", { name: "Start scan" }).click();
  await nextPoll(page, calls);
  await nextPoll(page, calls, 61_000);
  await expect(dialog.getByRole("status")).toContainText(/1:0\d elapsed/);
  const count = calls.gets.length;
  await page.clock.fastForward(3_500);
  await page.waitForTimeout(200);
  expect(calls.gets).toHaveLength(count);
  await nextPoll(page, calls, 2_000);
  expect(calls.gets).toHaveLength(count + 1);
});

test("a failed async scan shows its error", async ({ page }) => {
  const calls = await mockScans(page, { status: 202, json: scanRecord() }, [
    scanRecord({ status: "failed", started_at: at(1), completed_at: at(2), error: "Nmap discovery failed: exit status 1" }),
  ]);
  const dialog = await openScanModal(page);
  await dialog.getByRole("button", { name: "Start scan" }).click();
  await expect(dialog.getByRole("status")).toContainText("Scan queued");
  await nextPoll(page, calls);
  await expect(dialog.locator(".nm-alert--error")).toHaveText("Nmap discovery failed: exit status 1");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Start scan" })).toBeEnabled();
});

test("a 409 attaches to the scan that is already running", async ({ page }) => {
  const calls = await mockScans(page, { status: 409, json: { detail: "A manual discovery scan is already running", scan_id: 77 } }, [
    scanRecord({ id: 77, target: "10.0.0.0/24", scan_type: "basic_ports", status: "running", started_at: at(-30), progress: { done: 100, total: 254 } }),
    scanRecord({ id: 77, target: "10.0.0.0/24", scan_type: "basic_ports", status: "completed", started_at: at(-30), completed_at: at(3), result_count: 2, results: hosts }),
  ]);
  const dialog = await openScanModal(page);
  await dialog.getByRole("button", { name: "Start scan" }).click();
  const status = dialog.getByRole("status");
  await expect(status).toContainText("A scan of 10.0.0.0/24 was already running, so this shows its progress instead of starting another.");
  await expect(status).toContainText("Running basic port detection.");
  await expect(status).toContainText(/100 of 254 addresses scanned · 0:3\d elapsed/);
  await expect(dialog.locator(".nm-alert--error")).toHaveCount(0);
  await nextPoll(page, calls);
  await expect(dialog.locator(".scan-summary")).toContainText("basic_ports · completed");
  expect(calls.posts).toBe(1);
  expect(new Set(calls.gets)).toEqual(new Set(["/api/v1/discovery/scans/77"]));
});

test("closing the modal stops polling", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", message => { if (message.type() === "error" || message.type() === "warning") warnings.push(message.text()); });
  page.on("pageerror", error => warnings.push(error.message));
  const calls = await mockScans(page, { status: 202, json: scanRecord() }, [scanRecord({ status: "running", started_at: at(1) })]);
  const dialog = await openScanModal(page);
  await dialog.getByRole("button", { name: "Start scan" }).click();
  await nextPoll(page, calls);
  await expect(dialog.getByRole("status")).toContainText("Scanning network");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  const count = calls.gets.length;
  for (let i = 0; i < 3; i += 1) await page.clock.fastForward(5_000);
  await page.waitForTimeout(300);
  expect(calls.gets).toHaveLength(count);
  expect(warnings).toEqual([]);
});

test("the synchronous scan response still works without polling", async ({ page }) => {
  // Today's backend: 201 with a finished scan and no started_at/progress fields.
  const legacy = { id: 9, schedule_id: null, target: "192.168.50.0/24", scan_type: "ping", status: "completed", host_count: 254, result_count: 2, results: hosts, error: null, created_at: at(0), completed_at: at(4) };
  const calls = await mockScans(page, { status: 201, json: legacy }, []);
  const dialog = await openScanModal(page);
  await dialog.getByRole("button", { name: "Start scan" }).click();
  await expect(dialog.locator(".scan-summary")).toContainText("hosts found from 254 target addresses · ping · completed");
  await expect(dialog.locator(".scan-row input[type=checkbox]:checked")).toHaveCount(2);
  await page.clock.fastForward(10_000);
  await page.waitForTimeout(200);
  expect(calls.gets).toEqual([]);
});

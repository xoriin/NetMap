import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

// The endpoint overview popup must show new poll results while it stays open.
test("the endpoint popup refreshes its history while open", async ({ page }) => {
  await page.clock.install();
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
  const point = (i: number, status = "online") => ({
    id: i + 1, checked_at: new Date(end - (23 - i) * 120_000).toISOString(), status,
    response_time_ms: status === "online" ? 100 + (i % 6) * 20 : null, status_code: status === "online" ? 200 : 503,
    error: status === "online" ? null : "Service unavailable", assertion_detail: null, response_size_bytes: 2048, cert_expires_at: null,
  });
  let history = Array.from({ length: 24 }, (_, i) => point(i));
  let historyCalls = 0;
  await page.route("**/api/v1/monitors", (route) => route.fulfill({ json: [monitor] }));
  await page.route("**/api/v1/monitors/1/history?*", (route) => { historyCalls += 1; return route.fulfill({ json: history }); });
  await page.goto("/monitoring#endpoints");
  await page.locator(".monitors-table tbody tr").first().click();
  const popup = page.getByRole("dialog", { name: "Google monitor overview" });
  const beats = popup.locator(".heartbeat-bar--lg .heartbeat-beat");
  await expect(beats).toHaveCount(24);
  await expect(popup).toContainText("24 loaded");
  await expect(popup).toContainText("24 data points");
  const callsAtOpen = historyCalls;

  // A new (failed) check lands; the next poll must bring it into the open popup.
  history = [...history, point(24, "offline")];
  await page.clock.runFor(31_000);
  expect(historyCalls).toBeGreaterThan(callsAtOpen);
  await expect(popup).toContainText("25 loaded");
  await expect(popup).toContainText("25 data points");
  await expect(beats).toHaveCount(25);
  await expect(popup.locator(".monitor-http-history-row").first()).toContainText("Service unavailable");
});

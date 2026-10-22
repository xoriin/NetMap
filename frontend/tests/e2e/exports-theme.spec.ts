import { expect, test, type Page } from "@playwright/test";
import { mockUser, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function setupExports(page: Page, theme: "light" | "dark") {
  await setupCoreMocks(page, "Maintenance window tonight");
  await setupTopologyMocks(page);
  await page.route("**/api/v1/exports/summary", (route) => route.fulfill({ json: {
    inventory_rows: 85,
    firewall_events: 1247,
    exports_last_30_days: 12,
    last_export_at: "2026-08-01T10:05:00Z",
    last_export_type: "Firewall events",
    last_export_detail: "format=csv rows=5000",
  } }));
  await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
  await page.goto("/exports");
  await page.locator(".exports-layout").waitFor({ state: "visible" });
}

for (const theme of ["light", "dark"] as const) {
  test(`Exports uses the approved operational panels in ${theme} mode`, async ({ page }) => {
    await setupExports(page, theme);

    await expect(page.locator(".exports-summary-card")).toHaveCount(4);
    await expect(page.locator(".exports-summary-grid")).toContainText("Inventory rows");
    await expect(page.locator(".exports-summary-grid")).toContainText("85");
    await expect(page.locator(".exports-summary-grid")).toContainText("1,247");
    await expect(page.locator(".exports-summary-grid")).toContainText("Firewall events");
    await expect(page.locator(".exports-panel")).toHaveCount(3);
    await expect(page.locator(".exports-panel").first()).toHaveCSS("background-image", "none");
    await expect(page.locator(".exports-panel-header")).toHaveCount(3);
    await expect(page.locator(".exports-panel-header").nth(0)).toContainText("Device inventory");
    await expect(page.locator(".exports-panel-header").nth(1)).toContainText("Network report");
    await expect(page.locator(".exports-panel-header").nth(2)).toContainText("Firewall events");
    await expect(page.locator(".exports-panel-header").first()).toHaveCSS("min-height", "44px");
    await expect(page.locator(".exports-panel .nm-input").first()).toHaveCSS("background-color", theme === "dark" ? "rgb(2, 6, 23)" : "rgb(254, 254, 254)");
  });
}

test("Firewall export keeps filters useful and sends them to the existing API", async ({ page }) => {
  await page.route("**/api/v1/exports/firewall?*", (route) => route.fulfill({
    body: "received_at,src_ip,dst_ip\n",
    contentType: "text/csv",
    headers: { "content-disposition": "attachment; filename=firewall-events.csv" },
  }));
  await setupExports(page, "dark");

  await page.getByLabel("Source IP").fill("10.0.0.1");
  await page.getByLabel("Action").fill("block");
  await expect(page.locator(".exports-filter-summary")).toContainText("2 active filters");
  const requestPromise = page.waitForRequest((request) => request.url().includes("/api/v1/exports/firewall?"));
  await page.getByRole("button", { name: "Download firewall export" }).click();
  const request = await requestPromise;
  expect(request.url()).toContain("src_ip=10.0.0.1");
  expect(request.url()).toContain("action=block");
  expect(request.url()).toContain("limit=5000");
});

test("Exports reflows without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await setupExports(page, "dark");
  const widths = await page.locator(".exports-layout").evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await expect(page.locator(".exports-console-grid")).toHaveCSS("grid-template-columns", /.+/);
});

test("only the exports a role may run are shown, with no access chips", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ...mockUser, role: "SecurityAnalyst", permissions: ["security_view", "tools_passive", "firewall_export"] } }));
  await page.route("**/api/v1/exports/summary", (route) => route.fulfill({ json: { inventory_rows: 0, firewall_events: 10, exports_last_30_days: 0, last_export_at: null, last_export_type: null, last_export_detail: null } }));
  await page.goto("/exports");
  await page.locator(".exports-layout").waitFor({ state: "visible" });
  await expect(page.locator(".exports-panel")).toHaveCount(1);
  await expect(page.locator(".exports-panel")).toContainText("Firewall events");
  await expect(page.locator(".exports-console-grid")).toHaveClass(/exports-console-grid--single/);
  await expect(page.getByText(/Allowed|Restricted|Your role cannot/)).toHaveCount(0);
  const panel = await page.locator(".exports-panel").boundingBox();
  const grid = await page.locator(".exports-console-grid").boundingBox();
  expect(Math.abs(panel!.width - grid!.width)).toBeLessThanOrEqual(1);
});

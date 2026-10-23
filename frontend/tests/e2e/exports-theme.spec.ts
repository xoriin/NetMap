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
    await expect(page.locator(".exports-panel .nm-input").first()).toHaveCSS("background-color", theme === "dark" ? "rgb(18, 22, 36)" : "rgb(254, 254, 254)");
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

for (const theme of ["light", "slate", "zinc"] as const) {
  test(`Exports keeps tasks readable beside useful context in ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) => errors.push(request.url()));
    await page.addInitScript((style) => localStorage.setItem("netmap.dark_style", style), theme === "zinc" ? "zinc" : "slate");
    await page.setViewportSize({ width: 2560, height: 1200 });
    await setupExports(page, theme === "light" ? "light" : "dark");
    const layout = page.locator(".exports-layout");
    expect((await layout.boundingBox())!.width).toBeLessThanOrEqual(1440);
    await expect(page.getByRole("complementary", { name: "Export information" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Choose a format" })).toBeVisible();
    await expect(page.locator(".exports-format-guide")).toContainText("CSV");
    await expect(page.locator(".exports-format-guide")).toContainText("JSON");
    await expect(page.locator(".exports-format-guide")).toContainText("PDF");
    for (const width of [2560, 1440, 1100, 820, 430, 320]) {
      await page.setViewportSize({ width, height: 1200 });
      const overflow = await layout.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const tasks = (await page.locator(".exports-console-grid").boundingBox())!;
      const context = (await page.locator(".exports-context").boundingBox())!;
      const informationPanels = page.locator(".exports-context > .nm-panel");
      const activity = (await informationPanels.first().boundingBox())!;
      const guide = (await informationPanels.last().boundingBox())!;
      if (width > 760 && width < 1201) expect(guide.x - activity.x - activity.width).toBeCloseTo(16, 0);
      else expect(guide.y - activity.y - activity.height).toBeCloseTo(16, 0);
      if (width >= 1440) {
        expect(context.x).toBeGreaterThan(tasks.x + tasks.width);
        expect(tasks.width).toBeLessThanOrEqual(1104);
      } else {
        expect(context.y).toBeGreaterThan(tasks.y + tasks.height);
      }
      await page.screenshot({ path: `/tmp/exports-${theme}-${width}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  });
}

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
  await expect(page.locator(".exports-format-guide")).not.toContainText("PDF");
  await expect(page.locator(".exports-console-grid")).toHaveClass(/exports-console-grid--single/);
  await expect(page.getByText(/Allowed|Restricted|Your role cannot/)).toHaveCount(0);
  const panel = await page.locator(".exports-panel").boundingBox();
  const grid = await page.locator(".exports-console-grid").boundingBox();
  expect(Math.abs(panel!.width - grid!.width)).toBeLessThanOrEqual(1);
});

test("inventory and report downloads still work, with visible errors and retry", async ({ page }) => {
  let fail = true;
  let release: (() => void) | undefined;
  await page.route("**/api/v1/exports/inventory?*", async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 500, json: { detail: "Export is temporarily unavailable" } });
    } else {
      await new Promise<void>((resolve) => { release = resolve; });
      await route.fulfill({ body: "[]", contentType: "application/json", headers: { "content-disposition": "attachment; filename=inventory.json" } });
    }
  });
  await page.route("**/api/v1/exports/report.pdf", (route) => route.fulfill({ body: "%PDF-1.4", contentType: "application/pdf", headers: { "content-disposition": "attachment; filename=report.pdf" } }));
  await setupExports(page, "dark");
  const inventory = page.locator(".exports-panel").filter({ hasText: "Device inventory" });
  await inventory.getByRole("combobox").selectOption("json");
  await inventory.getByRole("button", { name: "Download inventory" }).click();
  await expect(page.locator(".form-error")).toContainText("Export is temporarily unavailable");
  await inventory.getByRole("button", { name: "Download inventory" }).click();
  await expect(inventory.getByRole("button", { name: "Preparing…" })).toBeDisabled();
  await expect.poll(() => typeof release).toBe("function");
  const download = page.waitForEvent("download");
  release!();
  expect((await download).suggestedFilename()).toBe("inventory.json");
  await expect(page.locator(".form-error")).toHaveCount(0);
  const report = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF report" }).click();
  expect((await report).suggestedFilename()).toBe("report.pdf");
});

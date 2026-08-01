import { expect, test, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function setupTools(page: Page, theme: "light" | "dark") {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/admin/snmp-profiles", (route) => route.fulfill({ json: [] }));
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("netmap.theme", selectedTheme);
    if (!window.sessionStorage.getItem("netmap.tools.test-ready")) {
      window.localStorage.removeItem("netmap.tools.recent_v1");
      window.localStorage.removeItem("netmap.tools.saved_v1");
      window.sessionStorage.setItem("netmap.tools.test-ready", "1");
    }
  }, theme);
  await page.goto("/tools");
  await page.locator(".tools-workspace").waitFor({ state: "visible", timeout: 8000 });
}

for (const theme of ["light", "dark"] as const) {
  test(`Tools uses the approved integrated operational window in ${theme} mode`, async ({ page }) => {
    await setupTools(page, theme);

    const window = page.locator(".tools-content");
    await expect(window).toHaveCSS("background-image", "none");
    await expect(page.locator(".tools-summary-card")).toHaveCount(4);
    await expect(page.locator(".tools-library-item")).toHaveCount(0);
    await expect(page.locator(".tools-activity")).toBeVisible();
    await expect(page.locator(".tools-saved")).toBeVisible();
    await expect(page.locator(".tools-guide")).toContainText("How DNS Lookup works");
    await expect(page.locator("html")).toHaveCSS("background-color", theme === "dark" ? "rgb(12, 17, 24)" : "rgb(232, 238, 243)");
    if (theme === "dark") await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");

    const dnsPanel = page.locator(".tool-card");
    await expect(page.getByRole("tablist", { name: "Network tools" })).toHaveClass(/nm-workspace-tabs--attached/);
    await expect(page.getByRole("tab", { name: "DNS Lookup" })).toHaveAttribute("aria-selected", "true");
    const inactiveTab = page.getByRole("tab", { name: "Reverse DNS" });
    await expect(inactiveTab).toHaveCSS("border-top-width", "1px");
    await expect(inactiveTab).toHaveCSS("border-left-width", "1px");
    await expect(inactiveTab).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await expect(dnsPanel).toHaveCSS("background-image", "none");
    await expect(dnsPanel).toHaveCSS("border-top-width", "0px");
    const [stageBox, panelBox, headerBox] = await Promise.all([
      window.boundingBox(),
      dnsPanel.boundingBox(),
      dnsPanel.locator(".tool-card-header").boundingBox(),
    ]);
    expect(stageBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(Math.abs(stageBox!.width - panelBox!.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(panelBox!.width - headerBox!.width)).toBeLessThanOrEqual(1);
    await expect(dnsPanel.locator(".tool-card-header")).toHaveCSS("min-height", "44px");
    await expect(dnsPanel.locator(".tool-panel-identity")).toContainText("DNS lookup");
    await expect(dnsPanel.locator("input")).toHaveCSS("background-color", theme === "dark" ? "rgb(10, 21, 32)" : "rgb(255, 255, 255)");

    await page.getByRole("tab", { name: "Ping Test" }).click();
    await expect(page.getByRole("tab", { name: "Ping Test" })).toHaveClass(/tools-nav-item--active/);
    await expect(page.locator(".tool-panel-title")).toHaveText("Ping test");
    await expect(page.getByRole("button", { name: "Ping", exact: true })).toHaveClass(/nm-btn--primary/);
    await expect(page.getByRole("button", { name: "Ping", exact: true })).toBeInViewport();
    await expect(page.locator(".tools-guide")).toContainText("How Ping Test works");
  });
}

test("Tools tabs stay attached and scroll horizontally on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await setupTools(page, "dark");

  await expect(page.locator(".tools-nav")).toHaveCSS("flex-direction", "row");
  const [tabsBox, stageBox] = await Promise.all([
    page.locator(".tools-nav").boundingBox(),
    page.locator(".tools-content").boundingBox(),
  ]);
  expect(tabsBox).not.toBeNull();
  expect(stageBox).not.toBeNull();
  expect(Math.abs((tabsBox!.y + tabsBox!.height) - stageBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(tabsBox!.x - stageBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(tabsBox!.width - stageBox!.width)).toBeLessThanOrEqual(1);
  const moduleBox = await page.locator(".tool-card").boundingBox();
  expect(moduleBox).not.toBeNull();
  expect(Math.abs(moduleBox!.x - stageBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(moduleBox!.y - stageBox!.y)).toBeLessThanOrEqual(1);
  // The module sits inside the stage's one-pixel border on each side.
  expect(Math.abs(moduleBox!.width - stageBox!.width)).toBeLessThanOrEqual(2);
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
});

test("Tools records real activity and saves reusable results", async ({ page }) => {
  await page.route("**/api/v1/tools/dns", (route) => route.fulfill({
    json: {
      queried_name: "example.com",
      record_type: "A",
      records: [{ value: "93.184.216.34", ttl: 300 }],
      source: "system resolver",
      dns_server: "1.1.1.1",
      response_code: "NOERROR",
      canonical_name: "example.com",
      duration_ms: 18,
    },
  }));
  await setupTools(page, "dark");

  await page.getByLabel("Query", { exact: true }).fill("example.com");
  await page.getByRole("button", { name: "Lookup", exact: true }).click();
  await expect(page.locator(".dns-result-workspace")).toContainText("93.184.216.34");
  await expect(page.locator(".dns-summary-grid")).toContainText("1.1.1.1");
  await expect(page.locator(".dns-summary-grid")).toContainText("NOERROR");
  await expect(page.locator(".dns-answer-table")).toContainText("300s");
  await expect(page.locator(".dns-recent-panel")).toContainText("example.com");
  await expect(page.locator(".tools-activity")).toContainText("example.com");
  await expect(page.locator(".tools-activity")).toContainText("1 A record");

  await page.getByRole("button", { name: "Save DNS Lookup result" }).click();
  await expect(page.locator(".tools-saved")).toContainText("example.com");
  await expect(page.locator(".tools-summary-card").nth(2)).toContainText("1");

  await page.reload();
  await page.locator(".tools-workspace").waitFor({ state: "visible" });
  await expect(page.locator(".tools-saved")).toContainText("example.com");
});

test("Tools keeps every desktop tab visible and sizes the module to its content", async ({ page }) => {
  await page.setViewportSize({ width: 876, height: 1145 });
  await setupTools(page, "dark");
  await page.getByRole("tab", { name: "Ping Test" }).click();

  const geometry = await page.evaluate(() => {
    const tabs = document.querySelector<HTMLElement>(".tools-nav")?.getBoundingClientRect();
    const lastTab = document.querySelector<HTMLElement>(".tools-nav-item:last-child")?.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>(".tools-content")?.getBoundingClientRect();
    const card = document.querySelector<HTMLElement>(".tool-card")?.getBoundingClientRect();
    if (!tabs || !lastTab || !stage || !card) return null;
    return {
      lastTabRight: lastTab.right,
      tabsRight: tabs.right,
      stageHeight: stage.height,
      stageCardBottomGap: stage.bottom - card.bottom,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry!.lastTabRight).toBeLessThanOrEqual(geometry!.tabsRight + 1);
  expect(geometry!.stageHeight).toBeLessThan(420);
  expect(Math.abs(geometry!.stageCardBottomGap)).toBeLessThanOrEqual(1);
});

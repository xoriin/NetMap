import { expect, test, type Page } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupInventoryMocks, setupTopologyMocks } from "./helpers/api-mocks";

const breaking = { id: "v2-postgres", severity: "breaking", title: "NetMap 2.0 moves to PostgreSQL", message: "Back up before upgrading.", link: "https://docs.netmap.dev/upgrade", can_dismiss: false, can_acknowledge: true };
const info = { id: "tip", severity: "info", title: "New guide", message: "<b>Not bold</b> plain text.", link: null, can_dismiss: true, can_acknowledge: false };
const warning = { id: "watchtower", severity: "warning", title: "Pause auto-updates", message: "Hold Watchtower until 2.0 is out.", link: null, can_dismiss: true, can_acknowledge: false };

async function open(page: Page, route: string, notices: unknown[], theme: "light" | "dark" = "dark") {
  await setupCoreMocks(page);
  const devices = [mockDevice({ id: 1, hostname: "router-01" })];
  await setupTopologyMocks(page, devices);
  await setupInventoryMocks(page, devices);
  const calls: string[] = [];
  let current = [...notices];
  await page.route("**/api/v1/notices", (route) => route.fulfill({ json: current }));
  await page.route(/\/api\/v1\/notices\/[^/]+\/(dismiss|acknowledge)$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(`${route.request().method()} ${path}`);
    current = current.filter((n) => !path.includes(`/${(n as { id: string }).id}/`));
    return route.fulfill({ status: 204, body: "" });
  });
  await page.addInitScript((t) => localStorage.setItem("netmap.theme", t), theme);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(route);
  return calls;
}

test("notices show above the workspace and can be dismissed or acknowledged", async ({ page }) => {
  const calls = await open(page, "/overview", [breaking, warning, info]);
  const banner = (title: string) => page.getByRole(title === info.title ? "status" : "alert", { name: `Notice: ${title}` });
  await expect(banner(breaking.title)).toHaveClass(/nm-alert--error/);
  await expect(banner(breaking.title)).toHaveCSS("align-items", "center");
  await expect(banner(warning.title)).toHaveClass(/nm-alert--warning/);
  await expect(banner(info.title)).toHaveClass(/nm-alert--info/);
  await expect(banner(info.title)).toContainText("<b>Not bold</b> plain text.");
  await expect(banner(info.title).locator("b")).toHaveCount(0);
  const link = banner(breaking.title).getByRole("link", { name: "Read more" });
  await expect(link).toHaveAttribute("href", "https://docs.netmap.dev/upgrade");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(banner(breaking.title).getByRole("button", { name: "Dismiss" })).toHaveCount(0);

  await banner(info.title).getByRole("button", { name: "Dismiss" }).click();
  await expect(banner(info.title)).toHaveCount(0);
  await banner(breaking.title).getByRole("button", { name: "Acknowledge" }).click();
  await expect(banner(breaking.title)).toHaveCount(0);
  await expect(banner(warning.title)).toBeVisible();
  expect(calls).toEqual(["POST /api/v1/notices/tip/dismiss", "POST /api/v1/notices/v2-postgres/acknowledge"]);
});

for (const route of ["/inventory#devices", "/topology"]) {
  test(`notice banners keep the workspace gutters on ${route}`, async ({ page }) => {
    await open(page, route, [warning, info]);
    const banners = page.locator(".workspace-notice");
    await expect(banners).toHaveCount(2);
    const [first, second] = [await banners.nth(0).boundingBox(), await banners.nth(1).boundingBox()];
    const workspace = await page.locator(".workspace").boundingBox();
    expect(first!.x).toBeGreaterThan(workspace!.x);
    expect(first!.x).toBeCloseTo(second!.x, 0);
    expect(first!.width).toBeCloseTo(second!.width, 0);
    expect(second!.y - (first!.y + first!.height)).toBeLessThan(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}


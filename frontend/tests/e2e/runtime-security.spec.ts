import { expect, test, type Page } from "@playwright/test";
import { mockUser, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const warning = "Set AUTH_COOKIE_SECURE=true to mark sign-in cookies Secure. Recreate the container after changing its environment.";
const hstsWarning = "Set SECURE_HSTS_ENABLED=true once this hostname is served exclusively over HTTPS. Recreate the container after changing its environment.";

async function setup(page: Page) {
  await page.route("**/api/v1/**", route => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
}

for (const theme of ["light", "dark"]) {
  test(`security warning persists across routes and reloads in ${theme}`, async ({ page }) => {
    await setup(page);
    await page.addInitScript(theme => localStorage.setItem("netmap.theme", theme), theme);
    await page.route("**/api/v1/admin/runtime-security", route => route.fulfill({ json: { warnings: [warning, hstsWarning] } }));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/overview");
    const alert = page.getByRole("alert", { name: "Deployment security" });
    await expect(alert).toContainText("AUTH_COOKIE_SECURE=true");
    await expect(alert.getByRole("button")).toHaveCount(0);
    for (const route of ["Inventory", "Topology", "Monitoring", "Overview"]) {
      await page.getByRole("navigation").getByRole("link", { name: route, exact: true }).click();
      await expect(alert).toBeVisible();
    }
    await page.reload();
    await expect(alert).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `/tmp/netmap-security-${theme}-desktop.png` });
    for (const width of [1440, 700, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await alert.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      const style = await alert.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, fontSize: getComputedStyle(el).fontSize }));
      expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(style.fontSize).toBe("12px");
    }
    await page.screenshot({ path: `/tmp/netmap-security-${theme}-narrow.png` });
    expect(errors).toEqual([]);
  });
}

test("security warning stays on refresh errors and clears when compliant", async ({ page }) => {
  await setup(page);
  let state = "warning";
  await page.route("**/api/v1/admin/runtime-security", route => state === "error"
    ? route.fulfill({ status: 503, json: { detail: "Unavailable" } })
    : route.fulfill({ json: { warnings: state === "warning" ? [warning] : [] } }));
  await page.goto("/overview");
  const alert = page.getByRole("alert", { name: "Deployment security" });
  await expect(alert).toContainText(warning);
  state = "error";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(alert).toContainText("Unable to refresh");
  await expect(alert).toContainText(warning);
  state = "compliant";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(alert).toHaveCount(0);
});

test("security status is polled while the workspace stays open", async ({ page }) => {
  await setup(page);
  let count = 0;
  await page.route("**/api/v1/admin/runtime-security", route => {
    count += 1;
    return route.fulfill({ json: { warnings: count === 1 ? [warning] : [] } });
  });
  await page.clock.install();
  await page.goto("/overview");
  await expect(page.getByRole("alert", { name: "Deployment security" })).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect(page.getByRole("alert", { name: "Deployment security" })).toHaveCount(0);
  expect(count).toBeGreaterThanOrEqual(2);
});

test("non-administrators do not fetch deployment security status", async ({ page }) => {
  await setup(page);
  await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { ...mockUser, role: "Viewer" } }));
  let requests = 0;
  await page.route("**/api/v1/admin/runtime-security", route => { requests += 1; return route.fulfill({ json: { warnings: [warning] } }); });
  await page.goto("/overview");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByRole("alert", { name: "Deployment security" })).toHaveCount(0);
  expect(requests).toBe(0);
});

for (const theme of ["light", "dark"]) {
  test(`security and announcement banners keep their gutters in ${theme}`, async ({ page }) => {
    await setup(page);
    await setupCoreMocks(page, "Planned maintenance");
    await page.addInitScript(theme => localStorage.setItem("netmap.theme", theme), theme);
    await page.route("**/api/v1/admin/runtime-security", route => route.fulfill({ json: { warnings: [warning, hstsWarning] } }));
    for (const width of [1440, 700]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const path of ["/overview", "/inventory", "/topology", "/monitoring", "/ipam", "/security"]) {
        await page.goto(path);
        const alert = page.getByRole("alert", { name: "Deployment security" });
        const announcement = page.locator(".dash-alert--announcement");
        await expect(alert).toBeVisible();
        await expect(announcement).toBeVisible();
        const a = (await alert.boundingBox())!;
        const b = (await announcement.boundingBox())!;
        expect(a.x, path).toBeCloseTo(b.x, 0);
        expect(a.width, path).toBeCloseTo(b.width, 0);
        expect(b.y - a.y - a.height, path).toBeCloseTo(16, 0);
        const ancestors = await alert.evaluate(el => {
          const result = [];
          for (let node: Element | null = el; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            result.push({ class: node.className, width: node.getBoundingClientRect().width, min: style.minWidth, display: style.display, flex: style.flex });
          }
          return result;
        });
        expect(a.x + a.width, `${path}: ${JSON.stringify(ancestors)}`).toBeLessThanOrEqual(width);
      }
    }
  });
}

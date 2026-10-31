import { expect, test, type Page } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const routes = [
  "/inventory#devices",
  "/monitoring#devices",
  "/monitoring#endpoints",
  "/vlans",
  "/locations",
  "/security",
  "/admin#users",
];

const searchInputs = 'input[placeholder^="Search"], input[aria-label^="Search"]';

type SearchStyle = Record<string, string>;

async function setup(page: Page, theme: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/v1/**", route => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  const devices = [mockDevice({ id: 1, hostname: "router-01" })];
  await setupTopologyMocks(page, devices);
  await setupInventoryMocks(page, devices);
  await setupMonitoringMocks(page);
  await page.route("**/api/v1/syslog/status", route => route.fulfill({ json: { enabled: true, total_events: 0, retention_days: 7 } }));
  await page.route("**/api/v1/syslog/events*", route => route.fulfill({ json: { retention_days: 7, total: 0, offset: 0, limit: 100, events: [] } }));
  await page.addInitScript(value => {
    localStorage.setItem("netmap.theme", value === "light" ? "light" : "dark");
    localStorage.setItem("netmap.dark_style", value === "zinc" ? "zinc" : "slate");
  }, theme);
  await page.setViewportSize({ width: 1600, height: 1000 });
}

async function open(page: Page, route: string) {
  await page.goto(route);
  await expect(page.locator(searchInputs).first(), route).toBeVisible();
}

async function searchStyles(page: Page): Promise<Array<{ label: string; style: SearchStyle }>> {
  return page.locator(searchInputs).evaluateAll(inputs => inputs
    .filter(input => (input as HTMLElement).getClientRects().length > 0)
    .map(input => {
      const well = input.closest(".nm-search");
      const box = getComputedStyle(well ?? input);
      const field = getComputedStyle(input);
      const icon = well?.querySelector("svg");
      return {
        label: (input as HTMLInputElement).placeholder || input.getAttribute("aria-label") || "",
        style: {
          wrapped: String(Boolean(well)),
          borderColor: box.borderTopColor,
          borderWidth: box.borderTopWidth,
          background: box.backgroundColor,
          radius: box.borderTopLeftRadius,
          height: box.height,
          inputBackground: field.backgroundColor,
          inputBorder: field.borderTopWidth,
          fontSize: field.fontSize,
          color: field.color,
          icon: icon ? `${Math.round(icon.getBoundingClientRect().width)}` : "none",
        },
      };
    }));
}

for (const theme of ["light", "slate", "zinc"] as const) {
  test(`every workspace search box shares one style in ${theme}`, async ({ page }) => {
    const seen: Array<{ route: string; label: string; style: SearchStyle }> = [];
    await setup(page, theme);
    for (const route of routes) {
      await open(page, route);
      for (const entry of await searchStyles(page)) seen.push({ route, ...entry });
    }
    expect(routes.filter(route => !seen.some(entry => entry.route === route))).toEqual([]);
    if (process.env.SEARCH_DUMP) console.log(JSON.stringify(seen));
    const reference = seen[0].style;
    expect(reference.wrapped).toBe("true");
    expect(reference.inputBackground).toBe("rgba(0, 0, 0, 0)");
    expect(reference.inputBorder).toBe("0px");
    for (const entry of seen) {
      expect.soft(entry.style, `${entry.route} "${entry.label}"`).toEqual(reference);
    }
  });
}

test("search boxes show the shared hover border", async ({ page }) => {
  await setup(page, "light");
  for (const route of ["/inventory#devices", "/monitoring#devices"]) {
    await open(page, route);
    const well = page.locator(".nm-search").filter({ has: page.locator(searchInputs) }).first();
    const resting = await well.evaluate(element => getComputedStyle(element).borderTopColor);
    await well.hover();
    await expect.poll(() => well.evaluate(element => getComputedStyle(element).borderTopColor), { message: route }).not.toBe(resting);
  }
});

import { expect, test, type Page } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const groups = [
  { id: 1, name: "Servers", vlan_id: "20", ip_range: "10.30.20.0/24" },
  { id: 2, name: "Wi-Fi", vlan_id: "30", ip_range: "10.30.30.0/23" },
].map((group) => ({ ...group, display_name: group.name, gateway: null, dns_servers: null, description: "", color: null }));

const devices = [
  mockDevice({ id: 1, display_name: "Core Router", device_type: "router", topology_group: "Servers" }),
  mockDevice({ id: 2, display_name: "AP Lobby", device_type: "access_point", topology_group: "Wi-Fi" }),
];

async function boot(page: Page, style: "light" | "slate" | "zinc") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices, []);
  await setupMonitoringMocks(page, []);
  await page.route("**/api/v1/topology/groups*", (route) => route.fulfill({ json: groups }));
  await page.route("**/api/v1/monitors", (route) => route.fulfill({ json: [] }));
  await page.addInitScript((value) => {
    localStorage.setItem("netmap.theme", value === "light" ? "light" : "dark");
    localStorage.setItem("netmap.dark_style", value === "zinc" ? "zinc" : "slate");
  }, style);
}

async function fillWidths(page: Page, list: string) {
  const fills = page.getByRole("list", { name: list, exact: true }).locator(".nm-bar-list-track > i");
  await expect(fills.first()).toBeAttached();
  return fills.evaluateAll((items) => items.map((fill) => fill.getBoundingClientRect().width));
}

for (const style of ["light", "slate", "zinc"] as const) {
  test(`zero-total bar lists draw empty tracks in ${style}`, async ({ page }) => {
    await boot(page, style);
    await page.setViewportSize({ width: 1600, height: 1000 });

    await page.goto("/ipam");
    const ipam = await fillWidths(page, "Address Space");
    expect(ipam.length).toBeGreaterThan(0);
    for (const width of ipam) expect(width).toBe(0);
  });

  test(`insight header actions stay on one row beside the full title at 820px in ${style}`, async ({ page }) => {
    await boot(page, style);
    await page.setViewportSize({ width: 820, height: 1000 });
    await page.goto("/overview");

    const panel = page.getByRole("region", { name: "Top Groups", exact: true });
    const title = panel.locator(".nm-insight-title strong");
    await expect(title).toHaveText("Top Groups");
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    const manage = (await panel.getByRole("link", { name: /Manage/ }).boundingBox())!;
    const options = (await panel.getByRole("button", { name: /Visual options/ }).boundingBox())!;
    expect(Math.abs((manage.y + manage.height / 2) - (options.y + options.height / 2))).toBeLessThanOrEqual(2);
    expect(options.x).toBeGreaterThan(manage.x + manage.width);
  });
}

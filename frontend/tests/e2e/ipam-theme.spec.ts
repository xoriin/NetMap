import { expect, test, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const subnet = {
  id: 1,
  name: "Core network",
  cidr: "10.30.20.0/24",
  description: "Core infrastructure",
  vlan_id: "20",
  site_id: null,
  gateway: "10.30.20.1",
  dhcp_start: "10.30.20.100",
  dhcp_end: "10.30.20.150",
  dns_servers: "10.30.20.1",
  notes: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  total_hosts: 254,
  used: 4,
  free: 250,
  utilization: 4 / 254,
  device_count: 1,
  dhcp_count: 1,
  reservation_count: 1,
};

const addresses = Array.from({ length: 256 }, (_, index) => {
  const ip = `10.30.20.${index}`;
  if (index === 0) return { ip, kind: "network", label: "Network address", display_name: null, mac_address: null, vendor: null, dhcp_range: false };
  if (index === 1) return { ip, kind: "gateway", label: "Core gateway", display_name: "Core gateway", mac_address: null, vendor: null, dhcp_range: false };
  if (index === 4) return { ip, kind: "device", label: null, display_name: "Core switch", mac_address: "00:1a:2b:3c:4d:5e", vendor: "Example Networks", dhcp_range: true };
  if (index === 20) return { ip, kind: "dhcp", label: "workstation-20", display_name: null, mac_address: "00:aa:bb:cc:dd:20", vendor: null, dhcp_range: false };
  if (index === 30) return { ip, kind: "reserved", label: "Printer allocation", display_name: null, mac_address: null, vendor: null, dhcp_range: false };
  if (index === 255) return { ip, kind: "broadcast", label: "Broadcast address", display_name: null, mac_address: null, vendor: null, dhcp_range: false };
  return { ip, kind: "free", label: null, display_name: null, mac_address: null, vendor: null, dhcp_range: index >= 100 && index <= 150 };
});

async function setupIpam(page: Page, theme: "light" | "dark" = "dark") {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/ipam/summary", (route) => route.fulfill({
    json: {
      subnet_count: 1,
      total_hosts: 254,
      used: 4,
      free: 250,
      utilization: 4 / 254,
      conflict_count: 0,
      dhcp_lease_count: 0,
      reservation_count: 1,
    },
  }));
  await page.route("**/api/v1/ipam/subnets", (route) => route.fulfill({ json: [subnet] }));
  await page.route("**/api/v1/ipam/conflicts", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/ipam/dhcp-leases", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/ipam/reservations", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/ipam/subnets/1/addresses", (route) => route.fulfill({ json: addresses }));
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("netmap.theme", selectedTheme);
  }, theme);
  await page.goto("/ipam");
  await page.locator(".ipam-subnets-panel").waitFor({ state: "visible", timeout: 8000 });
}

for (const theme of ["light", "dark"] as const) {
  test(`IPAM uses the approved solid panel hierarchy in ${theme} mode`, async ({ page }) => {
    await setupIpam(page, theme);

    const panels = page.locator(".ipam-workspace .ipam-panel.nm-app-panel");
    await expect(panels).toHaveCount(3);
    for (const panel of await panels.all()) {
      await expect(panel).toHaveCSS("background-image", "none");
      const header = panel.locator(":scope > .ipam-panel-header.nm-app-panel-header");
      await expect(header).toBeVisible();
      await expect(header).toHaveCSS("min-height", "44px");
      await expect(header).toHaveCSS("background-image", "none");
      await expect(header.locator(".ipam-panel-icon")).toBeVisible();
    }

    await expect(page.locator(".ipam-data-table th").first()).toHaveCSS("border-right-width", "0px");
  });
}

test("the dense /24 map shows all addresses without scaling or horizontal overflow", async ({ page }) => {
  await setupIpam(page);
  await page.locator(".ipam-subnet-row").click();

  const dialog = page.getByRole("dialog", { name: "Core network" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ipam-grid-row")).toHaveCount(8);
  await expect(dialog.locator(".ipam-grid-cell")).toHaveCount(256);

  const map = dialog.locator(".ipam-grid-map");
  const sizes = await map.evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
  const dialogHeightBefore = (await dialog.locator(":scope > .modal").boundingBox())?.height ?? 0;

  const deviceCell = dialog.getByRole("button", { name: "10.30.20.4 · Device" });
  const freeCell = dialog.getByRole("button", { name: "10.30.20.2 · Free" });
  const [deviceFill, freeFill] = await Promise.all([
    deviceCell.evaluate((node) => getComputedStyle(node).backgroundColor),
    freeCell.evaluate((node) => getComputedStyle(node).backgroundColor),
  ]);
  expect(deviceFill).not.toBe(freeFill);
  await deviceCell.hover();
  await expect(dialog.locator(".ipam-grid-detail-card .ipam-tooltip-ip")).toHaveText("10.30.20.4");
  const detailCard = dialog.locator(".ipam-grid-detail-card");
  await expect(detailCard.getByText("Example Networks", { exact: true })).toBeVisible();
  const detailBox = await detailCard.boundingBox();
  expect(detailBox).not.toBeNull();
  expect((detailBox?.y ?? 0) + (detailBox?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.height ?? 720);
  const dialogHeightWithDevice = (await dialog.locator(":scope > .modal").boundingBox())?.height ?? 0;
  expect(Math.abs(dialogHeightWithDevice - dialogHeightBefore)).toBeLessThanOrEqual(0.5);

  const firstCell = dialog.getByRole("button", { name: "10.30.20.0 · Network" });
  await expect(firstCell).toHaveText("0");
  const before = await firstCell.boundingBox();
  await firstCell.hover();
  const after = await firstCell.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.width ?? 0) - (before?.width ?? 0))).toBeLessThanOrEqual(0.5);
  expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(0.5);
  await expect(firstCell).toHaveCSS("transform", "none");
  await expect(dialog.locator(".ipam-grid-detail-card .ipam-tooltip-ip")).toHaveText("10.30.20.0");

  const finalCell = dialog.getByRole("button", { name: "10.30.20.255 · Broadcast" });
  await expect(finalCell).toHaveText("255");
  await finalCell.focus();
  await expect(dialog.locator(".ipam-grid-detail-card .ipam-tooltip-ip")).toHaveText("10.30.20.255");
  const dialogHeightWithBroadcast = (await dialog.locator(":scope > .modal").boundingBox())?.height ?? 0;
  expect(Math.abs(dialogHeightWithBroadcast - dialogHeightBefore)).toBeLessThanOrEqual(0.5);
});

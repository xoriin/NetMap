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

async function setupIpam(page: Page, theme: "light" | "dark" = "dark", beforeGoto?: () => Promise<void>) {
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
  await beforeGoto?.();
  await page.goto("/ipam");
  await page.locator(".ipam-subnets-panel").waitFor({ state: "visible", timeout: 8000 });
}

/** External IPs is its own page, reached through the IPAM sidebar sub-nav — the in-page
 *  tab strip is gone. Using the real nav also exercises the sub-view routing. */
const rich = Array.from({ length: 256 }, (_, i) => {
  const ip = `10.30.20.${i}`;
  const kind = i === 0 ? "network" : i === 255 ? "broadcast" : i === 1 ? "gateway" : [5, 12, 37, 38, 90, 148].includes(i) ? "device" : [101, 102, 120].includes(i) ? "dhcp" : [20, 21].includes(i) ? "reserved" : "free";
  return { ip, kind, label: kind === "device" ? `host-${i}` : null, display_name: i === 37 ? "nas-01" : null, mac_address: kind === "device" ? "00:11:32:aa:bb:" + i.toString(16).padStart(2, "0") : null, vendor: i === 37 ? "Synology" : null, dhcp_range: i >= 100 && i <= 150 };
});

test("the address map numbers each tile and shows a hover card", async ({ page }) => {
  await setupIpam(page, "dark", async () => {
    await page.route("**/api/v1/ipam/subnets/1/addresses", (route) => route.fulfill({ json: rich }));
  });
  await page.locator(".ipam-subnets-table tbody tr").first().click();
  const map = page.locator(".ipam-ip-map");
  await map.waitFor({ state: "visible", timeout: 8000 });
  await expect(map.locator(".ipam-tile").nth(37)).toHaveText("37");
  await expect(map.locator(".ipam-tile").nth(200)).toHaveText("200");
  await map.locator(".ipam-tile").nth(37).hover();
  const card = page.locator(".ipam-tile-tooltip");
  await expect(card).toContainText("10.30.20.37");
  await expect(card).toContainText("Device");
  await expect(card).toContainText("nas-01");
  await expect(card).toContainText("Synology");
  await map.locator(".ipam-tile").nth(200).hover();
  await expect(card).toContainText("10.30.20.200");
  await expect(card).toContainText("Available");
  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);
});

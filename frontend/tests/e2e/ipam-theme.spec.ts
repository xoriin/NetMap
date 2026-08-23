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
async function openExternalIps(page: Page) {
  // On /ipam the sub-nav is already expanded, and clicking the parent there collapses it
  // (the same "already on the first sub-view" rule as Inventory and Monitoring).
  const link = page.getByRole("button", { name: "External IPs" });
  if (!await link.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "IPAM", exact: true }).click();
  }
  await link.click();
  await page.locator(".external-ip-panel").waitFor({ state: "visible", timeout: 8000 });
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
      // The subnets panel's header hosts the Internal/External section tabs in place
      // of the identity icon; every other panel still leads with the icon.
      const mark = header.locator(".ipam-panel-icon, .nm-section-tabs");
      await expect(mark.first()).toBeVisible();
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

  const legendColors = await dialog.locator(".ipam-legend-dot").evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).backgroundColor),
  );
  expect(new Set(legendColors).size).toBeGreaterThanOrEqual(5);

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

const AWS = { id: 1, key: "aws", name: "AWS", aliases: [], icon: "aws", icon_data: null, builtin: true };

const POOL = {
  id: 10, name: "AWS individual addresses", provider_id: 1, provider: AWS, account: "acct-1", region: null,
  service: "Amazon EC2", icon: "server",
  description: null, created_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
  total: 6, in_use: 1, reserved: 0, free: 5, utilization: 0.16,
  allocations: [{ id: 1, pool_id: 10, cidr: "13.54.22.0/29", total: 6, created_at: "2026-08-02T00:00:00Z" }],
};

const ASSET = {
  id: 5, name: "web-prod-01", kind: "ec2", provider_id: 1, provider: AWS, account: "acct-1",
  region: "ap-southeast-2", device_id: null, description: null,
  created_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
  address_count: 1, in_use: 1, reserved: 0,
};

const DEVICE = { id: 7, display_name: "web-prod-01", hostname: null, ip_address: "10.0.0.5", device_type: "server", site_id: null };

const ASSIGNMENT = {
  id: 21, pool_id: 10, device_id: 7, device: DEVICE, asset_id: 5, asset: ASSET, ip_address: "13.54.22.1", label: "web-prod-01",
  status: "in_use", owner: null, tags: null, notes: null,
  created_at: "2026-08-02T00:00:00Z", updated_at: "2026-08-02T00:00:00Z",
};

async function mockExternal(page: Page, pools = [POOL], assets = [ASSET], assignments = [ASSIGNMENT]) {
  await page.route("**/api/v1/ipam/external/summary", (route) => route.fulfill({ json: {
    pool_count: pools.length, total: 6, in_use: 1, reserved: 0, free: 5,
    asset_count: assets.length, unassigned_address_count: 0,
  } }));
  await page.route("**/api/v1/ipam/external/pools", (route) => route.fulfill({ json: pools }));
  await page.route("**/api/v1/ipam/external/assets", (route) => route.fulfill({ json: assets }));
  await page.route("**/api/v1/ipam/external/assignments**", (route) => route.fulfill({ json: assignments }));
  await page.route("**/api/v1/admin/cloud-providers", (route) => route.fulfill({ json: [AWS] }));
  await page.route("**/api/v1/ipam/external/pools/10/addresses**", (route) => route.fulfill({ json: {
    total: 6, offset: 0, limit: 256,
    addresses: Array.from({ length: 6 }, (_, index) => ({
      ip_address: `13.54.22.${index + 1}`,
      status: index === 0 ? "in_use" : "available",
      assignment: index === 0 ? ASSIGNMENT : null,
    })),
  } }));
}

test("External IPs shows allocations and spare capacity, not asset management", async ({ page }) => {
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await openExternalIps(page);

  // Provider rolls up capacity so spare addresses are visible without drilling in.
  const providerRow = page.locator(".external-ip-provider-row");
  await expect(providerRow).toContainText("AWS");
  await expect(providerRow).toContainText("5 free of 6");

  // Assets are Inventory's concern — IPAM must not create or delete them.
  await expect(page.getByRole("button", { name: "Add asset" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Allocations/ })).toHaveCount(0);

  // Provider and cloud-service tiers are open on arrival, with a visible allocation row.
  await expect(page.locator(".external-ip-service-row")).toContainText("Amazon EC2");
  const allocationRow = page.locator(".external-ip-pool-row").first();
  await expect(allocationRow).toContainText("AWS individual addresses");
  await expect(allocationRow).toContainText("13.54.22.0/29");

  // Allocations start collapsed unless they hold one address. The chevron makes the
  // additional tier explicit, and either it or the row opens the addresses.
  await expect(allocationRow).toHaveAttribute("aria-expanded", "false");
  await allocationRow.getByRole("button", { name: "Expand AWS individual addresses" }).click();
  // One IP per row, in the same table, rather than a grid of tiles in a colSpan cell.
  await expect(page.locator("tr.external-ip-address-row--available")).toHaveCount(5);
  await expect(page.locator("tr.external-ip-address-row--in_use")).toContainText("web-prod-01");
  await expect(page.locator(".external-ip-grid")).toHaveCount(0);

  // Nothing interrupts the run of IP rows: no ranges strip between an allocation and its
  // addresses. Ranges are edit-time detail and live in the allocation modal instead.
  await expect(page.locator(".external-ip-ranges-row")).toHaveCount(0);
  const kinds = await page.locator(".external-ip-table tbody tr").evaluateAll((rows) =>
    rows.map((row) => row.className.split(" ").find((name) => name.endsWith("-row")) ?? ""),
  );
  expect(kinds.filter((kind) => kind === "external-ip-address-row")).toHaveLength(6);

  // The Addresses column means the same thing on a provider as on its allocations.
  const providerAddresses = await page.locator(".external-ip-provider-row td").nth(3).innerText();
  const allocationAddresses = await page.locator(".external-ip-pool-row td").nth(3).innerText();
  expect(providerAddresses.trim()).toBe(allocationAddresses.trim());

  // Collapsing remains available from the whole row.
  await allocationRow.click();
  await expect(page.locator("tr.external-ip-address-row--available")).toHaveCount(0);
  await providerRow.click();
  await expect(page.locator(".external-ip-pool-row")).toHaveCount(0);
});

test("External IPs uses the approved service tree, filters, and allocation menu", async ({ page }) => {
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await openExternalIps(page);

  const provider = page.locator(".external-ip-provider-row");
  const service = page.locator(".external-ip-service-row");
  const allocation = page.locator(".external-ip-pool-row");
  await expect(provider).toContainText("1 service");
  await expect(service).toContainText("Amazon EC2");
  await expect(allocation).toContainText("6 addresses");
  await expect(page.locator(".external-ip-utilization .ipam-util-bar")).toHaveCount(3);

  // The hierarchy must not consume the spare width while the informational columns
  // remain cramped. The proportions fill the table and give account, totals,
  // utilisation, and actions deliberate room at the normal app viewport.
  const columnLayout = await page.locator(".external-ip-table").evaluate((table) => {
    const tableWidth = table.getBoundingClientRect().width;
    const widths = [...table.querySelectorAll("col")].map((col) => col.getBoundingClientRect().width);
    const wrapper = table.parentElement!;
    return { tableWidth, widths, wrapperClient: wrapper.clientWidth, wrapperScroll: wrapper.scrollWidth };
  });
  expect(columnLayout.widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(columnLayout.tableWidth, 0);
  expect(columnLayout.widths[0] / columnLayout.tableWidth).toBeLessThan(0.33);
  expect(columnLayout.widths[1] / columnLayout.tableWidth).toBeGreaterThan(0.16);
  expect(columnLayout.widths[5] / columnLayout.tableWidth).toBeGreaterThan(0.13);
  expect(columnLayout.widths[6] / columnLayout.tableWidth).toBeGreaterThan(0.11);
  expect(columnLayout.wrapperScroll).toBeLessThanOrEqual(columnLayout.wrapperClient);

  // Each connector starts immediately below its parent icon and stops just before
  // the child icon box. Deeper rows do not keep decorative ancestor rails behind them.
  const geometry = await page.locator(".external-ip-tree-level-1").evaluate((node) => {
    const cell = node.getBoundingClientRect();
    const icon = node.querySelector(".external-ip-tree-icon")!.getBoundingClientRect();
    const before = getComputedStyle(node, "::before");
    const after = getComputedStyle(node, "::after");
    return {
      branchTop: cell.top + parseFloat(before.top),
      branchEnd: cell.left + parseFloat(after.left) + parseFloat(after.width),
      iconLeft: icon.left,
    };
  });
  const parentIcon = await page.locator(".external-ip-provider-icon").boundingBox();
  expect(Math.abs(geometry.branchTop - (parentIcon!.y + parentIcon!.height))).toBeLessThanOrEqual(2);
  expect(geometry.iconLeft - geometry.branchEnd).toBeGreaterThan(0);
  expect(geometry.iconLeft - geometry.branchEnd).toBeLessThanOrEqual(4);
  await expect(page.locator(".external-ip-tree-level-2")).toHaveCSS("background-image", "none");
  await allocation.click();
  await expect(page.locator(".external-ip-tree-level-3").first()).toHaveCSS("background-image", "none");
  await allocation.click();

  await allocation.getByRole("button", { name: "Actions" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Add range" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Edit allocation" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Delete allocation" })).toBeVisible();

  // Allocations use the shared searchable icon catalogue. The selected icon is
  // persisted with the allocation and immediately becomes its tree-row mark.
  await menu.getByRole("menuitem", { name: "Edit allocation" }).click();
  const allocationDialog = page.getByRole("dialog", { name: "Edit allocation" });
  await expect(allocationDialog.getByText("Server", { exact: true })).toBeVisible();
  await allocationDialog.locator(".icon-picker-trigger-btn").click();
  const iconDialog = page.getByRole("dialog", { name: "Choose icon" });
  await iconDialog.getByPlaceholder("Search icons...").fill("database");
  await iconDialog.locator('.icon-picker-item[title="Database"]').click();
  await expect(allocationDialog.getByText("Database", { exact: true })).toBeVisible();
  let allocationPatch: Record<string, unknown> | null = null;
  await page.route("**/api/v1/ipam/external/pools/10", async (route) => {
    allocationPatch = route.request().postDataJSON();
    await route.fulfill({ json: { ...POOL, icon: "database" } });
  });
  await allocationDialog.getByRole("button", { name: "Save allocation" }).click();
  await expect.poll(() => allocationPatch?.icon).toBe("database");

  const search = page.getByRole("searchbox", { name: "Search external IPs" });
  await search.fill("Amazon EC2");
  await expect(service).toBeVisible();
  await search.fill("no-such-cloud-service");
  await expect(page.getByText("No external IP records match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(provider).toBeVisible();

  // An address row is independently removable. This calls the address endpoint rather
  // than deleting its complete parent range/allocation through the Actions menu.
  let deletedAddress = "";
  await page.route("**/api/v1/ipam/external/pools/10/addresses/13.54.22.2", async (route) => {
    deletedAddress = route.request().url();
    await route.fulfill({ status: 204, body: "" });
  });
  await allocation.click();
  const freeAddress = page.locator("tr.external-ip-address-row--available", { hasText: "13.54.22.2" });
  await freeAddress.getByRole("button", { name: "Delete 13.54.22.2" }).click();
  const confirmDelete = page.getByRole("dialog", { name: "Delete external IP address" });
  await expect(confirmDelete).toContainText("Delete 13.54.22.2 from AWS individual addresses?");
  await confirmDelete.getByRole("button", { name: "Delete address" }).click();
  await expect.poll(() => deletedAddress).toContain("/pools/10/addresses/13.54.22.2");
});

test("Cloud assets is a device-centric page fed by IPAM", async ({ page }) => {
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  // Cloud assets is an Inventory sub-view, the same shape as Monitoring's
  // Devices / Endpoints split — reached through the sidebar, not a top-level page.
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Cloud assets" }).click();

  // Grouped provider → device → address, the same order as IPAM's External IPs table.
  const providerRow = page.locator(".cloud-group-row");
  await expect(providerRow).toHaveCount(1);
  await expect(providerRow).toContainText("AWS");
  await expect(providerRow).toContainText("1 device");

  // One row per device holding public addresses — not a second inventory of assets.
  const deviceRow = page.locator(".cloud-device-row");
  await expect(deviceRow).toHaveCount(1);
  await expect(deviceRow).toContainText("web-prod-01");

  // Devices arrive here through the IPAM toggle, so the page offers no create action.
  await expect(page.getByRole("button", { name: /^Add asset/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Manage in IPAM/ })).toBeVisible();

  // Groups start open: collapsing by default would hide the only content the page has.
  const addressRow = page.locator(".cloud-address-row").first();
  await expect(addressRow).toContainText("13.54.22.1");
  await expect(addressRow).toContainText("AWS");

  await deviceRow.click();
  await expect(page.locator(".cloud-address-row")).toHaveCount(0);

  // Collapsing the provider takes its devices with it.
  await providerRow.click();
  await expect(page.locator(".cloud-device-row")).toHaveCount(0);
});

test("the Inventory parent navigates and drops the menu down, never collapsing it", async ({ page }) => {
  // The link and the chevron are separate controls. Clicking the section name goes to its
  // first sub-view and leaves the menu open; only the chevron closes it. Earlier revisions
  // made the parent collapse the menu as a side effect, which hid the sub-items you were
  // about to click.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  const inventoryParent = page.getByRole("button", { name: "Inventory", exact: true });
  const inventoryToggle = page.getByRole("button", { name: /(Collapse|Expand) Inventory sections/ });
  const cloudLink = page.getByRole("button", { name: "Cloud assets", exact: true });

  await inventoryParent.click();
  await cloudLink.click();
  await expect(page.locator(".cloud-table")).toBeVisible();

  // Parent click: back to Devices, menu still down.
  await inventoryParent.click();
  await expect(page.locator(".inventory-table")).toBeVisible();
  await expect(cloudLink).toBeVisible();

  // Chevron closes it without navigating away from Devices. Its rotation is a real
  // transition driven by aria-expanded, not an instantaneous icon replacement.
  const chevron = inventoryToggle.locator(".sidebar-parent-chevron");
  await expect(chevron).toHaveCSS("transition-duration", "0.22s");
  await expect(chevron).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  const expandedTransform = await chevron.evaluate((node) => getComputedStyle(node).transform);
  await inventoryToggle.click();
  const activeAnimations = await chevron.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === "running").length);
  expect(activeAnimations).toBeGreaterThan(0);
  await expect(cloudLink).toHaveCount(0);
  await expect(page.locator(".inventory-table")).toBeVisible();
  await expect(chevron).not.toHaveCSS("transform", expandedTransform);

  // ...and the parent drops it back down.
  await inventoryParent.click();
  await expect(cloudLink).toBeVisible();
  await expect(chevron).toHaveCSS("transform", expandedTransform);
});

test("Manage in IPAM opens the External IPs tab directly", async ({ page }) => {
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Cloud assets" }).click();

  const manage = page.getByRole("button", { name: "Manage in IPAM" });
  // Text only — the icon was noise on a button that already reads as a link.
  await expect(manage.locator("svg")).toHaveCount(0);
  await manage.click();

  // Lands on External IPs, not on Internal networks with the user hunting for it.
  await expect(page.locator(".external-ip-provider-row")).toBeVisible();
  await expect(page.getByRole("button", { name: "External IPs" })).toHaveAttribute("aria-current", "page");
  // ...and it is a page of its own: none of Internal networks' panels come with it.
  await expect(page.locator(".ipam-subnets-panel")).toHaveCount(0);
  await expect(page.locator(".ipam-reservations-panel")).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`Inventory and IPAM render the same table header in ${theme} mode`, async ({ page }) => {
    // The pages felt unrelated because each table themed its own header: Monitoring sat
    // on the same surface as its rows in sentence case, IPAM used the canonical treatment,
    // Inventory a third. They now all read --nm-table-header-*; Inventory is the reference.
    await setupIpam(page, theme, async () => { await mockExternal(page); });
    const read = (selector: string) => page.locator(selector).first().evaluate((node) => {
      const s = getComputedStyle(node);
      return {
        bg: s.backgroundColor, color: s.color, fontSize: s.fontSize,
        fontWeight: s.fontWeight, textTransform: s.textTransform, letterSpacing: s.letterSpacing,
      };
    });

    await page.getByRole("button", { name: "Inventory", exact: true }).click();
    await expect(page.locator(".inventory-table-header").first()).toBeVisible();
    const inventory = await read(".inventory-table-header");

    await page.getByRole("button", { name: "IPAM", exact: true }).click();
    await openExternalIps(page);
    const ipam = await read(".external-ip-table thead th");

    expect(ipam).toEqual(inventory);
    // ...and it is genuinely the shared token, not a coincidence of two hard-coded values.
    const token = await page.locator(".external-ip-table thead th").first().evaluate((node) => {
      const probe = document.createElement("div");
      node.appendChild(probe);
      probe.style.backgroundColor = getComputedStyle(node).getPropertyValue("--nm-table-header-bg").trim();
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return resolved;
    });
    expect(inventory.bg).toBe(token);

    // Rows too — the headers matching while the row surfaces differed is exactly what
    // still made the two pages look unrelated after the first pass at this.
    // Expand: collapsed, the only rows are provider group rows, which deliberately wear
    // the header surface (a tier Inventory has no equivalent of).
    const ordinaryRow = page.locator(".external-ip-pool-row td").first();
    const rowToken = await ordinaryRow.evaluate((node) => {
      const probe = document.createElement("div");
      node.appendChild(probe);
      probe.style.backgroundColor = getComputedStyle(node).getPropertyValue("--nm-table-row-bg").trim();
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return resolved;
    });
    const ipamRow = await ordinaryRow.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(ipamRow).toBe(rowToken);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`address rows carry status in the pill, not in the row edge (${theme})`, async ({ page }) => {
    // Regression guard. An earlier pass painted the row's 3px inset left edge green for
    // "in use" and amber for "reserved" — inventing a colour vocabulary the design system
    // does not have, and stealing the canonical teal hover affordance to do it.
    await setupIpam(page, theme, async () => { await mockExternal(page); });
    await openExternalIps(page);

    const tracked = page.locator("tr.external-ip-address-row--in_use");
    const free = page.locator("tr.external-ip-address-row--available").first();
    await page.locator(".external-ip-pool-row").first().click();
    await expect(tracked).toBeVisible();

    // At rest, a tracked row is styled exactly like a free one: no status colour anywhere.
    for (const row of [tracked, free]) {
      await expect(row.locator("td").first()).toHaveCSS("box-shadow", "none");
    }

    // Status lives in the pill, and only there.
    await expect(tracked.locator(".nm-status")).toHaveText("In use");

    // Hover still produces the canonical teal edge, unobstructed.
    await tracked.hover();
    const shadow = await tracked.locator("td").first().evaluate((n) => getComputedStyle(n).boxShadow);
    expect(shadow).toContain("rgba(29, 154, 176, 0.3)");
  });
}

test("Cloud assets survives the Admin stylesheet being loaded", async ({ page }) => {
  // Regression guard, and it must visit Admin first: `admin.css` ships with the Admin
  // chunk, so its `.cloud-provider-row { display: grid }` only exists in the document once
  // a user has been there. Cloud assets reused that class name and its provider rows
  // stopped being table rows — but only for users who had opened Admin, which is why a
  // single-page test saw nothing wrong.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await page.locator(".admin-layout, .admin-workspace").first().waitFor({ state: "visible", timeout: 8000 });

  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Cloud assets" }).click();

  const groupRow = page.locator(".cloud-group-row").first();
  await expect(groupRow).toBeVisible();
  await expect(groupRow).toHaveCSS("display", "table-row");

  // Every cell sits on one baseline: a grid would stack them into a tall block.
  const cellTops = await groupRow.locator("td").evaluateAll((cells) =>
    cells.map((cell) => Math.round(cell.getBoundingClientRect().top)),
  );
  expect(new Set(cellTops).size).toBe(1);
  const height = (await groupRow.boundingBox())!.height;
  expect(height).toBeLessThan(80);
});

test("sidebar section menus stay open when you leave the section", async ({ page }) => {
  // They used to be seeded from the current route and force-expanded on arrival, so leaving
  // a section collapsed its menu and returning discarded a deliberate collapse.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  const inventoryParent = page.getByRole("button", { name: "Inventory", exact: true });
  const monitoringParent = page.getByRole("button", { name: "Monitoring", exact: true });
  const topology = page.getByRole("button", { name: "Topology", exact: true });
  const cloudLink = page.getByRole("button", { name: "Cloud assets", exact: true });

  await inventoryParent.click();
  await expect(cloudLink).toBeVisible();

  // Leaving Inventory entirely no longer closes its menu...
  await topology.click();
  await expect(cloudLink).toBeVisible();
  const inventoryToggle = page.getByRole("button", { name: /^(Collapse|Expand) Inventory sections$/ });
  await expect(inventoryToggle).toHaveAttribute("aria-expanded", "true");
  // ...and nothing in it claims to be the current page while we are elsewhere.
  await expect(page.getByRole("button", { name: "Devices", exact: true })).not.toHaveAttribute("aria-current", "page");

  // A sub-item still works from off-route: it takes you back to its section.
  await cloudLink.click();
  await expect(page.locator(".cloud-table")).toBeVisible();
  await expect(cloudLink).toHaveAttribute("aria-current", "page");

  // Inventory's off-route chevron still reflects its sticky open menu and animates shut.
  await topology.click();
  const inventoryChevron = inventoryToggle.locator(".sidebar-parent-chevron");
  await expect(inventoryChevron).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await inventoryToggle.click();
  expect(await inventoryChevron.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === "running").length)).toBeGreaterThan(0);
  await expect(inventoryToggle).toHaveAttribute("aria-expanded", "false");
  await expect(cloudLink).toHaveCount(0);

  // Monitoring uses the same truthful state and animation when its sticky menu is
  // manipulated while another workspace is current.
  await monitoringParent.click();
  const monitoringSubnav = page.locator('[aria-label="Monitoring sections"]');
  await expect(monitoringSubnav).toBeVisible();
  await topology.click();
  const monitoringToggle = page.getByRole("button", { name: /^(Collapse|Expand) Monitoring sections$/ });
  const monitoringChevron = monitoringToggle.locator(".sidebar-parent-chevron");
  await expect(monitoringToggle).toHaveAttribute("aria-expanded", "true");
  await expect(monitoringChevron).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await monitoringToggle.click();
  expect(await monitoringChevron.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === "running").length)).toBeGreaterThan(0);
  await expect(monitoringToggle).toHaveAttribute("aria-expanded", "false");
  await expect(monitoringSubnav).toHaveCount(0);
});

test("a collapsed sidebar menu stays collapsed across navigation and reload", async ({ page }) => {
  // "Sticky" means the collapse survives moving around the app and reloading. Clicking the
  // section's own name is not "moving around" — that deliberately drops the menu back down,
  // which is covered by the parent-click test above.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  const inventoryParent = page.getByRole("button", { name: "Inventory", exact: true });
  const inventoryToggle = page.getByRole("button", { name: /(Collapse|Expand) Inventory sections/ });
  const cloudLink = page.getByRole("button", { name: "Cloud assets", exact: true });

  await inventoryParent.click();
  await expect(cloudLink).toBeVisible();
  await inventoryToggle.click();
  await expect(cloudLink).toHaveCount(0);

  // Move elsewhere: still collapsed.
  await page.getByRole("button", { name: "Topology", exact: true }).click();
  await expect(cloudLink).toHaveCount(0);

  // Persisted, not just held in memory.
  await page.reload();
  await expect(cloudLink).toHaveCount(0);
});

test("Cloud assets loads its own stylesheet", async ({ page }) => {
  // Regression guard. This page began life inside IPAM and kept IPAM's `.external-ip-*`
  // class names when it moved under Inventory — but `ipam.css` is imported by
  // `IpamWorkspace` alone, so the page rendered with no styling whatsoever. Text-only
  // assertions passed the whole time, which is why these are computed-style checks.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Cloud assets" }).click();

  const table = page.locator(".cloud-table");
  await expect(table).toHaveClass(/\bnm-table\b/);

  // The provider row wears the workspace header surface. If inventory.css's cloud block
  // were missing, this would fall back to a transparent/section background.
  const modalHeader = await table.evaluate((node) => {
    const probe = document.createElement("div");
    node.appendChild(probe);
    probe.style.backgroundColor = getComputedStyle(node).getPropertyValue("--nm-modal-header").trim();
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  });
  const rowBackground = await page.locator(".cloud-group-row td").first()
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(rowBackground).toBe(modalHeader);

  // Indentation is what carries the provider > device > address hierarchy.
  const padding = async (selector: string) => parseFloat(
    await page.locator(selector).first().evaluate((node) => getComputedStyle(node).paddingLeft),
  );
  const providerPad = await padding(".cloud-group-row td");
  const devicePad = await padding(".cloud-device-row td");
  const addressPad = await padding(".cloud-address-row td");
  expect(devicePad).toBeGreaterThan(providerPad);
  expect(addressPad).toBeGreaterThan(devicePad);
});

test("Cloud assets keeps provider marks icon-sized", async ({ page }) => {
  // The bundled provider marks are SVGs with their own viewBox. `CloudProviderIcon`
  // used to ignore `size` for those, so outside a caller that happened to constrain
  // `img` the logo rendered full-page and blew the table out sideways.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Cloud assets" }).click();

  const mark = page.locator(".cloud-group-icon > *").first();
  const box = await mark.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(24);
  expect(box!.height).toBeLessThanOrEqual(24);

  // ...and the table therefore fits its wrapper instead of scrolling sideways.
  const overflow = await page.locator(".cloud-table-wrap").evaluate(
    (node) => node.scrollWidth - node.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

for (const theme of ["light", "dark"] as const) {
  test(`External IPs keeps the canonical table treatment in ${theme} mode`, async ({ page }) => {
    await setupIpam(page, theme, async () => { await mockExternal(page); });
    await openExternalIps(page);

    const table = page.locator(".external-ip-table");
    await expect(table).toHaveClass(/\bnm-table\b/);
    await expect(page.locator(".nm-table-wrap.external-ip-table-wrap")).toBeVisible();

    const th = table.locator("thead th").first();
    await expect(th).toHaveCSS("text-transform", "uppercase");
    await expect(th).toHaveCSS("position", "sticky");

    // Surfaces follow the workspace --nm-modal-* hierarchy, not the darker component default.
    const tokens = await table.evaluate((node) => {
      const s = getComputedStyle(node);
      const probe = document.createElement("div");
      node.appendChild(probe);
      const resolve = (name: string) => {
        probe.style.backgroundColor = s.getPropertyValue(name).trim();
        return getComputedStyle(probe).backgroundColor;
      };
      const out = { header: resolve("--nm-table-header-bg"), section: resolve("--nm-table-row-bg"), surface: resolve("--nm-surface") };
      probe.remove();
      return out;
    });
    expect(await th.evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(tokens.header);

    const row = page.locator(".external-ip-pool-row").first();
    // Rows wear the shared --nm-table-row-bg, and the table surface behind them stays
    // lighter. This deliberately supersedes an earlier rule that IPAM rows must not be
    // --nm-surface: that fix was for a table sitting deeper than its own panel. Inventory
    // — the reference — puts --nm-surface rows on a --nm-modal-section table, and it is
    // that row/surface contrast, not the row colour alone, that keeps it from reading dark.
    const rowBg = await row.locator("td").first().evaluate((n) => getComputedStyle(n).backgroundColor);
    expect(rowBg).toBe(tokens.section);
    if (theme === "dark") {
      // In dark the table surface stays lighter than its rows, which is the contrast that
      // keeps Inventory's --nm-surface rows from reading as a hole. Light mode resolves
      // both to the same value, so there is nothing to assert there.
      const tableBg = await page.locator(".external-ip-table-wrap").evaluate((n) => getComputedStyle(n).backgroundColor);
      expect(tableBg).not.toBe(rowBg);
    }

    // Canonical hover: soft tint plus the 3px teal left edge.
    await row.hover();
    expect(await row.locator("td").first().evaluate((n) => getComputedStyle(n).boxShadow)).toContain("29, 154, 176");

    // Every data row fills the same columns as the header.
    const headerCells = await table.locator("thead th").count();
    for (const dataRow of await table.locator("tbody tr").all()) {
      if (await dataRow.locator("td[colspan]").count() > 0) continue;
      expect(await dataRow.locator("td").count()).toBe(headerCells);
    }

    // Row actions sit flush right, as the design system places them.
    await expect(table.locator("thead th.external-ip-actions")).toHaveCSS("text-align", "right");
    const cell = row.locator("td.external-ip-actions");
    const cellBox = await cell.boundingBox();
    const padRight = await cell.evaluate((n) => parseFloat(getComputedStyle(n).paddingRight));
    const boxes = await Promise.all((await cell.getByRole("button").all()).map((b) => b.boundingBox()));
    const groupRight = Math.max(...boxes.map((b) => b!.x + b!.width));
    expect(Math.abs(groupRight - (cellBox!.x + cellBox!.width - padRight))).toBeLessThanOrEqual(2);
  });
}

test("two-column form rows keep their controls aligned", async ({ page }) => {
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await openExternalIps(page);
  const tracked = page.locator("tr.external-ip-address-row--in_use");
  await page.locator(".external-ip-pool-row").first().click();
  await expect(tracked).toBeVisible();
  await tracked.click();

  const dialog = page.getByRole("dialog", { name: /Edit external IP/ });
  await expect(dialog).toBeVisible();

  // "Cloud asset" carries helper text; "Status" beside it does not. With the grid's
  // default `stretch` the taller cell grew its neighbour's control out of alignment.
  const left = await dialog.getByLabel(/Cloud asset/).boundingBox();
  const right = await dialog.getByLabel(/^Status/).boundingBox();
  expect(Math.abs(left!.y - right!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(left!.height - right!.height)).toBeLessThanOrEqual(1);
});

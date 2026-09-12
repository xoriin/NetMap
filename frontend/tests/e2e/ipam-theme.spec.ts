import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";
import { AWS, mockAddress } from "./helpers/external-ip";

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
  const link = page.getByRole("link", { name: "External IPs" });
  if (!await link.isVisible().catch(() => false)) {
    await page.getByRole("link", { name: "IPAM", exact: true }).click();
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

test("Internal IPAM tables own canonical typography independently of Monitoring", async ({ page }) => {
  await setupIpam(page, "dark", async () => {
    await page.route("**/api/v1/ipam/reservations", (route) => route.fulfill({ json: [{
      id: 1,
      ip_address: "10.30.20.30",
      subnet_id: 1,
      label: "Printer allocation",
      mac_address: null,
      notes: "Office printer",
      reserved_by: "Network team",
      expires_at: null,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    }] }));
    await page.route("**/api/v1/ipam/dhcp-leases", (route) => route.fulfill({ json: [{
      id: 1,
      ip_address: "10.30.20.20",
      mac_address: "00:aa:bb:cc:dd:20",
      hostname: "workstation-20",
      expires_at: "2026-08-25T00:00:00Z",
      is_active: true,
      source: "test",
      imported_at: "2026-08-24T00:00:00Z",
    }] }));
  });

  await page.locator(".ipam-reservations-panel").getByRole("button", { name: "Show" }).click();
  const tables = page.locator(".ipam-data-table");
  await expect(tables).toHaveCount(3);
  for (const table of await tables.all()) {
    await expect(table).toHaveCSS("font-size", "12px");
    await expect(table.locator("tbody td").first()).toHaveCSS("font-size", "12px");
  }
  await expect(page.locator(".ipam-subnets-table .mon-device-name")).toHaveCSS("font-size", "12px");
});

for (const theme of ["light", "dark"] as const) {
test(`Internal networks distributes its columns across the available width in ${theme} mode`, async ({ page }) => {
  await page.setViewportSize({ width: 2338, height: 988 });
  await setupIpam(page, theme);

  const layout = await page.locator(".ipam-subnets-table").evaluate((table) => {
    const tableWidth = table.getBoundingClientRect().width;
    const widths = [...table.querySelectorAll("col")].map((col) => col.getBoundingClientRect().width);
    return {
      tableWidth,
      widths,
      tableLayout: getComputedStyle(table).tableLayout,
      wrapperWidth: table.parentElement!.getBoundingClientRect().width,
    };
  });

  expect(layout.tableLayout).toBe("fixed");
  expect(layout.widths).toHaveLength(9);
  expect(layout.widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(layout.tableWidth, 0);
  const ratios = layout.widths.map((width) => width / layout.tableWidth);
  expect(ratios[0]).toBeCloseTo(0.14, 2);
  expect(ratios[1]).toBeCloseTo(0.11, 2);
  expect(ratios[2]).toBeCloseTo(0.11, 2);
  expect(ratios[3]).toBeCloseTo(0.08, 2);
  expect(ratios[4]).toBeCloseTo(0.08, 2);
  expect(ratios[5]).toBeCloseTo(0.15, 2);
  expect(ratios[6]).toBeCloseTo(0.08, 2);
  expect(ratios[7]).toBeCloseTo(0.10, 2);
  expect(ratios[8]).toBeCloseTo(0.15, 2);
  expect(layout.tableWidth).toBeGreaterThanOrEqual(layout.wrapperWidth);

  const headers = page.locator(".ipam-subnets-table thead th");
  const firstRowCells = page.locator(".ipam-subnets-table tbody tr").first().locator("td");
  for (let column = 2; column <= 7; column += 1) {
    await expect(headers.nth(column)).toHaveCSS("text-align", "center");
    await expect(firstRowCells.nth(column)).toHaveCSS("text-align", "center");
  }
  await expect(firstRowCells.nth(2).locator(".ipam-util-wrap")).toHaveCSS("justify-content", "center");
  await expect(firstRowCells.nth(8)).toHaveCSS("text-align", "right");
});
}

test("IPAM column layouts use contained horizontal scrolling on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await setupIpam(page, "dark", async () => { await mockExternal(page); });

  const internal = await page.locator(".ipam-subnets-panel .dash-panel-body").evaluate((wrapper) => ({
    clientWidth: wrapper.clientWidth,
    scrollWidth: wrapper.scrollWidth,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(internal.scrollWidth).toBeGreaterThan(internal.clientWidth);
  expect(internal.pageOverflow).toBeLessThanOrEqual(1);

  await openExternalIps(page);
  const external = await page.locator(".external-ip-table-wrap").evaluate((wrapper) => ({
    clientWidth: wrapper.clientWidth,
    scrollWidth: wrapper.scrollWidth,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(external.scrollWidth).toBeGreaterThan(external.clientWidth);
  expect(external.pageOverflow).toBeLessThanOrEqual(1);
});

for (const theme of ["light", "dark"] as const) {
test(`a reservation can be explicitly converted into a device from IPAM in ${theme} mode`, async ({ page }) => {
  const reservation = {
    id: 7,
    ip_address: "10.30.20.30",
    subnet_id: 1,
    label: "Printer allocation",
    mac_address: "00:11:22:33:44:55",
    notes: "Office printer",
    reserved_by: "Network team",
    expires_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
  const requests: Record<string, unknown>[] = [];
  await setupIpam(page, theme, async () => {
    await page.route("**/api/v1/ipam/reservations", (route) => route.fulfill({ json: [reservation] }));
    await page.route("**/api/v1/admin/device-types", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/v1/topology/devices", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = await route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      if (!body.claim_reservation) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: { code: "ip_reservation_conflict", reservation_id: reservation.id, ip_address: reservation.ip_address, label: reservation.label, mac_address: reservation.mac_address, can_claim: true } }),
        });
        return;
      }
      await route.fulfill({ json: mockDevice({ id: 30, display_name: reservation.label, hostname: null, ip_address: reservation.ip_address, mac_address: reservation.mac_address }) });
    });
  });

  await page.locator(".ipam-reservations-panel").getByRole("button", { name: "Show" }).click();
  const reservationRow = page.locator(".ipam-reservations-table tbody tr").first();
  const actionCell = reservationRow.locator(".ipam-reservation-actions");
  const actionGroup = actionCell.locator(".ipam-row-actions");
  const editAction = actionCell.getByRole("button", { name: "Edit" });
  const deleteAction = actionCell.getByRole("button", { name: "Delete" });
  const [actionCellBox, actionGroupBox, editActionBox, deleteActionBox] = await Promise.all([
    actionCell.boundingBox(),
    actionGroup.boundingBox(),
    editAction.boundingBox(),
    deleteAction.boundingBox(),
  ]);
  expect(actionCellBox).not.toBeNull();
  expect(actionGroupBox).not.toBeNull();
  const actionCellCentreX = (actionCellBox?.x ?? 0) + (actionCellBox?.width ?? 0) / 2;
  const actionGroupCentreX = (actionGroupBox?.x ?? 0) + (actionGroupBox?.width ?? 0) / 2;
  expect(Math.abs(actionCellCentreX - actionGroupCentreX)).toBeLessThanOrEqual(2);
  expect(actionGroupBox?.width ?? 0).toBeLessThan(130);
  expect((deleteActionBox?.x ?? 0) - ((editActionBox?.x ?? 0) + (editActionBox?.width ?? 0))).toBeGreaterThanOrEqual(8);
  await editAction.click();
  const reservationDialog = page.getByRole("dialog", { name: "Edit reservation" });
  const convertButton = reservationDialog.getByRole("button", { name: "Convert to device" });
  await expect(convertButton).toBeVisible();
  const closeButton = reservationDialog.getByRole("button", { name: "Close" });
  const [convertBox, closeBox, cancelBox, saveBox] = await Promise.all([
    convertButton.boundingBox(),
    closeButton.boundingBox(),
    reservationDialog.getByRole("button", { name: "Cancel" }).boundingBox(),
    reservationDialog.getByRole("button", { name: "Save changes" }).boundingBox(),
  ]);
  await expect(reservationDialog.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  expect(convertBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(cancelBox).not.toBeNull();
  expect(saveBox).not.toBeNull();
  const convertCentreY = (convertBox?.y ?? 0) + (convertBox?.height ?? 0) / 2;
  const closeCentreY = (closeBox?.y ?? 0) + (closeBox?.height ?? 0) / 2;
  expect(Math.abs(convertCentreY - closeCentreY)).toBeLessThanOrEqual(1);
  expect(Math.abs((convertBox?.height ?? 0) - (closeBox?.height ?? 0))).toBeLessThanOrEqual(1);
  expect(convertBox?.x ?? 0).toBeLessThan(closeBox?.x ?? 0);
  expect((closeBox?.y ?? 0) + (closeBox?.height ?? 0)).toBeLessThan(cancelBox?.y ?? 0);
  expect(Math.abs((cancelBox?.y ?? 0) - (saveBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(cancelBox?.x ?? 0).toBeLessThan(saveBox?.x ?? 0);
  await convertButton.click();

  const deviceDialog = page.getByRole("dialog", { name: "Convert reservation to device" });
  await expect(deviceDialog.getByLabel("Display name")).toHaveValue(reservation.label);
  await expect(deviceDialog.getByLabel("IP address")).toHaveValue(reservation.ip_address);
  await expect(deviceDialog.getByLabel("MAC address")).toHaveValue(reservation.mac_address);
  await expect(deviceDialog.getByLabel("Notes")).toHaveValue(reservation.notes);
  await deviceDialog.getByRole("button", { name: "Convert to device" }).click();

  const confirmDialog = page.getByRole("dialog", { name: "Use reserved IP address?" });
  await expect(confirmDialog).toContainText(reservation.label);
  await expect(confirmDialog).toContainText(reservation.mac_address);
  await confirmDialog.getByRole("button", { name: "Delete reservation and create device" }).click();

  await expect(deviceDialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[0].claim_reservation).toBe(false);
  expect(requests[1].claim_reservation).toBe(true);
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


// ── External IPs ─────────────────────────────────────────────────────────────
//
// The page is now one flat `nm-table` of addresses with a Group-by lens over it.
// The provider → cloud-service → allocation tree, its utilisation bars, and the
// Cloud assets page that hung off it are gone; the specs that covered them have
// been removed rather than retargeted, because there is nothing left to point at.
// Workflow coverage lives in `external-ip-addresses.spec.ts`; what stays here is
// the theming contract.

const LOCATIONS = [
  { id: 1, account_id: 1, name: "Sydney", region: "ap-southeast-2" },
  { id: 2, account_id: null, name: "On-premises", region: null },
];
const ACCOUNTS = [{ id: 1, provider_id: 1, name: "Production" }];
const ADDRESSES = [
  mockAddress({ id: 1, ip_address: "203.0.113.10", location_id: 1, status: "in_use", label: "Public web endpoint", owner: "Platform", tags: "production,wan" }),
  mockAddress({ id: 2, ip_address: "203.0.113.11", location_id: 1, status: "available" }),
  mockAddress({ id: 3, ip_address: "203.0.113.12", location_id: 1, status: "reserved" }),
  mockAddress({ id: 4, ip_address: "198.51.100.4", location_id: null, status: "available" }),
];

/** Read-only fixtures for the theme guards — mutation is exercised in the workflow spec. */
async function mockExternal(page: Page) {
  await page.route("**/api/v1/admin/cloud-providers", (route) => route.fulfill({ json: [AWS] }));
  await page.route("**/api/v1/ipam/external/summary", (route) => route.fulfill({
    json: { pool_count: 0, total: 4, in_use: 1, reserved: 1, free: 2, asset_count: 0, unassigned_address_count: 1 },
  }));
  await page.route("**/api/v1/ipam/external/migration-report", (route) => route.fulfill({ json: null }));
  await page.route("**/api/v1/ipam/external/accounts", (route) => route.fulfill({ json: ACCOUNTS }));
  await page.route("**/api/v1/ipam/external/locations", (route) => route.fulfill({ json: LOCATIONS }));
  await page.route("**/api/v1/ipam/external/addresses", (route) => route.fulfill({ json: ADDRESSES }));
}

/** Resolves a `--nm-*` token in the context of the element that inherits it. */
async function resolveToken(locator: Locator, token: string) {
  return locator.evaluate((node, name) => {
    const probe = document.createElement("div");
    node.appendChild(probe);
    probe.style.backgroundColor = getComputedStyle(node).getPropertyValue(name).trim();
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, token);
}

for (const theme of ["light", "dark"] as const) {
  test(`the Location picker wears the reference combobox's tokens in ${theme} mode`, async ({ page }) => {
    // `.theme-lab-combobox` in the theme-preview workspace is the sanctioned
    // "Location combobox" example and this picker is its production
    // counterpart, but that workspace is `import.meta.env.DEV`-only and is not
    // in the build Playwright serves — so this pins the tokens the reference
    // decides rather than diffing against the live element.
    //
    // It is the guard for the picker drifting off the reference: a 3px accent
    // glow on the filter field, an accent-filled create row, option rows at
    // --nm-text/--nm-text-sm instead of --nm-text-muted/--nm-text-xs, and a
    // filter input that the modal's own form rules repainted into a second
    // bordered well inside the filter row.
    await setupIpam(page, theme, async () => { await mockExternal(page); });
    await openExternalIps(page);
    await page.getByRole("button", { name: "Add external IP" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add external IP" });
    await dialog.getByRole("button", { name: "Location", exact: true }).click();
    await expect(dialog.getByRole("listbox")).toBeVisible();
    await expect(dialog.getByLabel("Filter Location")).toBeFocused();

    const menu = page.locator(".nm-pick-menu");
    const surfaces = await menu.evaluate((node) => {
      const read = (selector: string, root: Element = node) => {
        const el = selector ? root.querySelector(selector) : root;
        if (!el) throw new Error(`missing ${selector}`);
        return getComputedStyle(el);
      };
      const shell = read("");
      const row = read(".nm-pick-filter");
      const input = read(".nm-pick-filter input");
      const option = read('.nm-pick-row[role="option"]:not(.nm-pick-row--hl)');
      const highlighted = read(".nm-pick-row--hl");
      const create = read(".nm-pick-row--create");
      return {
        menuBg: shell.backgroundColor, menuBorder: shell.borderTopColor,
        rowBg: row.backgroundColor,
        inputBorderWidth: input.borderTopWidth, inputBg: input.backgroundColor,
        inputOutline: input.outlineStyle, inputPadding: input.paddingLeft,
        optionColor: option.color, optionSize: option.fontSize, optionMinHeight: option.minHeight,
        highlightedBg: highlighted.backgroundColor,
        createBg: create.backgroundColor,
      };
    });

    const token = (name: string) => resolveToken(menu, name);

    // The menu shell and its filter well come straight from the reference.
    expect(surfaces.menuBg).toBe(await token("--nm-modal-header"));
    expect(surfaces.menuBorder).toBe(await token("--nm-border-strong"));
    expect(surfaces.rowBg).toBe(await token("--nm-modal-input"));

    // The filter row *is* the field: the input inside it paints nothing of its
    // own, no border, no well, and no focus outline even while focused.
    expect(surfaces.inputBorderWidth).toBe("0px");
    expect(surfaces.inputBg).toBe("rgba(0, 0, 0, 0)");
    expect(surfaces.inputOutline).toBe("none");
    expect(surfaces.inputPadding).toBe("0px");

    // Option rows are the reference's muted, compact type…
    expect(surfaces.optionColor).toBe(await token("--nm-text-muted"));
    const textXs = await menu.evaluate((node) => getComputedStyle(node).getPropertyValue("--nm-text-xs").trim());
    expect(surfaces.optionSize).toBe(textXs);
    expect(surfaces.optionMinHeight).toBe("31px");

    // …and both the highlight and the create action share one hover surface,
    // rather than the create row taking a filled accent of its own.
    const hover = await token("--nm-tab-hover-bg");
    expect(surfaces.highlightedBg).toBe(hover);
    expect(surfaces.createBg).toBe("rgba(0, 0, 0, 0)");
    await page.locator(".nm-pick-row--create").hover();
    await expect.poll(() => page.locator(".nm-pick-row--create")
      .evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(hover);
  });
}

test("External IPs is one flat register of addresses, not a tree", async ({ page }) => {
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await openExternalIps(page);

  // One table, one row per address, plus a group header per bucket of the current lens.
  await expect(page.locator(".external-ip-address-row")).toHaveCount(4);
  // Sydney, the address-less On-premises location (which still needs Edit/Delete),
  // and Unassigned for the address that has no location at all.
  await expect(page.locator(".external-ip-group-name")).toHaveText(["On-premises", "Sydney", "Unassigned"]);

  // Every trace of the old hierarchy is gone — no provider/service/allocation tiers,
  // no tree rails, no utilisation bars, and no "Needs location" placeholder.
  for (const selector of [
    ".external-ip-provider-row",
    ".external-ip-service-row",
    ".external-ip-pool-row",
    ".external-ip-tree-level-1",
    ".external-ip-tree-level-2",
    ".external-ip-tree-level-3",
    ".external-ip-utilization",
    ".external-ip-ranges-row",
    ".external-ip-grid",
  ]) {
    await expect(page.locator(selector)).toHaveCount(0);
  }
  await expect(page.getByText("Needs location")).toHaveCount(0);

  // A single primary action, and the lens control beside the filters.
  await expect(page.getByRole("button", { name: "Add external IP" })).toHaveCount(1);
  const header = page.locator(".external-ip-panel-header");
  await expect(header.getByRole("searchbox", { name: "Search external IPs" })).toBeVisible();
  await expect(header.locator(".external-ip-status-filter > span")).toHaveText(["Status", "Group by"]);
  await expect(header.getByLabel("Group by")).toHaveValue("location");
  await expect(header.getByRole("button", { name: "Clear filters" })).toBeVisible();
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

    await page.getByRole("link", { name: "Inventory", exact: true }).click();
    await expect(page.locator(".inventory-table-header").first()).toBeVisible();
    const inventory = await read(".inventory-table-header");

    await page.getByRole("link", { name: "IPAM", exact: true }).click();
    await openExternalIps(page);
    const ipam = await read(".external-ip-table thead th");

    expect(ipam).toEqual(inventory);
    // ...and it is genuinely the shared token, not a coincidence of two hard-coded values.
    const token = await resolveToken(page.locator(".external-ip-table thead th").first(), "--nm-table-header-bg");
    expect(inventory.bg).toBe(token);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`the address register wears the workspace surfaces in ${theme} mode`, async ({ page }) => {
    // The ruled contract: header cells take --nm-table-header-bg (so the header matches
    // Inventory), ordinary body cells take the workspace's own --nm-modal-section, and a
    // group header takes --nm-modal-header. The project's theming doc contradicted itself
    // on this; these three assertions are what settled it.
    await setupIpam(page, theme, async () => { await mockExternal(page); });
    await openExternalIps(page);

    const table = page.locator(".external-ip-table");
    await expect(table).toHaveClass(/\bnm-table\b/);
    await expect(page.locator(".nm-table-wrap.external-ip-table-wrap")).toBeVisible();

    const th = table.locator("thead th").first();
    await expect(th).toHaveCSS("text-transform", "uppercase");
    await expect(th).toHaveCSS("position", "sticky");
    expect(await th.evaluate((node) => getComputedStyle(node).backgroundColor))
      .toBe(await resolveToken(th, "--nm-table-header-bg"));

    // First row of a group is never banded, so it shows the base cell surface.
    const bodyCell = page.locator(".external-ip-address-row td").first();
    expect(await bodyCell.evaluate((node) => getComputedStyle(node).backgroundColor))
      .toBe(await resolveToken(bodyCell, "--nm-modal-section"));

    const groupCell = page.locator(".external-ip-group-row td").first();
    expect(await groupCell.evaluate((node) => getComputedStyle(node).backgroundColor))
      .toBe(await resolveToken(groupCell, "--nm-modal-header"));

    // Canonical hover: soft tint plus the 3px teal left edge.
    const row = page.locator(".external-ip-address-row").first();
    await row.hover();
    expect(await row.locator("td").first().evaluate((node) => getComputedStyle(node).boxShadow))
      .toContain("29, 154, 176");

    // Every data row fills the same columns as the header.
    const headerCells = await table.locator("thead th").count();
    for (const dataRow of await table.locator("tbody tr").all()) {
      if (await dataRow.locator("td[colspan]").count() > 0) continue;
      expect(await dataRow.locator("td").count()).toBe(headerCells);
    }
  });
}

test("group rows and body cells use different dark surfaces", async ({ page }) => {
  // Depth is only observable in dark: light mode aliases --nm-modal-header and
  // --nm-modal-section to the same value, so the same assertion there passes
  // vacuously and would guard nothing.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await openExternalIps(page);

  const groupBg = await page.locator(".external-ip-group-row td").first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const cellBg = await page.locator(".external-ip-address-row td").first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(groupBg).not.toBe(cellBg);
});

for (const theme of ["light", "dark"] as const) {
  test(`row actions sit flush right in ${theme} mode`, async ({ page }) => {
    await setupIpam(page, theme, async () => { await mockExternal(page); });
    await openExternalIps(page);

    const table = page.locator(".external-ip-table");
    await expect(table.locator("thead th.external-ip-actions")).toHaveCSS("text-align", "right");

    const cell = page.locator(".external-ip-address-row td.external-ip-actions").first();
    await expect(cell).toHaveCSS("text-align", "right");
    const cellBox = await cell.boundingBox();
    const padRight = await cell.evaluate((node) => parseFloat(getComputedStyle(node).paddingRight));
    const boxes = await Promise.all((await cell.getByRole("button").all()).map((button) => button.boundingBox()));
    expect(boxes.length).toBeGreaterThan(0);
    const groupRight = Math.max(...boxes.map((box) => box!.x + box!.width));
    expect(Math.abs(groupRight - (cellBox!.x + cellBox!.width - padRight))).toBeLessThanOrEqual(2);
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

test("two-column form rows size each cell to its own content", async ({ page }) => {
  // The address field carries a live count underneath it; Location beside it does not.
  // With the grid's default `stretch` the taller cell grows its neighbour's control out
  // of alignment, which is what `.nm-form-row { align-items: start }` exists to prevent.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await openExternalIps(page);
  await page.getByRole("button", { name: "Add external IP" }).click();

  const dialog = page.getByRole("dialog", { name: "Add external IP" });
  const formRow = dialog.locator(".nm-form-row").first();
  await expect(formRow).toHaveCSS("align-items", "start");

  await dialog.getByLabel("Address or range").fill("203.0.113.0/29");
  const address = await dialog.getByLabel("Address or range").boundingBox();
  const location = await dialog.getByRole("button", { name: "Location", exact: true }).boundingBox();
  expect(Math.abs(address!.y - location!.y)).toBeLessThanOrEqual(1);
});

test("the Location picker's trigger is a real control surface in dark mode", async ({ page }) => {
  // `PickOrCreate` defaults to --nm-surface, which reads as a darker hole beside the
  // real `.nm-select` next to it; inside a modal it must take the modal input well.
  // A transparent trigger is the failure this catches.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await openExternalIps(page);
  await page.getByRole("button", { name: "Add external IP" }).click();

  const dialog = page.getByRole("dialog", { name: "Add external IP" });
  const trigger = dialog.getByRole("button", { name: "Location", exact: true });
  const background = await trigger.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  expect(background).not.toBe("transparent");
  expect(background).toBe(await resolveToken(trigger, "--nm-modal-input"));
});

test("the Location picker is the same height as the inputs beside it", async ({ page }) => {
  // Regression guard. `.nm-pick-trigger` used to fix `height: var(--nm-control-md)`
  // (32px) while modal form inputs take a 40px min-height, so the Location control
  // sat 8px shorter than the Address field it shares a `.nm-form-row` with.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  await openExternalIps(page);
  await page.getByRole("button", { name: "Add external IP" }).click();

  const dialog = page.getByRole("dialog", { name: "Add external IP" });
  const trigger = dialog.getByRole("button", { name: "Location", exact: true });
  const input = dialog.getByLabel("Address or range");
  // Pre-condition: both controls really rendered, so setup breakage cannot be
  // read as a height match.
  await expect(trigger).toBeVisible();
  await expect(input).toBeVisible();

  const [triggerBox, inputBox] = await Promise.all([trigger.boundingBox(), input.boundingBox()]);
  expect(Math.abs(triggerBox!.height - inputBox!.height)).toBeLessThanOrEqual(1);
});

// ── Sidebar sub-menus ────────────────────────────────────────────────────────
//
// These used "Cloud assets" as their probe sub-item. That page is gone, so they
// now probe Inventory's remaining sub-item, scoped to Inventory's own sub-nav
// because Monitoring has a "Devices" entry too.

function inventorySubItem(page: Page) {
  return page.locator('[aria-label="Inventory sections"]').getByRole("link", { name: "Devices", exact: true });
}

test("the Inventory parent navigates and drops the menu down, never collapsing it", async ({ page }) => {
  // The link and the chevron are separate controls. Clicking the section name goes to its
  // first sub-view and leaves the menu open; only the chevron closes it. Earlier revisions
  // made the parent collapse the menu as a side effect, which hid the sub-items you were
  // about to click.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  const inventoryParent = page.getByRole("link", { name: "Inventory", exact: true });
  const inventoryToggle = page.getByRole("button", { name: /(Collapse|Expand) Inventory sections/ });
  const subItem = inventorySubItem(page);

  await inventoryParent.click();
  await expect(subItem).toBeVisible();
  await expect(page.locator(".inventory-table")).toBeVisible();

  // Chevron closes it without navigating away from Devices. Its rotation is a real
  // transition driven by aria-expanded, not an instantaneous icon replacement.
  const chevron = inventoryToggle.locator(".sidebar-parent-chevron");
  await expect(chevron).toHaveCSS("transition-duration", "0.22s");
  await expect(chevron).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  const expandedTransform = await chevron.evaluate((node) => getComputedStyle(node).transform);
  await inventoryToggle.click();
  const activeAnimations = await chevron.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === "running").length);
  expect(activeAnimations).toBeGreaterThan(0);
  await expect(subItem).toHaveCount(0);
  await expect(page.locator(".inventory-table")).toBeVisible();
  await expect(chevron).not.toHaveCSS("transform", expandedTransform);

  // ...and the parent drops it back down.
  await inventoryParent.click();
  await expect(subItem).toBeVisible();
  await expect(chevron).toHaveCSS("transform", expandedTransform);
});

test("sidebar section menus stay open when you leave the section", async ({ page }) => {
  // They used to be seeded from the current route and force-expanded on arrival, so leaving
  // a section collapsed its menu and returning discarded a deliberate collapse.
  await setupIpam(page, "dark", async () => { await mockExternal(page); });
  const inventoryParent = page.getByRole("link", { name: "Inventory", exact: true });
  const monitoringParent = page.getByRole("link", { name: "Monitoring", exact: true });
  const topology = page.getByRole("link", { name: "Topology", exact: true });
  const subItem = inventorySubItem(page);

  await inventoryParent.click();
  await expect(subItem).toBeVisible();

  // Leaving Inventory entirely no longer closes its menu...
  await topology.click();
  await expect(subItem).toBeVisible();
  const inventoryToggle = page.getByRole("button", { name: /^(Collapse|Expand) Inventory sections$/ });
  await expect(inventoryToggle).toHaveAttribute("aria-expanded", "true");
  // ...and nothing in it claims to be the current page while we are elsewhere.
  await expect(subItem).not.toHaveAttribute("aria-current", "page");

  // A sub-item still works from off-route: it takes you back to its section.
  await subItem.click();
  await expect(page.locator(".inventory-table")).toBeVisible();
  await expect(subItem).toHaveAttribute("aria-current", "page");

  // Inventory's off-route chevron still reflects its sticky open menu and animates shut.
  await topology.click();
  const inventoryChevron = inventoryToggle.locator(".sidebar-parent-chevron");
  await expect(inventoryChevron).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await inventoryToggle.click();
  expect(await inventoryChevron.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === "running").length)).toBeGreaterThan(0);
  await expect(inventoryToggle).toHaveAttribute("aria-expanded", "false");
  await expect(subItem).toHaveCount(0);

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
  const inventoryParent = page.getByRole("link", { name: "Inventory", exact: true });
  const inventoryToggle = page.getByRole("button", { name: /(Collapse|Expand) Inventory sections/ });
  const subItem = inventorySubItem(page);

  await inventoryParent.click();
  await expect(subItem).toBeVisible();
  await inventoryToggle.click();
  await expect(subItem).toHaveCount(0);

  // Move elsewhere: still collapsed.
  await page.getByRole("link", { name: "Topology", exact: true }).click();
  await expect(subItem).toHaveCount(0);

  // Persisted, not just held in memory.
  await page.reload();
  await expect(subItem).toHaveCount(0);
});

test("signing out resets remembered sidebar menu states", async ({ page }) => {
  const menuKeys = ["admin", "inventory", "ipam", "monitoring"]
    .map((section) => `netmap.sidebar.menu.${section}`);

  await setupIpam(page, "dark", async () => {
    await page.route("**/api/v1/auth/logout", (route) => route.fulfill({ status: 204, body: "" }));
    await page.addInitScript((keys) => {
      keys.forEach((key, index) => window.localStorage.setItem(key, index % 2 === 0 ? "open" : "closed"));
    }, menuKeys);
  });

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => page.evaluate((keys) => keys.map((key) => window.localStorage.getItem(key)), menuKeys))
    .toEqual([null, null, null, null]);
});

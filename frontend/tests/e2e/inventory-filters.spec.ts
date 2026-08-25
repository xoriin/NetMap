import { test, expect } from "@playwright/test";
import {
  setupCoreMocks,
  setupTopologyMocks,
  setupInventoryMocks,
  mockDevice,
} from "./helpers/api-mocks";

/**
 * The bulk menu is a native <details>, which only closes via its own summary.
 * These pin the controlled-dismiss behaviour layered on top of it.
 */
test.describe("Inventory bulk menu", () => {
  test.beforeEach(async ({ page }) => {
    const devices = [
      mockDevice({ id: 1, hostname: "router-01", ip_address: "192.168.1.1" }),
      mockDevice({ id: 2, hostname: "switch-01", ip_address: "192.168.1.2" }),
    ];
    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices);
    await setupInventoryMocks(page, devices);
    await page.goto("/inventory");
  });

  async function openBulkMenu(page: import("@playwright/test").Page) {
    const summary = page.locator(".inv-bulk-menu summary");
    await summary.waitFor({ state: "visible", timeout: 8000 });
    await summary.click();
    await expect(page.locator(".inv-bulk-menu-panel")).toBeVisible();
  }

  test("closes when clicking outside it", async ({ page }) => {
    await openBulkMenu(page);

    // Somewhere clearly outside the menu.
    await page.locator(".inv-panel-title").click();

    await expect(page.locator(".inv-bulk-menu-panel")).toBeHidden();
  });

  test("stays open while using a picker inside it", async ({ page }) => {
    await openBulkMenu(page);

    await page.locator(".inv-bulk-menu-field .nm-swatch-trigger").first().click();
    await expect(page.locator(".inv-bulk-menu .nm-swatch-list")).toBeVisible();
    await expect(page.locator(".inv-bulk-menu-panel")).toBeVisible();
  });

  test("Escape closes an open picker before the menu itself", async ({ page }) => {
    await openBulkMenu(page);
    await page.locator(".inv-bulk-menu-field .nm-swatch-trigger").first().click();
    await expect(page.locator(".inv-bulk-menu .nm-swatch-list")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".inv-bulk-menu .nm-swatch-list")).toBeHidden();
    await expect(page.locator(".inv-bulk-menu-panel")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".inv-bulk-menu-panel")).toBeHidden();
  });
});

test.describe("Inventory device type filter", () => {
  test.beforeEach(async ({ page }) => {
    const devices = [
      mockDevice({ id: 1, hostname: "router-01", ip_address: "192.168.1.1", device_type: "router" }),
      mockDevice({ id: 2, hostname: "switch-01", ip_address: "192.168.1.2", device_type: "switch" }),
      mockDevice({ id: 3, hostname: "switch-02", ip_address: "192.168.1.3", device_type: "switch", monitor_status: "offline" }),
    ];
    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices);
    await setupInventoryMocks(page, devices);
    await page.goto("/inventory");
  });

  test("offers only the types actually in use, and filters by them", async ({ page }) => {
    const typeFilter = page.getByRole("button", { name: "Filter by device type" });
    await typeFilter.waitFor({ state: "visible", timeout: 8000 });
    await expect(page.locator(".inventory-row")).toHaveCount(3);

    await typeFilter.click();
    const options = page.locator(".nm-swatch-list .nm-swatch-option");
    // All types + router + switch — no options for the 15 unused built-ins.
    await expect(options).toHaveCount(3);

    await options.filter({ hasText: "Switch" }).click();
    await expect(page.locator(".inventory-row")).toHaveCount(2);
  });

  test("uses the colour-aware status picker and filters by status", async ({ page }) => {
    const statusFilter = page.getByRole("button", { name: "Filter by status" });
    await statusFilter.waitFor({ state: "visible", timeout: 8000 });
    await expect(statusFilter).toContainText("All statuses");

    await statusFilter.click();
    const offlineOption = page.getByRole("option", { name: "Offline" });
    await expect(offlineOption.locator(".nm-swatch-dot")).toBeVisible();
    await offlineOption.click();

    await expect(statusFilter).toContainText("Offline");
    await expect(page.locator(".inventory-row")).toHaveCount(1);
    await expect(page.locator(".inventory-row")).toContainText("switch-02");
  });

  test("shows the same 24-hour average RTT used by Monitoring", async ({ page }) => {
    const routerRow = page.locator(".inventory-row", { hasText: "router-01" });
    await expect(routerRow).toContainText("20.1 ms");
  });
});

test.describe("Reserved IP allocation", () => {
  test("confirms before deleting a reservation and creating the device", async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page, []);
    await setupInventoryMocks(page, []);
    const requests: Record<string, unknown>[] = [];
    await page.route("**/api/v1/topology/devices", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = await route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      if (!body.claim_reservation) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ detail: { code: "ip_reservation_conflict", reservation_id: 7, ip_address: "192.168.1.50", label: "Printer allocation", mac_address: "00:11:22:33:44:55", can_claim: true } }),
        });
        return;
      }
      await route.fulfill({ json: mockDevice({ id: 50, hostname: "printer", ip_address: "192.168.1.50" }) });
    });
    await page.goto("/inventory");
    await page.getByRole("button", { name: "+ Device" }).click();
    const deviceDialog = page.getByRole("dialog", { name: "Add device" });
    await deviceDialog.getByLabel("Hostname").fill("printer");
    await deviceDialog.getByLabel("IP address").fill("192.168.1.50");
    await deviceDialog.getByRole("button", { name: "Save" }).click();

    const confirmDialog = page.getByRole("dialog", { name: "Use reserved IP address?" });
    await expect(confirmDialog).toContainText("Printer allocation");
    await expect(confirmDialog).toContainText("00:11:22:33:44:55");
    await confirmDialog.getByRole("button", { name: "Delete reservation and create device" }).click();

    await expect(deviceDialog).toBeHidden();
    expect(requests).toHaveLength(2);
    expect(requests[0].claim_reservation).toBe(false);
    expect(requests[1].claim_reservation).toBe(true);
  });
});

test.describe("Inventory approved workspace hierarchy", () => {
  const devices = [
    mockDevice({ id: 1, hostname: "router-01", display_name: "Core Router", ip_address: "192.168.1.1", device_type: "router" }),
    mockDevice({ id: 2, hostname: "switch-01", display_name: "Access Switch", ip_address: "192.168.1.2", device_type: "switch" }),
    mockDevice({ id: 3, hostname: "server-01", display_name: "App Server", ip_address: "192.168.1.3", device_type: "server" }),
  ];

  async function openInventory(
    page: import("@playwright/test").Page,
    theme: "light" | "dark" = "dark",
    announcement: string | null = null,
  ) {
    await setupCoreMocks(page, announcement);
    await setupTopologyMocks(page, devices);
    await setupInventoryMocks(page, devices);
    await page.route("**/api/v1/tools/snmp/profiles", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/v1/topology/devices/*/security-events*", (route) => route.fulfill({
      json: { device_id: 1, window_hours: 24, total: 0, severity_counts: {}, events: [] },
    }));
    await page.addInitScript((selectedTheme) => {
      window.localStorage.setItem("netmap.theme", selectedTheme);
      window.localStorage.removeItem("netmap.inv_col_widths_v1");
    }, theme);
    await page.goto("/inventory");
    await page.locator(".inventory-surface").waitFor({ state: "visible", timeout: 8000 });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`uses the canonical full-width table treatment in ${theme} mode`, async ({ page }) => {
      await openInventory(page, theme);

      const surface = page.locator(".inventory-surface.nm-app-panel");
      const header = surface.locator(":scope > .inventory-panel-header.nm-app-panel-header");
      const table = surface.locator(":scope > .inventory-table");
      await expect(surface).toBeVisible();
      await expect(header).toBeVisible();
      await expect(header).toHaveCSS("min-height", "44px");
      await expect(surface).toHaveCSS("background-image", "none");
      await expect(header).toHaveCSS("background-image", "none");
      await expect(table).toHaveCSS("background-image", "none");
      await expect(page.getByRole("complementary", { name: "Device overview" })).toHaveCount(0);
      await expect(page.getByPlaceholder("Search devices…")).toBeVisible();
      await expect(header.getByRole("button", { name: "Import" })).toBeVisible();

      const [surfaceBox, contentBox] = await Promise.all([
        surface.boundingBox(),
        page.locator(".topology-content").boundingBox(),
      ]);
      expect(surfaceBox).not.toBeNull();
      expect(contentBox).not.toBeNull();
      // topology-content owns the canonical 24px workspace gutter on both
      // sides; the table panel fills all usable width inside that gutter.
      expect(Math.abs((surfaceBox?.width ?? 0) - ((contentBox?.width ?? 0) - 48))).toBeLessThanOrEqual(2);
    });
  }

  test("keeps the full-bleed MOTD, summary row, and table on one inner gutter", async ({ page }) => {
    await openInventory(page, "dark", "Planned maintenance");

    const [workspaceBox, motdBox, summaryBox, surfaceBox] = await Promise.all([
      page.locator(".workspace").boundingBox(),
      page.locator(".dash-alert--announcement").boundingBox(),
      page.locator(".inventory-stats.nm-summary-band").boundingBox(),
      page.locator(".inventory-surface").boundingBox(),
    ]);
    expect(workspaceBox).not.toBeNull();
    expect(motdBox).not.toBeNull();
    expect(summaryBox).not.toBeNull();
    expect(surfaceBox).not.toBeNull();
    for (const box of [motdBox!, summaryBox!, surfaceBox!]) {
      expect(Math.abs(box.x - workspaceBox!.x - 24)).toBeLessThanOrEqual(1);
      expect(Math.abs((box.x + box.width) - (workspaceBox!.x + workspaceBox!.width - 24))).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(summaryBox!.y - (motdBox!.y + motdBox!.height) - 16)).toBeLessThanOrEqual(1);
  });

  test("opens device details in a closable contextual sidebar", async ({ page }) => {
    await openInventory(page);
    const surface = page.locator(".inventory-surface");
    const widthBefore = (await surface.boundingBox())?.width ?? 0;

    await page.locator(".inventory-row").first().click();
    const sidebar = page.getByRole("complementary", { name: "Device overview" });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator(".inventory-device-sidebar-body")).toBeVisible();
    await expect(sidebar.getByRole("heading", { name: "Access Switch" })).toBeVisible();
    await expect(sidebar.getByText("observed online", { exact: true })).toBeVisible();
    await expect(sidebar.locator("dl").getByText("18.6 ms", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("24 h avg 20.1 ms", { exact: true })).toBeVisible();

    const widthWithSidebar = (await surface.boundingBox())?.width ?? 0;
    expect(widthWithSidebar).toBeLessThan(widthBefore - 300);
    await sidebar.getByRole("button", { name: "Close device overview" }).click();
    await expect(sidebar).toBeHidden();
    const widthAfterClose = (await surface.boundingBox())?.width ?? 0;
    expect(Math.abs(widthAfterClose - widthBefore)).toBeLessThanOrEqual(2);
  });

  test("keeps row selection, favourites, and bulk selection as independent valid controls", async ({ page }) => {
    await openInventory(page);
    const row = page.locator(".inventory-row").first();
    await expect(row.locator("button button, button input")).toHaveCount(0);
    await expect(row).not.toHaveAttribute("role", "button");

    const openDetails = row.getByRole("button", { name: "Open Access Switch details" });
    await openDetails.focus();
    await page.keyboard.press("Enter");
    const sidebar = page.getByRole("complementary", { name: "Device overview" });
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole("button", { name: "Close device overview" }).click();

    await row.getByRole("checkbox", { name: "Select Access Switch" }).click();
    await expect(sidebar).toBeHidden();
    await row.getByRole("button", { name: "Add to favourites" }).click();
    await expect(sidebar).toBeHidden();
  });

  test("keeps the row canvas full width while one column is resized", async ({ page }) => {
    await openInventory(page);
    const table = page.locator(".inventory-table");
    const header = page.locator(".inventory-table-header");
    const deviceCell = header.locator(":scope > span").nth(1);
    const ipCell = header.locator(":scope > span").nth(2);
    const handle = page.locator(".inventory-col-resize-handle").first();
    const deviceBefore = (await deviceCell.boundingBox())?.width ?? 0;
    const ipBefore = (await ipCell.boundingBox())?.width ?? 0;
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();

    await page.mouse.move((handleBox?.x ?? 0) + 2, (handleBox?.y ?? 0) + 8);
    await page.mouse.down();
    await page.mouse.move((handleBox?.x ?? 0) + 62, (handleBox?.y ?? 0) + 8);
    await page.mouse.up();

    await expect(table).toHaveClass(/inventory-table--fixed/);
    const deviceAfter = (await deviceCell.boundingBox())?.width ?? 0;
    const ipAfter = (await ipCell.boundingBox())?.width ?? 0;
    expect(deviceAfter).toBeGreaterThan(deviceBefore + 45);
    expect(Math.abs(ipAfter - ipBefore)).toBeLessThanOrEqual(2);

    const [tableWidth, rowWidth] = await Promise.all([
      table.evaluate((node) => node.clientWidth),
      page.locator(".inventory-row").first().evaluate((node) => node.getBoundingClientRect().width),
    ]);
    expect(rowWidth).toBeGreaterThanOrEqual(tableWidth);
    await expect(page.locator(".inventory-row").first()).toHaveCSS("border-bottom-style", "solid");
  });
});


/**
 * The status pill is an inline-flex row whose coloured dot is a ::before flex
 * item. Truncating long expected-state labels by switching the pill to
 * inline-block drops that dot onto its own line above the text, which shipped
 * briefly and looked broken across the whole Inventory table.
 */
test.describe("Inventory status pill", () => {
  test("keeps the status dot inline with its label", async ({ page }) => {
    const devices = [
      mockDevice({
        id: 1,
        hostname: "deliberately-down",
        ip_address: "192.168.1.9",
        monitor_status: "offline",
        expected_status: "online",
      }),
    ];
    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices);
    await setupInventoryMocks(page, devices);
    await page.goto("/inventory");

    const pill = page.locator(".inventory-row .status-pill").first();
    await expect(pill).toBeVisible();
    // Grid items are blockified, so inline-flex computes to flex — the point
    // is that it stays a flex container and the ::before dot stays in-line.
    await expect(pill).toHaveCSS("display", "flex");

    // The dot sits to the left of the text on the same line, not above it.
    const pillBox = await pill.boundingBox();
    const textBox = await pill.locator(".status-pill-text").boundingBox();
    expect(pillBox).not.toBeNull();
    expect(textBox).not.toBeNull();
    // A wrapped dot would push the text box well below the pill's top edge.
    expect(textBox!.height).toBeLessThanOrEqual(pillBox!.height);
    expect(textBox!.y).toBeGreaterThanOrEqual(pillBox!.y);
    expect(pillBox!.height).toBeLessThanOrEqual(32);
  });
});

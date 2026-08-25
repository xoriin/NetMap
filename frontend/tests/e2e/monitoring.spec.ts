import { test, expect } from "@playwright/test";
import {
  setupCoreMocks,
  setupMonitoringMocks,
  setupTopologyMocks,
  mockDevice,
  mockMonitoringDevice,
} from "./helpers/api-mocks";

test.describe("Monitoring workspace", () => {
  test.beforeEach(async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page, [
      mockDevice({ id: 1, display_name: "Core Router With A Longer Name", hostname: "router-core-01", ip_address: "192.168.100.1", device_type: "router", icon: "router" }),
      mockDevice({ id: 2, display_name: "Access Switch", hostname: "switch-access-01", ip_address: "192.168.100.2", device_type: "switch", icon: "switch" }),
    ]);
    await setupMonitoringMocks(page, [
      mockMonitoringDevice({
        device_id: 1,
        display_name: "Core Router With A Longer Name",
        hostname: "router-core-01",
        ip_address: "192.168.100.1",
        device_type: undefined,
        icon: undefined,
        latest_port_results: [
          { target_id: 3, port: 443, label: "Web", check_type: "tcp", open: true, status: "open" },
          { target_id: 2, port: 53, label: "dns", check_type: "udp", open: true, status: "open" },
          { target_id: 1, port: 22, label: "SSH", check_type: "tcp", open: true, status: "open" },
        ],
      }),
      mockMonitoringDevice({
        device_id: 2,
        display_name: "Access Switch",
        hostname: "switch-access-01",
        ip_address: "192.168.100.2",
        device_type: undefined,
        icon: undefined,
        status: "offline",
        expected_status: "offline",
        health_status: "healthy",
        heartbeat: ["offline", "offline"],
        heartbeat_health: ["healthy", "healthy"],
      }),
    ]);
    await page.goto("/");
    await page.getByRole("link", { name: "Monitoring", exact: true }).click();
  });

  test("allocates most row width to heartbeat and RTT displays", async ({ page }) => {
    const row = page.locator(".mon-row").first();
    await expect(row).toBeVisible();

    // The inline RTT sparkline moved to the detail panel; rows now show
    // name/IP plus the heartbeat strip, which must dominate the row width.
    const deviceCell = row.locator("td").nth(2);
    const heartbeat = deviceCell.locator(".heartbeat-bar--sm");

    await expect(heartbeat).toBeVisible();

    const widths = await page.evaluate(() => {
      const rowEl = document.querySelector(".mon-row");
      if (!rowEl) return null;
      const cells = Array.from(rowEl.querySelectorAll("td"));
      return {
        device: cells[2]?.getBoundingClientRect().width ?? 0,
        uptime: cells[4]?.getBoundingClientRect().width ?? 0,
        services: cells[7]?.getBoundingClientRect().width ?? 0,
        heartbeat: document.querySelector(".heartbeat-bar--sm")?.getBoundingClientRect().width ?? 0,
      };
    });

    expect(widths).not.toBeNull();
    // Device cell (name + heartbeat strip) must dominate the metadata columns.
    expect(widths!.device).toBeGreaterThan(widths!.uptime * 1.5);
    expect(widths!.device).toBeGreaterThan(widths!.services * 1.5);
    // Heartbeat strip width scales with beat count; require it to fill
    // most of the device cell rather than an absolute pixel width.
    expect(widths!.heartbeat).toBeGreaterThan(widths!.device * 0.4);
    expect(widths!.services).toBeLessThanOrEqual(240);
  });

  test("shows the full device name above the heartbeat strip", async ({ page }) => {
    const cell = page.locator(".mon-row", { hasText: "Core Router With A Longer Name" }).locator(".mon-device-cell");
    const name = cell.locator(".mon-device-name");
    const heartbeat = cell.locator(".heartbeat-bar--sm");
    await expect(name).toHaveText("Core Router With A Longer Name");
    const layout = await cell.evaluate((element) => {
      const nameRect = element.querySelector(".mon-device-name")!.getBoundingClientRect();
      const heartbeatRect = element.querySelector(".heartbeat-bar--sm")!.getBoundingClientRect();
      return { nameBottom: nameRect.bottom, heartbeatTop: heartbeatRect.top, clipped: element.querySelector(".mon-device-name")!.scrollWidth > element.querySelector(".mon-device-name")!.clientWidth };
    });
    expect(layout.nameBottom).toBeLessThanOrEqual(layout.heartbeatTop);
    expect(layout.clipped).toBe(false);
  });

  test("sorts service badges alphabetically for every device", async ({ page }) => {
    const badges = page.locator(".mon-row", { hasText: "Core Router With A Longer Name" }).locator(".mon-port-badge");
    await expect(badges).toHaveCount(3);
    await expect(badges).toHaveText(["dns", "SSH", "Web"]);
  });

  test("edits an existing port monitoring method without recreating it", async ({ page }) => {
    const target = {
      id: 12, device_id: null, port: 443, label: "Web health", check_type: "https",
      http_path: "/health", http_method: "GET", expected_status_min: 200,
      expected_status_max: 399, timeout_seconds: 5, verify_tls: true,
      follow_redirects: true, enabled: true, created_at: "2026-08-19T00:00:00Z",
    };
    let updateBody: Record<string, unknown> | null = null;
    await page.route("**/api/v1/monitoring/service-checks", (route) => route.fulfill({ json: [target] }));
    await page.route("**/api/v1/monitoring/service-checks/12", async (route) => {
      updateBody = route.request().postDataJSON();
      await route.fulfill({ json: { ...target, ...updateBody } });
    });
    await page.reload();

    await page.getByRole("button", { name: /Monitored ports/ }).click();
    await page.getByRole("button", { name: "Edit Web health" }).click();
    await page.getByLabel("Method").selectOption("HEAD");
    await page.getByRole("button", { name: "Update", exact: true }).click();

    await expect.poll(() => updateBody?.http_method).toBe("HEAD");
  });

  test("lets an authorised user organise service checks into a custom order", async ({ page }) => {
    const targets = [
      { id: 1, device_id: null, port: 53, label: "DNS", check_type: "udp", http_path: null, http_method: "GET", expected_status_min: 200, expected_status_max: 399, timeout_seconds: null, verify_tls: false, follow_redirects: true, enabled: true, sort_order: 1, created_at: "2026-08-19T00:00:00Z" },
      { id: 2, device_id: null, port: 22, label: "SSH", check_type: "tcp", http_path: null, http_method: "GET", expected_status_min: 200, expected_status_max: 399, timeout_seconds: null, verify_tls: false, follow_redirects: true, enabled: true, sort_order: 2, created_at: "2026-08-19T00:00:00Z" },
    ];
    let savedOrder: number[] | null = null;
    await page.route("**/api/v1/monitoring/service-checks", (route) => route.fulfill({ json: targets }));
    await page.route("**/api/v1/monitoring/service-checks/order-config", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: { mode: "alphabetical" } });
      const body = route.request().postDataJSON();
      if (body.mode === "manual" && body.target_ids) savedOrder = body.target_ids;
      const order = body.target_ids ?? targets.map((target) => target.id);
      await route.fulfill({ json: order.map((id: number, index: number) => ({ ...targets.find((target) => target.id === id)!, sort_order: index + 1 })) });
    });
    await page.reload();

    await page.getByRole("button", { name: /Monitored ports/ }).click();
    await page.getByRole("button", { name: "Organise" }).click();
    await page.getByRole("button", { name: "Manual" }).click();
    await page.getByRole("button", { name: "Drag DNS to reorder" }).dragTo(page.locator(".incident-row", { hasText: "SSH" }));

    await expect.poll(() => savedOrder).toEqual([2, 1]);
  });

  test("uses the shared table header treatment without losing table behaviour", async ({ page }) => {
    // Monitoring's header used to be 12px sentence case on the same surface as its own
    // rows, so it did not read as a header and the page looked unrelated to Inventory
    // and IPAM. All three now share Inventory's treatment: 11px/700 uppercase at 0.06em
    // on --nm-modal-header, divided from --nm-modal-section rows by --nm-border-strong.
    const header = page.locator(".mon-table--fleet th").nth(2);
    const cell = page.locator(".mon-row td").nth(2);
    await expect(header).toHaveCSS("text-transform", "uppercase");
    await expect(header).toHaveCSS("font-weight", "700");
    await expect(header).toHaveCSS("font-size", "11px");
    await expect(header).toHaveCSS("letter-spacing", "0.66px");
    await expect(header).toHaveCSS("border-right-width", "0px");

    const resolved = await header.evaluate((node) => {
      const probe = document.createElement("div");
      node.appendChild(probe);
      const read = (name: string) => {
        probe.style.backgroundColor = getComputedStyle(node).getPropertyValue(name).trim();
        return getComputedStyle(probe).backgroundColor;
      };
      const out = { header: read("--nm-table-header-bg"), section: read("--nm-table-row-bg") };
      probe.remove();
      return out;
    });
    await expect(header).toHaveCSS("background-color", resolved.header);
    await expect(page.locator(".mon-row").first()).toHaveCSS("background-color", resolved.section);
    await expect(page.locator(".mon-view-window")).toHaveCSS("border-radius", "10px");
    await expect(page.locator(".mon-table--fleet th").nth(3)).toContainText("Type");
    await expect(page.locator(".mon-row", { hasText: "Core Router" }).locator("td").nth(3).locator(".nm-chip")).toContainText("Router");
  });

  test("uses the same canonical panel and table theme for devices and endpoints", async ({ page }) => {
    await page.route("**/api/v1/monitors", (route) => route.fulfill({ json: [{
      id: 7,
      name: "Public API",
      url: "https://api.example.com/health",
      enabled: true,
      last_status: "online",
      last_checked_at: "2026-08-02T11:00:00Z",
      uptime_24h: 96.7,
      uptime_7d: 99.1,
      avg_response_time_24h: 42.3,
      heartbeat: ["online", "online"],
    }] }));
    await expect(page.locator(".mon-table--fleet")).toBeVisible();

    const theme = async (panel: string, header: string, table: string) => page.evaluate(({ panel, header, table }) => {
      const styles = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing theme sample: ${selector}`);
        const computed = getComputedStyle(element);
        return {
          background: computed.backgroundColor,
          borderBottom: computed.borderBottomColor,
          color: computed.color,
          fontSize: computed.fontSize,
          fontWeight: computed.fontWeight,
          letterSpacing: computed.letterSpacing,
          paddingBlock: `${computed.paddingTop} ${computed.paddingBottom}`,
          textTransform: computed.textTransform,
        };
      };
      return {
        panel: styles(panel),
        panelHeader: styles(header),
        tableHeader: styles(`${table} thead th:nth-child(3)`),
        tableCell: styles(`${table} tbody td:nth-child(3)`),
      };
    }, { panel, header, table });

    for (const dark of [false, true]) {
      await page.evaluate((useDarkTheme) => document.body.classList.toggle("theme-dark", useDarkTheme), dark);
      const devices = await theme(".mon-view-window", ".mon-device-window-header", ".mon-table--fleet");

      await page.getByLabel("Monitoring sections", { exact: true }).getByRole("link", { name: "Endpoints", exact: true }).click();
      await expect(page.locator(".monitors-table")).toBeVisible();
      const endpoints = await theme(".mon-view-window", ".monitors-table-toolbar", ".monitors-table");

      expect(endpoints).toEqual(devices);
      expect(devices.tableHeader).toMatchObject({
        fontSize: "11px",
        fontWeight: "700",
        textTransform: "uppercase",
      });

      await page.getByLabel("Monitoring sections", { exact: true }).getByRole("link", { name: "Devices", exact: true }).click();
      await expect(page.locator(".mon-table--fleet")).toBeVisible();
    }
  });

  test("fills every fleet-table cell on row hover", async ({ page }) => {
    const row = page.locator(".mon-row", { hasText: "Core Router With A Longer Name" });
    for (const dark of [false, true]) {
      await page.evaluate((useDarkTheme) => document.body.classList.toggle("theme-dark", useDarkTheme), dark);
      await row.hover();

      await expect.poll(async () => {
        const cellBackgrounds = await row.locator("td").evaluateAll((cells) =>
          cells.map((cell) => getComputedStyle(cell).backgroundColor)
        );
        return {
          distinctBackgrounds: new Set(cellBackgrounds).size,
          firstBackground: cellBackgrounds[0],
        };
      }).toEqual({
        distinctBackgrounds: 1,
        firstBackground: expect.not.stringMatching(/^rgba\(0, 0, 0, 0\)$/),
      });
    }
  });

  test("filters the fleet by device type", async ({ page }) => {
    const filter = page.getByRole("button", { name: "Filter by device type" });
    await expect(filter).toContainText("All types");
    await filter.click();
    const options = page.getByRole("listbox").getByRole("option");
    await expect(options).toHaveCount(3);
    await options.filter({ hasText: "Switch" }).click();
    await expect(filter).toContainText("Switch");
    await expect(page.locator(".mon-row")).toHaveCount(1);
    await expect(page.locator(".mon-row")).toContainText("Access Switch");
    await expect(page.locator(".mon-table-toolbar-meta")).toContainText("1 of 2");
  });

  test("configures DHCP checks as safe device-scoped probes", async ({ page }) => {
    await page.getByRole("button", { name: "Ports", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Port Monitoring" });
    await dialog.getByLabel("Protocol").selectOption("dhcp");
    await expect(dialog.getByLabel("Port(s)")).toHaveValue("67");
    await expect(dialog.getByLabel("Port(s)")).toBeDisabled();
    await expect(dialog.getByRole("note")).toContainText("never requests or reserves a lease");
    await expect(dialog.getByLabel("Scope")).toHaveValue("device");
    await expect(dialog.getByLabel("Scope").locator("option[value=global]")).toHaveAttribute("disabled", "");
  });

  test("keeps favourites on the left and renders expected-offline health correctly", async ({ page }) => {
    const row = page.locator(".mon-row").first();
    await expect(row.locator("td").first().locator(".fav-btn")).toBeVisible();
    const expectedOfflineRow = page.locator(".mon-row", { hasText: "Access Switch" });
    await expect(expectedOfflineRow.locator("td").nth(1).locator(".mon-dot-healthy")).toBeVisible();
    await expect(expectedOfflineRow.locator(".mon-expected-badge")).toContainText("expected offline");
  });

  test("changes upside-down monitoring from the device popup", async ({ page }) => {
    let savedExpectation: string | null = null;
    await page.route("**/api/v1/topology/devices/2", async (route) => {
      savedExpectation = (await route.request().postDataJSON()).expected_status;
      await route.fulfill({ json: mockDevice({ id: 2, expected_status: savedExpectation }) });
    });

    await page.locator(".mon-row", { hasText: "Access Switch" }).click();
    const toggle = page.getByRole("switch", { name: "Upside down" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toContainText("Upside down");
    await expect(toggle.locator(".mon-expectation-track")).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(savedExpectation).toBe("online");
    await expect(page.locator(".mon-hero-sub")).toContainText("expected online");
  });

  test("uses collapsible sidebar navigation for devices and endpoints", async ({ page }) => {
    const monitoringParent = page.getByRole("link", { name: "Monitoring", exact: true });
    const monitoringNav = page.getByLabel("Monitoring sections", { exact: true });
    // The chevron is its own control now: the parent link navigates, the chevron opens and
    // closes the menu, so neither click has to mean both.
    const monitoringToggle = page.getByRole("button", { name: /(Collapse|Expand) Monitoring sections/ });
    await expect(monitoringToggle.locator(".sidebar-parent-chevron")).toBeVisible();
    await expect(page.getByRole("button", { name: /(Collapse|Expand) Admin sections/ })).toBeVisible();
    await expect(monitoringToggle).toHaveAttribute("aria-expanded", "true");
    await expect(monitoringNav.getByRole("link")).toHaveCount(2);
    await expect(monitoringNav.getByRole("link", { name: "Devices", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("tablist", { name: "Monitoring view" })).toHaveCount(0);

    await monitoringToggle.click();
    await expect(monitoringToggle).toHaveAttribute("aria-expanded", "false");
    await expect(monitoringNav).toBeHidden();
    await monitoringToggle.click();
    await expect(monitoringNav).toBeVisible();

    // The parent link navigates and leaves the menu open — it must never collapse it.
    await monitoringParent.click();
    await expect(monitoringNav).toBeVisible();

    await monitoringNav.getByRole("link", { name: "Endpoints", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#endpoints");
    await expect(page.getByText("HTTP/HTTPS endpoints", { exact: true })).toBeVisible();
    await expect(page.getByText("No HTTP/HTTPS endpoints yet.", { exact: false })).toBeVisible();

    await page.goBack();
    await expect(monitoringNav.getByRole("link", { name: "Devices", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".mon-row").first()).toBeVisible();
  });

  test("shows endpoint heartbeat history directly in the table", async ({ page }) => {
    await page.route("**/api/v1/monitors", (route) => route.fulfill({ json: [{
      id: 7,
      name: "Public API",
      url: "https://api.example.com/health",
      enabled: true,
      last_status: "online",
      last_checked_at: "2026-08-02T11:00:00Z",
      uptime_24h: 96.7,
      uptime_7d: 99.1,
      avg_response_time_24h: 42.3,
      heartbeat: ["online", "online", "offline", "online"],
    }] }));

    await page.getByLabel("Monitoring sections", { exact: true }).getByRole("link", { name: "Endpoints", exact: true }).click();
    const row = page.locator(".monitors-table tbody tr", { hasText: "Public API" });
    await expect(row).toBeVisible();
    await expect(row.locator(".monitors-heartbeat-cell .heartbeat-bar--sm")).toBeVisible();
    await expect(row.locator(".monitors-heartbeat-cell .heartbeat-beat")).toHaveCount(4);

    for (const dark of [false, true]) {
      await page.evaluate((useDarkTheme) => document.body.classList.toggle("theme-dark", useDarkTheme), dark);
      await row.hover();
      await expect.poll(async () => {
        const cellBackgrounds = await row.locator("td").evaluateAll((cells) =>
          cells.map((cell) => getComputedStyle(cell).backgroundColor)
        );
        return {
          distinctBackgrounds: new Set(cellBackgrounds).size,
          firstBackground: cellBackgrounds[0],
        };
      }).toEqual({
        distinctBackgrounds: 1,
        firstBackground: expect.not.stringMatching(/^rgba\(0, 0, 0, 0\)$/),
      });
    }
  });
});

test.describe("Monitoring layout and column sizing", () => {
  test.beforeEach(async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page);
    // Enough rows that the table certainly runs past the bottom of the panel.
    await setupMonitoringMocks(
      page,
      Array.from({ length: 60 }, (_, i) =>
        mockMonitoringDevice({
          device_id: i + 1,
          display_name: `Device ${i + 1}`,
          hostname: `host-${i + 1}`,
          ip_address: `192.168.1.${i + 1}`,
        })
      )
    );
    await page.goto("/");
    await page.getByRole("link", { name: "Monitoring", exact: true }).click();
    await expect(page.locator(".mon-row").first()).toBeVisible();
  });

  test("scrolls the table, not the page", async ({ page }) => {
    const pageOverflow = await page.evaluate(() => ({
      body: document.body.scrollHeight - document.body.clientHeight,
      doc: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(pageOverflow.body).toBeLessThanOrEqual(1);
    expect(pageOverflow.doc).toBeLessThanOrEqual(1);

    // The rows have to actually overflow, or the assertion above proves nothing.
    const body = page.locator(".mon-table-body");
    const overflow = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(overflow).toBeGreaterThan(0);

    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // Scrolling to the end of the table must not have moved the page.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("keeps the pagination footer in view without scrolling", async ({ page }) => {
    const footer = page.locator(".inv-pagination");
    await expect(footer).toBeInViewport();
  });

  test("fills the viewport and keeps equal table gutters", async ({ page }) => {
    await page.setViewportSize({ width: 1744, height: 1100 });

    const geometry = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".app-main")?.getBoundingClientRect();
      const topbar = document.querySelector<HTMLElement>(".app-topbar")?.getBoundingClientRect();
      const panel = document.querySelector<HTMLElement>(".mon-view-window")?.getBoundingClientRect();
      if (!main || !topbar || !panel) return null;
      return {
        viewportRight: window.innerWidth,
        mainRight: main.right,
        topbarRight: topbar.right,
        leftPanelGutter: panel.left - main.left,
        rightPanelGutter: main.right - panel.right,
      };
    });

    expect(geometry).not.toBeNull();
    expect(Math.abs(geometry!.viewportRight - geometry!.mainRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry!.viewportRight - geometry!.topbarRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry!.leftPanelGutter - geometry!.rightPanelGutter)).toBeLessThanOrEqual(1);
  });

  async function headerWidths(page: import("@playwright/test").Page) {
    return page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".mon-table--fleet thead th")).map(
        (th) => Math.round(th.getBoundingClientRect().width)
      )
    );
  }

  async function dragDivider(page: import("@playwright/test").Page, handleIdx: number, dx: number) {
    const handle = page.locator(".mon-table--fleet .mon-col-resize-handle").nth(handleIdx);
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
  }

  // Both directions matter and they fail differently. table-layout: fixed grows
  // the table when the columns add up to more than its stated width, so
  // widening a column looks fine even when the width is wrong; it only
  // redistributes when they add up to less, so shrinking one column is what
  // visibly inflates its neighbours.
  for (const [label, dx] of [["widening", 90], ["shrinking", -90]] as const) {
    test(`${label} a column leaves every other column's width untouched`, async ({ page }) => {
      const before = await headerWidths(page);

      // Handle index 1 is the Type column, i.e. header cell 3 after Favourite and Status.
      await dragDivider(page, 1, dx);

      const after = await headerWidths(page);
      // The first resize introduces a flexible spacer after the resizable data columns.
      expect(after.length).toBe(before.length + 1);
      // The dragged column actually moved...
      expect(Math.abs(after[3] - before[3])).toBeGreaterThan(60);
      // ...and nothing else did.
      for (const i of [0, 1, 2, 4, 5, 6, 7, 8]) {
        expect(Math.abs(after[i] - before[i])).toBeLessThanOrEqual(1);
      }
    });
  }

  test("double-clicking a divider restores the default column widths", async ({ page }) => {
    const before = await headerWidths(page);

    const handle = page.locator(".mon-table--fleet .mon-col-resize-handle").nth(1);
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    expect((await headerWidths(page))[3]).toBeGreaterThan(before[3] + 60);

    await page.locator(".mon-table--fleet .mon-col-resize-handle").nth(1).dblclick();

    const after = await headerWidths(page);
    for (let i = 0; i < before.length; i += 1) {
      expect(Math.abs(after[i] - before[i])).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => window.localStorage.getItem("netmap.mon_col_widths_v9"))).toBeNull();
  });

  test("fills narrow saved columns and keeps favourites at the left edge", async ({ page }) => {
    await page.evaluate(() => {
      window.localStorage.setItem("netmap.mon_col_widths_v9", JSON.stringify([160, 90, 80, 80, 90, 110, 100]));
    });
    await page.reload();
    await expect(page.locator(".mon-row").first()).toBeVisible();

    const dimensions = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(".mon-table-body--fleet");
      const table = document.querySelector<HTMLElement>(".mon-table--fleet");
      const row = document.querySelector<HTMLElement>(".mon-table--fleet .mon-row");
      const filler = document.querySelector<HTMLElement>(".mon-table--fleet .mon-table-filler");
      const favourite = document.querySelector<HTMLElement>(".mon-table--fleet .mon-row td:first-child");
      if (!viewport || !table || !row || !filler || !favourite) return null;
      const viewportRect = viewport.getBoundingClientRect();
      return {
        viewportWidth: viewport.clientWidth,
        tableWidth: table.getBoundingClientRect().width,
        rowWidth: row.getBoundingClientRect().width,
        fillerWidth: filler.getBoundingClientRect().width,
        favouriteLeftGap: Math.abs(viewportRect.left - favourite.getBoundingClientRect().left),
      };
    });

    expect(dimensions).not.toBeNull();
    expect(dimensions!.tableWidth).toBeGreaterThanOrEqual(dimensions!.viewportWidth - 1);
    expect(dimensions!.rowWidth).toBeGreaterThanOrEqual(dimensions!.viewportWidth - 1);
    expect(dimensions!.fillerWidth).toBeGreaterThan(100);
    expect(dimensions!.favouriteLeftGap).toBeLessThanOrEqual(2);
  });
});

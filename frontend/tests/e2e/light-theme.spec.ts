import { expect, test, type Page } from "@playwright/test";
import { mockDevice, mockRelationship, mockUser, setupCoreMocks, setupInventoryMocks, setupTopologyMocks } from "./helpers/api-mocks";

type Theme = "light" | "dark";

const devices = [
  mockDevice({ id: 1, hostname: "router-01", display_name: "Core Router", topology_group: "Core" }),
  mockDevice({ id: 2, hostname: "switch-01", display_name: "Access Switch", monitor_status: "offline", topology_group: "Core" }),
];

async function openInventory(page: Page, theme: Theme) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await setupInventoryMocks(page, devices);
  await page.addInitScript((selected) => window.localStorage.setItem("netmap.theme", selected), theme);
  await page.goto("/inventory#devices");
  await page.locator(".inventory-row").first().waitFor({ state: "visible" });
}

function resolve(page: Page, token: string, property: "color" | "backgroundColor" = "color") {
  return page.evaluate(([name, prop]) => {
    const probe = document.createElement("span");
    probe.style.setProperty(prop === "color" ? "color" : "background-color", `var(${name})`);
    document.body.append(probe);
    const value = getComputedStyle(probe)[prop as "color" | "backgroundColor"];
    probe.remove();
    return value;
  }, [token, property] as const);
}

/** Every text run painted directly on a panel header band, with its contrast against the band. */
function headerTextContrast(page: Page) {
  return page.evaluate(() => {
    const channels = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const painted = (el: Element | null): string => {
      for (let node = el; node; node = node.parentElement) {
        const bg = getComputedStyle(node).backgroundColor;
        const [, , , alpha = 1] = channels(bg);
        if (bg !== "transparent" && alpha >= 0.5) return bg;
      }
      return "rgb(255, 255, 255)";
    };
    const results: { text: string; className: string; ratio: number }[] = [];
    for (const header of Array.from(document.querySelectorAll(".nm-app-panel-header, .topology-toolbar--ribbon, .inventory-device-sidebar-header, .security-results-meta, .tools-side-header, .modal .modal-header, .topology-details-panel .details-heading, .mon-hero-header, .inv-pagination, .security-pagination, .vlan-table-footer, .locations-panel-footer"))) {
      for (const el of Array.from(header.querySelectorAll("*"))) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
        if (!own || (el as HTMLElement).offsetParent === null || el.tagName === "OPTION") continue;
        const surface = painted(el);
        if (surface !== getComputedStyle(header).backgroundColor) continue;
        const fg = luminance(channels(getComputedStyle(el).color));
        const bg = luminance(channels(surface));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        results.push({ text: own.slice(0, 30), className: String((el as HTMLElement).className), ratio: Math.round(ratio * 100) / 100 });
      }
    }
    return results;
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`sidebar text uses the brightened shell tokens in ${theme} mode`, async ({ page }) => {
    await openInventory(page, theme);
    expect(await resolve(page, "--nm-sidebar-text")).toBe("rgb(241, 245, 249)");
    expect(await resolve(page, "--nm-sidebar-active")).toBe("rgb(143, 224, 238)");
    expect(await resolve(page, "--nm-sidebar-label")).toBe("rgb(163, 175, 188)");

    const sidebar = page.locator(".sidebar");
    await expect(sidebar.locator(".sidebar-link:not(.active)").first()).toHaveCSS("color", "rgb(241, 245, 249)");
    await expect(sidebar.locator(".sidebar-admin-link.active").first()).toHaveCSS("color", "rgb(143, 224, 238)");
    await expect(sidebar.locator(".sidebar-section-label").first()).toHaveCSS("color", "rgb(163, 175, 188)");
  });
}

test("light mode paints the tinted page, near-white panels and the page header bar", async ({ page }) => {
  await openInventory(page, "light");
  expect(await resolve(page, "--nm-bg", "backgroundColor")).toBe("rgb(254, 254, 254)");
  await expect(page.locator(".app-main")).toHaveCSS("background-color", "rgb(254, 254, 254)");
  expect(await resolve(page, "--nm-modal-shell", "backgroundColor")).toBe("rgb(245, 245, 246)");

  const panel = page.locator(".inventory-surface.nm-app-panel");
  await expect(panel).toHaveCSS("background-color", "rgb(254, 254, 254)");
  await expect(panel).toHaveCSS("border-top-color", "rgb(216, 220, 225)");
  expect(await resolve(page, "--nm-border-strong", "backgroundColor")).toBe("rgb(188, 195, 203)");
  await expect(panel).toHaveCSS("border-radius", "10px");
  await expect(panel).toHaveCSS("box-shadow", "rgba(15, 35, 52, 0.08) 0px 0px 0px 1px, rgba(15, 35, 52, 0.09) 0px 2px 4px 0px, rgba(15, 35, 52, 0.1) 0px 6px 18px 0px");

  const topbar = page.locator(".app-topbar");
  await expect(topbar).toHaveCSS("background-color", "rgb(254, 254, 254)");
  await expect(topbar).toHaveCSS("border-bottom-color", "rgb(216, 220, 225)");
  await expect(topbar.locator(".app-topbar-copy strong")).toHaveCSS("color", "rgb(15, 61, 71)");
  await expect(topbar.locator(".app-topbar-copy small")).toHaveCSS("color", "rgb(82, 98, 114)");
  const icon = topbar.locator(".app-topbar-icon");
  await expect(icon).toHaveCSS("background-color", "rgb(43, 122, 136)");
  await expect(icon).toHaveCSS("color", "rgb(255, 255, 255)");
});

test("light panel headers are navy bands with light text and a solid teal icon chip", async ({ page }) => {
  await openInventory(page, "light");
  expect(await resolve(page, "--nm-panel-head-bg", "backgroundColor")).toBe("rgb(47, 68, 91)");
  const header = page.locator(".inventory-panel-header.nm-app-panel-header");
  await expect(header).toHaveCSS("background-color", await resolve(page, "--nm-panel-head-bg", "backgroundColor"));
  await expect(header).toHaveCSS("border-bottom-color", "rgb(24, 40, 58)");
  await expect(header.locator(".inv-panel-title > span:not([class])")).toHaveCSS("color", "rgb(241, 245, 249)");
  await expect(header.locator(".inv-panel-count")).toHaveCSS("color", "rgb(177, 188, 199)");
  const chip = header.locator(".inv-panel-title-icon");
  await expect(chip).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(chip).toHaveCSS("color", "rgb(255, 255, 255)");

  // Toolbar controls keep their light style on the band.
  await expect(header.locator(".inv-search-box input")).toHaveCSS("background-color", "rgb(254, 254, 254)");
  await expect(header.locator(".inv-search-box input")).toHaveCSS("color", "rgb(19, 32, 44)");
  const secondary = header.getByRole("button", { name: "Import" });
  await expect(secondary).toHaveCSS("color", "rgb(19, 32, 44)");

  const low = (await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5);
  expect(low).toEqual([]);

  await page.locator(".inventory-row").first().click();
  const sidebarHeader = page.locator(".inventory-device-sidebar-header");
  await expect(sidebarHeader).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(sidebarHeader.locator(".nm-btn--icon")).toHaveCSS("color", "rgb(177, 188, 199)");
  expect((await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5)).toEqual([]);
});

test("Overview panel headers share the band and keep their links readable", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/overview");
  const headers = page.locator(".overview-panel-header.nm-app-panel-header");
  await expect(headers.first()).toBeVisible();
  for (const header of await headers.all()) await expect(header).toHaveCSS("background-color", "rgb(47, 68, 91)");
  const low = (await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5);
  expect(low).toEqual([]);
});

test("light panel header links such as View all and Manage are white and turn teal on hover", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/overview");
  const links = page.locator(".overview-panel-header .overview-panel-link");
  await expect(links.first()).toBeVisible();
  for (const link of await links.all()) await expect(link).toHaveCSS("color", "rgb(255, 255, 255)");
  await links.first().hover();
  await expect(links.first()).toHaveCSS("color", "rgb(143, 224, 238)");
});

for (const theme of ["light", "dark"] as const) {
  test(`the Favs filter is a standard header button with a gold on state in ${theme} mode`, async ({ page }) => {
    await openInventory(page, theme);
    const favs = page.locator(".nm-app-panel-header .inv-fav-filter");
    const bulk = page.locator(".nm-app-panel-header .inv-bulk-trigger, .nm-app-panel-header button:has-text('Import')").first();
    await expect(favs).toHaveAttribute("aria-pressed", "false");
    for (const property of ["background-color", "height", "border-radius"]) {
      expect(await favs.evaluate((node, prop) => getComputedStyle(node).getPropertyValue(prop), property))
        .toBe(await bulk.evaluate((node, prop) => getComputedStyle(node).getPropertyValue(prop), property));
    }
    await favs.click();
    await page.mouse.move(0, 0);
    await expect(favs).toHaveAttribute("aria-pressed", "true");
    await expect(favs).toHaveCSS("border-top-color", "rgb(232, 184, 64)");
    await expect(favs.locator("svg")).toHaveCSS("color", "rgb(232, 184, 64)");
  });
}

for (const [theme, track] of [["light", "rgb(211, 211, 211)"], ["dark", "rgba(148, 163, 184, 0.18)"]] as const) {
  test(`Overview health and mini tracks use the track colour in ${theme} mode`, async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices);
    await page.addInitScript((value) => window.localStorage.setItem("netmap.theme", value), theme);
    await page.goto("/overview");
    const tracks = page.locator(".dash-health-track, .dash-mini-track");
    await expect(tracks.first()).toBeVisible();
    for (const track_ of await tracks.all()) await expect(track_).toHaveCSS("background-color", track);
  });
}

test("small buttons use the same 12px text as standard buttons", async ({ page }) => {
  await openInventory(page, "light");
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.className = "nm-btn nm-btn--sm";
    button.id = "probe-sm";
    button.textContent = "Probe";
    document.body.appendChild(button);
  });
  await expect(page.locator("#probe-sm")).toHaveCSS("font-size", "12px");
});

for (const [theme, body] of [["light", "rgb(247, 247, 247)"], ["dark", "rgb(15, 23, 42)"]] as const) {
  test(`Overview panel bodies use the panel-body surface in ${theme} mode`, async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices);
    await page.addInitScript((value) => window.localStorage.setItem("netmap.theme", value), theme);
    await page.goto("/overview");
    const bodies = page.locator(".overview-panel > .dash-panel-body");
    await expect(bodies.first()).toBeVisible();
    for (const panelBody of await bodies.all()) await expect(panelBody).toHaveCSS("background-color", body);
  });
}

test("the Topology ribbon carries the same light band as every panel header", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/topology");
  const ribbon = page.locator(".topology-toolbar--ribbon");
  await expect(ribbon).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(ribbon.locator(".topology-ribbon-icon")).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(page.locator(".topology-workspace-frame .graph-surface")).toHaveCSS("background-color", "rgb(241, 242, 244)");
  expect(await resolve(page, "--nm-surface-tint", "backgroundColor")).toBe("rgb(236, 238, 241)");
  await expect(page.locator("select.toolbar-select").first()).toHaveCSS("background-color", "rgb(236, 238, 241)");
  const low = (await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5);
  expect(low).toEqual([]);
});

test("light tables use slate column headers, near-white rows and a slate selected row", async ({ page }) => {
  await openInventory(page, "light");
  expect(await resolve(page, "--nm-table-header-bg", "backgroundColor")).toBe("rgb(238, 241, 244)");
  const header = page.locator(".inventory-table-header");
  await expect(header).toHaveCSS("background-color", "rgb(238, 241, 244)");
  await expect(header).toHaveCSS("color", "rgb(59, 77, 96)");
  await expect(header).toHaveCSS("border-bottom-color", "rgb(214, 220, 227)");

  const table = page.locator(".inventory-table").first();
  await expect(table).toHaveCSS("background-color", "rgb(254, 254, 254)");
  expect(await table.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toContain("155, 185, 208");
  const row = page.locator(".inventory-row").nth(1);
  await expect(row).toHaveCSS("background-color", "rgb(254, 254, 254)");
  await expect(row).toHaveCSS("border-bottom-color", "rgb(233, 235, 238)");
  expect(await resolve(page, "--nm-row-hover", "backgroundColor")).toBe("rgb(239, 241, 243)");
  expect(await resolve(page, "--nm-surface-soft", "backgroundColor")).toBe("rgb(241, 242, 244)");
  await page.locator(".inventory-row").first().click();
  const selected = page.locator(".inventory-row.active");
  await expect(selected).toHaveCSS("background-color", "rgb(228, 231, 235)");
  await expect(selected).toHaveCSS("border-left-color", "rgb(29, 154, 176)");
});

for (const theme of ["light", "dark"] as const) {
  test(`row hover ${theme === "light" ? "drops" : "keeps"} the teal edge in ${theme} mode while selection keeps its edge`, async ({ page }) => {
    await openInventory(page, theme);
    const rows = page.locator(".inventory-row");
    await rows.first().click();
    await rows.nth(1).hover();
    const hovered = rows.nth(1);
    if (theme === "light") await expect(hovered).toHaveCSS("background-color", "rgb(239, 241, 243)");
    await expect.poll(() => hovered.evaluate((el) => { const cs = getComputedStyle(el); return `${cs.borderLeftColor} ${cs.boxShadow}`.includes("29, 154, 176"); })).toBe(theme === "dark");
    if (theme === "light") {
      await rows.first().hover();
      await expect(page.locator(".inventory-row.active")).toHaveCSS("border-left-color", "rgb(29, 154, 176)");
    }
  });
}

test("the VLAN table shares the light column header", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [mockDevice({ topology_group: "Servers" })]);
  await page.route("**/api/v1/topology/groups*", (route) => route.fulfill({ json: [{ id: 1, name: "Servers", vlan_id: 20, color: "#2d9d78", description: null }] }));
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/vlans");
  const vlanHeader = page.locator(".vlan-table-header");
  await expect(vlanHeader).toHaveCSS("background-color", "rgb(238, 241, 244)");
  await expect(vlanHeader).toHaveCSS("color", "rgb(59, 77, 96)");
});

test("light summary cards are tinted per status with a deep top line and a solid icon square", async ({ page }) => {
  await openInventory(page, "light");
  const tones = {
    teal: { bg: "rgb(255, 255, 255)", border: "rgb(191, 230, 237)", deep: "rgb(43, 122, 136)" },
    green: { bg: "rgb(255, 255, 255)", border: "rgb(191, 230, 212)", deep: "rgb(47, 122, 99)" },
    red: { bg: "rgb(255, 255, 255)", border: "rgb(245, 199, 199)", deep: "rgb(168, 72, 72)" },
  } as const;
  for (const tone of ["amber", "purple", "blue", "indigo"]) expect(await resolve(page, `--nm-kpi-${tone}-bg`, "backgroundColor")).toBe("rgb(255, 255, 255)");
  for (const [tone, expected] of Object.entries(tones)) {
    const card = page.locator(`.dash-stat--${tone}`).first();
    await expect(card).toHaveCSS("background-color", expected.bg);
    await expect(card).toHaveCSS("border-top-color", expected.border);
    const line = await card.evaluate((el) => { const s = getComputedStyle(el, "::before"); return { bg: s.backgroundColor, height: s.height }; });
    expect(line).toEqual({ bg: expected.deep, height: "3px" });
    await expect(card.locator(".dash-stat-icon")).toHaveCSS("background-color", expected.deep);
    await expect(card.locator(".dash-stat-icon")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(card.locator(".dash-stat-value")).toHaveCSS("color", "rgb(19, 32, 44)");
  }
});

test("Security results and Tools side cards carry the light band too", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await page.route("**/api/v1/syslog/events*", (route) => route.fulfill({ json: { retention_days: 7, total: 0, offset: 0, limit: 100, events: [] } }));
  await page.route("**/api/v1/syslog/searches", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: { enabled: true, retention_days: 7, total_events: 0, received_packets: 0, stored_events: 0, dropped_unparsed: 0, denied_senders: 0 } }));
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/security");
  await expect(page.locator(".security-results-meta")).toHaveCSS("background-color", "rgb(47, 68, 91)");
  expect((await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5)).toEqual([]);

  await page.goto("/tools");
  const sideHeaders = page.locator(".tools-side-header");
  await expect(sideHeaders.first()).toHaveCSS("background-color", "rgb(47, 68, 91)");
  expect((await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5)).toEqual([]);
});

test("light popup headers share the navy band with a readable title and close button", async ({ page }) => {
  await openInventory(page, "light");
  await page.locator("button", { hasText: /^\s*\+?\s*Device\s*$/ }).first().click();
  const header = page.locator(".modal .modal-header").first();
  await expect(header).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(header).toHaveCSS("border-bottom-color", "rgb(24, 40, 58)");
  await expect(header.locator("h3")).toHaveCSS("color", "rgb(241, 245, 249)");
  await expect(header.locator(".modal-close-btn")).toHaveCSS("color", "rgb(241, 245, 249)");
  expect((await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5)).toEqual([]);
});

test("light Topology device and link detail headings share the navy band", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page,
    [mockDevice({ id: 1, hostname: "router-01", topology_group: "Core" }), mockDevice({ id: 2, hostname: "switch-01", topology_group: "Core" })],
    [mockRelationship({ id: 1, source_device_id: 1, target_device_id: 2, link_speed_mbps: 2500 })]);
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/topology");
  const entityPanel = page.locator(".topo-entity-panel");
  await entityPanel.locator(".topo-stat-btn--devices").click();
  await entityPanel.locator(".topo-entity-row", { hasText: "router-01" }).click();
  const heading = page.locator(".topology-details-panel .details-heading").first();
  await expect(heading).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(heading.locator("h3")).toHaveCSS("color", "rgb(241, 245, 249)");
  expect((await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5)).toEqual([]);

  await entityPanel.locator(".topo-stat-btn--relationships").click();
  await entityPanel.locator(".topo-entity-row--relationship").click();
  const linkHeading = page.locator(".relationship-detail__heading");
  await expect(linkHeading).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(linkHeading.locator(".relationship-detail__heading-icon")).toHaveCSS("background-color", "rgb(47, 68, 91)");
  expect((await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5)).toEqual([]);
});

test("light table footers carry the same navy band as the panel header", async ({ page }) => {
  await openInventory(page, "light");
  const footer = page.locator(".inv-pagination").first();
  await expect(footer).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(footer).toHaveCSS("border-top-color", "rgb(24, 40, 58)");
  await expect(footer.locator(".inv-pagination-info")).toHaveCSS("color", "rgb(177, 188, 199)");
  expect((await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5)).toEqual([]);
});

test("light Admin users and schedule headers carry the navy band", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [{ ...mockUser, display_name: "Admin", avatar_data: null, auth_source: "local", entity_colors_enabled: true }] }));
  await page.route("**/api/v1/audit/logs*", (route) => route.fulfill({ json: { total: 0, limit: 50, offset: 0, records: [] } }));
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/admin#users");
  const usersHeader = page.locator(".admin-users-header").first();
  await expect(usersHeader).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(usersHeader).toHaveCSS("color", "rgb(241, 245, 249)");
  await page.goto("/admin#automation");
  const schedules = page.locator(".nm-app-panel", { has: page.locator(".admin-schedule-task") }).first().locator(":scope > .nm-app-panel-header");
  await expect(schedules).toHaveCSS("background-color", "rgb(47, 68, 91)");
  await expect(schedules.locator(".admin-section-title")).toHaveCSS("color", "rgb(241, 245, 249)");
  await expect(page.locator(".admin-schedule-task > .nm-app-panel-header")).toHaveCount(0);
  await expect(page.locator(".admin-schedule-task .admin-task-count")).toBeVisible();
});

test("light buttons: soft danger and neutral secondary are a step stronger and readable", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [{ ...mockUser, display_name: "Admin", avatar_data: null, auth_source: "local", entity_colors_enabled: true }] }));
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/admin#users");
  const danger = page.getByRole("button", { name: "Logout" }).first();
  await expect(danger).toHaveCSS("background-color", "rgb(248, 224, 224)");
  await expect(danger).toHaveCSS("border-top-color", "rgb(226, 163, 163)");
  await expect(danger).toHaveCSS("color", "rgb(174, 56, 56)");
  const ratio = await danger.evaluate((el) => {
    const ch = (v: string) => (v.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => [r, g, b].map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    const cs = getComputedStyle(el); const a = lum(ch(cs.color)); const b = lum(ch(cs.backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  const secondary = page.getByRole("button", { name: "Reset PW" }).first();
  await expect(secondary).toHaveCSS("background-color", "rgb(236, 238, 241)");
  await expect(secondary).toHaveCSS("border-top-color", "rgb(170, 179, 189)");
});

for (const theme of ["light", "dark"] as const) {
  test(`a hovered button on the panel band stays solid and readable in ${theme} mode`, async ({ page }) => {
    await openInventory(page, theme);
    const button = page.locator(".nm-app-panel-header").getByRole("button", { name: "Import" }).first();
    await button.hover();
    await expect.poll(() => button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(theme === "light" ? "rgb(228, 243, 245)" : "rgb(37, 48, 70)");
    const ratio = await button.evaluate((el) => {
      const ch = (v: string) => (v.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => [r, g, b].map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      const cs = getComputedStyle(el); const a = lum(ch(cs.color)); const b = lum(ch(cs.backgroundColor));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    if (theme === "light") {
      expect(await resolve(page, "--nm-btn-hover-bg", "backgroundColor")).toBe("rgb(228, 243, 245)");
      expect(await resolve(page, "--nm-btn-hover-text")).toBe("rgb(29, 100, 114)");
    }
  });
}

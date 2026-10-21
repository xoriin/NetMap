import { expect, test, type Page } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupInventoryMocks, setupTopologyMocks } from "./helpers/api-mocks";

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
    for (const header of Array.from(document.querySelectorAll(".nm-app-panel-header, .topology-toolbar--ribbon, .inventory-device-sidebar-header"))) {
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
  expect(await resolve(page, "--nm-bg", "backgroundColor")).toBe("rgb(230, 237, 242)");
  await expect(page.locator(".app-main")).toHaveCSS("background-color", "rgb(230, 237, 242)");

  const panel = page.locator(".inventory-surface.nm-app-panel");
  await expect(panel).toHaveCSS("background-color", "rgb(254, 254, 254)");
  await expect(panel).toHaveCSS("border-top-color", "rgb(211, 221, 229)");
  await expect(panel).toHaveCSS("border-radius", "10px");
  await expect(panel).toHaveCSS("box-shadow", "rgba(15, 35, 52, 0.06) 0px 1px 2px 0px, rgba(15, 35, 52, 0.06) 0px 2px 6px 0px");

  const topbar = page.locator(".app-topbar");
  await expect(topbar).toHaveCSS("background-color", "rgb(254, 254, 254)");
  await expect(topbar).toHaveCSS("border-bottom-color", "rgb(211, 221, 229)");
  await expect(topbar.locator(".app-topbar-copy strong")).toHaveCSS("color", "rgb(15, 61, 71)");
  await expect(topbar.locator(".app-topbar-copy small")).toHaveCSS("color", "rgb(82, 98, 114)");
  const icon = topbar.locator(".app-topbar-icon");
  await expect(icon).toHaveCSS("background-color", "rgb(43, 122, 136)");
  await expect(icon).toHaveCSS("color", "rgb(255, 255, 255)");
});

test("light panel headers are navy bands with light text and a solid teal icon chip", async ({ page }) => {
  await openInventory(page, "light");
  expect(await resolve(page, "--nm-panel-head-bg", "backgroundColor")).toBe("rgb(29, 46, 64)");
  const header = page.locator(".inventory-panel-header.nm-app-panel-header");
  await expect(header).toHaveCSS("background-color", await resolve(page, "--nm-panel-head-bg", "backgroundColor"));
  await expect(header).toHaveCSS("border-bottom-color", "rgb(24, 40, 58)");
  await expect(header.locator(".inv-panel-title > span:not([class])")).toHaveCSS("color", "rgb(241, 245, 249)");
  await expect(header.locator(".inv-panel-count")).toHaveCSS("color", "rgb(177, 188, 199)");
  const chip = header.locator(".inv-panel-title-icon");
  await expect(chip).toHaveCSS("background-color", "rgb(43, 122, 136)");
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
  await expect(sidebarHeader).toHaveCSS("background-color", "rgb(29, 46, 64)");
  expect((await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5)).toEqual([]);
});

test("Overview panel headers share the band and keep their links readable", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/overview");
  const headers = page.locator(".overview-panel-header.nm-app-panel-header");
  await expect(headers.first()).toBeVisible();
  for (const header of await headers.all()) await expect(header).toHaveCSS("background-color", "rgb(29, 46, 64)");
  const low = (await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5);
  expect(low).toEqual([]);
});

test("the Topology ribbon carries the same light band as every panel header", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices);
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/topology");
  const ribbon = page.locator(".topology-toolbar--ribbon");
  await expect(ribbon).toHaveCSS("background-color", "rgb(29, 46, 64)");
  await expect(ribbon.locator(".topology-ribbon-icon")).toHaveCSS("background-color", "rgb(43, 122, 136)");
  const low = (await headerTextContrast(page)).filter((entry) => entry.ratio < 4.5);
  expect(low).toEqual([]);
});

test("light tables use teal-tinted column headers, near-white rows and a teal selected row", async ({ page }) => {
  await openInventory(page, "light");
  expect(await resolve(page, "--nm-table-header-bg", "backgroundColor")).toBe("rgb(230, 241, 244)");
  const header = page.locator(".inventory-table-header");
  await expect(header).toHaveCSS("background-color", "rgb(230, 241, 244)");
  await expect(header).toHaveCSS("color", "rgb(29, 100, 114)");
  await expect(header).toHaveCSS("border-bottom-color", "rgb(197, 223, 229)");

  const row = page.locator(".inventory-row").nth(1);
  await expect(row).toHaveCSS("background-color", "rgb(254, 254, 254)");
  await expect(row).toHaveCSS("border-bottom-color", "rgb(230, 237, 242)");
  await page.locator(".inventory-row").first().click();
  const selected = page.locator(".inventory-row.active");
  await expect(selected).toHaveCSS("background-color", "rgb(217, 238, 242)");
  await expect(selected).toHaveCSS("border-left-color", "rgb(29, 154, 176)");
});

test("the VLAN table shares the light column header", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [mockDevice({ topology_group: "Servers" })]);
  await page.route("**/api/v1/topology/groups*", (route) => route.fulfill({ json: [{ id: 1, name: "Servers", vlan_id: 20, color: "#2d9d78", description: null }] }));
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "light"));
  await page.goto("/vlans");
  const vlanHeader = page.locator(".vlan-table-header");
  await expect(vlanHeader).toHaveCSS("background-color", "rgb(230, 241, 244)");
  await expect(vlanHeader).toHaveCSS("color", "rgb(29, 100, 114)");
});

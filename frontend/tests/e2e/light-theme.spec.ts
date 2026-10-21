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

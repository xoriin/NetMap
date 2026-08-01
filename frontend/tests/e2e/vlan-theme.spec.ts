import { expect, test, type Page } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const vlanGroup = {
  id: 20,
  name: "Servers",
  display_name: "Production servers",
  vlan_id: "20",
  ip_range: "10.30.20.0/24",
  gateway: "10.30.20.1",
  dns_servers: "10.30.20.2, 10.30.20.3",
  description: "Server network",
  color: null,
};

async function setupVlans(page: Page, theme: "light" | "dark" = "dark") {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [mockDevice({ topology_group: "Servers" })]);
  await page.route("**/api/v1/topology/groups*", (route) => {
    if (route.request().method() === "GET") route.fulfill({ json: [vlanGroup] });
    else route.fulfill({ json: vlanGroup });
  });
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("netmap.theme", selectedTheme);
    window.localStorage.removeItem("netmap.vlan_col_widths_v1");
  }, theme);
  await page.goto("/vlans");
  await page.locator(".vlan-table-panel").waitFor({ state: "visible", timeout: 8000 });
}

for (const theme of ["light", "dark"] as const) {
  test(`VLANs use the approved purpose-built table hierarchy in ${theme} mode`, async ({ page }) => {
    await setupVlans(page, theme);

    const panel = page.locator(".vlan-table-panel");
    await expect(panel).toHaveCSS("background-image", "none");
    await expect(panel.locator(":scope > .vlan-toolbar")).toHaveCSS("min-height", "44px");
    await expect(panel.locator(".vlan-panel-icon")).toBeVisible();
    await expect(panel.locator(".vlan-panel-title")).toContainText("Groups & VLANs");
    await expect(panel.locator(".vlan-search .nm-input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(panel.locator(".vlan-table-header")).toHaveCSS("background-image", "none");

    const panelBox = await panel.boundingBox();
    const footerBox = await panel.locator(".vlan-table-footer").boundingBox();
    expect(panelBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(Math.abs((panelBox?.y ?? 0) + (panelBox?.height ?? 0) - ((footerBox?.y ?? 0) + (footerBox?.height ?? 0)))).toBeLessThanOrEqual(1);
  });
}

test("VLAN column resizing preserves full-width row surfaces and opens a canonical form", async ({ page }) => {
  await setupVlans(page);

  const panel = page.locator(".vlan-table-panel");
  const firstHandle = panel.locator(".vlan-col-resize-handle").first();
  const handleBox = await firstHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  if (handleBox) {
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 80, handleBox.y + handleBox.height / 2);
    await page.mouse.up();
  }

  await expect(panel.locator(".vlan-table--fixed")).toBeVisible();
  const viewportWidth = await panel.locator(".vlan-table-viewport").evaluate((node) => node.clientWidth);
  const rowWidth = await panel.locator(".vlan-row").first().evaluate((node) => node.getBoundingClientRect().width);
  const headerWidth = await panel.locator(".vlan-table-header").evaluate((node) => node.getBoundingClientRect().width);
  expect(rowWidth).toBeGreaterThanOrEqual(viewportWidth - 1);
  expect(headerWidth).toBeGreaterThanOrEqual(viewportWidth - 1);

  await page.getByRole("button", { name: "+ New group" }).click();
  const dialog = page.getByRole("dialog", { name: "New group" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".vlan-modal-body")).toHaveCSS("background-image", "none");
  await expect(dialog.getByRole("button", { name: "Create group" })).toBeVisible();
});

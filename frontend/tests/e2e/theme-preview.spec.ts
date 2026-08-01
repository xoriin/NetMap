import { expect, test } from "@playwright/test";
import { setupCoreMocks } from "./helpers/api-mocks";

test.skip(process.env.NETMAP_UI_PREVIEW_TESTS !== "1", "Theme preview is available only from the Vite development server");

for (const theme of ["light", "dark"] as const) {
  test(`theme preview renders the panel review board in ${theme} mode`, async ({ page }) => {
    await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
    await setupCoreMocks(page);
    await page.route("**/api/v1/topology/graph", (route) =>
      route.fulfill({ json: { devices: [], relationships: [] } }),
    );
    await page.addInitScript((selectedTheme) => {
      window.localStorage.setItem("netmap.theme", selectedTheme);
    }, theme);

    await page.goto("/theme-preview");

    await expect(page.locator(".theme-lab-workspace")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Application panel system" })).toBeVisible();
    await expect(page.locator(".theme-lab-table-window")).toBeVisible();
    await expect(page.locator(".theme-lab-theme-sample--light")).toBeVisible();
    await expect(page.locator(".theme-lab-theme-sample--dark")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Forms and field states" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Operational data visuals" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Device monitoring popup" })).toBeVisible();
    await expect(page.locator(".theme-lab-monitor-popup")).toContainText("Core gateway");
    await expect(page.getByRole("heading", { name: "Overlays and choice controls" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Authentication screens" })).toBeVisible();

    const nestedSearchBackground = await page.locator(".theme-lab-search input").evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(nestedSearchBackground).toBe("rgba(0, 0, 0, 0)");

    const headerBox = await page.locator(".theme-lab-panel-header").first().boundingBox();
    expect(headerBox?.height).toBe(44);

    const table = page.locator(".theme-lab-table");
    const tableViewport = page.locator(".theme-lab-table-scroll");
    const defaultTableBox = await table.boundingBox();
    const tableViewportBox = await tableViewport.boundingBox();
    expect(defaultTableBox).not.toBeNull();
    expect(tableViewportBox).not.toBeNull();
    if (defaultTableBox && tableViewportBox) {
      expect(Math.abs(defaultTableBox.width - tableViewportBox.width)).toBeLessThanOrEqual(1);
    }

    const firstColumn = page.locator(".theme-lab-table th").first();
    const resizeHandle = firstColumn.locator(".theme-lab-col-resize-handle");
    await firstColumn.scrollIntoViewIfNeeded();
    const beforeResize = await firstColumn.boundingBox();
    expect(beforeResize).not.toBeNull();
    if (beforeResize) {
      const dividerX = beforeResize.x + beforeResize.width - 2;
      const dividerY = beforeResize.y + beforeResize.height / 2;
      await resizeHandle.dispatchEvent("mousedown", { clientX: dividerX, clientY: dividerY, button: 0 });
      await page.mouse.move(dividerX + 40, dividerY);
      await page.mouse.up();
      await expect.poll(async () => (await firstColumn.boundingBox())?.width ?? 0).toBeGreaterThan(beforeResize.width + 35);
    }

    const securityTab = page.getByRole("tab", { name: "Security" });
    await securityTab.click();
    await expect(securityTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toContainText("Security settings");

    await page.getByText("Core router", { exact: true }).last().click();
    await expect(page.locator(".theme-lab-bulk-bar")).toContainText("1 selected");
    const stateTableCard = page.locator(".theme-lab-mini-table-window");
    const stateTableFooter = stateTableCard.locator(".theme-lab-table-footer");
    const stateTableCardBox = await stateTableCard.boundingBox();
    const stateTableFooterBox = await stateTableFooter.boundingBox();
    expect(stateTableCardBox).not.toBeNull();
    expect(stateTableFooterBox).not.toBeNull();
    if (stateTableCardBox && stateTableFooterBox) {
      expect(Math.abs(stateTableCardBox.y + stateTableCardBox.height - (stateTableFooterBox.y + stateTableFooterBox.height))).toBeLessThanOrEqual(1);
    }

    await expect(page.locator(".theme-lab-monitor-chart .theme-lab-rtt-line")).toBeVisible();

    await page.getByRole("option", { name: "Sydney data centre" }).click();
    await expect(page.locator(".theme-lab-combobox > button")).toContainText("Sydney data centre");

    const deleteConfirmation = page.locator(".theme-lab-confirm-card");
    const destructiveButton = deleteConfirmation.getByRole("button", { name: "Delete devices" });
    await expect(destructiveButton).toBeDisabled();
    await deleteConfirmation.getByPlaceholder("delete").fill("delete");
    await expect(destructiveButton).toBeEnabled();

    await page.getByRole("button", { name: "Start scan" }).click();
    await expect(page.getByRole("button", { name: "Stop scan" })).toBeVisible();
    await expect(page.locator(".theme-lab-progress-track i")).toHaveAttribute("style", /62%/);

    await page.getByRole("tab", { name: "Password reset" }).click();
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();

    await page.getByRole("tab", { name: "Compact list" }).click();
    await expect(page.locator(".theme-lab-ip-list")).toContainText("Core gateway");
    await page.getByRole("tab", { name: "Utilization strip" }).click();
    await expect(page.locator(".theme-lab-ip-strip-view")).toContainText("128 of 254 usable addresses");
    await page.getByRole("tab", { name: "Dense map" }).click();
    await expect(page.locator(".theme-lab-ip-map-cell")).toHaveCount(256);
    const firstIpCell = page.locator(".theme-lab-ip-map-cell").first();
    const ipMapViewport = page.locator(".theme-lab-ip-map-scroll");
    await firstIpCell.hover();
    const firstIpCellBox = await firstIpCell.boundingBox();
    const ipMapViewportBox = await ipMapViewport.boundingBox();
    expect(firstIpCellBox).not.toBeNull();
    expect(ipMapViewportBox).not.toBeNull();
    if (firstIpCellBox && ipMapViewportBox) {
      expect(firstIpCellBox.y).toBeGreaterThanOrEqual(ipMapViewportBox.y);
    }
    const ipMapOverflow = await ipMapViewport.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(ipMapOverflow.scrollWidth).toBeLessThanOrEqual(ipMapOverflow.clientWidth);
    await page.getByRole("button", { name: "10.30.20.120" }).hover();
    await expect(page.locator("#theme-lab-ip-detail")).toContainText("10.30.20.120");
    await expect(page.locator("#theme-lab-ip-detail")).toContainText("DHCP pool");

    const collapseButton = page.getByRole("button", { name: "Collapse", exact: true });
    await collapseButton.click();
    await expect(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
  });
}

import { expect, test, type Page } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const locations = [
  {
    id: 1,
    name: "brisbane-hq",
    display_name: "Brisbane HQ",
    description: "Primary office",
    address: "123 Main Street, Brisbane",
    color: "#2d9d78",
  },
  {
    id: 2,
    name: "sydney-edge",
    display_name: "Sydney Edge",
    description: "Edge facility",
    address: null,
    color: null,
  },
];

async function setupLocations(page: Page, theme: "light" | "dark" = "dark") {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [mockDevice({ site_id: 1 })]);
  await page.route("**/api/v1/topology/sites*", (route) => {
    if (route.request().method() === "GET") route.fulfill({ json: locations });
    else route.fulfill({ json: locations[0] });
  });
  await page.route("https://nominatim.openstreetmap.org/**", (route) => route.fulfill({ json: [] }));
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("netmap.theme", selectedTheme);
  }, theme);
  await page.goto("/locations");
  await page.locator(".locations-panel").waitFor({ state: "visible", timeout: 8000 });
}

for (const theme of ["light", "dark"] as const) {
  test(`Locations use the approved solid library hierarchy in ${theme} mode`, async ({ page }) => {
    await setupLocations(page, theme);

    const panel = page.locator(".locations-panel");
    await expect(panel).toHaveCSS("background-image", "none");
    await expect(panel.locator(":scope > .locations-panel-header")).toHaveCSS("min-height", "44px");
    await expect(panel.locator(".locations-panel-icon")).toBeVisible();
    await expect(panel.locator(".locations-panel-title")).toContainText("Locations");
    await expect(panel.locator(".locations-search .nm-input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(panel.locator(".loc-card")).toHaveCount(2);
    await expect(panel.locator(".loc-card").first()).toHaveCSS("background-image", "none");

    const panelBox = await panel.boundingBox();
    const footerBox = await panel.locator(".locations-panel-footer").boundingBox();
    expect(panelBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(Math.abs((panelBox?.y ?? 0) + (panelBox?.height ?? 0) - ((footerBox?.y ?? 0) + (footerBox?.height ?? 0)))).toBeLessThanOrEqual(1);
  });
}

test("Location detail and editor use the canonical popup treatment", async ({ page }) => {
  await setupLocations(page);

  await page.getByRole("button", { name: "Open Brisbane HQ" }).click();
  const detail = page.getByRole("dialog", { name: "Brisbane HQ" });
  await expect(detail).toBeVisible();
  await expect(detail.locator(".modal-header svg").first()).toBeVisible();
  await expect(detail.getByText("Primary office")).toBeVisible();
  await detail.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "+ New location" }).click();
  const editor = page.getByRole("dialog", { name: "New location" });
  await expect(editor).toBeVisible();
  await expect(editor.locator(".location-modal-body")).toHaveCSS("background-image", "none");
  await expect(editor.getByRole("textbox", { name: "Name *" })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Create location" })).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";
import { setupExternalIps } from "./helpers/external-ip";
import { mockUser } from "./helpers/api-mocks";
import type { SavedCloudAsset } from "../../src/api/client";

async function open(page: Page, initial: SavedCloudAsset[] = [], theme: "light" | "dark" = "dark") {
  const assets = [...initial];
  const typePosts: unknown[] = [];
  await setupExternalIps(page, { theme, beforeGoto: async page => {
    await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { ...mockUser, role: "Operator", permissions: ["ipam_write"] } }));
    await page.route("**/api/v1/ipam/external/assets", route => {
      if (route.request().method() !== "POST") return route.fulfill({ json: assets });
      const asset = { id: 50 + assets.length, ...route.request().postDataJSON() } as SavedCloudAsset;
      assets.push(asset);
      return route.fulfill({ status: 201, json: asset });
    });
    await page.route(/\/api\/v1\/ipam\/external\/assets\/\d+$/, route => {
      const id = Number(route.request().url().split("/").pop());
      const index = assets.findIndex(asset => asset.id === id);
      assets[index] = { ...assets[index], ...route.request().postDataJSON() };
      return route.fulfill({ json: assets[index] });
    });
    page.on("request", request => { if (request.url().endsWith("/asset-types") && request.method() === "POST") typePosts.push(request.postDataJSON()); });
  }});
  await page.goto("/inventory#cloud-assets");
  return { assets, typePosts };
}

for (const theme of ["light", "dark"] as const) {
test(`the popup offers plain built-in types and adds a custom one inline in ${theme}`, async ({ page }) => {
  const { assets, typePosts } = await open(page, [], theme);
  const surface = page.locator(".inventory-cloud-layout");
  await expect(surface.getByRole("button", { name: "Filter by asset type" })).toBeVisible();
  await expect(surface.locator(".inventory-table-header")).toContainText("Type");
  await page.getByRole("button", { name: "Add cloud asset", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add cloud asset", exact: true });
  await expect(dialog).not.toContainText("Kind");
  await expect(page.locator(".inventory-cloud-layout")).not.toContainText("Kind");
  await dialog.getByLabel("Name", { exact: true }).fill("Queue worker");
  await dialog.getByRole("button", { name: "Type", exact: true }).click();
  const list = page.getByRole("listbox", { name: "Type", exact: true });
  await expect(list.getByRole("option")).toHaveText(["Not set", "Server", "Load balancer", "Database", "Storage", "Network", "Other"]);
  await page.getByRole("button", { name: "Add type…", exact: true }).click();
  await dialog.getByRole("textbox", { name: "New type name", exact: true }).fill("Message queue");
  await dialog.getByRole("textbox", { name: "New type name", exact: true }).press("Enter");
  await expect(dialog.getByRole("button", { name: "Type", exact: true })).toHaveText("Message queue");
  await page.screenshot({path:`/tmp/netmap-handoff-type-${theme}.png`});
  expect(typePosts).toEqual([{ label: "Message queue" }]);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Add asset", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(assets[0]).toMatchObject({ name: "Queue worker", kind: "message_queue" });
  await expect(page.locator('[data-cloud-record="saved-50"]')).toContainText("Message queue");
  await page.getByRole("button", { name: "Filter by asset type" }).click();
  await expect(page.getByRole("option", { name: "Message queue" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add cloud asset", exact: true }).click();
  await dialog.getByRole("button", { name: "Type", exact: true }).click();
  await page.getByRole("option", { name: "Message queue", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Type", exact: true })).toHaveText("Message queue");
});

}

test("an inline type matching a built-in reuses it and cancelling keeps the popup", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Add cloud asset", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add cloud asset", exact: true });
  await dialog.getByRole("button", { name: "Type", exact: true }).click();
  await page.getByRole("button", { name: "Add type…", exact: true }).click();
  await dialog.getByRole("textbox", { name: "New type name", exact: true }).fill("load BALANCER");
  await dialog.getByRole("button", { name: "Add type", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Type", exact: true })).toHaveText("Load balancer");
  await dialog.getByRole("button", { name: "Type", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Type", exact: true }).getByRole("option", { name: "Load balancer" })).toHaveCount(1);
  await page.getByRole("button", { name: "Add type…", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Type", exact: true })).toHaveText("Load balancer");
});

test("the sidebar edits the type with the same picker and can add a custom type", async ({ page }) => {
  const { assets } = await open(page, [{ id: 4, name: "Retained VM", kind: "server", provider_id: null, account: null, region: null, device_id: null, description: null }]);
  await page.getByRole("button", { name: "Open Retained VM details" }).click();
  const sidebar = page.getByRole("complementary", { name: "Asset overview" });
  const field = sidebar.locator('dt:text-is("Type") + dd');
  await expect(field).toHaveText("Server");
  await expect(sidebar).not.toContainText("Kind");
  await field.dblclick();
  await sidebar.getByRole("button", { name: "Type", exact: true }).click();
  await page.getByRole("button", { name: "Add type…", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "New type name", exact: true }).fill("Edge function");
  await sidebar.getByRole("textbox", { name: "New type name", exact: true }).press("Enter");
  await expect(sidebar.getByRole("button", { name: "Type", exact: true })).toHaveText("Edge function");
  await sidebar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toHaveText("Edge function");
  expect(assets[0].kind).toBe("edge_function");
  await expect(page.locator('[data-cloud-record="saved-4"]')).toContainText("Edge function");
});

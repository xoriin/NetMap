import { expect, test } from "@playwright/test";
import { setupExternalIps } from "./helpers/external-ip";
import { mockDevice } from "./helpers/api-mocks";
import type { SavedCloudAsset } from "../../src/api/client";

for (const theme of ["light", "dark"] as const) {
  test(`new cloud asset defaults to Inventory and retries only its link in ${theme}`, async ({ page }) => {
    let asset: SavedCloudAsset | null = null;
    let assetPosts = 0, devicePosts = 0, linkAttempts = 0;
    await setupExternalIps(page, { theme, beforeGoto: async page => {
      await page.route("**/api/v1/admin/device-types", route => route.fulfill({ json: [] }));
      await page.route("**/api/v1/ipam/external/assets", route => {
        if (route.request().method() !== "POST") return route.fulfill({ json: asset ? [asset] : [] });
        assetPosts++; asset = { id: 55, ...route.request().postDataJSON() } as SavedCloudAsset;
        return route.fulfill({ status: 201, json: asset });
      });
      await page.route("**/api/v1/ipam/external/assets/55", route => {
        linkAttempts++;
        if (linkAttempts === 1) return route.fulfill({ status: 500, json: { detail: "Link unavailable" } });
        asset = { ...asset!, ...route.request().postDataJSON() };
        return route.fulfill({ json: asset });
      });
      await page.route("**/api/v1/topology/devices", route => {
        devicePosts++;
        return route.fulfill({ json: mockDevice({ id: 77, ...route.request().postDataJSON() }) });
      });
    }});
    await page.goto("/inventory#cloud-assets");
    await page.getByRole("button", { name: "Add cloud asset", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add cloud asset", exact: true });
    const toggle = add.getByRole("switch", { name: "Add to Inventory", exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveCSS("width", "36px");
    await expect(toggle).toHaveCSS("height", "20px");
    await expect(add.getByRole("button", { name: "Inventory device", exact: true })).toHaveCount(0);
    await add.getByLabel("Name", { exact: true }).fill("Production service");
    await page.screenshot({ path: `/tmp/netmap-handoff-default-${theme}.png` });
    await add.getByRole("button", { name: "Add asset", exact: true }).click();
    const device = page.getByRole("dialog", { name: "Add device", exact: true });
    await expect(device.getByLabel("Display name", { exact: true })).toHaveValue("Production service");
    expect(assetPosts).toBe(1);
    await device.getByLabel("IP address", { exact: true }).fill("8.8.8.8");
    await device.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Link the created device", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Retry link", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(devicePosts).toBe(1); expect(assetPosts).toBe(1); expect(linkAttempts).toBe(2);
    expect(asset!.device_id).toBe(77);
    await expect(page.getByRole("complementary", { name: "Asset overview" })).toContainText("Production service");
  });
}

test("cancelling default device creation leaves the saved cloud asset unlinked", async ({ page }) => {
  const assets: SavedCloudAsset[] = [];
  await setupExternalIps(page, { beforeGoto: async page => {
    await page.route("**/api/v1/admin/device-types", route => route.fulfill({ json: [] }));
    await page.route("**/api/v1/ipam/external/assets", route => {
      if (route.request().method() !== "POST") return route.fulfill({ json: assets });
      const asset = { id: 66, ...route.request().postDataJSON() } as SavedCloudAsset;
      assets.push(asset); return route.fulfill({ status: 201, json: asset });
    });
    await page.route("**/api/v1/topology/devices", route => {
      if (route.request().method() === "POST") throw new Error("Cancel must not create a device");
      return route.fallback();
    });
  }});
  await page.goto("/inventory#cloud-assets");
  await page.getByRole("button", { name: "Add cloud asset", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add cloud asset", exact: true });
  await add.getByLabel("Name", { exact: true }).fill("Kept resource");
  await add.getByRole("button", { name: "Add asset", exact: true }).click();
  await page.getByRole("dialog", { name: "Add device", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(assets).toHaveLength(1); expect(assets[0].device_id).toBeNull();
  await expect(page.locator('[data-cloud-record="saved-66"]')).toBeVisible();
  await page.getByRole("button", { name: "Add cloud asset", exact: true }).click();
  await expect(add.getByRole("switch", { name: "Add to Inventory", exact: true })).toHaveAttribute("aria-checked", "true");
  await add.getByRole("switch", { name: "Add to Inventory", exact: true }).click();
  await expect(add.getByRole("button", { name: "Inventory device", exact: true })).toBeVisible();
  await page.setViewportSize({width:780,height:850});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:"/tmp/netmap-handoff-default-narrow.png"});
});

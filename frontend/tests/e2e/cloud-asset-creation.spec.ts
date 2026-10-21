import { expect, test } from "@playwright/test";
import { setupExternalIps, AWS } from "./helpers/external-ip";
import { mockDevice, mockUser } from "./helpers/api-mocks";
import type { SavedCloudAsset } from "../../src/api/client";

for (const theme of ["light", "dark"] as const) {
  test(`create, link and reopen a cloud asset in ${theme}`, async ({ page }) => {
    const assets: SavedCloudAsset[] = [];
    let posts = 0;
    let fail = true;
    let finishCreate: (() => void) | undefined;
    await setupExternalIps(page, { theme, providers: [AWS], devices: [mockDevice({ id: 7, hostname: "Existing server", monitoring_paused: true })], beforeGoto: async page => {
      await page.route("**/api/v1/ipam/external/assets", async route => {
        if (route.request().method() !== "POST") return route.fulfill({ json: assets });
        posts++;
        if (fail) return route.fulfill({ status: 409, json: { detail: "An asset with this name already exists" } });
        await new Promise<void>(resolve => { finishCreate = resolve; });
        const asset = { id: 9, ...route.request().postDataJSON() } as SavedCloudAsset;
        assets.push(asset);
        return route.fulfill({ status: 201, json: asset });
      });
    }});
    await page.goto("/inventory#cloud-assets");
    await page.getByRole("button", { name: "Add cloud asset", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add cloud asset", exact: true });
    await expect(dialog.getByRole("button", { name: "Add asset", exact: true })).toBeDisabled();
    await dialog.getByLabel("Name", { exact: true }).fill("Production gateway");
    await dialog.getByRole("button", { name: "Type", exact: true }).click();
    await page.getByRole("option", { name: "Network", exact: true }).click();
    await dialog.getByLabel("Provider", { exact: true }).selectOption("1");
    await dialog.getByLabel("Account", { exact: true }).fill("Infrastructure");
    await dialog.getByLabel("Region", { exact: true }).fill("Sydney");
    await dialog.getByLabel("Description", { exact: true }).fill("Public production gateway");
    await dialog.getByRole("button", { name: "Inventory device", exact: true }).click();
    await page.getByRole("option", { name: "Existing server", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Inventory device", exact: true })).toBeHidden();
    await page.screenshot({ path: `/tmp/netmap-cloud-create-${theme}-desktop.png` });
    await dialog.getByRole("button", { name: "Add asset", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("already exists");
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Production gateway");
    fail = false;
    await dialog.getByRole("button", { name: "Add asset", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Adding…", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    finishCreate!();
    await expect(dialog).toBeHidden();
    expect(posts).toBe(2);
    expect(assets[0]).toMatchObject({ name: "Production gateway", kind: "network", provider_id: 1, device_id: 7, region: "Sydney", account: "Infrastructure" });
    await expect(page.getByRole("complementary", { name: "Asset overview" })).toContainText("Production gateway");
    await page.reload();
    await page.getByRole("button", { name: "Open Production gateway details" }).click();
    await expect(page.getByRole("complementary", { name: "Asset overview" })).toContainText("Public production gateway");
    await page.getByRole("button", { name: "Add cloud asset", exact: true }).click();
    await page.setViewportSize({ width: 780, height: 850 });
    await dialog.getByLabel("Name", { exact: true }).fill("Cancelled draft");
    const modal = await dialog.locator(".modal").boundingBox();
    expect(modal!.x).toBeGreaterThanOrEqual(0);
    expect(modal!.x + modal!.width).toBeLessThanOrEqual(780);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/netmap-cloud-create-${theme}-narrow.png` });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(posts).toBe(2);
    await expect(dialog).toBeHidden();
  });
}

test("name-only creation clears filters and creates no device", async ({ page }) => {
  let body: Record<string, unknown> | null = null;
  await setupExternalIps(page, { beforeGoto: async page => {
    await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { ...mockUser, role: "Operator", permissions: ["ipam_write"] } }));
    await page.route("**/api/v1/ipam/external/assets", route => {
      if (route.request().method() !== "POST") return route.fulfill({ json: [] });
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 201, json: { id: 10, ...body } });
    });
    await page.route("**/api/v1/topology/devices", route => {
      if (route.request().method() === "POST") throw new Error("Cloud creation must not create a device");
      return route.fallback();
    });
  }});
  await page.goto("/inventory#cloud-assets");
  await page.getByRole("textbox", { name: "Search cloud assets" }).fill("does not match");
  await page.getByRole("button", { name: "Add cloud asset", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add cloud asset", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Name only");
  await dialog.getByRole("button", { name: "Add asset", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(body).toMatchObject({ name: "Name only", device_id: null, provider_id: null, kind: null });
  await expect(page.getByRole("textbox", { name: "Search cloud assets" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Open Name only details" })).toBeVisible();
});

test("read-only users cannot create cloud assets", async ({ page }) => {
  await setupExternalIps(page, { beforeGoto: async page => {
    await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { ...mockUser, role: "Viewer", permissions: [] } }));
  }});
  await page.goto("/inventory#cloud-assets");
  await expect(page.locator(".inventory-surface")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add cloud asset", exact: true })).toHaveCount(0);
});

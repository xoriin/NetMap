import { test, expect, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks, mockDevice, mockRelationship } from "./helpers/api-mocks";

const devices = [
  mockDevice({ id: 1, hostname: "router-01", ip_address: "10.0.0.1", topology_group: "Core" }),
  mockDevice({ id: 2, hostname: "switch-01", ip_address: "10.0.0.2", topology_group: "Core" }),
  mockDevice({ id: 3, hostname: "server-01", ip_address: "10.0.0.3", topology_group: "Servers" }),
];

const relationships = [
  mockRelationship({ id: 11, source_device_id: 1, target_device_id: 2 }),
  mockRelationship({ id: 12, source_device_id: 2, target_device_id: 3, notes: "__visual_endpoints__:device%3A2|group%3AServers" }),
];

async function openMap(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices, relationships);
  await page.goto("/topology");
  await expect(page.locator(".topology-overlay-node[title='server-01']")).toBeVisible({ timeout: 8000 });
  return errors;
}

const boxesToggle = (page: Page) => page.locator(".toolbar-toggle", { hasText: "Boxes" }).locator("input");
const centre = async (page: Page, title: string) => {
  const box = (await page.locator(`.topology-overlay-node[title='${title}'] .topology-device-icon-frame`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("group boxes show by default", async ({ page }) => {
  await openMap(page);
  await expect(boxesToggle(page)).toBeChecked();
  await expect(page.locator(".topology-group-header")).toHaveCount(2);
});

test("unticking Boxes hides every group box and keeps devices where they are", async ({ page }) => {
  const errors = await openMap(page);
  const before = await centre(page, "switch-01");

  await boxesToggle(page).uncheck();

  await expect(page.locator(".topology-group-header")).toHaveCount(0);
  await expect(page.locator(".topology-overlay-node")).toHaveCount(3);
  const after = await centre(page, "switch-01");
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test("a device can be dragged freely once boxes are off", async ({ page }) => {
  await openMap(page);
  await boxesToggle(page).uncheck();
  const server = await centre(page, "server-01");
  const router = await centre(page, "router-01");

  await page.mouse.move(server.x, server.y);
  await page.mouse.down();
  await page.mouse.move(server.x + 160, server.y + 120, { steps: 10 });
  await page.mouse.up();

  const moved = await centre(page, "server-01");
  expect(moved.x - server.x).toBeGreaterThan(120);
  const routerAfter = await centre(page, "router-01");
  expect(Math.abs(routerAfter.x - router.x)).toBeLessThan(2);
});

test("the Boxes choice is remembered after a reload", async ({ page }) => {
  await openMap(page);
  await boxesToggle(page).uncheck();
  await expect(page.locator(".topology-group-header")).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".topology-overlay-node[title='server-01']")).toBeVisible({ timeout: 8000 });

  await expect(boxesToggle(page)).not.toBeChecked();
  await expect(page.locator(".topology-group-header")).toHaveCount(0);
});

test("ticking Boxes again brings the group boxes back", async ({ page }) => {
  await openMap(page);
  await boxesToggle(page).uncheck();
  await boxesToggle(page).check();
  await expect(page.locator(".topology-group-header")).toHaveCount(2);
});

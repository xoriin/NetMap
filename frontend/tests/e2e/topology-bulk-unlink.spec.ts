import { test, expect, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks, mockDevice, mockRelationship } from "./helpers/api-mocks";

type Rel = ReturnType<typeof mockRelationship>;

const devices = [
  mockDevice({ id: 1, hostname: "switch-01", ip_address: "10.0.20.2", topology_group: "Rack" }),
  mockDevice({ id: 2, hostname: "hv-01", ip_address: "10.0.20.11", topology_group: "Rack" }),
  mockDevice({ id: 3, hostname: "nas-01", ip_address: "10.0.20.20", topology_group: "Rack" }),
  mockDevice({ id: 4, hostname: "core-01", ip_address: "10.0.0.1", topology_group: "Core" }),
];

const startLinks = (): Rel[] => [
  mockRelationship({ id: 11, source_device_id: 1, target_device_id: 2, link_speed_mbps: 10_000, notes: "rack a" }),
  mockRelationship({ id: 12, source_device_id: 1, target_device_id: 3, relationship_type: "storage" }),
  mockRelationship({ id: 13, source_device_id: 4, target_device_id: 1, relationship_type: "uplink" }),
];

async function openMap(page: Page, deleteStatus = 200) {
  const graph = { relationships: startLinks() };
  const bulkBodies: { relationship_ids: number[] }[] = [];
  const posts: Record<string, unknown>[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("netmap.topology-layout.v3.1", JSON.stringify({
      "device-1": { x: 0, y: 0 },
      "device-2": { x: 126, y: 0 },
      "device-3": { x: 252, y: 0 },
      "device-4": { x: 1400, y: 0 },
    }));
    localStorage.setItem("netmap.topology-layout.meta.1", JSON.stringify({ savedAt: Date.now() + 86_400_000 }));
  });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices, graph.relationships);
  await page.route("**/api/v1/topology/graph", (route) => route.fulfill({ json: { devices, relationships: graph.relationships } }));
  await page.route("**/api/v1/topology/relationships/bulk-delete", async (route) => {
    const body = route.request().postDataJSON() as { relationship_ids: number[] };
    bulkBodies.push(body);
    if (deleteStatus !== 200) return route.fulfill({ status: deleteStatus, json: { detail: "Database is locked" } });
    const deleted = graph.relationships.filter((r) => body.relationship_ids.includes(r.id));
    graph.relationships = graph.relationships.filter((r) => !body.relationship_ids.includes(r.id));
    return route.fulfill({ json: { deleted } });
  });
  await page.route("**/api/v1/topology/relationships", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    const created = mockRelationship({ id: 100 + posts.length, ...body });
    graph.relationships.push(created);
    return route.fulfill({ status: 201, json: created });
  });
  await page.goto("/topology");
  await expect(page.locator(".topology-overlay-node[title='core-01']")).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(400);
  return { graph, bulkBodies, posts };
}

async function centre(page: Page, title: string) {
  const box = (await page.locator(`.topology-overlay-node[title='${title}'] .topology-device-icon-frame`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function boxSelectRack(page: Page) {
  const header = (await page.locator(".topology-group-header", { hasText: "Rack" }).boundingBox())!;
  const nas = await centre(page, "nas-01");
  await page.keyboard.down("Shift");
  await page.mouse.move(header.x - 40, header.y - 40);
  await page.mouse.down();
  await page.mouse.move(nas.x + 50, nas.y + 90, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".topo-bulkbar")).toContainText("3 devices selected");
}

const removeButton = (page: Page) => page.locator(".topo-bulkbar").getByRole("button", { name: "Remove links…" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Remove links" });

test("removes only the links between the selected devices by default", async ({ page }) => {
  const { bulkBodies } = await openMap(page);
  await boxSelectRack(page);

  await removeButton(page).click();
  await expect(dialog(page)).toContainText("Only links between these devices (2)");
  await expect(dialog(page)).toContainText("Every link to or from these devices (3)");
  await dialog(page).getByRole("button", { name: "Remove 2 links" }).click();

  await expect(dialog(page)).toHaveCount(0);
  expect(bulkBodies).toEqual([{ relationship_ids: [11, 12] }]);
  await expect(page.locator(".topo-pathbar")).toContainText("Removed 2 links");
  await expect(page.locator(".topo-bulkbar")).toHaveCount(0);
});

test("can widen the removal to every link touching the selection", async ({ page }) => {
  const { bulkBodies } = await openMap(page);
  await boxSelectRack(page);

  await removeButton(page).click();
  await dialog(page).getByLabel(/Every link to or from these devices/).check();
  await dialog(page).getByRole("button", { name: "Remove 3 links" }).click();

  expect(bulkBodies[0].relationship_ids.sort()).toEqual([11, 12, 13]);
  await expect(page.locator(".topo-pathbar")).toContainText("Removed 3 links");
});

test("Undo restores the removed links with their settings", async ({ page }) => {
  const { posts } = await openMap(page);
  await boxSelectRack(page);
  await removeButton(page).click();
  await dialog(page).getByRole("button", { name: "Remove 2 links" }).click();

  await page.locator(".topo-pathbar").getByRole("button", { name: "Undo" }).click();

  await expect(page.locator(".topo-pathbar")).toHaveCount(0);
  await expect.poll(() => posts.length).toBe(2);
  expect(posts).toContainEqual(expect.objectContaining({ source_device_id: 1, target_device_id: 2, link_speed_mbps: 10_000, notes: "rack a", relationship_type: "uplink" }));
  expect(posts).toContainEqual(expect.objectContaining({ source_device_id: 1, target_device_id: 3, relationship_type: "storage" }));
});

test("Cancel removes nothing and keeps the selection", async ({ page }) => {
  const { bulkBodies } = await openMap(page);
  await boxSelectRack(page);
  await removeButton(page).click();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();

  await expect(dialog(page)).toHaveCount(0);
  expect(bulkBodies).toEqual([]);
  await expect(page.locator(".topo-bulkbar")).toContainText("3 devices selected");
});

test("a failed removal keeps the links and shows the error", async ({ page }) => {
  await openMap(page, 503);
  await boxSelectRack(page);
  await removeButton(page).click();
  await dialog(page).getByRole("button", { name: "Remove 2 links" }).click();

  await expect(page.getByText("Database is locked")).toBeVisible();
  await expect(page.locator(".topo-pathbar")).toHaveCount(0);
});

test("Esc dismisses the Removed bar", async ({ page }) => {
  await openMap(page);
  await boxSelectRack(page);
  await removeButton(page).click();
  await dialog(page).getByRole("button", { name: "Remove 2 links" }).click();
  await expect(page.locator(".topo-pathbar")).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.locator(".topo-pathbar")).toHaveCount(0);
});

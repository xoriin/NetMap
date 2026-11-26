import { test, expect, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks, mockDevice, mockRelationship } from "./helpers/api-mocks";

type Rel = ReturnType<typeof mockRelationship>;

const devices = [
  mockDevice({ id: 1, hostname: "router-01", ip_address: "10.0.0.1", topology_group: "Core" }),
  mockDevice({ id: 2, hostname: "switch-01", ip_address: "10.0.0.2", topology_group: "Core" }),
  mockDevice({ id: 3, hostname: "server-01", ip_address: "10.0.0.3", topology_group: "Servers" }),
];

async function openLinkMap(page: Page, relationships: Rel[] = [], createStatus = 201) {
  const graph = { relationships: [...relationships] };
  const posts: Record<string, unknown>[] = [];
  await setupCoreMocks(page);
  await setupTopologyMocks(page, devices, relationships);
  await page.route("**/api/v1/topology/graph", (route) => route.fulfill({ json: { devices, relationships: graph.relationships } }));
  await page.route("**/api/v1/topology/relationships", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    if (createStatus !== 201) return route.fulfill({ status: createStatus, json: { detail: "Database is locked" } });
    const created = mockRelationship({ id: 50 + posts.length - 1, ...body });
    graph.relationships.push(created);
    return route.fulfill({ status: 201, json: created });
  });
  await page.goto("/topology");
  await expect(page.locator(".topology-overlay-node[title='router-01']")).toBeVisible({ timeout: 8000 });
  return { posts, graph };
}

async function tapDevice(page: Page, title: string) {
  const box = (await page.locator(`.topology-overlay-node[title='${title}'] .topology-device-icon-frame`).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function tapGroup(page: Page, name: string) {
  const box = (await page.locator(".topology-group-header", { hasText: name }).boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + box.height + 6);
}

const linkModeButton = (page: Page) => page.getByRole("button", { name: "Link mode" });
const linkBar = (page: Page) => page.locator(".topo-pathbar");

test.describe("Topology Link mode", () => {
  test("link mode creates a link from two taps and stays on", async ({ page }) => {
    const { posts } = await openLinkMap(page);
    await linkModeButton(page).click();
    await expect(linkBar(page)).toContainText("Link mode: click the first device");

    await tapDevice(page, "router-01");
    await expect(page.locator(".topology-overlay-node.selected[title='router-01']")).toHaveCount(1);
    await expect(linkBar(page)).toContainText("Now click the device to link to router-01");

    await tapDevice(page, "switch-01");
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      source_device_id: 1,
      target_device_id: 2,
      relationship_type: "link",
      allow_outbound: true,
      allow_inbound: true,
      link_speed_mbps: null,
    });
    expect(String(posts[0].notes)).toMatch(/^__visual_endpoints__:device%3A1\|device%3A2/);
    await expect(linkBar(page)).toContainText("Link mode: click the first device");
    await expect(linkModeButton(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".topology-details-panel")).toHaveCount(0);
  });

  test("tapping the start device again clears it", async ({ page }) => {
    const { posts } = await openLinkMap(page);
    await linkModeButton(page).click();
    await tapDevice(page, "router-01");
    await expect(page.locator(".topology-overlay-node.selected")).toHaveCount(1);
    await tapDevice(page, "router-01");
    await expect(page.locator(".topology-overlay-node.selected")).toHaveCount(0);
    await expect(linkBar(page)).toContainText("Link mode: click the first device");
    expect(posts).toHaveLength(0);
  });

  test("an already-linked pair creates nothing", async ({ page }) => {
    const { posts } = await openLinkMap(page, [mockRelationship({ id: 7, source_device_id: 1, target_device_id: 2 })]);
    await linkModeButton(page).click();
    await tapDevice(page, "switch-01");
    await tapDevice(page, "router-01");
    await expect(linkBar(page)).toContainText("switch-01 and router-01 are already linked");
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(0);
  });

  test("a group tap links to the group's representative device", async ({ page }) => {
    const { posts } = await openLinkMap(page);
    await linkModeButton(page).click();
    await tapGroup(page, "Core");
    await tapDevice(page, "server-01");
    await expect.poll(() => posts.length).toBe(1);
    expect(String(posts[0].notes)).toMatch(/^__visual_endpoints__:group%3ACore\|device%3A3/);
    expect(posts[0].target_device_id).toBe(3);
  });

  test("link mode and path mode switch each other off", async ({ page }) => {
    await openLinkMap(page);
    const path = page.getByRole("button", { name: "Path", exact: true });
    await linkModeButton(page).click();
    await path.click();
    await expect(linkModeButton(page)).toHaveAttribute("aria-pressed", "false");
    await expect(path).toHaveAttribute("aria-pressed", "true");
    await linkModeButton(page).click();
    await expect(path).toHaveAttribute("aria-pressed", "false");
    await expect(linkModeButton(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("Esc clears the start, then exits link mode", async ({ page }) => {
    await openLinkMap(page);
    await page.keyboard.press("l");
    await expect(linkModeButton(page)).toHaveAttribute("aria-pressed", "true");
    await tapDevice(page, "router-01");
    await page.keyboard.press("Escape");
    await expect(page.locator(".topology-overlay-node.selected")).toHaveCount(0);
    await expect(linkBar(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(linkBar(page)).toHaveCount(0);
    await expect(linkModeButton(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("a failed create shows the error and adds nothing", async ({ page }) => {
    await openLinkMap(page, [], 500);
    await linkModeButton(page).click();
    await tapDevice(page, "router-01");
    await tapDevice(page, "switch-01");
    await expect(page.locator(".form-error")).toContainText("Database is locked");
    await expect(page.locator(".topology-link-label")).toHaveCount(0);
    await expect(page.locator(".topo-linkquick")).toHaveCount(0);
  });

  test("link mode is hidden without topology write", async ({ page }) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page, devices, []);
    await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { id: 2, username: "viewer", email: "viewer@example.com", role: "Viewer", is_active: true, permissions: ["topology_read"] } }));
    await page.goto("/topology");
    await expect(page.locator(".topology-overlay-node[title='router-01']")).toBeVisible({ timeout: 8000 });
    await expect(linkModeButton(page)).toHaveCount(0);
  });
});

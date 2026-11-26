import { test, expect, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks, mockDevice, mockRelationship } from "./helpers/api-mocks";

type Rel = ReturnType<typeof mockRelationship>;

const devices = [
  mockDevice({ id: 1, hostname: "router-01", ip_address: "10.0.0.1", topology_group: "Core" }),
  mockDevice({ id: 2, hostname: "switch-01", ip_address: "10.0.0.2", topology_group: "Core" }),
  mockDevice({ id: 3, hostname: "server-01", ip_address: "10.0.0.3", topology_group: "Servers" }),
];

async function openLinkMap(page: Page, relationships: Rel[] = [], createStatus = 201, patchStatus = 200) {
  const graph = { relationships: [...relationships] };
  const posts: Record<string, unknown>[] = [];
  const patches: { id: number; body: Record<string, unknown> }[] = [];
  const deletes: number[] = [];
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
  await page.route(/\/api\/v1\/topology\/relationships\/\d+$/, async (route) => {
    const id = Number(route.request().url().split("/").pop());
    if (route.request().method() === "DELETE") {
      deletes.push(id);
      graph.relationships = graph.relationships.filter((r) => r.id !== id);
      return route.fulfill({ status: 204, body: "" });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    patches.push({ id, body });
    if (patchStatus !== 200) return route.fulfill({ status: patchStatus, json: { detail: "Speed update refused" } });
    const current = graph.relationships.find((r) => r.id === id)!;
    Object.assign(current, body);
    return route.fulfill({ json: current });
  });
  await page.goto("/topology");
  await expect(page.locator(".topology-overlay-node[title='router-01']")).toBeVisible({ timeout: 8000 });
  return { posts, graph, patches, deletes };
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

  test.describe("quick-edit popup", () => {
    const popup = (page: Page) => page.locator(".topo-linkquick");

    async function makeLink(page: Page, from = "router-01", to = "switch-01") {
      await tapDevice(page, from);
      await tapDevice(page, to);
      await expect(popup(page)).toBeVisible();
    }

    test("the popup appears at the cursor after a link is made", async ({ page }) => {
      await openLinkMap(page);
      await linkModeButton(page).click();
      await makeLink(page);
      await expect(popup(page)).toContainText("Linked router-01 → switch-01");
      await expect(popup(page).getByRole("button", { name: "—" })).toHaveClass(/nm-btn--active/);
      await expect(popup(page)).toHaveAttribute("role", "dialog");
    });

    test("a speed picked in the popup saves and carries to the next link", async ({ page }) => {
      const { posts, patches } = await openLinkMap(page);
      await linkModeButton(page).click();
      await makeLink(page);
      await popup(page).getByRole("button", { name: "1G", exact: true }).click();
      await expect.poll(() => patches.length).toBe(1);
      expect(patches[0]).toEqual({ id: 50, body: { link_speed_mbps: 1000 } });
      await expect(popup(page).getByRole("button", { name: "1G", exact: true })).toHaveClass(/nm-btn--active/);
      await expect(linkBar(page)).toContainText("New links: 1 Gbps");
      await tapDevice(page, "router-01");
      await tapDevice(page, "server-01");
      await expect.poll(() => posts.length).toBe(2);
      expect(posts[1].link_speed_mbps).toBe(1000);
    });

    test("the next tap closes the popup without blocking", async ({ page }) => {
      await openLinkMap(page);
      await linkModeButton(page).click();
      await makeLink(page);
      await tapDevice(page, "router-01");
      await expect(popup(page)).toHaveCount(0);
      await expect(page.locator(".topology-overlay-node.selected[title='router-01']")).toHaveCount(1);
    });

    test("undo deletes the new link", async ({ page }) => {
      const { deletes } = await openLinkMap(page);
      await linkModeButton(page).click();
      await makeLink(page);
      await popup(page).getByRole("button", { name: "Undo" }).click();
      await expect.poll(() => deletes).toEqual([50]);
      await expect(linkBar(page)).toContainText("Link removed — click two devices to try again");
      await expect(popup(page)).toHaveCount(0);
    });

    test("More opens the edit form for that link", async ({ page }) => {
      await openLinkMap(page);
      await linkModeButton(page).click();
      await makeLink(page);
      await popup(page).getByRole("button", { name: "More…" }).click();
      await expect(page.getByRole("dialog", { name: "Edit link" })).toBeVisible();
    });

    test("clearing the type saves link", async ({ page }) => {
      const { patches } = await openLinkMap(page);
      await linkModeButton(page).click();
      await makeLink(page);
      const type = popup(page).getByLabel("Link type");
      await type.fill("");
      await type.press("Tab");
      await expect(type).toHaveValue("link");
      await type.fill("uplink");
      await type.press("Enter");
      await expect.poll(() => patches.map((p) => p.body)).toEqual([{ relationship_type: "uplink" }]);
      await type.fill("  ");
      await type.press("Tab");
      await expect.poll(() => patches.map((p) => p.body)).toEqual([{ relationship_type: "uplink" }, { relationship_type: "link" }]);
    });

    test("typing L in the type field does not toggle link mode", async ({ page }) => {
      await openLinkMap(page);
      await linkModeButton(page).click();
      await makeLink(page);
      const type = popup(page).getByLabel("Link type");
      await type.click();
      await type.pressSequentially("lag");
      await expect(linkModeButton(page)).toHaveAttribute("aria-pressed", "true");
      await expect(type).toHaveValue("linklag");
    });

    test("a popup near the window edge stays on screen", async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 600 });
      await openLinkMap(page);
      await linkModeButton(page).click();
      for (const target of ["server-01", "switch-01"]) {
        await tapDevice(page, "router-01");
        await tapDevice(page, target);
        await expect(popup(page)).toBeVisible();
        const box = (await popup(page).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(900);
        expect(box.y + box.height).toBeLessThanOrEqual(600);
      }
    });

    test("a failed speed change shows the error", async ({ page }) => {
      await openLinkMap(page, [], 201, 500);
      await linkModeButton(page).click();
      await makeLink(page);
      await popup(page).getByRole("button", { name: "10G", exact: true }).click();
      await expect(page.locator(".form-error")).toContainText("Speed update refused");
      await expect(page.locator(".topology-link-label", { hasText: "10 Gbps" })).toHaveCount(0);
    });
  });
});

import { test, expect, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks, mockDevice } from "./helpers/api-mocks";

async function centre(page: Page, title: string) {
  const box = (await page.locator(`.topology-overlay-node[title='${title}'] .topology-device-icon-frame`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test("a device in a group with no saved layout lands beside the arranged map", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("netmap.topology-layout.v3.1", JSON.stringify({
      "device-1": { x: 4000, y: 3000 },
      "device-2": { x: 4126, y: 3000 },
      "device-3": { x: 4252, y: 3000 },
    }));
    localStorage.setItem("netmap.topology-layout.meta.1", JSON.stringify({ savedAt: Date.now() + 86_400_000 }));
  });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [
    mockDevice({ id: 1, hostname: "router-01", ip_address: "10.0.0.1", topology_group: "Core" }),
    mockDevice({ id: 2, hostname: "switch-01", ip_address: "10.0.0.2", topology_group: "Core" }),
    mockDevice({ id: 3, hostname: "server-01", ip_address: "10.0.0.3", topology_group: "Core" }),
    mockDevice({ id: 4, hostname: "aws-vm-01", ip_address: "172.31.0.10", topology_group: "AWS" }),
  ], []);
  await page.goto("/topology");
  await expect(page.locator(".topology-overlay-node[title='aws-vm-01']")).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(500);

  const router = await centre(page, "router-01");
  const switchNode = await centre(page, "switch-01");
  const server = await centre(page, "server-01");
  const aws = await centre(page, "aws-vm-01");
  const neighbourGap = distance(router, switchNode);
  const nearest = Math.min(distance(aws, router), distance(aws, switchNode), distance(aws, server));

  expect(neighbourGap).toBeGreaterThan(40);
  expect(nearest / neighbourGap).toBeLessThan(6);
});

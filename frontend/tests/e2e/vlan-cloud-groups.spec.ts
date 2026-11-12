import { expect, test, type Page } from "@playwright/test";
import { mockDevice, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const networkGroup = {
  id: 20,
  name: "Servers",
  display_name: "Production servers",
  vlan_id: "20",
  ip_range: "10.30.20.0/24",
  gateway: "10.30.20.1",
  dhcp_start: "10.30.20.20",
  dhcp_end: "10.30.20.200",
  dns_servers: "10.30.20.2, 10.30.20.3",
  description: "Server network",
  color: null,
  kind: "network",
  provider: null,
};

const cloudGroup = {
  id: 21,
  name: "AWS VPC",
  display_name: "Cloud apps",
  vlan_id: null,
  ip_range: null,
  gateway: null,
  dhcp_start: null,
  dhcp_end: null,
  dns_servers: null,
  description: "Public cloud",
  color: null,
  kind: "cloud",
  provider: "AWS",
};

async function setupVlans(page: Page, groups = [networkGroup, cloudGroup]) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [
    mockDevice({ topology_group: "Servers" }),
    mockDevice({ id: 2, hostname: "lambda-1", ip_address: "10.0.0.2", topology_group: "AWS VPC" }),
  ]);
  await page.route("**/api/v1/topology/groups*", (route) => {
    if (route.request().method() === "GET") route.fulfill({ json: groups });
    else route.fulfill({ json: { ...networkGroup, kind: "cloud", provider: "AWS" } });
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("netmap.theme", "dark");
    window.localStorage.setItem("netmap.dark_style", "slate");
  });
  await page.goto("/vlans");
  await page.locator(".vlan-table-panel").waitFor({ state: "visible", timeout: 8000 });
}

test("switching a group to Cloud clears network fields and PATCHes them as null", async ({ page }) => {
  let patchBody: Record<string, unknown> | null = null;
  await setupVlans(page);
  await page.route("**/api/v1/topology/groups/20", async (route) => {
    if (route.request().method() === "PATCH") {
      patchBody = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        json: {
          ...networkGroup,
          kind: "cloud",
          provider: "AWS",
          vlan_id: null,
          ip_range: null,
          gateway: null,
          dhcp_start: null,
          dhcp_end: null,
          dns_servers: null,
        },
      });
    }
    return route.fulfill({ json: networkGroup });
  });

  const row = page.locator(".vlan-row", { hasText: "Servers" }).first();
  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit group" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "VLAN ID" })).toHaveValue("20");
  await expect(dialog.getByRole("textbox", { name: "Subnet (CIDR)" })).toHaveValue("10.30.20.0/24");
  await expect(dialog.getByRole("textbox", { name: "Gateway" })).toHaveValue("10.30.20.1");
  await expect(dialog.getByRole("textbox", { name: "DNS servers" })).toHaveValue("10.30.20.2, 10.30.20.3");

  await dialog.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Cloud", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("textbox", { name: "VLAN ID" })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Subnet (CIDR)" })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Gateway" })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "DNS servers" })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Provider" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Provider" }).fill("AWS");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);

  expect(patchBody).not.toBeNull();
  expect(patchBody).toMatchObject({
    kind: "cloud",
    provider: "AWS",
    vlan_id: null,
    ip_range: null,
    gateway: null,
    dhcp_start: null,
    dhcp_end: null,
    dns_servers: null,
  });
});

test("the group list shows a cloud icon and provider subtitle, and switching back to Network sends provider null", async ({ page }) => {
  let patchBody: Record<string, unknown> | null = null;
  await setupVlans(page);
  await page.route("**/api/v1/topology/groups/21", async (route) => {
    if (route.request().method() === "PATCH") {
      patchBody = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { ...cloudGroup, kind: "network", provider: null } });
    }
    return route.fulfill({ json: cloudGroup });
  });

  const cloudRow = page.locator('.vlan-row[data-group-kind="cloud"]', { hasText: "AWS VPC" });
  await expect(cloudRow.getByRole("img", { name: "Cloud group" })).toBeVisible();
  await expect(cloudRow.locator(".vlan-name-sub")).toHaveText("AWS");
  await expect(cloudRow.locator(".nm-pill")).toHaveCount(0);
  await expect(cloudRow.locator(".vlan-empty-cell").first()).toHaveText("—");

  await cloudRow.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit group" });
  await dialog.getByRole("button", { name: "Network", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Provider" })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "VLAN ID" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
  expect(patchBody).toMatchObject({ kind: "network", provider: null });
});

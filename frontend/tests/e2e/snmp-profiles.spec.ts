import { expect, test, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const stamp = "2026-11-20T12:00:00Z";

function profile(row: Record<string, unknown>) {
  return {
    username: null,
    security_level: null,
    auth_protocol: null,
    priv_protocol: null,
    context_name: null,
    has_community: false,
    has_auth_key: false,
    has_priv_key: false,
    created_at: stamp,
    updated_at: stamp,
    ...row,
  };
}

async function openProfiles(page: Page, rows: ReturnType<typeof profile>[] = []) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("netmap.theme", "dark");
    localStorage.setItem("netmap.dark_style", "slate");
  });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/tools/snmp/profiles**", (route) => route.fulfill({ json: rows }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin#credentials");
  await expect(page.getByRole("region", { name: "Add SNMP Profile", exact: true })).toBeVisible();
}

test("the profile list shows each profile's real version", async ({ page }) => {
  await openProfiles(page, [
    profile({ id: 1, name: "Core v3", version: "v3", port: 161, timeout_seconds: 2, retries: 1, username: "monitor", security_level: "authPriv", has_auth_key: true, has_priv_key: true }),
    profile({ id: 2, name: "Lab", version: "v2c", port: 1161, timeout_seconds: 5, retries: 3, has_community: true }),
  ]);
  const table = page.locator(".admin-snmp-table");
  await expect(table.locator(".admin-users-row", { hasText: "Core v3" }).locator(".notif-method-tag")).toHaveText("v3");
  await expect(table.locator(".admin-users-row", { hasText: "Lab" }).locator(".notif-method-tag")).toHaveText("v2c");
  await expect(page.locator(".dash-stat", { hasText: "SNMPv3" }).locator(".dash-stat-value")).toHaveText("1");
  await expect(page.locator(".dash-stat", { hasText: "SNMPv2c" }).locator(".dash-stat-value")).toHaveText("1");
});

test("creating a v3 authPriv profile sends only v3 fields", async ({ page }) => {
  const created: unknown[] = [];
  await openProfiles(page);
  await page.route("**/api/v1/tools/snmp/profiles**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      created.push(body);
      return route.fulfill({
        json: profile({
          id: 3,
          ...body,
          has_community: false,
          has_auth_key: true,
          has_priv_key: true,
          community: undefined,
          auth_key: undefined,
          priv_key: undefined,
        }),
      });
    }
    return route.fulfill({ json: [] });
  });
  const form = page.getByRole("region", { name: "Add SNMP Profile", exact: true });
  await form.getByLabel("Name", { exact: true }).fill("Edge switches");
  await form.getByRole("combobox", { name: "Version", exact: true }).selectOption("v3");
  await expect(form.getByLabel("Community", { exact: true })).toHaveCount(0);
  await form.getByLabel("Username", { exact: true }).fill("monitor");
  await form.getByRole("combobox", { name: "Security level", exact: true }).selectOption("authPriv");
  await form.getByRole("combobox", { name: "Auth protocol", exact: true }).selectOption("SHA-256");
  await form.getByLabel("Auth key", { exact: true }).fill("auth-secret-1");
  await form.getByRole("combobox", { name: "Privacy protocol", exact: true }).selectOption("AES");
  await form.getByLabel("Privacy key", { exact: true }).fill("priv-secret-1");
  await form.getByLabel("Context name", { exact: true }).fill("nmc");
  await form.getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(page.locator(".admin-snmp-table .admin-users-row", { hasText: "Edge switches" }).locator(".notif-method-tag")).toHaveText("v3");
  expect(created).toEqual([{
    name: "Edge switches",
    version: "v3",
    port: 161,
    timeout_seconds: 3,
    retries: 1,
    username: "monitor",
    security_level: "authPriv",
    auth_protocol: "SHA-256",
    auth_key: "auth-secret-1",
    priv_protocol: "AES",
    priv_key: "priv-secret-1",
    context_name: "nmc",
  }]);
  expect(JSON.stringify(created[0])).not.toContain("community");
});

test("creating a v2c profile omits v3 fields", async ({ page }) => {
  const created: unknown[] = [];
  await openProfiles(page);
  await page.route("**/api/v1/tools/snmp/profiles**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      created.push(body);
      return route.fulfill({ json: profile({ id: 4, ...body, has_community: true, community: undefined }) });
    }
    return route.fulfill({ json: [] });
  });
  const form = page.getByRole("region", { name: "Add SNMP Profile", exact: true });
  await form.getByLabel("Name", { exact: true }).fill("Access points");
  await expect(form.getByRole("combobox", { name: "Version", exact: true })).toHaveValue("v2c");
  await form.getByLabel("Community", { exact: true }).fill("public");
  await expect(form.getByLabel("Username", { exact: true })).toHaveCount(0);
  await expect(form.getByLabel("Auth key", { exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(page.locator(".admin-snmp-table .admin-users-row", { hasText: "Access points" }).locator(".notif-method-tag")).toHaveText("v2c");
  expect(created).toEqual([{
    name: "Access points",
    version: "v2c",
    port: 161,
    timeout_seconds: 3,
    retries: 1,
    community: "public",
  }]);
  expect(JSON.stringify(created[0])).not.toContain("username");
  expect(JSON.stringify(created[0])).not.toContain("auth_key");
  expect(JSON.stringify(created[0])).not.toContain("priv_key");
});

test("editing a v3 profile leaves blank secrets out of the PATCH", async ({ page }) => {
  const existing = profile({
    id: 1,
    name: "Core v3",
    version: "v3",
    port: 161,
    timeout_seconds: 2,
    retries: 1,
    username: "monitor",
    security_level: "authPriv",
    auth_protocol: "SHA-256",
    priv_protocol: "AES",
    context_name: "nmc",
    has_auth_key: true,
    has_priv_key: true,
  });
  const saved: unknown[] = [];
  await openProfiles(page, [existing]);
  await page.route("**/api/v1/tools/snmp/profiles**", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      saved.push(body);
      return route.fulfill({ json: { ...existing, ...body, name: "Core v3 renamed", has_auth_key: true, has_priv_key: true } });
    }
    return route.fulfill({ json: [existing] });
  });
  await page.getByRole("button", { name: "Edit Core v3", exact: true }).click();
  const form = page.getByRole("region", { name: "Edit Core v3", exact: true });
  await expect(form.getByLabel("Auth key", { exact: true })).toHaveAttribute("placeholder", "leave blank to keep");
  await expect(form.getByLabel("Privacy key", { exact: true })).toHaveAttribute("placeholder", "leave blank to keep");
  await expect(form.getByLabel("Auth key", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("Privacy key", { exact: true })).toHaveValue("");
  await form.getByLabel("Name", { exact: true }).fill("Core v3 renamed");
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  expect(saved).toEqual([{
    name: "Core v3 renamed",
    version: "v3",
    port: 161,
    timeout_seconds: 2,
    retries: 1,
    username: "monitor",
    security_level: "authPriv",
    auth_protocol: "SHA-256",
    priv_protocol: "AES",
    context_name: "nmc",
  }]);
  expect(JSON.stringify(saved[0])).not.toContain("auth_key");
  expect(JSON.stringify(saved[0])).not.toContain("priv_key");
  expect(JSON.stringify(saved[0])).not.toContain("community");
});

test("an ad-hoc SNMP probe stays v2c-only while the picker offers v3 profiles", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/tools/snmp/profiles", (route) => route.fulfill({ json: [
    profile({ id: 1, name: "Core v3", version: "v3", port: 161, timeout_seconds: 2, retries: 1, has_auth_key: true, has_priv_key: true }),
    profile({ id: 2, name: "Lab", version: "v2c", port: 161, timeout_seconds: 3, retries: 1, has_community: true }),
  ] }));
  await page.goto("/tools");
  await page.getByRole("tab", { name: "SNMP Probe", exact: true }).click();
  const form = page.getByRole("tabpanel").locator("form.tool-form");
  const picker = form.getByRole("combobox", { name: "Profile", exact: true });
  await expect(picker).toContainText("Core v3 (v3)");
  await expect(picker).toContainText("Lab (v2c)");
  await expect(picker).toHaveValue("");
  await expect(form.getByLabel("Community", { exact: true })).toBeVisible();
  await expect(form.getByLabel("Username", { exact: true })).toHaveCount(0);
  await expect(form.getByLabel("Auth key", { exact: true })).toHaveCount(0);
  await picker.selectOption("1");
  await expect(form.getByLabel("Community", { exact: true })).toHaveCount(0);
  await expect(form.getByLabel("Username", { exact: true })).toHaveCount(0);
});

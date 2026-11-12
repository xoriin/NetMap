import { expect, test, type Page } from "@playwright/test";
import { mockUser, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function openAutomation(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, []);
  await page.route("**/api/v1/discovery/schedules", (route) => {
    if (route.request().method() === "GET") route.fulfill({ json: [] });
    else route.fulfill({ json: { id: 1, name: "Wide", target: "10.0.0.0/16", scan_type: "ping", enabled: true, interval_minutes: 1440, confirm_large_scan: true } });
  });
  await page.route("**/api/v1/discovery/observations*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/discovery/observations/summary*", (route) => route.fulfill({ json: { days: [] } }));
  await page.route("**/api/v1/admin/notification-profiles", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/topology/groups*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [{ ...mockUser, display_name: null, avatar_data: null, auth_source: "local" }] }));
  await page.goto("/admin#automation");
  await expect(page.getByRole("region", { name: "New Schedule", exact: true })).toBeVisible();
}

test("creating a schedule larger than 256 hosts requires confirmation and sends confirm_large_scan true", async ({ page }) => {
  let created: Record<string, unknown> | null = null;
  await openAutomation(page);
  await page.route("**/api/v1/discovery/schedules", async (route) => {
    if (route.request().method() === "POST") {
      created = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        json: { id: 12, ...created, owner_user_id: mockUser.id, last_run_at: null, next_run_at: null, last_error: null, open_observation_count: 0, created_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z" },
      });
    }
    return route.fulfill({ json: [] });
  });

  const form = page.getByRole("region", { name: "New Schedule", exact: true });
  await form.getByPlaceholder("192.168.1.0/24").fill("10.0.0.0/16");
  await expect(form.getByText("65536 IPv4 addresses")).toBeVisible();
  const confirm = form.getByRole("checkbox", { name: "Confirm large scan" });
  await expect(confirm).toBeVisible();
  const submit = form.getByRole("button", { name: "Create schedule" });
  await expect(submit).toBeDisabled();
  await confirm.check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => created).not.toBeNull();
  expect(created).toMatchObject({ target: "10.0.0.0/16", confirm_large_scan: true });
});

test("uses the confirm threshold from GET /discovery/config", async ({ page }) => {
  let created: Record<string, unknown> | null = null;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, []);
  await page.route("**/api/v1/discovery/config", (route) =>
    route.fulfill({ json: { discovery_max_hosts_without_confirmation: 100, discovery_max_hosts: 65536 } }),
  );
  await page.route("**/api/v1/discovery/schedules", async (route) => {
    if (route.request().method() === "POST") {
      created = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        json: { id: 13, ...created, owner_user_id: mockUser.id, last_run_at: null, next_run_at: null, last_error: null, open_observation_count: 0, created_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z" },
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/v1/discovery/observations*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/discovery/observations/summary*", (route) => route.fulfill({ json: { days: [] } }));
  await page.route("**/api/v1/admin/notification-profiles", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/topology/groups*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [{ ...mockUser, display_name: null, avatar_data: null, auth_source: "local" }] }));
  await page.goto("/admin#automation");

  const form = page.getByRole("region", { name: "New Schedule", exact: true });
  await expect(form).toBeVisible();
  await form.getByPlaceholder("192.168.1.0/24").fill("192.168.1.0/24");
  await expect(form.getByText("256 IPv4 addresses")).toBeVisible();
  const confirm = form.getByRole("checkbox", { name: "Confirm large scan" });
  await expect(confirm).toBeVisible();
  const submit = form.getByRole("button", { name: "Create schedule" });
  await expect(submit).toBeDisabled();
  await confirm.check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => created).not.toBeNull();
  expect(created).toMatchObject({ target: "192.168.1.0/24", confirm_large_scan: true });
});

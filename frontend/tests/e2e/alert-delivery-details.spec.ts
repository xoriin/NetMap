import { expect, test, type Page } from "@playwright/test";
import { mockUser, setupCoreMocks } from "./helpers/api-mocks";

const sentAt = new Date(Date.now() - 3600_000).toISOString();
const message = "NetMap Alert\n\n⚠️ core-sw-01 (10.30.30.2) is now OFFLINE";
const deliveries = [
  { id: 3, rule_name: "Core switch down", device_id: 1, target: "profile:3", status: "failed", detail: "HTTP 401: delivery failed", message, event_type: "device_offline", source_label: "core-sw-01", sent_at: sentAt },
  { id: 2, rule_name: "Core switch down", device_id: 1, target: "profile:2", status: "sent", detail: "", message, event_type: "device_offline", source_label: "core-sw-01", sent_at: sentAt },
  { id: 1, rule_name: "Core switch down", device_id: 1, target: "profile:1", status: "sent", detail: "", message, event_type: "device_offline", source_label: "core-sw-01", sent_at: sentAt },
  { id: 5, rule_name: "Core switch down", device_id: 2, target: "profile:2", status: "sent", detail: "", message: "NetMap Alert\n\n⚠️ core-sw-02 (10.30.30.3) is now OFFLINE", event_type: "device_offline", source_label: "core-sw-02", sent_at: sentAt },
  { id: 4, rule_name: "Slow NAS", device_id: null, target: "email", status: "sent", detail: "", message: "", event_type: "", source_label: "", sent_at: new Date(Date.now() - 4 * 86_400_000).toISOString() },
];
const profiles = [
  { id: 1, name: "Ops email", provider: "smtp", enabled: true, config: { method: "smtp" }, created_at: sentAt, updated_at: sentAt },
  { id: 2, name: "On-call ntfy", provider: "ntfy", enabled: true, config: { method: "ntfy" }, created_at: sentAt, updated_at: sentAt },
  { id: 3, name: "Team Discord", provider: "apprise", enabled: true, config: { method: "discord" }, created_at: sentAt, updated_at: sentAt },
];

async function boot(page: Page, theme: "light" | "slate" | "zinc" = "slate") {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [{ ...mockUser, avatar_data: null, auth_source: "local" }] }));
  await page.route("**/api/v1/admin/notification-profiles", (route) => route.fulfill({ json: profiles }));
  await page.route("**/api/v1/alerts/deliveries*", (route) => route.fulfill({ json: deliveries }));
  await page.addInitScript((value) => {
    localStorage.setItem("netmap.theme", value === "light" ? "light" : "dark");
    localStorage.setItem("netmap.dark_style", value === "zinc" ? "zinc" : "slate");
  }, theme);
  await page.goto("/admin#alerts");
}

const history = (page: Page) => page.getByRole("region", { name: "Delivery History", exact: true });

test("Delivery History shows the device and what was sent, and marks older rows as not recorded", async ({ page }) => {
  await boot(page);
  const rows = history(page).locator("tbody tr");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText("core-sw-01");
  await expect(rows.nth(0)).toContainText("core-sw-01 (10.30.30.2) is now OFFLINE");
  await expect(rows.nth(0)).toContainText("HTTP 401: delivery failed");
  await expect(rows.nth(4)).toContainText("Not recorded");
});

test("Failed only narrows the list and All brings every row back", async ({ page }) => {
  await boot(page);
  const panel = history(page);
  await panel.getByRole("button", { name: /Failed only/ }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: /Failed only/ })).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: /^All/ }).click();
  await expect(panel.locator("tbody tr")).toHaveCount(5);
});

test("clicking a row opens the notification with the exact text, the result and the other methods", async ({ page }) => {
  await boot(page);
  await history(page).locator("tbody tr").first().click();
  const dialog = page.getByRole("dialog", { name: "Core switch down" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".nm-pill")).toHaveText("Failed");
  expect(await dialog.locator(".alert-delivery-message").textContent()).toBe(message);
  await expect(dialog.getByRole("region", { name: "Delivery" })).toContainText("Team Discord · Discord");
  await expect(dialog.getByRole("region", { name: "Delivery" })).toContainText("HTTP 401: delivery failed");
  await expect(dialog.getByRole("region", { name: "Delivery" })).toContainText("Core switch down · Goes offline");
  const others = dialog.getByRole("region", { name: "Same alert, other methods" }).locator("li");
  await expect(others).toHaveCount(2);
  await expect(others.nth(0)).toContainText("On-call ntfy");
  await expect(others.nth(1)).toContainText("Ops email");
  await expect(others.filter({ hasText: "core-sw-02" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("a row opens from the keyboard, and an older notification explains that its text was not kept", async ({ page }) => {
  await boot(page);
  const old = history(page).locator("tbody tr").nth(4);
  await old.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Slow NAS" });
  await expect(dialog).toContainText("not recorded for notifications sent before NetMap 1.8.0");
  await expect(dialog.getByRole("button", { name: "Copy" })).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Same alert, other methods" })).toHaveCount(0);
});

for (const theme of ["light", "slate", "zinc"] as const) {
  test(`the sent message is readable in ${theme}`, async ({ page }) => {
    await boot(page, theme);
    await history(page).locator("tbody tr").nth(1).click();
    const pre = page.locator(".alert-delivery-message");
    await expect(pre).toBeVisible();
    const [fg, bg] = await pre.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
    const lum = (c: string) => {
      const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    expect((a + 0.05) / (b + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
}

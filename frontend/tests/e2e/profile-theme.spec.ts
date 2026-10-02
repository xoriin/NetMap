import { expect, test, type Page } from "@playwright/test";
import { mockUser, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const profileUser = {
  ...mockUser,
  display_name: "Test User",
  email: "user@example.com",
  avatar_data: null,
  auth_source: "local",
  entity_colors_enabled: true,
};

const apiKeys = [
  {
    id: 1,
    name: "Automation",
    prefix: "AbCdEf123456",
    suffix: "x7Qp",
    created_at: "2026-07-11T00:00:00Z",
    expires_at: null,
    last_used_at: "2026-08-01T00:00:00Z",
    last_used_ip: "10.0.0.10",
    revoked_at: null,
  },
  {
    id: 2,
    name: "Reporting",
    prefix: "GhJkLm789012",
    suffix: null,
    created_at: "2026-07-12T00:00:00Z",
    expires_at: null,
    last_used_at: null,
    last_used_ip: null,
    revoked_at: null,
  },
];

async function setupProfileMocks(page: Page, userOverrides: Record<string, unknown> = {}, theme: "light" | "dark" = "dark") {
  await setupCoreMocks(page, "Maintenance window tonight");
  await setupTopologyMocks(page);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ...profileUser, ...userOverrides } }));
  await page.route("**/api/v1/api-keys", (route) => route.fulfill({ json: apiKeys }));
  await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
}

async function setupProfile(page: Page, theme: "light" | "dark" = "dark") {
  await setupProfileMocks(page, {}, theme);
  await page.goto("/profile");
  await page.locator(".profile-layout").waitFor({ state: "visible" });
}

for (const theme of ["light", "dark"] as const) {
  test(`Profile uses the approved account hierarchy in ${theme} mode`, async ({ page }) => {
    await setupProfile(page, theme);

    await expect(page.locator(".profile-identity-panel")).toHaveCSS("background-image", "none");
    await expect(page.locator(".profile-identity-name")).toHaveText("Test User");
    await expect(page.locator(".profile-summary-item")).toHaveCount(4);
    await expect(page.locator(".profile-summary-band")).toContainText("Profile completeness");
    await expect(page.locator(".profile-summary-band")).toContainText("Local password");
    await expect(page.locator(".profile-summary-band")).toContainText("2 keys can access NetMap");
    await expect(page.locator(".profile-panel-header")).toHaveCount(5);
    await expect(page.locator(".profile-panel-header").first()).toHaveCSS("min-height", "44px");
    await expect(page.locator(".profile-key-mask").first()).toHaveText("•••• •••• •••• x7Qp");
    await expect(page.locator(".profile-key-mask").nth(1)).toHaveText("•••• •••• •••• ••••");
    await expect(page.locator(".profile-panel .nm-input").first()).toHaveCSS(
      "background-color",
      theme === "dark" ? "rgb(10, 21, 32)" : "rgb(255, 255, 255)",
    );
  });
}

test("Profile settings reflow without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await setupProfile(page);

  const widths = await page.locator(".profile-layout").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await expect(page.locator(".profile-settings-grid")).toHaveCSS("grid-template-columns", /.+/);
});

test("Profile API key creation keeps the canonical one-time warning", async ({ page }) => {
  await setupProfile(page);

  await page.getByRole("button", { name: "Create API key" }).click();
  const modal = page.getByRole("dialog", { name: "Create API key" });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("shown once after creation");
  await expect(modal.getByLabel("Name")).toBeVisible();
});

test("two-factor row offers setup and completes enrolment in a modal", async ({ page }) => {
  await setupProfileMocks(page, { totp_enabled: false, totp_required: false, recovery_codes_remaining: 0 });
  await page.route("**/api/v1/auth/me/totp/setup", (route) => route.fulfill({ json: { secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/NetMap:alice?secret=JBSWY3DPEHPK3PXP&issuer=NetMap" } }));
  await page.route("**/api/v1/auth/me/totp/confirm", (route) => route.fulfill({ json: { recovery_codes: ["AAAAA-BBBBB"] } }));
  await page.goto("/profile");

  const row = page.locator(".profile-security-row", { hasText: "Two-factor authentication" });
  await expect(row.locator(".nm-pill")).toHaveText("Off");
  await row.getByRole("button", { name: "Set up" }).click();
  const dialog = page.getByRole("dialog", { name: "Set up two-factor authentication" });
  await expect(dialog.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  await dialog.getByLabel("Authentication code").fill("123456");
  await dialog.getByRole("button", { name: "Verify" }).click();
  await dialog.getByLabel("I've saved these recovery codes").check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

test("two-factor row warns on low recovery codes and hides Turn off when required", async ({ page }) => {
  await setupProfileMocks(page, { totp_enabled: true, totp_required: true, recovery_codes_remaining: 2 });
  await page.goto("/profile");
  const row = page.locator(".profile-security-row", { hasText: "Two-factor authentication" });
  await expect(row.locator(".nm-pill")).toHaveText("On");
  await expect(row).toContainText("2 recovery codes left");
  await expect(row).toContainText("Required by your administrator");
  await expect(row.getByRole("button", { name: "Turn off" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "New recovery codes" })).toBeVisible();
});

test("turning off asks for password and code", async ({ page }) => {
  await setupProfileMocks(page, { totp_enabled: true, totp_required: false, recovery_codes_remaining: 10 });
  let body: unknown = null;
  await page.route("**/api/v1/auth/me/totp", async (route) => { body = route.request().postDataJSON(); await route.fulfill({ status: 204, body: "" }); });
  await page.goto("/profile");
  await page.locator(".profile-security-row", { hasText: "Two-factor authentication" }).getByRole("button", { name: "Turn off" }).click();
  const dialog = page.getByRole("dialog", { name: "Turn off two-factor authentication" });
  await dialog.getByLabel("Current password").fill("correct horse battery");
  await dialog.getByLabel("Authentication code").fill("123456");
  await dialog.getByRole("button", { name: "Turn off" }).click();
  await expect.poll(() => body).toEqual({ password: "correct horse battery", code: "123456" });
});

test("new recovery codes are shown once without restarting enrolment", async ({ page }) => {
  await setupProfileMocks(page, { totp_enabled: true, totp_required: false, recovery_codes_remaining: 1 });
  let setupCalls = 0;
  await page.route("**/api/v1/auth/me/totp/setup", (route) => { setupCalls += 1; return route.fulfill({ json: { secret: "X", otpauth_uri: "otpauth://totp/x?secret=X" } }); });
  await page.route("**/api/v1/auth/me/totp/recovery-codes", (route) => route.fulfill({ json: { recovery_codes: ["CCCCC-DDDDD", "EEEEE-FFFFF"] } }));
  await page.goto("/profile");
  await expect(page.locator(".profile-security-panel .nm-alert--warning")).toContainText("running low on recovery codes");
  await page.locator(".profile-security-row", { hasText: "Two-factor authentication" }).getByRole("button", { name: "New recovery codes" }).click();
  const dialog = page.getByRole("dialog", { name: "New recovery codes" });
  await dialog.getByLabel("Current password").fill("correct horse battery");
  await dialog.getByLabel("Authentication code").fill("123456");
  await dialog.getByRole("button", { name: "Generate new codes" }).click();
  await expect(dialog.locator(".totp-recovery-codes li")).toHaveText(["CCCCC-DDDDD", "EEEEE-FFFFF"]);
  await expect(dialog.getByRole("img", { name: "QR code for your authenticator app" })).toHaveCount(0);
  await dialog.getByLabel("I've saved these recovery codes").check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  expect(setupCalls).toBe(0);
});

test("turn off shows the backend error inline", async ({ page }) => {
  await setupProfileMocks(page, { totp_enabled: true, totp_required: false, recovery_codes_remaining: 10 });
  await page.route("**/api/v1/auth/me/totp", (route) => route.fulfill({ status: 401, json: { detail: "Password or authentication code is incorrect" } }));
  await page.goto("/profile");
  await page.locator(".profile-security-row", { hasText: "Two-factor authentication" }).getByRole("button", { name: "Turn off" }).click();
  const dialog = page.getByRole("dialog", { name: "Turn off two-factor authentication" });
  await dialog.getByLabel("Current password").fill("wrong");
  await dialog.getByLabel("Authentication code").fill("000000");
  await dialog.getByRole("button", { name: "Turn off" }).click();
  await expect(dialog.locator(".form-error")).toContainText("Password or authentication code is incorrect");
  await expect(dialog).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`two-factor row and setup modal use shared surfaces in ${theme} mode`, async ({ page }) => {
    await setupProfileMocks(page, { totp_enabled: false, totp_required: false, recovery_codes_remaining: 0 }, theme);
    await page.route("**/api/v1/auth/me/totp/setup", (route) => route.fulfill({ json: { secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/NetMap:alice?secret=JBSWY3DPEHPK3PXP&issuer=NetMap" } }));
    await page.goto("/profile");
    const row = page.locator(".profile-security-row", { hasText: "Two-factor authentication" });
    await expect(row.locator(".profile-security-actions")).toHaveCSS("display", "flex");
    await expect(row.locator(".profile-security-actions")).toHaveCSS("column-gap", "8px");
    const pill = row.locator(".nm-pill");
    const pillStyle = await pill.evaluate((el) => {
      const s = getComputedStyle(el);
      return { radius: parseFloat(s.borderTopLeftRadius), border: s.borderTopStyle, padLeft: parseFloat(s.paddingLeft) };
    });
    expect(pillStyle.radius).toBeGreaterThan(0);
    expect(pillStyle.border).toBe("solid");
    expect(pillStyle.padLeft).toBeGreaterThan(0);

    await row.getByRole("button", { name: "Set up" }).click();
    const dialog = page.getByRole("dialog", { name: "Set up two-factor authentication" });
    const qr = dialog.getByRole("img", { name: "QR code for your authenticator app" });
    await expect(qr).toBeVisible();
    await expect(qr).toHaveCSS("border-radius", "8px");
    await expect(qr).toHaveCSS("background-color", "rgb(255, 255, 255)");
    const centring = await qr.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const parent = el.parentElement!.getBoundingClientRect();
      return Math.abs((box.left - parent.left) - (parent.right - box.right));
    });
    expect(centring).toBeLessThan(2);
    const shell = await dialog.locator(".modal").evaluate((el) => getComputedStyle(el).backgroundColor);
    const input = dialog.getByLabel("Authentication code");
    await expect(input).toHaveCSS("min-height", "40px");
    const inputBg = await input.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(inputBg).not.toBe(shell);
    const info = dialog.locator(".auth-reset-info");
    const infoColor = await info.evaluate((el) => getComputedStyle(el).color);
    const muted = await info.evaluate((el) => getComputedStyle(document.body).getPropertyValue("--nm-text-muted").trim());
    const probe = await page.evaluate((value) => {
      const span = document.createElement("span");
      span.style.color = value;
      document.body.appendChild(span);
      const resolved = getComputedStyle(span).color;
      span.remove();
      return resolved;
    }, muted);
    expect(infoColor).toBe(probe);
  });
}

test("two-factor row pluralises the recovery code count", async ({ page }) => {
  await setupProfileMocks(page, { totp_enabled: true, totp_required: false, recovery_codes_remaining: 1 });
  await page.goto("/profile");
  const row = page.locator(".profile-security-row", { hasText: "Two-factor authentication" });
  await expect(row.locator("small")).toHaveText("1 recovery code left");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await setupProfileMocks(page, { totp_enabled: true, totp_required: false, recovery_codes_remaining: 2 });
  await page.goto("/profile");
  await expect(row.locator("small")).toHaveText("2 recovery codes left");
});

test("closing a two-factor modal mid-request discards the late result and refreshes the row", async ({ page }) => {
  await setupProfileMocks(page, { totp_enabled: true, totp_required: false, recovery_codes_remaining: 2 });
  let rotated = false;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { ...profileUser, totp_enabled: true, totp_required: false, recovery_codes_remaining: rotated ? 10 : 2 },
  }));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/auth/me/totp/recovery-codes", async (route) => {
    await gate;
    rotated = true;
    await route.fulfill({ json: { recovery_codes: ["LATE1-CODES", "LATE2-CODES"] } });
  });
  await page.goto("/profile");
  const row = page.locator(".profile-security-row", { hasText: "Two-factor authentication" });
  await expect(row).toContainText("2 recovery codes left");

  await row.getByRole("button", { name: "New recovery codes" }).click();
  const regenerate = page.getByRole("dialog", { name: "New recovery codes" });
  await regenerate.getByLabel("Current password").fill("correct horse battery");
  await regenerate.getByLabel("Authentication code").fill("123456");
  await regenerate.getByRole("button", { name: "Generate new codes" }).click();
  await page.keyboard.press("Escape");
  await expect(regenerate).toBeHidden();
  const late = page.waitForResponse("**/api/v1/auth/me/totp/recovery-codes");
  release();
  await late;
  await page.waitForTimeout(100);

  await row.getByRole("button", { name: "Turn off" }).click();
  const disable = page.getByRole("dialog", { name: "Turn off two-factor authentication" });
  await expect(disable.locator(".totp-recovery-codes")).toHaveCount(0);
  await expect(disable).not.toContainText("LATE1-CODES");
  await expect(disable.getByLabel("Current password")).toHaveValue("");
  await expect(disable.getByLabel("Authentication code")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(row).toContainText("10 recovery codes left");
});

for (const theme of ["light", "dark"] as const) {
  test(`turn off and new codes accept a recovery code in ${theme} mode`, async ({ page }) => {
    await setupProfileMocks(page, { totp_enabled: true, totp_required: false, recovery_codes_remaining: 10 }, theme);
    await page.goto("/profile");
    const row = page.locator(".profile-security-row", { hasText: "Two-factor authentication" });
    for (const [button, title] of [["Turn off", "Turn off two-factor authentication"], ["New recovery codes", "New recovery codes"]] as const) {
      await row.getByRole("button", { name: button }).click();
      const dialog = page.getByRole("dialog", { name: title });
      const input = dialog.getByLabel("Authentication code");
      await expect(input).not.toHaveAttribute("inputmode", /.*/);
      const hint = dialog.locator(".profile-field-hint", { hasText: "You can also use a recovery code." });
      await expect(hint).toBeVisible();
      await expect(hint).toHaveCSS("font-size", "11px");
      const colors = await hint.evaluate((el) => {
        const span = document.createElement("span");
        span.style.color = getComputedStyle(document.body).getPropertyValue("--nm-text-muted").trim();
        document.body.appendChild(span);
        const muted = getComputedStyle(span).color;
        span.remove();
        return { hint: getComputedStyle(el).color, muted };
      });
      expect(colors.hint).toBe(colors.muted);
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).toBeHidden();
    }
  });
}

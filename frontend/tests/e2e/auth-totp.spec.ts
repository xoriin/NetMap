import { expect, test, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function setupLogin(page: Page, loginBody: Record<string, unknown>) {
  await page.route("**/api/v1/**", (route) => route.fulfill({ status: 401, json: { detail: "Not authenticated" } }));
  await page.route("**/api/v1/admin/settings/public", (route) => route.fulfill({ json: { app_name: "NetMap", login_message: "", idle_timeout_minutes: 15, announcement: null } }));
  await page.route("**/api/v1/setup/status", (route) => route.fulfill({ json: { needs_setup: false } }));
  await page.route("**/api/v1/auth/oidc/status", (route) => route.fulfill({ json: { enabled: false, provider_name: "SSO", require_sso: false } }));
  await page.route("**/api/v1/auth/login", (route) => route.fulfill({ json: loginBody }));
}

async function signInWithPassword(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username").fill("alice");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function mockEnrolment(page: Page) {
  const calls = { setup: 0 };
  await page.route("**/api/v1/auth/login/totp/setup", (route) => {
    calls.setup += 1;
    return route.fulfill({ json: { secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/NetMap:alice?secret=JBSWY3DPEHPK3PXP&issuer=NetMap" } });
  });
  await page.route("**/api/v1/auth/login/totp/setup/confirm", async (route) => {
    await setupCoreMocks(page);
    await setupTopologyMocks(page);
    await route.fulfill({ json: { recovery_codes: ["AAAAA-BBBBB", "CCCCC-DDDDD"], access_token: "access" } });
  });
  return calls;
}

for (const theme of ["light", "dark"] as const) {
  test(`code step completes sign-in in ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("netmap.theme", t), theme);
    await setupLogin(page, { mfa_required: true, mfa_setup_required: false, challenge: "chal" });
    let sent: { challenge: string; code: string } | null = null;
    await page.route("**/api/v1/auth/login/totp", async (route) => {
      sent = route.request().postDataJSON();
      await setupCoreMocks(page);
      await setupTopologyMocks(page);
      await route.fulfill({ json: { access_token: "access", token_type: "bearer" } });
    });
    await signInWithPassword(page);

    const code = page.getByLabel("Authentication code");
    await expect(code).toBeFocused();
    await expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await expect(code).toHaveAttribute("inputmode", "numeric");
    await code.fill("123456");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await expect.poll(() => sent).toEqual({ challenge: "chal", code: "123456" });
    await expect(page).toHaveURL(/\/overview$/);
  });

  test(`recovery codes step keeps link buttons and the checkbox styled in ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("netmap.theme", t), theme);
    await setupLogin(page, { mfa_required: false, mfa_setup_required: true, challenge: "setup-chal" });
    await mockEnrolment(page);
    const linkStyle = (name: string) => page.getByRole("button", { name, exact: true }).evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        className: node.className,
        color: style.color,
        backgroundImage: style.backgroundImage,
        boxShadow: style.boxShadow,
        height: Math.round(node.getBoundingClientRect().height),
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
      };
    });
    await page.goto("/");
    const reference = await linkStyle("Forgot password?");
    expect(reference.className).toBe("auth-forgot-link");
    await page.getByLabel("Username").fill("alice");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Authentication code").waitFor();
    await page.mouse.move(0, 0);
    await expect.poll(() => linkStyle("Back to sign in")).toEqual(reference);
    await page.getByLabel("Authentication code").fill("123456");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(page.getByText("AAAAA-BBBBB")).toBeVisible();

    await page.mouse.move(0, 0);
    for (const name of ["Copy", "Download .txt"]) {
      await expect.poll(() => linkStyle(name)).toEqual(reference);
    }
    await expect(page.getByRole("button", { name: "Back to sign in" })).toHaveCount(0);

    const check = page.getByLabel("I've saved these recovery codes");
    const box = await check.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const label = node.closest("label") as HTMLElement;
      const labelStyle = getComputedStyle(label);
      return { width: rect.width, height: rect.height, labelDisplay: labelStyle.display, labelDirection: labelStyle.flexDirection };
    });
    expect(box.width).toBeLessThanOrEqual(20);
    expect(box.height).toBeLessThanOrEqual(20);
    expect(box.labelDisplay).toBe("flex");
    expect(box.labelDirection).toBe("row");
  });
}

test("recovery code link swaps the input", async ({ page }) => {
  await setupLogin(page, { mfa_required: true, mfa_setup_required: false, challenge: "chal" });
  await signInWithPassword(page);
  await page.getByRole("button", { name: "Use a recovery code" }).click();
  await expect(page.getByLabel("Recovery code")).toBeVisible();
  await expect(page.getByLabel("Authentication code")).toHaveCount(0);
});

test("expired challenge returns to the password step", async ({ page }) => {
  await setupLogin(page, { mfa_required: true, mfa_setup_required: false, challenge: "chal" });
  await page.route("**/api/v1/auth/login/totp", (route) => route.fulfill({ status: 401, json: { detail: "Sign-in expired. Enter your password again." } }));
  await signInWithPassword(page);
  await page.getByLabel("Authentication code").fill("123456");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Your sign-in timed out. Enter your password again.")).toBeVisible();
});

test("forced enrolment gates Continue on saving the recovery codes", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await setupLogin(page, { mfa_required: false, mfa_setup_required: true, challenge: "setup-chal" });
  const calls = await mockEnrolment(page);
  await signInWithPassword(page);

  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  await expect(page.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();
  const copyKey = page.getByRole("button", { name: "Copy key", exact: true });
  await expect(copyKey).toHaveClass("auth-forgot-link");
  await copyKey.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("JBSWY3DPEHPK3PXP");
  expect(calls.setup).toBe(1);
  await page.getByLabel("Authentication code").fill("123456");
  await page.getByRole("button", { name: "Verify", exact: true }).click();

  await expect(page.getByText("AAAAA-BBBBB")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to sign in" })).toHaveCount(0);
  const proceed = page.getByRole("button", { name: "Continue", exact: true });
  await expect(proceed).toBeDisabled();
  await page.getByLabel("I've saved these recovery codes").check();
  await proceed.click();
  await expect(page).toHaveURL(/\/overview$/);
});

test("code step fits a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await setupLogin(page, { mfa_required: true, mfa_setup_required: false, challenge: "chal" });
  await signInWithPassword(page);
  await expect(page.getByLabel("Authentication code")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
});

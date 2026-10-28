import { expect, test, type Page, type Route } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

// The single sign-on callback lands on /?sso_mfa=challenge|setup with no
// tokens yet; the pending challenge lives in an HttpOnly cookie, so the SPA
// never sends `challenge` itself.

async function setupSignedOut(page: Page) {
  await page.route("**/api/v1/**", (route) => route.fulfill({ status: 401, json: { detail: "Not authenticated" } }));
  await page.route("**/api/v1/admin/settings/public", (route) => route.fulfill({ json: { app_name: "NetMap", login_message: "", idle_timeout_minutes: 15, announcement: null } }));
  await page.route("**/api/v1/setup/status", (route) => route.fulfill({ json: { needs_setup: false } }));
  await page.route("**/api/v1/auth/oidc/status", (route) => route.fulfill({ json: { enabled: true, provider_name: "Okta", require_sso: false } }));
}

async function signIn(route: Route, page: Page, json: Record<string, unknown>) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await route.fulfill({ json });
}

const verify = (page: Page) => page.getByRole("button", { name: "Verify", exact: true });

test("the SSO code prompt sends only the code and signs in", async ({ page }) => {
  await setupSignedOut(page);
  const bodies: unknown[] = [];
  await page.route("**/api/v1/auth/login/totp", async (route) => {
    bodies.push(route.request().postDataJSON());
    await signIn(route, page, { access_token: "access", token_type: "bearer" });
  });
  await page.goto("/?sso_mfa=challenge");
  await expect(page.getByRole("heading", { name: "Two-Factor Authentication" })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  const code = page.getByLabel("Authentication code");
  await expect(code).toBeFocused();
  await code.fill("123456");
  await verify(page).click();
  await expect(page).toHaveURL(/\/overview$/);
  expect(bodies).toEqual([{ code: "123456" }]);
});

test("a wrong SSO code shows beside the field", async ({ page }) => {
  await setupSignedOut(page);
  await page.route("**/api/v1/auth/login/totp", (route) => route.fulfill({ status: 401, json: { detail: "Invalid authentication code" } }));
  await page.goto("/?sso_mfa=challenge");
  const code = page.getByLabel("Authentication code");
  await code.fill("000000");
  await verify(page).click();
  await expect(page.getByRole("alert")).toHaveText("Invalid authentication code");
  await expect(code).toHaveAttribute("aria-invalid", "true");
  await expect(code).toHaveAccessibleDescription("Invalid authentication code");
});

test("an expired SSO sign-in returns to the sign-in screen with the server's message", async ({ page }) => {
  await setupSignedOut(page);
  await page.route("**/api/v1/auth/login/totp", (route) => route.fulfill({ status: 401, json: { detail: "Sign-in expired. Enter your password again." } }));
  await page.goto("/?sso_mfa=challenge");
  await page.getByLabel("Authentication code").fill("123456");
  await verify(page).click();
  await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
  await expect(page.getByText("Sign-in expired. Enter your password again.")).toBeVisible();
});

test("a throttled SSO code shows when it can be retried", async ({ page }) => {
  await setupSignedOut(page);
  await page.route("**/api/v1/auth/login/totp", (route) => route.fulfill({
    status: 429,
    headers: { "Retry-After": "30" },
    json: { detail: "Too many login attempts. Retry in 30 seconds." },
  }));
  await page.goto("/?sso_mfa=challenge");
  await page.getByLabel("Authentication code").fill("123456");
  await verify(page).click();
  await expect(page.getByRole("alert")).toHaveText(/^Too many attempts\. Try again in (30|29) seconds\.$/);
  await expect(verify(page)).toBeDisabled();
});

test("the SSO setup prompt enrols without a challenge and signs in", async ({ page }) => {
  await setupSignedOut(page);
  const bodies: Record<string, unknown> = {};
  await page.route("**/api/v1/auth/login/totp/setup", (route) => {
    bodies.setup = route.request().postDataJSON();
    return route.fulfill({ json: { secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/NetMap:alice?secret=JBSWY3DPEHPK3PXP&issuer=NetMap" } });
  });
  await page.route("**/api/v1/auth/login/totp/setup/confirm", async (route) => {
    bodies.confirm = route.request().postDataJSON();
    await signIn(route, page, { recovery_codes: ["AAAAA-BBBBB", "CCCCC-DDDDD"], access_token: "access" });
  });
  await page.goto("/?sso_mfa=setup");
  await expect(page.getByRole("heading", { name: "Set Up Two-Factor Authentication" })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();
  await page.getByLabel("Authentication code").fill("123456");
  await verify(page).click();
  await expect(page.getByText("AAAAA-BBBBB")).toBeVisible();
  await page.getByLabel("I've saved these recovery codes").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  expect(bodies).toEqual({ setup: {}, confirm: { code: "123456" } });
});

for (const [name, response, expected] of [
  ["a wrong code", { status: 401, json: { detail: "Invalid authentication code" } }, /^Invalid authentication code$/],
  ["throttling", { status: 429, headers: { "Retry-After": "45" }, json: { detail: "Too many login attempts. Retry in 45 seconds." } }, /^Too many attempts\. Try again in 45 seconds\.$/],
] as const) {
  test(`the SSO setup prompt shows ${name}`, async ({ page }) => {
    await setupSignedOut(page);
    await page.route("**/api/v1/auth/login/totp/setup", (route) => route.fulfill({ json: { secret: "JBSWY3DPEHPK3PXP", otpauth_uri: "otpauth://totp/NetMap:alice?secret=JBSWY3DPEHPK3PXP" } }));
    await page.route("**/api/v1/auth/login/totp/setup/confirm", (route) => route.fulfill(response));
    await page.goto("/?sso_mfa=setup");
    await page.getByLabel("Authentication code").fill("123456");
    await verify(page).click();
    await expect(page.locator(".form-error")).toHaveText(expected);
  });
}

test("an expired SSO setup returns to the sign-in screen", async ({ page }) => {
  await setupSignedOut(page);
  await page.route("**/api/v1/auth/login/totp/setup", (route) => route.fulfill({ status: 401, json: { detail: "Sign-in expired. Enter your password again." } }));
  await page.goto("/?sso_mfa=setup");
  await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
  await expect(page.getByText("Sign-in expired. Enter your password again.")).toBeVisible();
});

const SIGN_IN_ERRORS: [string, string][] = [
  ["account_not_linked", "This sign-in isn't linked to a NetMap account. If you already have an account, sign in with your password and link single sign-on from your Profile."],
  ["invalid_state", "The sign-in attempt expired or was invalid. Please try again."],
  ["account_disabled", "This account is disabled. Contact your administrator."],
  ["provider_denied", "Sign-in was cancelled or denied at the identity provider."],
  ["provider_error", "The identity provider returned an error. Please try again."],
  ["provider_unreachable", "Could not reach the identity provider. Try again or contact your administrator."],
  ["sso_disabled", "Single sign-on is not enabled on this server."],
  ["identity_in_use", "That identity is already linked to another NetMap account."],
  ["already_linked", "Single sign-on is already linked to your account."],
  ["reauth_required", "Sign in again at your identity provider to confirm this change. Nothing was changed, so please try again."],
  ["reauth_mismatch", "That sign-in doesn't match the identity linked to your account, so nothing was changed."],
  ["id_token_invalid", "Your identity provider's response couldn't be verified. Please try again or contact your administrator."],
  ["token_exchange_failed", "Your identity provider's response couldn't be verified. Please try again or contact your administrator."],
  ["provider_invalid_response", "Single sign-on isn't set up correctly. Contact your administrator."],
  ["link_from_profile", "Single sign-on didn't complete. Please try again or contact your administrator."],
  ["something_new", "Single sign-on didn't complete. Please try again or contact your administrator."],
];

for (const [code, message] of SIGN_IN_ERRORS) {
  test(`sso_error=${code} shows its notice on the sign-in screen and leaves the URL`, async ({ page }) => {
    await setupSignedOut(page);
    await page.goto(`/?sso_error=${code}`);
    await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
    await expect(page.locator(".auth-card .form-error")).toHaveText(message);
    expect(new URL(page.url()).search).toBe("");
  });
}

test("the SSO notice does not come back after signing in and out", async ({ page }) => {
  await setupSignedOut(page);
  await page.route("**/api/v1/auth/login", async (route) => signIn(route, page, { access_token: "access", token_type: "bearer" }));
  await page.goto("/?sso_error=account_not_linked");
  await expect(page.locator(".auth-card .form-error")).toBeVisible();
  await page.getByLabel("Username").fill("alice");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await page.route("**/api/v1/auth/logout", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/api/v1/auth/refresh", (route) => route.fulfill({ status: 401, json: { detail: "Not authenticated" } }));
  await page.getByRole("button", { name: /log out|sign out/i }).first().click();
  await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
  await expect(page.locator(".auth-card .form-error")).toHaveCount(0);
});

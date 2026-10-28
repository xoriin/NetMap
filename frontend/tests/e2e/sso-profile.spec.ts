import { expect, test, type Page, type Route } from "@playwright/test";
import { mockUser, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const baseUser = {
  ...mockUser,
  display_name: "Test User",
  email: "user@example.com",
  avatar_data: null,
  auth_source: "local",
  totp_enabled: false,
  entity_colors_enabled: true,
};

const okta = {
  id: 7,
  provider_name: "Okta",
  issuer: "https://idp.example.test",
  email: "user@corp.example",
  created_at: "2026-10-01T02:00:00Z",
  last_login_at: "2026-10-20T03:30:00Z",
};

const IDP = "https://idp.example.test/authorize?state=abc";

type Handler = (route: Route, body: Record<string, unknown>) => Promise<void>;

type Options = {
  user?: Record<string, unknown>;
  identities?: unknown[];
  oidc?: Record<string, unknown>;
  path?: string;
  onLink?: Handler;
  onUnlink?: Handler;
  onEmail?: Handler;
};

async function setupProfile(page: Page, options: Options = {}) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  const current: Record<string, unknown> = { ...baseUser, ...options.user };
  let identities = options.identities ?? [];
  const calls = { link: [] as Record<string, unknown>[], unlink: [] as Record<string, unknown>[], email: [] as Record<string, unknown>[], patch: [] as Record<string, unknown>[], refreshes: 0, logouts: 0 };
  await page.route("**/api/v1/auth/oidc/status", (route) => route.fulfill({ json: { enabled: true, provider_name: "Okta", require_sso: false, ...options.oidc } }));
  await page.route("**/api/v1/auth/me", async (route) => {
    if (route.request().method() !== "PATCH") return route.fulfill({ json: current });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.patch.push(body);
    Object.assign(current, body);
    return route.fulfill({ json: current });
  });
  await page.route("**/api/v1/auth/me/identities", (route) => route.fulfill({ json: identities }));
  await page.route("**/api/v1/auth/me/identities/link", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.link.push(body);
    if (options.onLink) return options.onLink(route, body);
    return route.fulfill({ json: { authorize_url: IDP } });
  });
  await page.route(/\/api\/v1\/auth\/me\/identities\/\d+$/, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.unlink.push({ url: new URL(route.request().url()).pathname, method: route.request().method(), ...body });
    if (options.onUnlink) return options.onUnlink(route, body);
    identities = [];
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/v1/auth/me/email/sso", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.email.push(body);
    if (options.onEmail) return options.onEmail(route, body);
    return route.fulfill({ json: { authorize_url: IDP } });
  });
  await page.route("https://idp.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Identity provider</h1>" }));
  await page.route("**/api/v1/api-keys", (route) => route.fulfill({ json: [] }));
  await page.goto(options.path ?? "/profile");
  await page.locator(".profile-security-panel").waitFor({ state: "visible" });
  // From here a refresh would fail and end the session, so any refresh or
  // logout call (other than the one after an unlink) means a 401 signed out.
  await page.route("**/api/v1/auth/refresh", async (route) => {
    calls.refreshes += 1;
    await route.fulfill({ status: 401, json: { detail: "Session revoked" } });
  });
  await page.route("**/api/v1/auth/logout", async (route) => {
    calls.logouts += 1;
    await route.fulfill({ status: 204, body: "" });
  });
  return calls;
}

async function stillSignedIn(page: Page, calls: { refreshes: number; logouts: number }) {
  await expect(page.getByRole("heading", { name: "Sign In" })).toHaveCount(0);
  expect(calls.refreshes).toBe(0);
  expect(calls.logouts).toBe(0);
}

const ssoRow = (page: Page) => page.locator(".profile-security-row", { hasText: "Single sign-on" });

test.describe("link single sign-on", () => {
  test("sends the password and code, then goes to the provider", async ({ page }) => {
    const calls = await setupProfile(page, { user: { totp_enabled: true } });
    await expect(ssoRow(page)).toContainText("Not linked");
    await ssoRow(page).getByRole("button", { name: "Link" }).click();
    const dialog = page.getByRole("dialog", { name: "Link single sign-on" });
    await expect(dialog.getByText("Next, you'll sign in with Okta to finish linking.")).toBeVisible();
    await dialog.getByLabel("Current password").fill("hunter2-correct");
    await dialog.getByLabel("Authentication code").fill("123456");
    await dialog.getByRole("button", { name: "Continue to Okta" }).click();
    await expect(page).toHaveURL(IDP);
    expect(calls.link).toEqual([{ current_password: "hunter2-correct", totp_code: "123456" }]);
  });

  test("leaves out the code when 2FA is off", async ({ page }) => {
    const calls = await setupProfile(page);
    await ssoRow(page).getByRole("button", { name: "Link" }).click();
    const dialog = page.getByRole("dialog", { name: "Link single sign-on" });
    await expect(dialog.getByLabel("Authentication code")).toHaveCount(0);
    await dialog.getByLabel("Current password").fill("hunter2-correct");
    await dialog.getByRole("button", { name: "Continue to Okta" }).click();
    await expect(page).toHaveURL(IDP);
    expect(calls.link).toEqual([{ current_password: "hunter2-correct" }]);
  });

  test("is hidden when single sign-on is off", async ({ page }) => {
    await setupProfile(page, { oidc: { enabled: false } });
    await expect(ssoRow(page)).toHaveCount(0);
  });

  for (const [detail, field] of [
    ["Authentication code is required to link single sign-on", "Authentication code"],
    ["Current password is incorrect", "Current password"],
  ] as const) {
    test(`shows "${detail}" beside its field without signing out`, async ({ page }) => {
      const calls = await setupProfile(page, {
        user: { totp_enabled: true },
        onLink: (route) => route.fulfill({ status: 401, json: { detail } }),
      });
      await ssoRow(page).getByRole("button", { name: "Link" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Current password").fill("wrong");
      await dialog.getByLabel("Authentication code").fill("1");
      await dialog.getByRole("button", { name: "Continue to Okta" }).click();
      const input = dialog.getByLabel(field);
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(input).toHaveAccessibleDescription(new RegExp(detail));
      await stillSignedIn(page, calls);
    });
  }

  for (const [status, detail] of [
    [401, "Password or authentication code is incorrect"],
    [409, "Single sign-on is already linked to your account"],
    [503, "SSO redirect URL is not configured (set APP_URL or the OIDC redirect URL)"],
    [502, "The identity provider could not be reached"],
  ] as const) {
    test(`shows the ${status} "${detail}"`, async ({ page }) => {
      const calls = await setupProfile(page, { onLink: (route) => route.fulfill({ status, json: { detail } }) });
      await ssoRow(page).getByRole("button", { name: "Link" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Current password").fill("pw");
      await dialog.getByRole("button", { name: "Continue to Okta" }).click();
      await expect(dialog.getByRole("alert")).toHaveText(detail);
      await stillSignedIn(page, calls);
    });
  }

  test("explains and hides Link when the server says SSO is not enabled", async ({ page }) => {
    await setupProfile(page, { onLink: (route) => route.fulfill({ status: 404, json: { detail: "SSO login is not enabled" } }) });
    await ssoRow(page).getByRole("button", { name: "Link" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Current password").fill("pw");
    await dialog.getByRole("button", { name: "Continue to Okta" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Single sign-on isn't enabled on this server, so there's nothing to link.");
    await expect(dialog.getByRole("button", { name: "Continue to Okta" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(ssoRow(page)).toHaveCount(0);
  });

  test("counts down a 429 and blocks retrying", async ({ page }) => {
    const calls = await setupProfile(page, {
      onLink: (route) => route.fulfill({ status: 429, headers: { "Retry-After": "42" }, json: { detail: "Too many attempts. Retry in 42 seconds." } }),
    });
    await ssoRow(page).getByRole("button", { name: "Link" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Current password").fill("pw");
    const submit = dialog.getByRole("button", { name: "Continue to Okta" });
    await submit.click();
    await expect(dialog.getByRole("alert")).toHaveText(/^Too many attempts\. Try again in (42|41) seconds\.$/);
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAccessibleDescription(/Try again in/);
    await stillSignedIn(page, calls);
  });
});

test.describe("unlink single sign-on", () => {
  test("lists the identity and unlinks it with the password and code", async ({ page }) => {
    const calls = await setupProfile(page, { user: { totp_enabled: true }, identities: [okta] });
    await expect(ssoRow(page)).toContainText("Okta · user@corp.example · Last used");
    await expect(ssoRow(page)).toContainText("Linked");
    await page.getByRole("button", { name: "Unlink Okta" }).click();
    const dialog = page.getByRole("dialog", { name: "Unlink single sign-on" });
    await expect(dialog.getByText("Unlinking signs you out on your other devices.")).toBeVisible();
    await dialog.getByLabel("Current password").fill("hunter2-correct");
    await dialog.getByLabel("Authentication code").fill("654321");
    // The unlink reissues cookies for this device; the client adopts them.
    await page.route("**/api/v1/auth/refresh", (route) => route.fulfill({ json: { access_token: "rotated", token_type: "bearer" } }));
    await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
    await expect(page.getByText("Single sign-on unlinked")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(ssoRow(page)).toContainText("Not linked");
    expect(calls.unlink).toEqual([{ url: "/api/v1/auth/me/identities/7", method: "DELETE", current_password: "hunter2-correct", totp_code: "654321" }]);
    await expect(page.getByRole("heading", { name: "Sign In" })).toHaveCount(0);
  });

  test("is hidden for non-admins when single sign-on is required", async ({ page }) => {
    await setupProfile(page, { user: { role: "Viewer" }, identities: [okta], oidc: { require_sso: true } });
    await expect(ssoRow(page)).toContainText("Linked");
    await expect(page.getByRole("button", { name: "Unlink Okta" })).toHaveCount(0);
  });

  for (const [status, detail, field] of [
    [401, "Authentication code is required to unlink single sign-on", "Authentication code"],
    [401, "Current password is incorrect", "Current password"],
    [401, "Password or authentication code is incorrect", null],
    [404, "Linked identity not found", null],
    [409, "Single sign-on is required here, so only an administrator can unlink it", null],
  ] as const) {
    test(`shows the ${status} "${detail}"`, async ({ page }) => {
      const calls = await setupProfile(page, {
        user: { totp_enabled: true },
        identities: [okta],
        onUnlink: (route) => route.fulfill({ status, json: { detail } }),
      });
      await page.getByRole("button", { name: "Unlink Okta" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Current password").fill("pw");
      await dialog.getByLabel("Authentication code").fill("1");
      await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveText(detail);
      if (field) await expect(dialog.getByLabel(field)).toHaveAttribute("aria-invalid", "true");
      await stillSignedIn(page, calls);
    });
  }

  test("counts down a 429", async ({ page }) => {
    const calls = await setupProfile(page, {
      identities: [okta],
      onUnlink: (route) => route.fulfill({ status: 429, headers: { "Retry-After": "1" }, json: { detail: "Too many attempts. Retry in 1 seconds." } }),
    });
    await page.getByRole("button", { name: "Unlink Okta" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Current password").fill("pw");
    const submit = dialog.getByRole("button", { name: "Unlink", exact: true });
    await submit.click();
    await expect(dialog.getByRole("alert")).toHaveText("Too many attempts. Try again in 1 second.");
    await expect(submit).toBeDisabled();
    await expect(submit).toBeEnabled({ timeout: 4000 });
    await stillSignedIn(page, calls);
  });
});

test.describe("SSO email change", () => {
  const form = (page: Page) => page.locator(".profile-account-panel form");

  test("confirms at the provider with the code and no password", async ({ page }) => {
    const calls = await setupProfile(page, { user: { totp_enabled: true }, identities: [okta] });
    const email = form(page).getByLabel(/^Email/);
    await expect(email).not.toHaveAttribute("readonly", "");
    await email.fill("new@corp.example");
    await expect(email).toHaveAccessibleDescription("You'll confirm this change by signing in again with Okta.");
    await expect(form(page).getByLabel(/^Current password/)).toHaveCount(0);
    await form(page).getByLabel(/^Authentication code/).fill("123456");
    await form(page).getByRole("button", { name: "Confirm with Okta" }).click();
    await expect(page).toHaveURL(IDP);
    expect(calls.email).toEqual([{ email: "new@corp.example", totp_code: "123456" }]);
    expect(calls.patch).toEqual([]);
  });

  test("saves a new display name first, without the email", async ({ page }) => {
    const calls = await setupProfile(page, { identities: [okta] });
    await form(page).getByLabel(/^Display name/).fill("Renamed");
    await form(page).getByLabel(/^Email/).fill("new@corp.example");
    await form(page).getByRole("button", { name: "Confirm with Okta" }).click();
    await expect(page).toHaveURL(IDP);
    expect(calls.patch).toEqual([{ display_name: "Renamed" }]);
    expect(calls.email).toEqual([{ email: "new@corp.example" }]);
  });

  test("counts down the per-user 429 and blocks retrying", async ({ page }) => {
    const calls = await setupProfile(page, {
      identities: [okta],
      onEmail: (route) => route.fulfill({ status: 429, headers: { "Retry-After": "600" }, json: { detail: "Too many attempts. Retry in 600 seconds." } }),
    });
    await form(page).getByLabel(/^Email/).fill("new@corp.example");
    const submit = form(page).getByRole("button", { name: "Confirm with Okta" });
    await submit.click();
    await expect(form(page).getByRole("alert")).toHaveText(/^Too many attempts\. Try again in (600|599) seconds\.$/);
    await expect(submit).toBeDisabled();
    await stillSignedIn(page, calls);
  });

  for (const detail of ["Authentication code is required to change your email", "Authentication code is incorrect"]) {
    test(`shows "${detail}" beside the code field`, async ({ page }) => {
      const calls = await setupProfile(page, {
        user: { totp_enabled: true },
        identities: [okta],
        onEmail: (route) => route.fulfill({ status: 401, json: { detail } }),
      });
      await form(page).getByLabel(/^Email/).fill("new@corp.example");
      const code = form(page).getByLabel(/^Authentication code/);
      await code.fill("1");
      await form(page).getByRole("button", { name: "Confirm with Okta" }).click();
      await expect(code).toHaveAttribute("aria-invalid", "true");
      await expect(code).toHaveAccessibleDescription(new RegExp(detail));
      await stillSignedIn(page, calls);
    });
  }

  for (const [status, detail] of [
    [422, "Enter a valid email address"],
    [400, "That is already your email"],
    [503, "SSO redirect URL is not configured (set APP_URL or the OIDC redirect URL)"],
    [502, "The identity provider could not be reached"],
  ] as const) {
    test(`shows the ${status} "${detail}"`, async ({ page }) => {
      const calls = await setupProfile(page, { identities: [okta], onEmail: (route) => route.fulfill({ status, json: { detail } }) });
      await form(page).getByLabel(/^Email/).fill("new@corp.example");
      await form(page).getByRole("button", { name: "Confirm with Okta" }).click();
      await expect(form(page).getByRole("alert")).toHaveText(detail);
      await stillSignedIn(page, calls);
    });
  }

  test("falls back to read-only on 403", async ({ page }) => {
    const calls = await setupProfile(page, {
      identities: [okta],
      onEmail: (route) => route.fulfill({ status: 403, json: { detail: "Your email is managed by your identity provider or an administrator" } }),
    });
    const email = form(page).getByLabel(/^Email/);
    await email.fill("new@corp.example");
    await form(page).getByRole("button", { name: "Confirm with Okta" }).click();
    await expect(form(page).getByRole("alert")).toHaveText("Your email is managed by your identity provider or an administrator");
    await expect(email).toHaveAttribute("readonly", "");
    await expect(email).toHaveValue("user@example.com");
    await expect(email).toHaveAccessibleDescription("Managed by your identity provider or an administrator.");
    await stillSignedIn(page, calls);
  });

  test("an SSO account without a linked identity stays read-only", async ({ page }) => {
    await setupProfile(page, { user: { auth_source: "oidc" } });
    const email = form(page).getByLabel(/^Email/);
    await expect(email).toHaveAttribute("readonly", "");
    await expect(email).toHaveAccessibleDescription("Managed by your identity provider or an administrator.");
  });

  test("a local account without a linked identity keeps the password flow", async ({ page }) => {
    await setupProfile(page);
    await form(page).getByLabel(/^Email/).fill("new@example.com");
    await expect(form(page).getByLabel(/^Current password/)).toBeVisible();
    await expect(form(page).getByRole("button", { name: "Save account details" })).toBeVisible();
  });
});

test.describe("callback notices on Profile", () => {
  for (const [query, message] of [
    ["sso_link=linked", "Single sign-on is now linked to your account."],
    ["sso_email=changed", "Your email address has been changed."],
  ]) {
    test(`?${query} opens Profile with a success toast`, async ({ page }) => {
      await setupProfile(page, { identities: [okta], path: `/?${query}` });
      await expect(page).toHaveURL(/\/profile$/);
      await expect(page.locator(".nm-toast--success")).toContainText(message);
    });
  }

  for (const [code, message] of [
    ["reauth_required", "Sign in again at your identity provider to confirm this change. Nothing was changed, so please try again."],
    ["reauth_mismatch", "That sign-in doesn't match the identity linked to your account, so nothing was changed."],
    ["identity_in_use", "That identity is already linked to another NetMap account."],
    ["already_linked", "Single sign-on is already linked to your account."],
    ["provider_denied", "Sign-in was cancelled or denied at the identity provider."],
    ["not_a_real_code", "Single sign-on didn't complete. Please try again or contact your administrator."],
  ]) {
    test(`?sso_error=${code} opens Profile with an error notice`, async ({ page }) => {
      await setupProfile(page, { path: `/?sso_error=${code}` });
      await expect(page).toHaveURL(/\/profile$/);
      const notice = page.locator(".profile-layout > .nm-alert--error");
      await expect(notice).toHaveText(new RegExp(message.replace(/[.?*+()]/g, "\\$&")));
      await notice.getByRole("button", { name: "Dismiss" }).click();
      await expect(notice).toHaveCount(0);
    });
  }
});

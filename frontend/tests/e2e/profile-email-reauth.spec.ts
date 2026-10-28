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

type Patch = (route: Route, body: Record<string, unknown>) => Promise<void>;

async function setupProfile(page: Page, userOverrides: Record<string, unknown> = {}, onPatch?: Patch) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  let current: Record<string, unknown> = { ...baseUser, ...userOverrides };
  const bodies: Record<string, unknown>[] = [];
  const refreshes: string[] = [];
  const logouts: string[] = [];
  await page.route("**/api/v1/auth/me", async (route) => {
    if (route.request().method() !== "PATCH") return route.fulfill({ json: current });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (onPatch) return onPatch(route, body);
    const { current_password: _password, totp_code: _code, ...rest } = body;
    current = { ...current, ...rest };
    return route.fulfill({ json: current });
  });
  await page.route("**/api/v1/api-keys", (route) => route.fulfill({ json: [] }));
  await page.goto("/profile");
  const form = page.locator(".profile-account-panel form");
  await form.waitFor({ state: "visible" });
  // Once signed in, any refresh would fail and end the session — so a refresh
  // or logout call after this point means a 401 tried to sign the user out.
  await page.route("**/api/v1/auth/refresh", async (route) => {
    refreshes.push(route.request().url());
    await route.fulfill({ status: 401, json: { detail: "Session revoked" } });
  });
  await page.route("**/api/v1/auth/logout", async (route) => {
    logouts.push(route.request().url());
    await route.fulfill({ status: 204, body: "" });
  });
  return { form, bodies, refreshes, logouts };
}

const save = (page: Page) => page.getByRole("button", { name: "Save account details", exact: true });

test("an unchanged email sends no password and shows no re-auth fields", async ({ page }) => {
  const { form, bodies } = await setupProfile(page, { totp_enabled: true });
  await form.getByLabel(/^Display name/).fill("Renamed");
  await expect(form.getByLabel(/^Current password/)).toHaveCount(0);
  await expect(form.getByLabel(/^Authentication code/)).toHaveCount(0);
  await save(page).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ display_name: "Renamed", email: "user@example.com" });
});

test("a changed email reveals the current password field and sends it", async ({ page }) => {
  const { form, bodies } = await setupProfile(page);
  const email = form.getByLabel(/^Email/);
  await email.fill("new@example.com");
  const password = form.getByLabel(/^Current password/);
  await expect(password).toBeVisible();
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expect(form.getByLabel(/^Authentication code/)).toHaveCount(0);

  // Reverting the email hides and clears the field.
  await password.fill("typed-then-reverted");
  await email.fill("user@example.com");
  await expect(password).toHaveCount(0);
  await email.fill("new@example.com");
  await expect(password).toHaveValue("");

  await password.fill("hunter2-correct");
  await save(page).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ display_name: "Test User", email: "new@example.com", current_password: "hunter2-correct" });
  // After success the saved email is current again, so the field is gone.
  await expect(form.getByLabel(/^Current password/)).toHaveCount(0);
  await expect(email).toHaveValue("new@example.com");
});

test("clearing the email also requires the current password", async ({ page }) => {
  const { form, bodies } = await setupProfile(page);
  await form.getByLabel(/^Email/).fill("");
  await form.getByLabel(/^Current password/).fill("pw");
  await save(page).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ display_name: "Test User", email: null, current_password: "pw" });
});

test("a 2FA user also sends totp_code with an email change", async ({ page }) => {
  const { form, bodies } = await setupProfile(page, { totp_enabled: true });
  await form.getByLabel(/^Email/).fill("new@example.com");
  const code = form.getByLabel(/^Authentication code/);
  await expect(code).toBeVisible();
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await form.getByLabel(/^Current password/).fill("pw");
  await code.fill(" 123456 ");
  await save(page).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ display_name: "Test User", email: "new@example.com", current_password: "pw", totp_code: "123456" });
  await expect(form.getByLabel(/^Authentication code/)).toHaveCount(0);
});

const fieldErrors = [
  { detail: "Current password is required to change your email", field: /^Current password/ },
  { detail: "Current password is incorrect", field: /^Current password/ },
  { detail: "Authentication code is required to change your email", field: /^Authentication code/ },
] as const;

for (const { detail, field } of fieldErrors) {
  test(`a 401 "${detail}" shows on its field and does not sign out`, async ({ page }) => {
    const { form, refreshes, logouts } = await setupProfile(page, { totp_enabled: true }, (route) =>
      route.fulfill({ status: 401, json: { detail } }),
    );
    await form.getByLabel(/^Email/).fill("new@example.com");
    await form.getByLabel(/^Current password/).fill("pw");
    await form.getByLabel(/^Authentication code/).fill("000000");
    await save(page).click();
    const input = form.getByLabel(field);
    await expect(form.getByRole("alert")).toHaveText(detail);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAccessibleDescription(new RegExp(detail));
    // Still signed in: no refresh attempt, no logout, no sign-in screen.
    await expect(page.getByRole("heading", { name: "Sign In" })).toHaveCount(0);
    await expect(page.locator(".sidebar")).toBeVisible();
    expect(refreshes).toHaveLength(0);
    expect(logouts).toHaveLength(0);
  });
}

test("a 401 for a wrong password or code shows at form level and does not sign out", async ({ page }) => {
  const detail = "Password or authentication code is incorrect";
  const { form, refreshes, logouts } = await setupProfile(page, { totp_enabled: true }, (route) =>
    route.fulfill({ status: 401, json: { detail } }),
  );
  await form.getByLabel(/^Email/).fill("new@example.com");
  await form.getByLabel(/^Current password/).fill("pw");
  await form.getByLabel(/^Authentication code/).fill("000000");
  await save(page).click();
  await expect(form.getByRole("alert")).toHaveText(detail);
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole("heading", { name: "Sign In" })).toHaveCount(0);
  expect(refreshes).toHaveLength(0);
  expect(logouts).toHaveLength(0);
});

test("a 429 shows the Retry-After time and holds submit until it elapses", async ({ page }) => {
  let throttle = true;
  const { form, bodies } = await setupProfile(page, {}, async (route, body) => {
    if (throttle) {
      throttle = false;
      return route.fulfill({
        status: 429,
        headers: { "Retry-After": "2" },
        json: { detail: "Too many attempts. Retry in 90 seconds." },
      });
    }
    return route.fulfill({ json: { ...baseUser, email: body.email } });
  });
  await form.getByLabel(/^Email/).fill("new@example.com");
  await form.getByLabel(/^Current password/).fill("pw");
  await save(page).click();
  // The header wins over the number in detail.
  await expect(form.getByRole("alert")).toHaveText(/Too many attempts\. Try again in [12] seconds?\./);
  await expect(save(page)).toBeDisabled();
  await expect(save(page)).toBeEnabled({ timeout: 5000 });
  await expect(form.getByRole("alert")).toHaveCount(0);
  await save(page).click();
  await expect.poll(() => bodies.length).toBe(2);
});

test("a 429 without Retry-After falls back to the seconds in detail", async ({ page }) => {
  const { form } = await setupProfile(page, {}, (route) =>
    route.fulfill({ status: 429, json: { detail: "Too many attempts. Retry in 45 seconds." } }),
  );
  await form.getByLabel(/^Email/).fill("new@example.com");
  await form.getByLabel(/^Current password/).fill("pw");
  await save(page).click();
  await expect(form.getByRole("alert")).toHaveText(/Too many attempts\. Try again in 4[45] seconds\./);
  await expect(save(page)).toBeDisabled();
});

// has_local_password (not auth_source) picks the flow. These run with single
// sign-on off (the core mocks), so an SSO-only account's email is read-only.
test("SSO-only users (oidc, no NetMap password) see a read-only email with a note and send no password", async ({ page }) => {
  const { form, bodies } = await setupProfile(page, { auth_source: "oidc", has_local_password: false, sso_issuer: "https://idp.example.com" });
  const email = form.getByLabel(/^Email/);
  await expect(email).toHaveAttribute("readonly", "");
  await expect(email).toHaveAccessibleDescription(/Managed by your identity provider/);
  await expect(form.getByLabel(/^Current password/)).toHaveCount(0);
  await form.getByLabel(/^Display name/).fill("SSO Person");
  await save(page).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ display_name: "SSO Person", email: "user@example.com" });
});

test("a local account later linked to SSO (oidc, with a NetMap password) keeps the password flow", async ({ page }) => {
  const { form, bodies, refreshes, logouts } = await setupProfile(page, { auth_source: "oidc", has_local_password: true, sso_issuer: "https://idp.example.com" });
  const email = form.getByLabel(/^Email/);
  await expect(email).not.toHaveAttribute("readonly", "");
  await email.fill("new@example.com");
  await form.getByLabel(/^Current password/).fill("hunter2-correct");
  await save(page).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ display_name: "Test User", email: "new@example.com", current_password: "hunter2-correct" });
  expect(refreshes).toEqual([]);
  expect(logouts).toEqual([]);
});

test("a local account (local, with a NetMap password) uses the password flow", async ({ page }) => {
  const { form } = await setupProfile(page, { auth_source: "local", has_local_password: true });
  await form.getByLabel(/^Email/).fill("new@example.com");
  await expect(form.getByLabel(/^Current password/)).toBeVisible();
  await expect(save(page)).toBeVisible();
});

test("a 409 for an account with no NetMap password shows the message and does not sign out", async ({ page }) => {
  const detail = "This account has no NetMap password. Confirm the email change by signing in again with single sign-on.";
  const { form, refreshes, logouts } = await setupProfile(page, {}, (route) => route.fulfill({ status: 409, json: { detail } }));
  await form.getByLabel(/^Email/).fill("new@example.com");
  await form.getByLabel(/^Current password/).fill("hunter2-correct");
  await save(page).click();
  await expect(form.getByRole("alert")).toHaveText(detail);
  await expect(page.getByRole("heading", { name: "Sign In" })).toHaveCount(0);
  expect(refreshes).toEqual([]);
  expect(logouts).toEqual([]);
});

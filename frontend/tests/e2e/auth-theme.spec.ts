import { expect, test, type Page } from "@playwright/test";

async function setupLoginMocks(page: Page) {
  await page.route("**/api/v1/**", (route) => route.fulfill({ status: 401, json: { detail: "Not authenticated" } }));
  await page.route("**/api/v1/admin/settings/public", (route) => route.fulfill({ json: { app_name: "NetMap", login_message: "", idle_timeout_minutes: 15, announcement: null } }));
  await page.route("**/api/v1/admin/public-settings", (route) => route.fulfill({ json: { app_name: "NetMap", login_message: "", idle_timeout_minutes: 15, announcement: null } }));
  await page.route("**/api/v1/setup/status", (route) => route.fulfill({ json: { needs_setup: false } }));
  await page.route("**/api/v1/auth/setup-required", (route) => route.fulfill({ json: { needs_setup: false } }));
  await page.route("**/api/v1/auth/oidc/status", (route) => route.fulfill({ json: { enabled: true, provider_name: "Xorin Net", require_sso: false } }));
}

for (const theme of ["light", "dark"] as const) {
  test(`SSO remains a full-width themed login control in ${theme} mode`, async ({ page }) => {
    await setupLoginMocks(page);
    await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
    await page.goto("/");

    const signIn = page.getByRole("button", { name: "Sign in", exact: true });
    const sso = page.getByRole("link", { name: "Continue with Xorin Net", exact: true });
    await expect(sso).toHaveAttribute("href", "/api/v1/auth/oidc/login");

    const geometry = await Promise.all([signIn, sso].map((control) => control.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        width: rect.width,
        height: rect.height,
        display: style.display,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
        textDecoration: style.textDecorationLine,
        borderStyle: style.borderStyle,
        backgroundColor: style.backgroundColor,
      };
    })));

    expect(Math.abs(geometry[0].width - geometry[1].width)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry[0].height - geometry[1].height)).toBeLessThanOrEqual(1);
    expect(geometry[1]).toMatchObject({
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      textDecoration: "none",
      borderStyle: "solid",
    });
    expect(geometry[1].backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });
}

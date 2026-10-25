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

for (const theme of ["light", "slate", "zinc"]) {
  test(`login text reveals once and respects reduced motion in ${theme}`, async ({ page }) => {
    await setupLoginMocks(page);
    const message = "The Blueprint for Your Infrastructure";
    await page.addInitScript(theme => {
      localStorage.setItem("netmap.theme", theme === "light" ? "light" : "dark");
      localStorage.setItem("netmap.dark_style", theme === "zinc" ? "zinc" : "slate");
    }, theme);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    const card = page.locator(".auth-login-card");
    const slogan = card.locator(".auth-slogan");
    const words = slogan.locator(".auth-text-reveal__word");
    await expect(slogan.locator(".auth-text-reveal__accessible")).toHaveText(message);
    await expect(slogan.locator('[aria-hidden="true"]')).toHaveText(message);
    await expect(words).toHaveCount(5);
    await expect(words.first()).toHaveCSS("animation-name", "auth-reveal-word");
    await expect(words.first()).toHaveCSS("animation-delay", "0.08s");
    await expect(words.nth(1)).toHaveCSS("animation-delay", "0.125s");
    await expect(card).toHaveCSS("animation-name", "auth-login-enter");
    // Autofocus and input remain available while the decorative text is entering.
    await page.getByLabel("Username", { exact: true }).fill("network-admin");
    await page.getByLabel("Password", { exact: true }).fill("example-password");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    await card.evaluate(el => {
      for (const animation of el.getAnimations({ subtree: true })) animation.finish();
    });
    await words.first().evaluate(el => { el.getAnimations()[0].id = "completed-login-word"; });
    await page.getByLabel("Username", { exact: true }).fill("updated-admin");
    expect(await words.first().evaluate(el => el.getAnimations()[0].id)).toBe("completed-login-word");
    await expect(words.first()).toHaveCSS("opacity", "1");
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByLabel("Username", { exact: true })).toBeInViewport();
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(words.first()).toHaveCSS("animation-name", "none");
    await expect(words.first()).toHaveCSS("opacity", "1");
    await expect(words.first()).toHaveCSS("filter", "none");
    await expect(words.first()).toHaveCSS("transform", "none");
    await expect(card).toHaveCSS("animation-name", "none");
    await page.screenshot({ path: test.info().outputPath(`login-reveal-${theme}.png`) });
  });
}

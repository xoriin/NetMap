import { expect, test } from "@playwright/test";
import { mockUser, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

for (const theme of ["light", "dark"] as const) {
  test(`sidebar footer stays anchored while expanded menus scroll in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await setupCoreMocks(page);
    await setupTopologyMocks(page);
    await setupMonitoringMocks(page);
    await page.addInitScript((selectedTheme) => {
      window.localStorage.setItem("netmap.theme", selectedTheme);
      for (const menu of ["admin", "monitoring", "inventory", "ipam"]) {
        window.localStorage.setItem(`netmap.sidebar.menu.${menu}`, "open");
      }
    }, theme);
    await page.goto("/overview");

    const sidebar = page.locator(".sidebar");
    const nav = sidebar.locator("nav");
    const footer = sidebar.locator(".sidebar-footer-actions");
    await expect(page.locator(".sidebar-admin-subnav").first()).toBeVisible();

    const geometry = async () => page.evaluate(() => {
      const aside = document.querySelector(".sidebar") as HTMLElement;
      const navEl = aside.querySelector("nav") as HTMLElement;
      const foot = aside.querySelector(".sidebar-footer-actions") as HTMLElement;
      return {
        viewport: window.innerHeight,
        asideScroll: aside.scrollHeight - aside.clientHeight,
        navOverflow: navEl.scrollHeight - navEl.clientHeight,
        footerBottom: foot.getBoundingClientRect().bottom,
        asideBottom: aside.getBoundingClientRect().bottom,
      };
    });

    const before = await geometry();
    expect(before.navOverflow).toBeGreaterThan(0);
    expect(before.asideScroll).toBeLessThanOrEqual(0);
    expect(before.footerBottom).toBeLessThanOrEqual(before.asideBottom);
    await expect(footer.getByRole("button", { name: /sign out/i })).toBeInViewport();

    await nav.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const after = await geometry();
    expect(after.footerBottom).toBe(before.footerBottom);
    await expect(nav.getByRole("link").last()).toBeInViewport();
  });
}

test("sidebar nav keeps its natural spacing when menus fit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await setupMonitoringMocks(page);
  await page.goto("/overview");
  const gaps = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll(".sidebar nav > div")) as HTMLElement[];
    return links.slice(1, 4).map((el, i) => el.getBoundingClientRect().top - links[i].getBoundingClientRect().bottom);
  });
  for (const gap of gaps) expect(gap).toBeLessThanOrEqual(3);
});

const FOOTER_PROPS = ["display", "height", "width", "color", "backgroundColor", "borderTopColor", "borderTopWidth", "borderRadius", "fontSize", "fontWeight", "paddingLeft", "textDecorationLine"] as const;

for (const theme of ["light", "dark"] as const) {
  for (const collapsed of [false, true]) {
    test(`documentation link matches the footer buttons in ${theme}${collapsed ? " collapsed" : ""}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await setupCoreMocks(page);
      await setupTopologyMocks(page);
      await setupMonitoringMocks(page);
      await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
      await page.goto("/overview");
      if (collapsed) await page.getByRole("button", { name: "Collapse sidebar" }).click();

      const footer = page.locator(".sidebar-footer-actions");
      const docs = footer.getByRole("link", { name: "Documentation" });
      await expect(docs).toHaveAttribute("href", "https://docs.netmap.dev");
      await expect(docs).toHaveAttribute("target", "_blank");
      await expect(docs).toHaveAttribute("rel", /noreferrer/);
      if (collapsed) await expect(docs).toHaveAttribute("title", "Documentation");

      const styleOf = (selector: string) => page.locator(selector).evaluate((el, props) => {
        const cs = getComputedStyle(el) as unknown as Record<string, string>;
        return Object.fromEntries(props.map((p) => [p, cs[p]]));
      }, [...FOOTER_PROPS]);
      const reference = await styleOf(".sidebar-theme-toggle");
      const actual = await styleOf(".sidebar-docs-link");
      expect({ ...actual, textDecorationLine: actual.textDecorationLine }).toEqual({ ...reference, textDecorationLine: "none" });

      await page.addStyleTag({ content: ".sidebar-footer-actions * { transition: none !important; }" });
      await docs.hover();
      const hovered = await docs.evaluate((el) => getComputedStyle(el).color);
      await page.locator(".sidebar-theme-toggle").hover();
      const toggleHovered = await page.locator(".sidebar-theme-toggle").evaluate((el) => getComputedStyle(el).color);
      expect(hovered).toBe(toggleHovered);

      const order = await footer.evaluate((el) => Array.from(el.children).map((c) => c.className));
      expect(order.indexOf("sidebar-docs-link")).toBe(order.findIndex((c) => c.includes("sidebar-theme-toggle")) - 1);
    });
  }
}

test("documentation link fits the mobile bottom bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await setupMonitoringMocks(page);
  await page.goto("/overview");
  const docs = page.locator(".sidebar-docs-link");
  const toggle = page.locator(".sidebar-theme-toggle");
  const [d, t] = await Promise.all([docs.boundingBox(), toggle.boundingBox()]);
  expect(d && t && Math.round(d.width) === Math.round(t.width) && Math.round(d.height) === Math.round(t.height)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aShoAAAAASUVORK5CYII=";
for (const theme of ["light", "dark"] as const) {
  for (const mode of ["expanded", "collapsed", "mobile"] as const) {
    test(`Profile photo keeps sidebar geometry in ${theme} ${mode}`, async ({ page }) => {
      await page.setViewportSize({ width: mode === "mobile" ? 390 : 1280, height: 900 });
      await setupCoreMocks(page); await setupTopologyMocks(page); await setupMonitoringMocks(page);
      await page.route("**/api/v1/api-keys", route => route.fulfill({json:[]}));
      await page.route("**/api/v1/auth/me", route => route.fulfill({json: {...mockUser, avatar_data: avatar}}));
      await page.addInitScript(t => localStorage.setItem("netmap.theme", t), theme);
      await page.goto("/overview");
      if (mode === "collapsed") await page.getByRole("button", {name:"Collapse sidebar"}).click();
      const link = page.locator('.sidebar-link[href="/profile"]');
      await link.scrollIntoViewIfNeeded();
      const photo = link.locator("img");
      await expect(photo).toHaveAttribute("src", avatar);
      await expect.poll(() => photo.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
      await expect(photo).toHaveCSS("width", "18px");
      await expect(photo).toHaveCSS("height", "18px");
      await expect(photo).toHaveCSS("border-radius", "50%");
      await expect(photo).toHaveCSS("object-fit", "cover");
      await link.hover(); await link.focus();
      await expect(link).toBeFocused();
      await link.click();
      await expect(page).toHaveURL(/\/profile$/);
      await expect(link).toHaveClass(/active/);
      await expect(page.getByRole("button", {name:"Save account details",exact:true})).toBeVisible();
      await page.screenshot({path:`/tmp/sidebar-avatar-${theme}-${mode}.png`});
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mode === "mobile" ? 390 : 1280);
    });
  }
}

test("Profile icon is retained for missing and broken photos", async ({page}) => {
  await setupCoreMocks(page); await setupTopologyMocks(page);
  await page.goto("/overview");
  const link = page.locator('.sidebar-link[href="/profile"]');
  await expect(link.locator("svg")).toBeVisible();
  await expect(link.locator("img")).toHaveCount(0);
  await page.route("**/api/v1/auth/me", route => route.fulfill({json:{...mockUser, avatar_data:"data:image/png;base64,broken"}}));
  await page.reload();
  await expect(link.locator("svg")).toBeVisible();
  await expect(link.locator("img")).toHaveCount(0);
});

test("saving and removing a profile photo updates the sidebar immediately", async ({page}) => {
  await setupCoreMocks(page); await setupTopologyMocks(page);
  await page.route("**/api/v1/auth/me", async route => {
    const payload = route.request().method() === "PATCH" ? route.request().postDataJSON() : {};
    await route.fulfill({json:{...mockUser, auth_source:"local", avatar_data:avatar, ...payload}});
  });
  await page.goto("/profile");
  const photo = page.locator('.sidebar-link[href="/profile"] img');
  await expect(photo).toBeVisible();
  await page.getByRole("button",{name:"Remove photo",exact:true}).click();
  await expect(photo).toBeVisible();
  await page.getByRole("button",{name:"Save account details",exact:true}).click();
  await expect(photo).toHaveCount(0);
  await page.locator('input[type="file"].profile-avatar-file').setInputFiles({name:"avatar.png",mimeType:"image/png",buffer:Buffer.from(avatar.split(",")[1],"base64")});
  await expect(page.getByRole("img",{name:"Profile avatar",exact:true})).toBeVisible();
  await expect(photo).toHaveCount(0);
  await page.getByRole("button",{name:"Save account details",exact:true}).click();
  await expect(photo).toBeVisible();
  await expect(photo).toHaveAttribute("src",avatar);
});

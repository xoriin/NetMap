import { expect, test } from "@playwright/test";
import { setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

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

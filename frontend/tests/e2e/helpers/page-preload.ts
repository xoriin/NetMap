import { type Page } from "@playwright/test";

/** Waits for the dashboard's idle preload of every page chunk (about 2 s after mount), so feature
 *  stylesheets that load late are applied before a layout is measured. Admin is preloaded with the rest. */
export async function waitForPagePreload(page: Page) {
  await page.waitForFunction(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="AdminWorkspace"]');
    return Boolean(link?.sheet);
  }, null, { timeout: 15_000 });
}

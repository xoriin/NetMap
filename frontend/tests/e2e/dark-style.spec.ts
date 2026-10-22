import { expect, test, type Page } from "@playwright/test";
import { setupCoreMocks } from "./helpers/api-mocks";

async function openProfile(page: Page, theme: "light" | "dark", style?: "slate" | "zinc") {
  await setupCoreMocks(page);
  await page.addInitScript(([t, s]) => {
    if (sessionStorage.getItem("dark-style-seeded")) return;
    sessionStorage.setItem("dark-style-seeded", "1");
    localStorage.setItem("netmap.theme", t);
    if (s) localStorage.setItem("netmap.dark_style", s);
  }, [theme, style ?? ""] as const);
  await page.goto("/profile");
  await page.locator(".profile-preferences-panel").waitFor();
}

const surface = (page: Page, selector: string) =>
  page.locator(selector).evaluate((node) => getComputedStyle(node).backgroundColor);

test("dark mode defaults to the Slate style", async ({ page }) => {
  await openProfile(page, "dark");
  await expect(page.locator("body")).not.toHaveClass(/theme-dark-zinc/);
  await expect(page.getByRole("button", { name: "Slate" })).toHaveAttribute("aria-pressed", "true");
  const slate = await page.getByRole("button", { name: "Slate" }).boundingBox();
  const zinc = await page.getByRole("button", { name: "Zinc" }).boundingBox();
  expect(zinc!.x - (slate!.x + slate!.width)).toBe(8);
  expect(await surface(page, "body")).toBe("rgb(2, 6, 23)");
  expect(await surface(page, "html")).toBe("rgb(2, 6, 23)");
});

test("choosing Zinc restyles dark mode and survives a reload", async ({ page }) => {
  await openProfile(page, "dark");
  await page.getByRole("button", { name: "Zinc" }).click();
  await expect(page.locator("body")).toHaveClass(/theme-dark-zinc/);
  await expect(page.getByRole("button", { name: "Zinc" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => surface(page, "body")).toBe("rgb(9, 9, 11)");
  expect(await surface(page, "html")).toBe("rgb(9, 9, 11)");
  expect(await page.evaluate(() => localStorage.getItem("netmap.dark_style"))).toBe("zinc");

  await page.reload();
  await page.locator(".profile-preferences-panel").waitFor();
  await expect(page.locator("body")).toHaveClass(/theme-dark-zinc/);
  expect(await surface(page, "body")).toBe("rgb(9, 9, 11)");

  await page.getByRole("button", { name: "Slate" }).click();
  await expect(page.locator("body")).not.toHaveClass(/theme-dark-zinc/);
  await expect.poll(() => surface(page, "body")).toBe("rgb(2, 6, 23)");
});

test("the dark style never changes light mode", async ({ page }) => {
  await openProfile(page, "light", "zinc");
  await expect(page.locator("body")).not.toHaveClass(/theme-dark/);
  expect(await surface(page, "body")).toBe("rgb(254, 254, 254)");
});

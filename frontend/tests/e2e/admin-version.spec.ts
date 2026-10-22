import { expect, test, type Page, type Locator } from "@playwright/test";
import type { VersionInfo } from "../../src/api/client";
import { mockUser, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function versionMocks(page: Page, info: VersionInfo) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { ...mockUser, whats_new_acknowledged_version: info.current } }));
  await page.route("**/api/v1/auth/users", route => route.fulfill({ json: [] }));
  await page.route("**/api/v1/admin/role-permissions", route => route.fulfill({ json: { permissions: [], roles: { SuperAdmin: [], Viewer: [] } } }));
  await page.route("**/api/v1/system/version", route => route.fulfill({ json: info }));
}

async function expectVerticalVersion(summary: Locator) {
  const rows = await summary.evaluate(node => {
    const copy = node.querySelector(".admin-version-copy")!;
    const actions = node.querySelector(".admin-version-actions")!;
    return [copy, ...actions.children].map(row => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, right: rect.right };
    });
  });
  expect(rows).toHaveLength(3);
  for (let index = 1; index < rows.length; index++) {
    expect(rows[index].top).toBeGreaterThanOrEqual(rows[index - 1].bottom + 4);
    expect(Math.abs(rows[index].right - rows[0].right)).toBeLessThanOrEqual(1);
  }
}

function versionInfo(state: "current" | "update" | "unavailable"): VersionInfo {
  return {
    current: "1.7.0", channel: state === "current" ? null : state === "update" ? "Test" : "Dev",
    latest: state === "unavailable" ? null : state === "current" ? "1.7.0" : "1.8.0",
    up_to_date: state === "current", release_url: "https://github.com/xoriin/netmap/releases/tag/v1.8.0",
    current_release_url: "https://github.com/xoriin/netmap/releases/tag/v1.7.0",
    whats_new: [{ version: "1.7.0", sections: [{ category: "Changed", items: ["Clearer administration panels."] }] }],
  };
}

for (const theme of ["light", "slate", "zinc"] as const) {
  for (const state of ["current", "update", "unavailable"] as const) {
    test(`Admin version summary is readable and responsive: ${theme}, ${state}`, async ({ page }) => {
      await page.addInitScript(value => {
        localStorage.setItem("netmap.theme", value === "light" ? "light" : "dark");
        localStorage.setItem("netmap.dark_style", value === "zinc" ? "zinc" : "slate");
      }, theme);
      const info = versionInfo(state);
      await versionMocks(page, info);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto("/admin#groups");
      const summary = page.locator(".app-topbar").getByLabel("NetMap version");
      await expect(summary.locator(".admin-version-build strong")).toHaveText("v1.7.0");
      await expect(summary.locator(".admin-version-build strong")).toHaveCSS("font-size", "12px");
      await expect(summary.locator(".admin-version-build strong")).toHaveCSS("font-weight", "500");
      const muted = await summary.locator(".admin-version-build strong").evaluate(node => getComputedStyle(node).color);
      await expect(summary.getByRole("button", { name: "What's new" })).toHaveCSS("color", muted);
      const header = page.locator(".app-topbar");
      const height = await header.evaluate(node => ({ actual: node.getBoundingClientRect().height, standard: parseFloat(getComputedStyle(node).getPropertyValue("--nm-topbar-height")) }));
      expect(height.actual).toBeLessThanOrEqual(height.standard + 1);
      await expect(summary.getByRole("button", { name: "What's new" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(summary.getByRole("button", { name: "What's new" })).toHaveCSS("border-top-style", "none");
      await expect(summary.getByText("NetMap", { exact: true })).toHaveCount(0);
      await expectVerticalVersion(summary);
      if (info.channel) await expect(summary.getByText(info.channel, { exact: true })).toBeVisible();
      if (state === "update") {
        const link = summary.getByRole("link", { name: "v1.8.0 available" });
        await expect(link).toHaveAttribute("href", info.release_url);
        await expect(link).toHaveAttribute("rel", "noreferrer");
        await link.focus();
        await expect(link).toBeFocused();
        await link.hover();
      } else {
        await expect(summary.getByText(state === "current" ? "Up to date" : "Latest unavailable", { exact: true })).toBeVisible();
        await expect(summary.locator(".dash-status-dot")).toHaveCount(0);
      }
      await page.locator(".app-topbar").screenshot({ path: test.info().outputPath(`version-${theme}-${state}-desktop.png`) });
      for (const width of [1000, 780]) {
        await page.setViewportSize({ width, height: 950 });
        await expectVerticalVersion(summary);
        const geometry = await summary.evaluate(node => {
          const box = node.getBoundingClientRect();
          const header = node.closest(".app-topbar")!.getBoundingClientRect();
          return { left: box.left, right: box.right, bottom: box.bottom, headerBottom: header.bottom, viewport: window.innerWidth, overflow: document.documentElement.scrollWidth - window.innerWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.headerBottom);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
      }
      await page.locator(".app-topbar").screenshot({ path: test.info().outputPath(`version-${theme}-${state}-narrow.png`) });
      const whatsNew = summary.getByRole("button", { name: "What's new" });
      await whatsNew.focus();
      await whatsNew.press("Enter");
      await expect(page.getByRole("dialog", { name: "What's new in v1.7.0" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.goto("/overview");
      await expect(page.getByLabel("NetMap version")).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}

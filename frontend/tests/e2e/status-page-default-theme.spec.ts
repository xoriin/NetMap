import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`status page defaults use Material surfaces and semantic colours in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1440, height: 1000 });
    let state = "operational";
    await page.route("**/api/v1/public/status-pages/theme-check", (route) => route.fulfill({ json: {
      slug: "theme-check", title: "Service status", accent: null, logo: null, custom_css: null,
      heartbeat_window: "1h", generated_at: new Date().toISOString(), valid_until: new Date(Date.now() + 600_000).toISOString(),
      summary: { state, label: "Current service status", counts: {} }, groups: [], incidents: [], past: [],
      notices: ["info", "warning", "critical"].map((level, id) => ({ id, level, title: `${level} notice`, body: "", link: null })),
      maintenance: [{ id: 1, title: "Planned maintenance", starts_at: "2026-10-22T01:00:00Z", ends_at: "2026-10-22T02:00:00Z", active: false, announced: true }],
    } }));
    for (const [next, tone] of [["operational", "success"], ["affected", "warning"], ["major", "danger"], ["maintenance", "maintenance"]]) {
      state = next;
      await page.goto("/status/theme-check");
      const banner = page.frameLocator("iframe.status-page-frame").locator(".sp-summary");
      await expect(banner).toBeVisible();
      const colours = await banner.evaluate((node, name) => {
        const probe = node.ownerDocument.createElement("span"); probe.style.backgroundColor = `var(--sp-${name}-soft)`; node.append(probe);
        const result = [getComputedStyle(node).backgroundColor, getComputedStyle(probe).backgroundColor]; probe.remove(); return result;
      }, tone);
      expect(colours[0]).toBe(colours[1]);
      const dot = banner.locator(".sp-summary-dot");
      await expect(dot).toHaveCSS("animation-name", next === "operational" ? "sp-operational-breathe" : "none");
      if (next === "operational") {
        const phases = await dot.evaluate(node => {
          const animation = node.getAnimations()[0];
          animation.pause();
          animation.currentTime = 0;
          const before = getComputedStyle(node).opacity;
          animation.currentTime = 1400;
          const after = getComputedStyle(node).opacity;
          animation.play();
          return [before, after];
        });
        expect(phases[0]).not.toBe(phases[1]);
      }
    }
    const frame = page.frameLocator("iframe.status-page-frame");
    await expect(frame.locator(".sp-page")).toHaveCSS("max-width", "1180px");
    await expect(frame.locator("body")).toHaveCSS("font-family", "Arial, sans-serif");
    for (const [selector, tone] of [[".sp-notice[data-level=info] .sp-pill", "info"], [".sp-notice[data-level=warning] .sp-pill", "warning"], [".sp-notice[data-level=critical] .sp-pill", "danger"], [".sp-strip[data-kind=maintenance] .sp-pill", "maintenance"]]) {
      const colours = await frame.locator(selector).evaluate((node, name) => {
        const probe = node.ownerDocument.createElement("span"); probe.style.backgroundColor = `var(--sp-${name}-soft)`; node.append(probe);
        const result = [getComputedStyle(node).backgroundColor, getComputedStyle(probe).backgroundColor]; probe.remove(); return result;
      }, tone);
      expect(colours[0]).toBe(colours[1]);
    }
    state = "operational";
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/status/theme-check");
    await expect(frame.locator(".sp-summary-dot")).toHaveCSS("animation-name", "none");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await frame.locator("html").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  });
}

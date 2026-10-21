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


for (const theme of ["light", "dark"] as const) {
  test(`information strips have clear semantic surfaces and readable copy in ${theme}`, async ({ page }) => {
    const errors: string[] = []; const failed: string[] = [];
    page.on("pageerror", e => errors.push(e.message)); page.on("requestfailed", r => failed.push(r.url()));
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1334, height: 1000 });
    await page.route("**/api/v1/public/status-pages/info-bars", route => route.fulfill({ json: {
      slug: "info-bars", title: "Main Test Status Page", accent: null, logo: null, custom_css: null, heartbeat_window: "1h",
      generated_at: new Date().toISOString(), valid_until: new Date(Date.now() + 600000).toISOString(),
      summary: { state: "operational", label: "All systems operational", counts: {} }, groups: [], incidents: [], past: [],
      notices: ["info", "warning", "critical"].map((level, id) => ({ id, level, title: `${level} notice`, body: "A readable explanation of what is happening and which services are affected.", link: null })),
      maintenance: [{ id: 1, title: "Internet Cutover", description: "Planned work on the internet connection.", starts_at: "2026-10-22T01:00:00Z", ends_at: "2026-10-22T02:00:00Z", active: false, announced: true }],
    } }));
    await page.goto("/status/info-bars");
    const frame = page.frameLocator("iframe.status-page-frame");
    for (const [selector, tone] of [[".sp-notice[data-level=info]", "info"], [".sp-notice[data-level=warning]", "warning"], [".sp-notice[data-level=critical]", "danger"], [".sp-strip[data-kind=maintenance]", "maintenance"]]) {
      const strip = frame.locator(selector);
      await expect(strip).toHaveAttribute("data-tone", tone);
      await expect(strip).toHaveCSS("border-left-width", "4px");
      await expect(strip.locator(".sp-strip-body")).toHaveCSS("font-size", "14px");
      const contrast = await strip.evaluate((node, name) => {
        const text = node.querySelector('.sp-strip-body')!;
        const c = getComputedStyle(node); const t = getComputedStyle(text);
        const luminance = (color: string) => {
          const channels = color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        };
        const l = [luminance(t.color), luminance(c.backgroundColor)].sort((a,b)=>b-a);
        const probe = node.ownerDocument.createElement('span'); probe.style.backgroundColor = `var(--sp-${name}-soft)`; node.append(probe);
        const fill = getComputedStyle(probe).backgroundColor; probe.remove();
        return { ratio: (l[0]+.05)/(l[1]+.05), actual: c.backgroundColor, expected: fill, page: getComputedStyle(node.ownerDocument.body).backgroundColor };
      }, tone);
      expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
      expect(contrast.actual).toBe(contrast.expected);
      expect(contrast.actual).not.toBe(contrast.page);
    }
    await page.screenshot({ path: test.info().outputPath(`info-bars-${theme}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 1000 });
    await expect.poll(() => frame.locator("html").evaluate(n => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath(`info-bars-narrow-${theme}.png`), fullPage: true });
    expect(errors).toEqual([]); expect(failed).toEqual([]);
  });
}

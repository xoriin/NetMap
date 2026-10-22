import { expect, test } from "@playwright/test";

for (const style of ["light", "slate", "zinc"] as const) {
  test(`status page panels match the canonical ${style} theme`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(selected => {
      if (window !== window.top) return;
      localStorage.setItem("netmap.theme", selected === "light" ? "light" : "dark");
      localStorage.setItem("netmap.dark_style", selected === "zinc" ? "zinc" : "slate");
    }, style);
    // Deliberately oppose the OS to exercise the explicit-selection path.
    await page.emulateMedia({ colorScheme: style === "light" ? "dark" : "light" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/api/v1/public/status-pages/aligned", route => route.fulfill({ json: {
      slug: "aligned", title: "Network service status", accent: null, logo: null, custom_css: null,
      heartbeat_window: "1h", generated_at: new Date().toISOString(), valid_until: new Date(Date.now() + 600000).toISOString(),
      summary: { state: "operational", label: "All systems operational", counts: {} },
      groups: [{ id: 1, name: "Core services", state: "operational", collapsed: false, items: [{
        id: 1, name: "Customer portal with a long readable service name", state: "operational",
        availability: { percent: .999, label: "ok", coverage: 1 }, heartbeats: Array(60).fill("healthy"),
        response: [1, 2, 3, null, 5], metrics: { avg_response: 2, p95_response: 5, failure_rate: 0, uptime_period: null }, incident_ids: [],
      }] }], incidents: [], past: [], notices: [], maintenance: [],
    } }));
    await page.goto("/status/aligned");
    const frame = page.frameLocator("iframe.status-page-frame");
    await expect(frame.locator(".sp-group")).toBeVisible();
    const canonical = await page.evaluate(() => {
      const panel = document.createElement("section"); panel.className = "nm-app-panel";
      const header = document.createElement("div"); header.className = "nm-app-panel-header";
      const title = document.createElement("strong"); title.className = "nm-panel-title"; title.textContent = "Service health"; header.append(title); panel.append(header); document.body.append(panel);
      const probe = document.createElement("span"); probe.style.backgroundColor = "var(--nm-row-hover)"; panel.append(probe);
      const p = getComputedStyle(panel), h = getComputedStyle(header);
      const values = { background: getComputedStyle(document.body).backgroundColor,
        panel: p.backgroundColor, radius: p.borderRadius, shadow: p.boxShadow, border: p.borderTopColor,
        header: h.backgroundColor, headerText: getComputedStyle(title).color, headerHeight: h.height,
        font: getComputedStyle(document.documentElement).fontFamily, hover: getComputedStyle(probe).backgroundColor };
      panel.remove(); return values;
    });
    await expect(frame.locator("body")).toHaveCSS("background-color", canonical.background);
    await expect(frame.locator("body")).toHaveCSS("font-family", canonical.font);
    await expect(frame.locator(".sp-group")).toHaveCSS("background-color", canonical.panel);
    await expect(frame.locator(".sp-group")).toHaveCSS("border-radius", canonical.radius);
    await expect(frame.locator(".sp-group")).toHaveCSS("box-shadow", canonical.shadow);
    await expect(frame.locator(".sp-group")).toHaveCSS("border-top-color", canonical.border);
    await expect(frame.locator(".sp-group-name")).toHaveCSS("background-color", canonical.header);
    await expect(frame.locator(".sp-group-name")).toHaveCSS("color", canonical.headerText);
    await expect(frame.locator(".sp-group-name")).toHaveCSS("height", canonical.headerHeight);
    await frame.locator("summary.sp-row-main").hover();
    await expect(frame.locator("summary.sp-row-main")).toHaveCSS("background-color", canonical.hover);
    await frame.locator("summary.sp-row-main").focus();
    await expect(frame.locator("summary.sp-row-main")).toHaveCSS("outline-style", "solid");
    await frame.locator("summary.sp-row-main").press("Enter");
    await expect(frame.locator("details.sp-row")).toHaveAttribute("open", "");
    await page.screenshot({ path: test.info().outputPath(`status-${style}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await frame.locator("html").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`status-${style}-narrow.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`status page defaults use NetMap surfaces and semantic colours in ${theme}`, async ({ page }) => {
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
    expect(await frame.locator("body").evaluate(node => getComputedStyle(node).fontFamily)).toBe(await page.locator("html").evaluate(node => getComputedStyle(node).fontFamily));
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
          const channels = color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v => color.startsWith("color(srgb") ? v : v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
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

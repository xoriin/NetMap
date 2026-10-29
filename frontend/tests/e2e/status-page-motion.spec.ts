import { expect, test, type Page } from "@playwright/test";
import type { StatusPagePayload } from "../../src/features/status-pages/statusPagesApi";

test.use({ locale: "en-GB", timezoneId: "Australia/Brisbane" });

async function setup(page: Page, window: "1h" | "24h" = "1h") {
  const start = new Date("2026-10-24T02:00:10Z");
  await page.clock.install({ time: start });
  let generated = start.getTime();
  const body: StatusPagePayload = {
    slug: "motion", title: "Network status", accent: null, logo: null, custom_css: null,
    heartbeat_window: window, generated_at: start.toISOString(), valid_until: new Date(generated + 600000).toISOString(),
    summary: { state: "operational", label: "All systems operational", counts: { operational: 1, degraded: 0, down: 0, unknown: 0, maintenance: 0 } },
    notices: [], incidents: [], maintenance: [], past: [],
    groups: [{ id: 1, name: "Core services", state: "operational", collapsed: false, items: [{
      id: 1, name: "Customer portal with a long service name", state: "operational",
      availability: { percent: 1, label: "ok", coverage: 1 }, heartbeats: Array(60).fill("healthy"),
      response: [10, 20], metrics: { avg_response: 15 }, incident_ids: [],
    }] }],
  };
  await page.route("**/api/v1/public/status-pages/motion", route => route.fulfill({ json: body }));
  await page.goto("/status/motion");
  const frame = page.frameLocator("iframe.status-page-frame");
  await expect(frame.locator(".sp-beat")).toHaveCount(60);
  return { body, frame, async refresh(seconds: number, updateTitle = true) {
    generated += seconds * 1000;
    body.generated_at = new Date(generated).toISOString();
    body.valid_until = new Date(generated + 600000).toISOString();
    if (updateTitle) body.title = `Network status · ${body.generated_at}`;
    const request = page.waitForResponse("**/api/v1/public/status-pages/motion");
    await page.clock.fastForward(30500); await request;
    await expect(frame.locator(".sp-title")).toHaveText(body.title);
    await page.clock.runFor(50);
  } };
}

for (const style of ["light", "slate", "zinc"] as const) {
  test(`new status heartbeats animate once in ${style}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request => errors.push(request.url()));
    await page.addInitScript(style => {
      if (window !== window.top) return;
      localStorage.setItem("netmap.theme", style === "light" ? "light" : "dark");
      localStorage.setItem("netmap.dark_style", style === "zinc" ? "zinc" : "slate");
    }, style);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const { frame, refresh } = await setup(page);
    await expect(frame.locator(".sp-beat--new")).toHaveCount(0);
    await refresh(60);
    await expect(frame.locator(".sp-beat--new")).toHaveCount(1);
    const newest = frame.locator(".sp-beat").last();
    await expect(newest).toHaveCSS("animation-name", "hb-arrive");
    const motion = await newest.evaluate(node => {
      const animation = node.getAnimations()[0]; animation.pause(); animation.currentTime = 175;
      return { transform: getComputedStyle(node).transform, duration: animation.effect?.getTiming().duration };
    });
    expect(motion.duration).toBe(700);
    expect(motion.transform).not.toBe("none");
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await frame.locator("html").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`${style}-${width}.png`) });
    }
    await refresh(10);
    await expect(frame.locator(".sp-beat--new")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("current-slot changes animate, old corrections and duplicate snapshots do not", async ({ page }) => {
  const { body, frame, refresh } = await setup(page);
  body.groups[0].items[0].heartbeats[59] = "unhealthy";
  await refresh(10);
  await expect(frame.locator(".sp-beat--new.sp-beat--unhealthy")).toHaveCount(1);
  await refresh(1);
  await expect(frame.locator(".sp-beat--new")).toHaveCount(0);
  body.groups[0].items[0].heartbeats[2] = "unknown";
  await refresh(1);
  await expect(frame.locator(".sp-beat--new")).toHaveCount(0);
  await refresh(600);
  await expect(frame.locator(".sp-beat--new")).toHaveCount(3);
});

test("new rows, window changes, empty history and older snapshots do not replay history", async ({ page }) => {
  const { body, frame, refresh } = await setup(page);
  body.groups[0].items.push({ ...body.groups[0].items[0], id: 2, name: "New service" });
  await refresh(1);
  await expect(frame.locator(".sp-beat--new")).toHaveCount(0);
  body.heartbeat_window = "24h";
  await refresh(60);
  await expect(frame.locator(".sp-beat--new")).toHaveCount(0);
  await refresh(-120);
  await expect(frame.locator(".sp-beat--new")).toHaveCount(0);
  body.groups[0].items.forEach(item => { item.heartbeats = []; });
  await refresh(1440);
  await expect(frame.locator(".sp-beat")).toHaveCount(0);
});

test("24h slots respect epoch boundaries and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { frame, refresh } = await setup(page, "24h");
  await refresh(60);
  await expect(frame.locator(".sp-beat--new")).toHaveCount(0);
  await refresh(1440);
  await expect(frame.locator(".sp-beat--new")).toHaveCount(1);
  await expect(frame.locator(".sp-beat").last()).toHaveCSS("animation-name", "none");
});

test("an unchanged poll after arrival keeps disclosures and does not restart motion", async ({ page }) => {
  const { frame, refresh } = await setup(page);
  await refresh(60);
  await expect(frame.locator(".sp-beat--new")).toHaveCount(1);
  const row = frame.locator("details.sp-row");
  await row.locator("summary").click();
  await expect(row).toHaveAttribute("open", "");
  await row.evaluate(node => { node.dataset.preserved = "yes"; });
  await refresh(1, false);
  await expect(row).toHaveAttribute("data-preserved", "yes");
  await expect(row).toHaveAttribute("open", "");
});

for (const style of ["light", "slate", "zinc"] as const) {
  test(`heartbeat hover matches Monitoring in ${style}`, async ({ page }) => {
    await page.addInitScript(style => {
      if (window !== window.top) return;
      localStorage.setItem("netmap.theme", style === "light" ? "light" : "dark");
      localStorage.setItem("netmap.dark_style", style === "zinc" ? "zinc" : "slate");
    }, style);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const { frame, refresh } = await setup(page);
    const beats = frame.locator(".sp-beat");
    const selected = beats.nth(30), neighbour = beats.nth(31);
    const before = await selected.boundingBox();
    const colour = await selected.evaluate(node => getComputedStyle(node).backgroundColor);
    await selected.locator("..").hover();
    await page.clock.runFor(300);
    await expect(selected).toHaveCSS("transform", "matrix(1.4, 0, 0, 1.35, 0, 0)");
    await expect(neighbour).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    await expect(neighbour).toHaveCSS("opacity", "0.5");
    await expect(selected).toHaveCSS("opacity", "1");
    await expect(frame.locator(".sp-heartbeat-tooltip")).toBeVisible();
    const tip = frame.locator(".sp-heartbeat-tooltip");
    await expect(tip).toHaveCSS("background-color", style === "light" ? "rgb(255, 255, 255)" : style === "slate" ? "rgb(22, 32, 51)" : "rgb(31, 31, 35)");
    // Compare with Monitoring's actual loaded primitive; the iframe must reuse
    // its appearance rather than maintain an independently styled popup.
    const monitoring = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "hb-tooltip-card";
      document.body.append(probe);
      const css = getComputedStyle(probe);
      const result = Object.fromEntries(["background-color", "border-top-color", "border-radius", "box-shadow", "padding", "font-size"].map(key => [key, css.getPropertyValue(key)]));
      probe.remove();
      return result;
    });
    for (const [property, value] of Object.entries(monitoring)) await expect(tip).toHaveCSS(property, value);
    await expect(tip).toHaveCSS("border-radius", "9px");
    const motion = await page.evaluate(() => {
      const bar = document.createElement("div");
      bar.className = "heartbeat-bar heartbeat-bar--lg has-active";
      const beat = document.createElement("span");
      beat.className = "heartbeat-beat is-active";
      bar.append(beat); document.body.append(bar);
      const css = getComputedStyle(beat);
      const result = Object.fromEntries(["transform", "transition-duration", "transition-timing-function", "opacity"].map(key => [key, css.getPropertyValue(key)]));
      bar.remove(); return result;
    });
    for (const [property, value] of Object.entries(motion)) await expect(selected).toHaveCSS(property, value);

    await expect(selected).toHaveCSS("transition-duration", "0.2s, 0.2s");
    await expect(selected.locator("..")).not.toHaveAttribute("title");
    expect((await selected.boundingBox())!.height).toBeCloseTo(before!.height * 1.35, 0);
    await expect(selected).toHaveCSS("background-color", colour);
    const a = await selected.locator("..").boundingBox();
    const b = await neighbour.locator("..").boundingBox();
    await page.mouse.move((a!.x + a!.width + b!.x) / 2, a!.y + a!.height / 2);
    await page.clock.runFor(300);
    await expect(frame.locator(".sp-beat.is-active")).toHaveCount(1);
    await expect(tip).toBeVisible();
    for (const width of [1440, 820, 390]) {
      await page.mouse.move(0, 0);
      await frame.locator("body").evaluate(node => {
        node.dataset.resized = "false";
        addEventListener("resize", () => { node.dataset.resized = "true"; }, { once: true });
      });
      await page.setViewportSize({ width, height: 900 });
      await expect(frame.locator("body")).toHaveAttribute("data-resized", "true");
      await page.clock.runFor(100);
      await selected.locator("..").hover({ force: true });
      await page.clock.runFor(300);
      await expect(selected).toHaveCSS("transform", "matrix(1.4, 0, 0, 1.35, 0, 0)");
      expect(await frame.locator("html").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await expect.poll(async () => { const box = await tip.boundingBox(); return box!.x + box!.width; }).toBeLessThanOrEqual(width);
      const box = await tip.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);
      await page.screenshot({ path: test.info().outputPath(`${style}-hover-${width}.png`) });
    }
    await tip.hover();
    await page.clock.runFor(200);
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await page.clock.runFor(200);
    await expect(tip).toBeHidden();
    await selected.locator("..").click();
    await page.mouse.move(0, 0);
    await page.clock.runFor(200);
    await expect(tip).toBeVisible();
    await expect(selected).toHaveClass(/is-pinned/);
    await page.keyboard.press("Escape");
    await page.clock.runFor(200);
    await expect(tip).toBeHidden();
    await page.mouse.move(0, 0);
    await refresh(60);
    const newest = beats.last();
    // The mocked clock can leave arrival at scaleY(0). Inspect midway through
    // arrival so this checks composition on a visible, deterministic target.
    await newest.evaluate(node => {
      for (const animation of node.getAnimations()) {
        animation.pause(); animation.currentTime = 350;
      }
    });
    await newest.locator("..").hover({ force: true });
    await page.clock.runFor(300);
    await expect(newest).toHaveClass(/is-active/);
    await expect(newest).toHaveCSS("animation-name", "hb-arrive");
    await page.clock.runFor(1000);
    await expect(newest).not.toHaveClass(/sp-beat--new/);
    await expect(newest).toHaveCSS("transform", "matrix(1.4, 0, 0, 1.35, 0, 0)");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(newest).toHaveCSS("transform", "none");
    await expect(newest).toHaveCSS("transition-duration", "0s");
    await page.mouse.move(0, 0);
    await expect(selected).toHaveCSS("transform", "none");
  });
}

test("touch heartbeats remain steady", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  const { frame } = await setup(page);
  const beat = frame.locator(".sp-beat").nth(30);
  await beat.hover({ force: true });
  await expect(beat).toHaveCSS("transform", "none");
  await context.close();
});

test("stricter host CSP keeps the native tooltip fallback", async ({ page }) => {
  await page.route("**/status/motion", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:" } });
  });
  const { frame } = await setup(page);
  await expect(frame.locator(".sp-heartbeat-tooltip")).toHaveCount(0);
  await expect(frame.locator(".sp-beat-slot").last()).toHaveAttribute("title", /In progress/);
});

for (const window of ["1h", "24h"] as const) {
  test(`heartbeat tooltips describe the actual ${window} interval and optional response`, async ({ page }) => {
    const { body, frame, refresh } = await setup(page, window);
    body.groups[0].items[0].response = Array(60).fill(null);
    body.groups[0].items[0].response![58] = 23.6;
    body.groups[0].items[0].heartbeats[58] = "unhealthy";
    body.groups[0].items[0].heartbeats[0] = "unknown";
    body.groups[0].items[0].heartbeats[1] = "maintenance";
    await refresh(1);
    const beats = frame.locator(".sp-beat");
    const choices = frame.locator(".sp-beat-choice");
    const tooltip = await choices.nth(58).getAttribute("aria-label");
    expect(tooltip).toContain("Down");
    expect(tooltip).toContain("24 Oct 2026");
    expect(tooltip).toContain(window === "1h" ? "11:59–12:00 (Australia/Brisbane)" : "11:36–12:00 (Australia/Brisbane)");
    expect(tooltip).toContain(window === "1h" ? "1-minute interval" : "24-minute interval");
    expect(tooltip).toContain("Average response: 24 ms");
    expect(await choices.first().getAttribute("aria-label")).toContain("Unknown");
    expect(await choices.nth(1).getAttribute("aria-label")).toContain("Maintenance");
    expect(await choices.last().getAttribute("aria-label")).toContain("In progress at last update");
    await choices.nth(58).focus();
    await expect(choices.nth(58)).toHaveAttribute("aria-label", tooltip!);
    await expect(beats.nth(58)).toHaveCSS("outline-style", "solid");
    await choices.nth(58).press("ArrowRight");
    await expect(choices.last()).toBeFocused();
    await expect(choices.last()).toBeChecked();
    await expect(frame.locator(".sp-beat-choice:checked")).toHaveCount(1);
    body.groups[0].items[0].response = null;
    await refresh(1);
    expect(await choices.nth(58).getAttribute("aria-label")).not.toContain("response");
  });
}

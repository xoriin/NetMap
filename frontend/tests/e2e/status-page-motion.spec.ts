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
    await expect(newest).toHaveCSS("animation-name", "sp-beat-arrive");
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
  test(`heartbeat hover enlarges only the inspected bar in ${style}`, async ({ page }) => {
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
    await selected.hover();
    await expect(selected).toHaveCSS("scale", "1.8 2.1");
    await expect(neighbour).toHaveCSS("scale", "none");
    expect((await selected.boundingBox())!.height).toBeCloseTo(before!.height * 2.1, 0);
    await expect(selected).toHaveCSS("background-color", colour);
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await selected.hover({ force: true });
      await expect(selected).toHaveCSS("scale", "1.8 2.1");
      expect(await frame.locator("html").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`${style}-hover-${width}.png`) });
    }
    await refresh(60);
    const newest = beats.last();
    // The mocked clock can leave arrival at scaleY(0). Inspect midway through
    // arrival so this checks composition on a visible, deterministic target.
    await newest.evaluate(node => {
      for (const animation of node.getAnimations()) {
        animation.pause(); animation.currentTime = 350;
      }
    });
    await newest.hover({ force: true });
    await expect(newest).toHaveCSS("scale", "1.8 2.1");
    await expect(newest).toHaveCSS("animation-name", "sp-beat-arrive");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(newest).toHaveCSS("scale", "none");
    await expect(newest).toHaveCSS("transition-duration", "0s");
    await page.mouse.move(0, 0);
    await expect(selected).toHaveCSS("scale", "none");
  });
}

test("touch heartbeats remain steady", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  const { frame } = await setup(page);
  const beat = frame.locator(".sp-beat").nth(30);
  await beat.hover({ force: true });
  await expect(beat).toHaveCSS("scale", "none");
  await context.close();
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
    const slots = frame.locator(".sp-beat-slot");
    const choices = frame.locator(".sp-beat-choice");
    const tooltip = await slots.nth(58).getAttribute("title");
    expect(tooltip).toContain("Down");
    expect(tooltip).toContain("24 Oct 2026");
    expect(tooltip).toContain(window === "1h" ? "11:59–12:00 (Australia/Brisbane)" : "11:36–12:00 (Australia/Brisbane)");
    expect(tooltip).toContain(window === "1h" ? "1-minute interval" : "24-minute interval");
    expect(tooltip).toContain("Average response: 24 ms");
    expect(await slots.first().getAttribute("title")).toContain("Unknown");
    expect(await slots.nth(1).getAttribute("title")).toContain("Maintenance");
    expect(await slots.last().getAttribute("title")).toContain("In progress at last update");
    await choices.nth(58).focus();
    await expect(choices.nth(58)).toHaveAttribute("aria-label", tooltip!);
    await expect(beats.nth(58)).toHaveCSS("outline-style", "solid");
    await choices.nth(58).press("ArrowRight");
    await expect(choices.last()).toBeFocused();
    await expect(choices.last()).toBeChecked();
    await expect(frame.locator(".sp-beat-choice:checked")).toHaveCount(1);
    body.groups[0].items[0].response = null;
    await refresh(1);
    expect(await slots.nth(58).getAttribute("title")).not.toContain("response");
  });
}

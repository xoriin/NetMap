import { expect, test, type Page } from "@playwright/test";
import type { StatusPagePayload } from "../../src/features/status-pages/statusPagesApi";

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

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

const SLUG = "acme";
const PUBLIC_URL = `**/api/v1/public/status-pages/${SLUG}`;
const CUSTOM_CSS = ".sp-row{background-color:rgb(1, 2, 3)}\n.sp-title{color:rgb(4, 5, 6)}\nbody, .nm-panel, .nm-app-panel{background-color:rgb(250, 0, 0)!important}";

function payload(customCss: string | null, overrides: Record<string, unknown> = {}) {
  const generated = new Date();
  return {
    slug: SLUG, title: "Acme Network", accent: null, logo: null, heartbeat_window: "1h", custom_css: customCss,
    generated_at: generated.toISOString(), valid_until: new Date(generated.getTime() + 30_000).toISOString(),
    summary: { state: "operational", label: "All systems operational", counts: { operational: 1, degraded: 0, down: 0, maintenance: 0, unknown: 0 } },
    notices: [], incidents: [], maintenance: [], past: [],
    groups: [{
      id: 1, name: "Core network", state: "operational", collapsed: false,
      items: [{
        id: 1, name: "Edge router", state: "operational", availability: { percent: 1, label: "ok", coverage: 1 },
        heartbeats: Array.from({ length: 60 }, () => "healthy"), response: null, metrics: null, incident_ids: [],
      }],
    }],
    ...overrides,
  };
}

const frameOf = (page: Page) => page.frameLocator("iframe.status-page-frame");
const computed = (locator: Locator, prop: "backgroundColor" | "color" | "animationName") =>
  locator.evaluate((node, name) => getComputedStyle(node)[name as "color"], prop);

async function servePublic(page: Page, body: unknown) {
  await page.route("**/api/v1/**", (route) => route.fulfill({ status: 401, json: { detail: "Authentication required" } }));
  await page.route(PUBLIC_URL, (route) => route.fulfill({ json: body, headers: { ETag: '"v1"' } }));
}

async function parentStyleText(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n"));
}

async function builtinRowBackground(page: Page) {
  await servePublic(page, payload(null));
  await page.goto(`/status/${SLUG}`);
  const row = frameOf(page).locator(".sp-row").first();
  await expect(row).toBeVisible();
  return computed(row, "backgroundColor");
}

test("custom css styles rows inside frame only", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, []);
  await setupMonitoringMocks(page, []);
  const stored = { id: 1, slug: SLUG, name: "Acme", title: null, visibility: "public", heartbeat_window: "1h", logo: null, accent: null, custom_css: CUSTOM_CSS, created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z" };
  await page.route("**/api/v1/status-pages**", (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status-pages")) return route.fulfill({ json: [stored] });
    if (path.endsWith("/sources")) return route.fulfill({ json: { devices: [], monitors: [] } });
    if (path.endsWith("/preview")) return route.fulfill({ json: payload(CUSTOM_CSS) });
    return route.fulfill({ json: { ...stored, groups: [] } });
  });
  await page.goto("/monitoring");
  await page.getByRole("link", { name: "Status pages", exact: true }).click();
  await page.locator(".status-pages-table tbody tr", { hasText: "Acme" }).getByRole("button", { name: "Edit" }).click();

  const panel = page.locator(".status-editor-panel").first();
  await expect(panel).toBeVisible();
  const before = { panel: await computed(panel, "backgroundColor"), body: await computed(page.locator("body"), "backgroundColor") };

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const frame = frameOf(page);
  await expect(frame.locator(".sp-row").first()).toBeVisible();
  expect(await computed(frame.locator(".sp-row").first(), "backgroundColor")).toBe("rgb(1, 2, 3)");
  expect(await computed(frame.locator(".sp-title"), "color")).toBe("rgb(4, 5, 6)");

  const previewPanel = page.locator(".status-editor-preview-panel");
  expect(await computed(previewPanel, "backgroundColor")).toBe(before.panel);
  expect(await computed(page.locator("body"), "backgroundColor")).toBe(before.body);
  expect(await computed(previewPanel, "backgroundColor")).not.toBe("rgb(250, 0, 0)");
  expect(await parentStyleText(page)).not.toContain("rgb(250, 0, 0)");
});

test("no network request is made by custom css", async ({ page }) => {
  const reached: string[] = [];
  const blocked: string[] = [];
  const isResource = (url: string) => !new URL(url).pathname.startsWith("/api/") && /\.png$|evil\.test/.test(url);
  page.on("requestfinished", (request) => { if (isResource(request.url())) reached.push(request.url()); });
  page.on("requestfailed", (request) => { if (isResource(request.url())) blocked.push(request.failure()?.errorText ?? ""); });
  await page.route("**/*.png", (route) => { reached.push(route.request().url()); return route.fulfill({ status: 204, body: "" }); });
  const hostile = ".sp-row{background-image:url(http://evil.test/row.png)} .sp-title{background:url(/leak.png)}";
  await servePublic(page, payload(`${CUSTOM_CSS}\n${hostile}`));
  await page.goto(`/status/${SLUG}`);
  const row = frameOf(page).locator(".sp-row").first();
  await expect(row).toBeVisible();
  expect(await computed(row, "backgroundColor")).toBe("rgb(1, 2, 3)");
  await page.waitForTimeout(500);
  expect(reached).toEqual([]);
  expect(blocked.every((reason) => reason === "csp")).toBe(true);
});

test("invalid stored css falls back to built-in style", async ({ page }) => {
  const builtin = await builtinRowBackground(page);
  expect(builtin).not.toBe("rgb(1, 2, 3)");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await servePublic(page, payload(`${CUSTOM_CSS}\n.sp-row{color:red}</style><script>parent.document.body.dataset.pwned="1"</script>`));
  await page.goto(`/status/${SLUG}`);
  const frame = frameOf(page);
  const row = frame.locator(".sp-row").first();
  await expect(row).toBeVisible();
  expect(await computed(row, "backgroundColor")).toBe(builtin);
  await expect(frame.locator("style[data-sp-custom]")).toHaveCount(0);
  await expect(frame.locator("script")).toHaveCount(1);
  expect(await page.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
});

test("reduced motion overrides custom animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await servePublic(page, payload("@keyframes spin{from{opacity:0}to{opacity:1}} .sp-row{animation:spin 1s infinite!important}"));
  await page.goto(`/status/${SLUG}`);
  const row = frameOf(page).locator(".sp-row").first();
  await expect(row).toBeVisible();
  expect(await computed(row, "animationName")).toBe("none");
});

test("css never applies after navigating from status page to app", async ({ page }) => {
  await servePublic(page, payload(CUSTOM_CSS));
  await page.goto(`/status/${SLUG}`);
  await expect(frameOf(page).locator(".sp-row").first()).toBeVisible();
  expect(await parentStyleText(page)).not.toContain("rgb(250, 0, 0)");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await setupCoreMocks(page);
  await setupTopologyMocks(page, []);
  await setupMonitoringMocks(page, []);
  await page.route("**/api/v1/status-pages**", (route) => route.fulfill({ json: [] }));
  await page.goto("/monitoring");
  const panel = page.locator(".nm-app-panel").first();
  await expect(panel).toBeVisible();
  expect(await computed(panel, "backgroundColor")).not.toBe("rgb(250, 0, 0)");
  expect(await computed(page.locator("body"), "backgroundColor")).not.toBe("rgb(250, 0, 0)");
  expect(await parentStyleText(page)).not.toContain("rgb(250, 0, 0)");
  await expect(page.locator("iframe.status-page-frame")).toHaveCount(0);
});

const CSS_ERRORS = { message: "Custom CSS was not saved", css_errors: ["Line 2, column 13: url() is not allowed"] };

test("editor css field shows line and column errors and keeps the draft", async ({ page }) => {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, []);
  await setupMonitoringMocks(page, []);
  const stored = { id: 1, slug: SLUG, name: "Acme", title: null, visibility: "public", heartbeat_window: "1h", logo: null, accent: null, custom_css: null as string | null, created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z" };
  const patches: Record<string, unknown>[] = [];
  await page.route("**/api/v1/status-pages**", (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/status-pages")) return route.fulfill({ json: [stored] });
    if (path.endsWith("/sources")) return route.fulfill({ json: { devices: [], monitors: [] } });
    if (path.endsWith("/preview")) return route.fulfill({ json: payload(stored.custom_css) });
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as { custom_css?: string };
      patches.push(body);
      if (body.custom_css?.includes("url(")) return route.fulfill({ status: 422, json: { detail: CSS_ERRORS } });
      Object.assign(stored, body);
      return route.fulfill({ json: stored });
    }
    return route.fulfill({ json: { ...stored, groups: [] } });
  });
  await page.goto("/monitoring");
  await page.getByRole("link", { name: "Status pages", exact: true }).click();
  await page.locator(".status-pages-table tbody tr", { hasText: "Acme" }).getByRole("button", { name: "Edit" }).click();

  const field = page.getByLabel("Custom CSS");
  await expect(field).toHaveValue("");
  await expect(field).toHaveClass(/nm-textarea/);
  const invalid = ".sp-row{color:red}\n.sp-title{ background:url(x)}";
  await field.fill(invalid);
  await page.getByRole("button", { name: "Save settings" }).click();
  const errors = page.locator(".status-editor-css-errors");
  await expect(errors).toContainText("Line 2, column 13: url() is not allowed");
  await expect(errors).toHaveClass(/nm-alert--error/);
  await expect(field).toHaveValue(invalid);
  await expect(field).toHaveAttribute("aria-invalid", "true");

  await field.fill(".sp-row{color:rgb(1, 2, 3)}");
  await expect(errors).toHaveCount(0);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => stored.custom_css).toBe(".sp-row{color:rgb(1, 2, 3)}");
  expect(patches.at(-1)).toEqual({ custom_css: ".sp-row{color:rgb(1, 2, 3)}" });

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(frameOf(page).locator(".sp-row").first()).toBeVisible();
  await expect(frameOf(page).locator(".sp-row").first()).toHaveCSS("color", "rgb(1, 2, 3)");
});

const ADMIN_SETTINGS = {
  app_name: "NetMap", login_message: "", announcement: "", support_email: "", support_url: "", live_ping_enabled: true,
  monitor_interval_seconds: 120, idle_timeout_minutes: 15, active_network_public_targets_enabled: false,
  ip_reservation_default_expiry_enabled: true, ip_reservation_reminder_enabled: false, ip_reservation_reminder_days: 3,
  ip_reservation_reminder_channels: [], backup_schedule_enabled: false, backup_schedule_interval_hours: 24, backup_retention_count: 7,
};

const SYSLOG_STATUS = {
  enabled: true, udp_enabled: true, tcp_enabled: true, tls_enabled: false, udp_port: 1514, tcp_port: 1514, tls_port: 6514,
  retention_days: 7, allowlist_enabled: false, total_events: 0, retention_last_run_at: null, retention_last_deleted: 0,
  retention_last_error: null, last_event_received_at: null, received_packets: 0, stored_events: 0, dropped_unparsed: 0,
  denied_senders: 0, last_packet_at: null, last_packet_sender: null, last_stored_at: null, last_stored_sender: null,
  last_drop_at: null, last_drop_sender: null, last_drop_raw: null, last_denied_at: null, last_denied_sender: null,
};

test("system tab default css card validates and saves", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/admin/settings", (route) => route.fulfill({ json: ADMIN_SETTINGS }));
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: SYSLOG_STATUS }));
  let savedCss: string | null = ".sp-row{color:red}";
  const puts: unknown[] = [];
  await page.route("**/api/v1/admin/status-page-default-css", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { css: string | null };
      puts.push(body);
      if (body.css?.includes("url(")) return route.fulfill({ status: 422, json: { detail: CSS_ERRORS } });
      savedCss = body.css;
      return route.fulfill({ json: { css: savedCss } });
    }
    return route.fulfill({ json: { css: savedCss } });
  });
  await page.goto("/admin");
  await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "System", exact: true }).click();

  const card = page.locator(".admin-system-card", { hasText: "Status page default CSS" });
  await expect(card).toBeVisible();
  const field = card.getByLabel("Default CSS for new status pages");
  await expect(field).toHaveValue(".sp-row{color:red}");
  await field.fill("a{}\n.sp-title{ background:url(x)}");
  await card.getByRole("button", { name: "Save default CSS" }).click();
  await expect(card.locator(".nm-alert--error")).toContainText("Line 2, column 13: url() is not allowed");
  await expect(field).toHaveAttribute("aria-invalid", "true");

  await field.fill(".sp-row{color:blue}");
  await card.getByRole("button", { name: "Save default CSS" }).click();
  await expect.poll(() => savedCss).toBe(".sp-row{color:blue}");
  await expect(card.locator(".nm-alert--error")).toHaveCount(0);
  expect(puts).toHaveLength(2);
});

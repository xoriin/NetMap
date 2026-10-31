import { createHash } from "node:crypto";
import { expect, test, type FrameLocator, type Page, type Route } from "@playwright/test";

const SLUG = "acme";
const PUBLIC_URL = `**/api/v1/public/status-pages/${SLUG}`;
const VIEW_URL = `**/api/v1/status-pages/${SLUG}/view`;

type Beat = "healthy" | "unhealthy" | "unknown" | "maintenance";

function beats(down = 0, unknown = 0): Beat[] {
  return Array.from({ length: 60 }, (_, i) => {
    if (i >= 60 - down) return "unhealthy";
    if (i < unknown) return "unknown";
    return "healthy";
  });
}

function item(id: number, name: string, extras = false, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    state: "operational",
    availability: { percent: 0.9998, label: "ok", coverage: 1 },
    heartbeats: beats(),
    response: extras ? Array.from({ length: 60 }, (_, i) => (i % 7 === 3 ? null : 10 + (i % 5) * 3)) : null,
    metrics: extras ? { avg_response: 14, p95_response: 22, failure_rate: 0.01, uptime_period: { period: "7d", percent: 0.999, label: "ok", coverage: 0.98 } } : null,
    incident_ids: [],
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}, validForSeconds = 30) {
  const generated = new Date();
  return {
    slug: SLUG,
    title: "Acme Network",
    accent: null,
    logo: null,
    heartbeat_window: "1h",
    custom_css: null,
    generated_at: generated.toISOString(),
    valid_until: new Date(generated.getTime() + validForSeconds * 1000).toISOString(),
    summary: { state: "operational", label: "All systems operational", counts: { operational: 3, degraded: 0, down: 0, maintenance: 0, unknown: 0 } },
    notices: [],
    incidents: [],
    maintenance: [],
    past: [],
    groups: [
      {
        id: 1,
        name: "Core network",
        state: "operational",
        collapsed: false,
        items: [item(1, "Edge router"), item(2, "Core switch", true), item(3, "Firewall", false, { availability: { percent: null, label: "insufficient", coverage: 0.4 } })],
      },
    ],
    ...overrides,
  };
}

function fulfillPayload(route: Route, body: unknown, etag = '"v1"', date?: Date) {
  const headers: Record<string, string> = { ETag: etag };
  if (date) headers.Date = date.toUTCString();
  return route.fulfill({ status: 200, json: body, headers });
}

function snapshot(serverNow: Date, generatedAgoSeconds: number, validForSeconds: number) {
  return payload({
    generated_at: new Date(serverNow.getTime() - generatedAgoSeconds * 1000).toISOString(),
    valid_until: new Date(serverNow.getTime() + validForSeconds * 1000).toISOString(),
  });
}

const unavailableAlert = (page: Page) => page.getByRole("alert").filter({ hasText: "Status is temporarily unavailable" });

async function blockEverythingElse(page: Page) {
  await page.route("**/api/v1/**", (route) => route.fulfill({ status: 401, json: { detail: "Authentication required" } }));
}

function statusFrame(page: Page): FrameLocator {
  return page.frameLocator("iframe.status-page-frame");
}

test("public page renders without calling auth refresh", async ({ page }) => {
  const apiCalls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) apiCalls.push(path);
  });
  await blockEverythingElse(page);
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload()));

  await page.goto(`/status/${SLUG}`);

  await expect(statusFrame(page).locator(".sp-summary")).toContainText("All systems operational");
  await expect(statusFrame(page).locator(".sp-title")).toHaveText("Acme Network");
  expect(apiCalls).not.toContain("/api/v1/auth/refresh");
  expect(new Set(apiCalls)).toEqual(new Set([`/api/v1/public/status-pages/${SLUG}`]));
});

test("renderer only allows its hashed controller and stays isolated", async ({ page }) => {
  await blockEverythingElse(page);
  const body = payload();
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, body));
  await page.goto(`/status/${SLUG}`);

  const frame = page.locator("iframe.status-page-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox allow-scripts");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  const doc = (await frame.getAttribute("srcdoc")) ?? "";
  expect(doc).toMatch(/^<!doctype html><html[^>]*><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  await expect(statusFrame(page).locator("script")).toHaveCount(1);
  const scriptText = await statusFrame(page).locator("script").textContent();
  const csp = await statusFrame(page).locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("script-src 'sha256-" + createHash("sha256").update(scriptText!).digest("base64") + "';");
  await expect(statusFrame(page).locator(".sp-heartbeat-tooltip")).toHaveCount(1);
  const security = await statusFrame(page).locator("body").evaluate(node => {
    const bad = document.createElement("script");
    bad.textContent = "document.body.dataset.injected = 'yes'";
    document.body.append(bad);
    let parentAccess, storageAccess;
    try { void parent.document.body; parentAccess = true; } catch { parentAccess = false; }
    try { void localStorage.length; storageAccess = true; } catch { storageAccess = false; }
    return { injected: node.dataset.injected, parentAccess, storageAccess };
  });
  expect(security).toEqual({ injected: undefined, parentAccess: false, storageAccess: false });
  expect(doc).not.toContain(body.generated_at);
  expect(doc).not.toContain(body.valid_until);
  expect(doc).not.toMatch(/https?:\/\//);
});

test("payload text is rendered as text", async ({ page }) => {
  const hostile = "<img src=x onerror=alert(1)>";
  await blockEverythingElse(page);
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload({
    title: `<b>${hostile}</b>`,
    notices: [{ id: 1, level: "warning", title: "Heads up", body: hostile, link: "javascript:alert(1)", expires_at: null }],
  })));
  await page.goto(`/status/${SLUG}`);

  const frame = statusFrame(page);
  await expect(frame.locator(".sp-notice")).toContainText(hostile);
  await expect(frame.locator(".sp-notice img")).toHaveCount(0);
  await expect(frame.locator(".sp-notice a")).toHaveCount(0);
  await expect(frame.locator(".sp-title")).toHaveText(`<b>${hostile}</b>`);
  await expect(frame.locator("img, b")).toHaveCount(0);
});

test("notices, open incidents and past incidents render in their places as text", async ({ page }) => {
  const hostile = "<img src=x onerror=alert(1)>";
  const opened = new Date(Date.now() - 3_600_000).toISOString();
  await blockEverythingElse(page);
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload({
    summary: { state: "affected", label: "Some systems are affected", counts: { operational: 3, degraded: 0, down: 0, maintenance: 0, unknown: 0 } },
    notices: [{ id: 4, level: "critical", title: "Datacentre power", body: "On generators", link: null, expires_at: null }],
    incidents: [{
      id: 7, title: "Mail delays", severity: "partial", status: "identified", opened_at: opened, resolved_at: null,
      ticket: { url: "https://tickets.example.com/INC-1042", label: "Ticket INC-1042" },
      updates: [
        { id: 1, at: opened, status: null, message: `Looking ${hostile}`, author: "Status team", internal: false },
        { id: 2, at: opened, status: "identified", message: "Queue host restarted", author: "Jane Smith", internal: true },
      ],
    }],
    past: [{
      kind: "incident", id: 3, title: "Website outage", severity: "major", status: "resolved", opened_at: opened, resolved_at: opened,
      ticket: { url: "javascript:alert(1)", label: "Bad" },
      updates: [{ id: 9, at: opened, status: "resolved", message: "Resolved.", author: "NetMap", internal: false }],
    }],
  })));
  await page.goto(`/status/${SLUG}`);
  const frame = statusFrame(page);

  await expect(frame.locator(".sp-summary + .sp-strip")).toContainText("Mail delays");
  const strip = frame.locator('.sp-strip[data-kind="incident"]');
  await expect(strip).toContainText("Partial outage");
  await expect(strip).toContainText("Identified");
  const ticket = strip.locator("a");
  await expect(ticket).toHaveText("Ticket INC-1042");
  await expect(ticket).toHaveAttribute("href", "https://tickets.example.com/INC-1042");
  await expect(ticket).toHaveAttribute("rel", "noopener noreferrer");
  await expect(frame.locator('.sp-notice[data-level="critical"]')).toContainText("Datacentre power");
  await expect(frame.locator(".sp-summary-counts")).toHaveCount(0);

  const log = frame.locator("details.sp-log");
  await expect(log).not.toHaveAttribute("open", "");
  await expect(log.locator(".sp-section-title")).toContainText("Incident log");
  await expect(log.locator("summary").getByRole("heading", { level: 2, name: "Incident log" })).toBeVisible();
  await expect(frame.locator("details.sp-past summary").getByRole("heading", { level: 2, name: "Past incidents" })).toBeVisible();
  await log.locator("summary").click();
  const updates = log.locator(".sp-update");
  await expect(updates).toHaveCount(2);
  await expect(updates.nth(0)).toContainText(`Looking ${hostile}`);
  await expect(updates.nth(0).locator(".sp-update-internal")).toHaveCount(0);
  await expect(updates.nth(1)).toHaveAttribute("data-internal", "true");
  await expect(updates.nth(1).locator(".sp-update-internal")).toHaveText("Internal");
  await expect(frame.locator(".sp-update img")).toHaveCount(0);

  const past = frame.locator("details.sp-past");
  await expect(past).not.toHaveAttribute("open", "");
  await past.locator("summary").click();
  await expect(past.locator(".sp-incident")).toContainText("Website outage");
  await expect(past.locator("a")).toHaveCount(0);
  const order = await frame.locator(".sp-page > *").evaluateAll((nodes) => nodes.map((node) => node.className));
  expect(order).toEqual(["sp-header", "sp-summary", "sp-strip", "sp-strip sp-notice", "sp-groups", "sp-log", "sp-past"]);
});

test.describe("scheduled maintenance", () => {
  test.use({ timezoneId: "Australia/Brisbane" });

  test("upcoming and active windows render under the summary and finished ones in Past", async ({ page }) => {
    const hostile = "<img src=x onerror=alert(1)>";
    const now = Date.now();
    const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();
    await blockEverythingElse(page);
    await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload({
      summary: { state: "maintenance", label: "Maintenance in progress", counts: { operational: 2, degraded: 0, down: 0, maintenance: 1, unknown: 0 } },
      maintenance: [
        { id: 1, title: "Core switch firmware upgrade", description: null, starts_at: iso(-10), ends_at: iso(20), active: true, announced: true },
        { id: 2, title: `Router swap ${hostile}`, description: `Expect ${hostile} blips`, starts_at: iso(48 * 60), ends_at: iso(48 * 60 + 30), active: false, announced: true },
      ],
      past: [{ kind: "maintenance", id: 3, title: "UPS battery test", description: "Done", starts_at: iso(-3000), ends_at: iso(-2940) }],
      groups: [{
        id: 1, name: "Core network", state: "maintenance", collapsed: false,
        items: [item(1, "Edge router", false, { state: "maintenance", heartbeats: Array(60).fill("maintenance") }), item(2, "Core switch")],
      }],
    })));
    await page.goto(`/status/${SLUG}`);
    const frame = statusFrame(page);

    const active = frame.locator('.sp-strip[data-kind="maintenance"][data-active="true"]');
    await expect(active).toContainText("Maintenance");
    await expect(active).toContainText("Core switch firmware upgrade");
    await expect(active.locator(".sp-strip-meta")).toContainText("until");
    await expect(active.locator(".sp-strip-meta")).toContainText("(Australia/Brisbane)");
    const upcoming = frame.locator('.sp-strip[data-kind="maintenance"][data-active="false"]');
    await expect(upcoming.locator(".sp-pill")).toHaveText("Planned maintenance");
    await expect(upcoming.locator(".sp-strip-title")).toHaveText(`Router swap ${hostile}`);
    await expect(upcoming.locator(".sp-strip-meta")).toHaveText(/^\w{3} .+ for 30 min \(Australia\/Brisbane\)$/);
    await expect(frame.locator(".sp-strip img")).toHaveCount(0);
    await expect(frame.locator(".sp-row").first()).toContainText("Under maintenance");

    const past = frame.locator("details.sp-past");
    await past.locator("summary").click();
    const entry = past.locator('.sp-incident[data-kind="maintenance"]');
    await expect(entry.locator(".sp-pill")).toHaveText("Planned maintenance");
    await expect(entry).toContainText("UPS battery test");
    await expect(entry.locator(".sp-incident-meta")).toContainText("(Australia/Brisbane)");
    const order = await frame.locator(".sp-page > *").evaluateAll((nodes) => nodes.map((node) => node.className));
    expect(order).toEqual(["sp-header", "sp-summary", "sp-strip", "sp-strip", "sp-groups", "sp-past"]);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`a window not announced on this page shows the generic line like an announced one in ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      const now = Date.now();
      const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();
      await blockEverythingElse(page);
      await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload({
        summary: { state: "maintenance", label: "Maintenance in progress", counts: { operational: 1, degraded: 0, down: 0, maintenance: 1, unknown: 0 } },
        maintenance: [
          { title: "Scheduled maintenance", description: null, starts_at: iso(-10), ends_at: iso(20), active: true, announced: false },
          { id: 2, title: "Router swap", description: "Expect blips", starts_at: iso(-5), ends_at: iso(25), active: true, announced: true },
        ],
        groups: [{
          id: 1, name: "Core network", state: "maintenance", collapsed: false,
          items: [item(1, "Edge router", false, { state: "maintenance", heartbeats: Array(60).fill("maintenance") }), item(2, "Core switch")],
        }],
      })));
      await page.goto(`/status/${SLUG}`);
      const frame = statusFrame(page);
      const generic = frame.locator('.sp-strip[data-kind="maintenance"][data-announced="false"]');
      const announced = frame.locator('.sp-strip[data-kind="maintenance"][data-announced="true"]');
      await expect(generic.locator(".sp-pill")).toHaveText("Maintenance");
      await expect(generic.locator(".sp-strip-title")).toHaveText("Scheduled maintenance");
      await expect(generic.locator(".sp-strip-meta")).toContainText("until");
      await expect(generic.locator(".sp-strip-body")).toHaveCount(0);
      await expect(announced.locator(".sp-strip-body")).toHaveText("Expect blips");
      expect(await frameBackground(page)).toBe(colorScheme === "dark" ? DARK_BG : LIGHT_BG);
      const look = (strip: typeof generic) => strip.evaluate((node) => {
        const pill = node.querySelector(".sp-pill")!;
        const s = getComputedStyle(node), p = getComputedStyle(pill);
        return [s.backgroundColor, s.borderColor, s.color, p.backgroundColor, p.color];
      });
      expect(await look(generic)).toEqual(await look(announced));
    });
  }
});

test("status page marks itself unavailable when the server stops answering", async ({ page }) => {
  await page.clock.install();
  await blockEverythingElse(page);
  let calls = 0;
  let recovered = false;
  await page.route(PUBLIC_URL, (route) => {
    calls += 1;
    if (calls === 1) return fulfillPayload(route, payload({}, 1));
    if (recovered) return fulfillPayload(route, payload(), '"v2"');
    return route.abort("connectionrefused");
  });
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-summary")).toContainText("All systems operational");

  await page.clock.fastForward(35_000);
  const overlay = page.getByRole("alert").filter({ hasText: "Status is temporarily unavailable" });
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Last updated");
  await expect(page.locator("iframe.status-page-frame")).toBeHidden();

  recovered = true;
  await page.clock.fastForward(31_000);
  await expect(overlay).toBeHidden();
  await expect(page.locator("iframe.status-page-frame")).toBeVisible();
});

test("a single 503 is retried after Retry-After before showing unavailable", async ({ page }) => {
  await page.clock.install();
  await blockEverythingElse(page);
  const responses: Array<"ok" | "503"> = ["ok", "503", "ok", "503", "503"];
  await page.route(PUBLIC_URL, (route) => {
    const next = responses.shift() ?? "503";
    if (next === "ok") return fulfillPayload(route, payload(), `"v${responses.length}"`);
    return route.fulfill({ status: 503, json: { detail: "Status page is being prepared" }, headers: { "Retry-After": "3" } });
  });
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-summary")).toContainText("All systems operational");
  const overlay = page.getByRole("alert").filter({ hasText: "Status is temporarily unavailable" });

  await page.clock.fastForward(30_500);
  await expect(overlay).toBeHidden();
  await page.clock.fastForward(3_500);
  await expect.poll(() => responses.length).toBe(2);
  await expect(overlay).toBeHidden();

  await page.clock.fastForward(30_500);
  await page.clock.fastForward(3_500);
  await expect(overlay).toBeVisible();
});

test("private page redirects to sign-in and returns afterwards", async ({ page }) => {
  let signedIn = false;
  await blockEverythingElse(page);
  await page.route("**/api/v1/admin/public-settings", (route) => route.fulfill({ json: { app_name: "NetMap", login_message: "", idle_timeout_minutes: 15, announcement: null } }));
  await page.route("**/api/v1/setup/status", (route) => route.fulfill({ json: { needs_setup: false } }));
  await page.route("**/api/v1/auth/oidc/status", (route) => route.fulfill({ json: { enabled: false, provider_name: "SSO", require_sso: false } }));
  await page.route("**/api/v1/auth/login", (route) => {
    signedIn = true;
    return route.fulfill({ json: { access_token: "mock-access-token", token_type: "bearer" } });
  });
  await page.route(PUBLIC_URL, (route) => route.fulfill({ status: 404, json: { detail: "Not found" } }));
  await page.route(VIEW_URL, (route) => (signedIn
    ? fulfillPayload(route, payload({ title: "Private Lab" }))
    : route.fulfill({ status: 401, json: { detail: "Authentication required" } })));

  await page.goto(`/status/${SLUG}`);
  await expect(page).toHaveURL(new RegExp(`/\\?next=%2Fstatus%2F${SLUG}$`));
  await page.getByLabel("Username").fill("viewer");
  await page.getByLabel("Password").fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/status/${SLUG}$`));
  await expect(statusFrame(page).locator(".sp-title")).toHaveText("Private Lab");
});

test("sign-in ignores a next target that is not a status page", async ({ page }) => {
  await blockEverythingElse(page);
  await page.route("**/api/v1/admin/public-settings", (route) => route.fulfill({ json: { app_name: "NetMap", login_message: "", idle_timeout_minutes: 15, announcement: null } }));
  await page.route("**/api/v1/setup/status", (route) => route.fulfill({ json: { needs_setup: false } }));
  await page.route("**/api/v1/auth/oidc/status", (route) => route.fulfill({ json: { enabled: false, provider_name: "SSO", require_sso: false } }));
  await page.route("**/api/v1/auth/login", (route) => route.fulfill({ json: { access_token: "mock-access-token", token_type: "bearer" } }));

  await page.goto(`/?next=${encodeURIComponent("//evil.example/status/acme")}`);
  await page.getByLabel("Username").fill("viewer");
  await page.getByLabel("Password").fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/evil\.example/);
  await expect(page).not.toHaveURL(/\/status\//);
});

test("rows with extras open with keyboard", async ({ page }) => {
  await blockEverythingElse(page);
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload()));
  await page.goto(`/status/${SLUG}`);
  const frame = statusFrame(page);
  const row = frame.locator("details.sp-row").first();
  await expect(row).toBeVisible();
  await expect(frame.locator("div.sp-row")).toHaveCount(2);
  await expect(row.locator(".sp-response")).toBeHidden();

  const summary = row.locator("summary");
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    if (await summary.evaluate((node) => node === node.ownerDocument.activeElement)) break;
  }
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row.locator(".sp-response")).toBeVisible();
  await expect(row.locator(".sp-stats")).toContainText("Avg response");
  await expect(row.locator(".sp-heartbeats")).toHaveAttribute("aria-label", "Last hour: 60 up");
});

test("heartbeat bars summarise the window and show non-ok uptime labels", async ({ page }) => {
  await blockEverythingElse(page);
  const body = payload();
  body.groups[0].items[0] = item(1, "Edge router", false, { heartbeats: [...beats(2, 3)], availability: { percent: null, label: "no_data", coverage: 0 } });
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, body));
  await page.goto(`/status/${SLUG}`);
  const frame = statusFrame(page);
  const rows = frame.locator(".sp-row");
  await expect(rows.nth(0).locator(".sp-heartbeats")).toHaveAttribute("aria-label", "Last hour: 55 up, 2 down, 3 unknown");
  await expect(rows.nth(0).locator(".sp-beat")).toHaveCount(60);
  await expect(rows.nth(0).locator(".sp-uptime")).toHaveText("No data");
  await expect(rows.nth(1).locator(".sp-uptime")).toHaveText("99.98%");
  await expect(rows.nth(2).locator(".sp-uptime")).toHaveText("Insufficient data");
  await expect(rows.nth(0)).toHaveAttribute("data-state", "operational");
  await expect(frame.locator(".sp-group").first()).toHaveAttribute("data-state", "operational");
});

test("an unchanged poll keeps open rows open", async ({ page }) => {
  await page.clock.install();
  await blockEverythingElse(page);
  let version = 0;
  await page.route(PUBLIC_URL, (route) => {
    version += 1;
    return fulfillPayload(route, payload(), `"v${version}"`);
  });
  await page.goto(`/status/${SLUG}`);
  const frame = statusFrame(page);
  const row = frame.locator("details.sp-row").first();
  await row.locator("summary").click();
  await expect(row.locator(".sp-response")).toBeVisible();

  await page.clock.fastForward(31_000);
  await expect.poll(() => version).toBeGreaterThan(1);
  await expect(row).toHaveAttribute("open", "");
});

test("the frame makes no network requests", async ({ page }) => {
  const frameRequests: string[] = [];
  page.on("request", (request) => {
    if (request.frame() !== page.mainFrame()) frameRequests.push(request.url());
  });
  await blockEverythingElse(page);
  const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload({
    logo,
    notices: [{ id: 1, level: "info", title: "Planned work", body: "Tonight", link: "https://example.com/notice", expires_at: null }],
  })));
  await page.goto(`/status/${SLUG}`);
  const frame = statusFrame(page);
  await expect(frame.locator(".sp-logo")).toHaveAttribute("src", logo);
  const link = frame.locator(".sp-notice a");
  await expect(link).toHaveAttribute("href", "https://example.com/notice");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await page.waitForTimeout(300);
  expect(frameRequests).toEqual([]);
});

test("a logo that is not a data image is not rendered", async ({ page }) => {
  await blockEverythingElse(page);
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload({ logo: "https://evil.example/logo.png" })));
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-title")).toHaveText("Acme Network");
  await expect(statusFrame(page).locator(".sp-logo")).toHaveCount(0);
});

test("an expired snapshot is marked unavailable on the server clock", async ({ page }) => {
  await page.clock.install();
  await blockEverythingElse(page);
  const serverNow = new Date(Math.floor(Date.now() / 1000) * 1000);
  const body = snapshot(serverNow, 2 * 60 * 60, 2);
  let calls = 0;
  await page.route(PUBLIC_URL, (route) => {
    calls += 1;
    if (calls === 1) return fulfillPayload(route, body, '"v1"', serverNow);
    return new Promise<void>(() => {});
  });
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-summary")).toContainText("All systems operational");

  await page.clock.fastForward(1_000);
  await expect(unavailableAlert(page)).toBeHidden();
  await page.clock.fastForward(7_000);
  await expect(unavailableAlert(page)).toBeVisible();
  await expect(page.locator("iframe.status-page-frame")).toBeHidden();
  const expected = await page.evaluate((iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), body.generated_at);
  await expect(unavailableAlert(page)).toContainText(`Last updated ${expected}`);
});

test("a 304 keeps the held snapshot's deadline mapped through the server clock", async ({ page }) => {
  await page.clock.install();
  await blockEverythingElse(page);
  const serverNow = new Date(Math.floor(Date.now() / 1000) * 1000);
  let calls = 0;
  await page.route(PUBLIC_URL, (route) => {
    calls += 1;
    if (calls === 1) return fulfillPayload(route, snapshot(serverNow, 0, 30), '"v1"', serverNow);
    if (calls === 2) {
      return route.fulfill({ status: 304, headers: { ETag: '"v1"', Date: new Date(serverNow.getTime() + 28_000).toUTCString() } });
    }
    return new Promise<void>(() => {});
  });
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-summary")).toContainText("All systems operational");

  await page.clock.fastForward(31_000);
  await expect.poll(() => calls).toBe(2);
  await expect(unavailableAlert(page)).toBeHidden();
  await page.clock.fastForward(8_000);
  await expect(unavailableAlert(page)).toBeVisible();
});

test("a snapshot that arrives already expired is marked unavailable within the grace", async ({ page }) => {
  await page.clock.install();
  await blockEverythingElse(page);
  const serverNow = new Date(Math.floor(Date.now() / 1000) * 1000);
  const body = snapshot(serverNow, 30, 0);
  let calls = 0;
  await page.route(PUBLIC_URL, (route) => {
    calls += 1;
    return fulfillPayload(route, body, '"v1"', serverNow);
  });
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-summary")).toContainText("All systems operational");

  for (let step = 0; step < 6; step += 1) {
    const before = calls;
    await page.clock.fastForward(1_000);
    await expect.poll(() => calls).toBeGreaterThan(before);
  }
  await expect(unavailableAlert(page)).toBeVisible();
});

test("an expired 304 does not clear an earlier unavailable state", async ({ page }) => {
  await page.clock.install();
  await blockEverythingElse(page);
  const serverNow = new Date(Math.floor(Date.now() / 1000) * 1000);
  let calls = 0;
  await page.route(PUBLIC_URL, (route) => {
    calls += 1;
    if (calls === 1) return fulfillPayload(route, snapshot(serverNow, 0, 30), '"v1"', serverNow);
    if (calls === 2) return route.abort("connectionrefused");
    return route.fulfill({ status: 304, headers: { ETag: '"v1"', Date: new Date(serverNow.getTime() + 62_000).toUTCString() } });
  });
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-summary")).toContainText("All systems operational");

  await page.clock.fastForward(31_000);
  await expect(unavailableAlert(page)).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect.poll(() => calls).toBeGreaterThanOrEqual(3);
  await page.clock.fastForward(1_500);
  await expect(unavailableAlert(page)).toBeVisible();
  await expect(page.locator("iframe.status-page-frame")).toBeHidden();
});

test("waking past the deadline shows unavailable at once", async ({ page }) => {
  await page.clock.install();
  await blockEverythingElse(page);
  const serverNow = new Date(Math.floor(Date.now() / 1000) * 1000);
  let calls = 0;
  await page.route(PUBLIC_URL, (route) => {
    calls += 1;
    if (calls === 1) return fulfillPayload(route, snapshot(serverNow, 0, 30), '"v1"', serverNow);
    return new Promise<void>(() => {});
  });
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-summary")).toContainText("All systems operational");

  await page.clock.setSystemTime(Date.now() + 10 * 60 * 1000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(unavailableAlert(page)).toBeVisible();
});

test("a signed-in viewer whose session expired is refreshed once before sign-in", async ({ page }) => {
  const order: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) order.push(path);
  });
  await blockEverythingElse(page);
  let viewCalls = 0;
  await page.route("**/api/v1/auth/refresh", (route) => route.fulfill({ json: { access_token: "fresh", token_type: "bearer" } }));
  await page.route(PUBLIC_URL, (route) => route.fulfill({ status: 404, json: { detail: "Not found" } }));
  await page.route(VIEW_URL, (route) => {
    viewCalls += 1;
    return viewCalls === 1
      ? route.fulfill({ status: 401, json: { detail: "Invalid or expired token" } })
      : fulfillPayload(route, payload({ title: "Private Lab" }));
  });
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-title")).toHaveText("Private Lab");
  await expect(page).toHaveURL(new RegExp(`/status/${SLUG}$`));
  expect(order.indexOf("/api/v1/auth/refresh")).toBeGreaterThan(order.indexOf(`/api/v1/public/status-pages/${SLUG}`));
  expect(viewCalls).toBe(2);
});

test("a signed-in viewer on an unknown slug sees not found without a redirect", async ({ page }) => {
  await blockEverythingElse(page);
  await page.route(PUBLIC_URL, (route) => route.fulfill({ status: 404, json: { detail: "Not found" } }));
  await page.route(VIEW_URL, (route) => route.fulfill({ status: 404, json: { detail: "Not found" } }));
  await page.goto(`/status/${SLUG}`);
  await expect(page.getByText("Status page not found")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/status/${SLUG}$`));
});

test("an anonymous visitor on an unknown slug gets the same sign-in redirect as a private page", async ({ page }) => {
  await blockEverythingElse(page);
  await page.route(PUBLIC_URL, (route) => route.fulfill({ status: 404, json: { detail: "Not found" } }));
  await page.goto(`/status/${SLUG}`);
  await expect(page).toHaveURL(new RegExp(`/\\?next=%2Fstatus%2F${SLUG}$`));
});

async function frameBackground(page: Page) {
  return statusFrame(page).locator("body").evaluate((body) => getComputedStyle(body).backgroundColor);
}

const LIGHT_BG = "rgb(254, 254, 254)";
const DARK_BG = "rgb(2, 6, 23)";

test("with no stored theme the shell and frame follow the OS scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await blockEverythingElse(page);
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload()));
  await page.goto(`/status/${SLUG}`);
  await expect(statusFrame(page).locator(".sp-summary")).toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/theme-dark/);
  expect(await frameBackground(page)).toBe(LIGHT_BG);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("body")).toHaveClass(/theme-dark/);
  await expect.poll(() => frameBackground(page)).toBe(DARK_BG);
  expect(await page.evaluate(() => window.localStorage.getItem("netmap.theme"))).toBeNull();
});

for (const [stored, os, background] of [["light", "dark", LIGHT_BG], ["dark", "light", DARK_BG]] as const) {
  test(`a stored ${stored} theme drives both the shell and the frame on a ${os} OS`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: os });
    await page.addInitScript((theme) => window.localStorage.setItem("netmap.theme", theme), stored);
    await blockEverythingElse(page);
    await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload({ custom_css:
      ".sp-title { color: rgb(12, 34, 56); } @media (prefers-color-scheme: dark) { .sp-title { color: rgb(78, 90, 123); } } @supports (display: grid) { @media (prefers-color-scheme: dark) and (max-width: 600px) { .sp-title { font-style: italic; } } }",
    })));
    await page.goto(`/status/${SLUG}`);
    await expect(statusFrame(page).locator(".sp-summary")).toBeVisible();
    await expect(statusFrame(page).locator(".sp-title")).toHaveCSS("color", stored === "dark" ? "rgb(78, 90, 123)" : "rgb(12, 34, 56)");
    if (stored === "dark") await expect(page.locator("body")).toHaveClass(/theme-dark/);
    else await expect(page.locator("body")).not.toHaveClass(/theme-dark/);
    expect(await frameBackground(page)).toBe(background);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(statusFrame(page).locator(".sp-title")).toHaveCSS("font-style", stored === "dark" ? "italic" : "normal");
  });
}

function largePayload() {
  const groups = Array.from({ length: 6 }, (_, g) => ({
    id: g + 1,
    name: `Group ${g + 1} with a fairly long descriptive name`,
    state: "operational",
    collapsed: false,
    items: Array.from({ length: g < 4 ? 7 : 6 }, (_, i) => item(g * 10 + i, `Service ${g + 1}.${i + 1} at a long hostname.example.internal`, i % 2 === 0, { heartbeats: beats(i % 3) })),
  }));
  return payload({ groups });
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`layout holds at ${width}px width with 40 items in 6 groups (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await blockEverythingElse(page);
      await page.route(PUBLIC_URL, (route) => fulfillPayload(route, largePayload()));
      await page.goto(`/status/${SLUG}`);
      const frame = statusFrame(page);
      await expect(frame.locator(".sp-row")).toHaveCount(40);
      await expect(frame.locator(".sp-group")).toHaveCount(6);

      const rows = frame.locator("details.sp-row");
      for (const index of [0, 5]) {
        const row = rows.nth(index);
        await row.locator("summary").click();
        const beatsBox = await row.locator(".sp-heartbeats").boundingBox();
        const responseBox = await row.locator(".sp-response").boundingBox();
        expect(beatsBox && responseBox).toBeTruthy();
        expect(Math.abs(beatsBox!.width - responseBox!.width)).toBeLessThanOrEqual(1);
        expect(responseBox!.height).toBeGreaterThanOrEqual(64);
        expect(responseBox!.y - beatsBox!.y - beatsBox!.height).toBeGreaterThanOrEqual(24);
        expect(Math.abs(beatsBox!.x - responseBox!.x)).toBeLessThanOrEqual(1);
      }

      const overflow = await frame.locator("html").evaluate((html) => ({
        scroll: html.scrollWidth,
        client: html.clientWidth,
        background: getComputedStyle(html.ownerDocument.body).backgroundColor,
      }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
      expect(overflow.background).toBe(colorScheme === "light" ? "rgb(254, 254, 254)" : "rgb(2, 6, 23)");
      const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(pageOverflow).toBeLessThanOrEqual(0);
    });
  }
}


for (const theme of ["light", "dark"] as const) {
  test(`response charts connect measured points and keep extras inline in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1334, height: 1000 });
    await blockEverythingElse(page);
    const response = [10, null, 14, null, 8, null, 18, null, 12];
    const body = payload({ groups: [{ id: 1, name: "Infra", state: "operational", collapsed: false, items: [
      item(1, "OPNsense", true, { response, metrics: { avg_response: 12, p95_response: 18, failure_rate: 0, last_check: new Date().toISOString() } }),
      item(2, "Failed and unknown intervals", true, { response: [10, null, null, 15, null, 20], heartbeats: ["healthy", "unhealthy", "unknown", "healthy", "healthy", "healthy"] }),
      item(3, "Single zero sample", true, { response: [null, null, 0, null], metrics: { avg_response: 0 } }),
      item(4, "No responses", true, { response: [null, null], metrics: {} }),
    ] }] });
    await page.route(PUBLIC_URL, route => fulfillPayload(route, body));
    await page.goto(`/status/${SLUG}`);
    const frame = statusFrame(page);
    const rows = frame.locator("details.sp-row");
    const first = rows.nth(0);
    await first.locator("summary").click();
    await expect(first.locator(".sp-response-line")).toHaveCount(1);
    await expect(first.locator(".sp-response-point")).toHaveCount(5);
    const points = await first.locator(".sp-response-line").getAttribute("points");
    expect(points!.split(" ")).toHaveLength(5);
    await expect(first.locator(".sp-response-line")).toHaveCSS("stroke-width", "2px");
    const stats = await first.locator(".sp-stat").evaluateAll(nodes => nodes.map(n => ({ x: n.getBoundingClientRect().x, y: n.getBoundingClientRect().y })));
    expect(stats).toHaveLength(4);
    expect(new Set(stats.map(r => r.y)).size).toBe(1);
    expect(stats[3].x).toBeGreaterThan(stats[0].x);
    const beatsBox = await first.locator(".sp-heartbeats").boundingBox();
    const graphBox = await first.locator(".sp-response").boundingBox();
    expect(graphBox!.height).toBeGreaterThanOrEqual(64);
    expect(graphBox!.y - beatsBox!.y - beatsBox!.height).toBeGreaterThanOrEqual(24);
    expect(Math.abs(graphBox!.x - beatsBox!.x)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`response-${theme}.png`), fullPage: true });
    await rows.nth(1).locator("summary").click();
    await expect(rows.nth(1).locator(".sp-response-line")).toHaveCount(1);
    await expect(rows.nth(1).locator(".sp-response-point")).toHaveCount(3);
    expect((await rows.nth(1).locator(".sp-response-line").getAttribute("points"))!.split(" ")).toHaveLength(2);
    await rows.nth(2).locator("summary").click();
    await expect(rows.nth(2).locator(".sp-response-point")).toHaveCount(1);
    await expect(rows.nth(2).locator(".sp-response-point")).toHaveAttribute("cy", "56.00");
    await expect(rows.nth(2).locator(".sp-response-line")).toHaveCount(0);
    await expect(rows.nth(2).locator(".sp-stats")).toContainText("0 ms");
    await rows.nth(3).locator("summary").click();
    await expect(rows.nth(3).locator(".sp-response-empty")).toHaveText("No successful responses");
    await page.setViewportSize({ width: 390, height: 1000 });
    await expect.poll(() => frame.locator("html").evaluate(n => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath(`response-narrow-${theme}.png`), fullPage: true });
  });
}

test("each group shows its chosen icon and can be targeted by custom CSS", async ({ page }) => {
  await blockEverythingElse(page);
  const groups = [
    { id: 1, name: "Core network", state: "operational", collapsed: false, icon: null, items: [item(1, "Edge router")] },
    { id: 7, name: "Databases", state: "operational", collapsed: false, icon: "database", items: [item(2, "Primary DB")] },
    { id: 9, name: "Websites", state: "operational", collapsed: false, icon: "world", items: [item(3, "Homepage")] },
    { id: 12, name: "Retired", state: "operational", collapsed: false, icon: "no-such-icon", items: [item(4, "Old box")] },
  ];
  const custom_css = '.sp-group[data-group="7"] .sp-panel-icon { color: rgb(255, 0, 0); }';
  await page.route(PUBLIC_URL, (route) => fulfillPayload(route, payload({ groups, custom_css })));
  await page.goto(`/status/${SLUG}`);
  const frame = statusFrame(page);
  const svg = (id: number) => frame.locator(`.sp-group[data-group="${id}"] .sp-panel-icon svg`);
  await expect(svg(1)).toBeVisible();
  const defaultIcon = await svg(1).evaluate((node) => node.innerHTML);

  await expect(frame.locator('.sp-group[data-group="7"]')).toHaveAttribute("data-icon", "database");
  expect(await svg(7).evaluate((node) => node.innerHTML)).not.toBe(defaultIcon);
  await expect(svg(7).locator("path")).toHaveCount(3);
  await expect.poll(() => svg(9).evaluate((node) => node.innerHTML)).not.toBe(defaultIcon);
  await expect(svg(9).locator("path").first()).toHaveAttribute("d", /\S/);
  await expect.poll(() => svg(12).evaluate((node) => node.innerHTML)).toBe(defaultIcon);

  await expect(frame.locator('.sp-group[data-group="7"] .sp-panel-icon')).toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(frame.locator('.sp-group[data-group="1"] .sp-panel-icon')).not.toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(frame.locator(".sp-panel-icon svg :not(path, circle, ellipse, line, polyline, polygon, rect)")).toHaveCount(0);
});

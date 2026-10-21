import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mockUser, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";
import { expectPopupRulesUseTokens, expectPopupSectionColours } from "./helpers/popup-sections";

type Source = { device?: number; monitor?: number; service_check?: number };
type Item = { id: number; source: Source; display_name: string };
type StoredPage = { id: number; slug: string; name: string; visibility: "public" | "private"; items: Item[] };
type Update = {
  id: number; at: string; page_id: number | null; author: string | null; author_kind: string; is_public: boolean;
  status: string | null; message: string | null; event_code: string | null;
};
type Incident = {
  id: number; title: string; severity: string; status: string; source: string; opened_at: string; resolved_at: string | null;
  ticket: { url: string; label: string | null } | null; page_ids: number[]; hidden_page_ids?: number[];
  items: { page_id: number; source_key: string; display_name: string }[]; updates: Update[]; breaching: boolean;
};
type Notice = {
  id: number; page_id: number; owner_kind: "user" | "token"; owner_id: number; level: string; title: string; body: string | null;
  link: string | null; author: string | null; created_at: string; expires_at: string | null; mine: boolean; token_active: boolean | null;
};
type Window = {
  id: number; title: string; description: string | null; starts_at: string; ends_at: string; suppress_alerts: boolean;
  state: "upcoming" | "active" | "finished"; items: { source: Source; source_key: string }[]; page_ids: number[];
  created_by: string | null; created_by_token: string | null; created_at: string;
};
type Token = {
  id: number; name: string; prefix: string; page_ids: number[]; created_by: string | null; created_at: string;
  expires_at: string | null; revoked_at: string | null; last_used_at: string | null; active: boolean;
};

const NO_EXTRAS = { rtt_graph: false, uptime_period: null, avg_response: false, p95_response: false, failure_rate: false, last_check: false };
const SECRET = "nmst_AbCd1234_s3cr3tValueOnlyShownOnce";

function sourceKey(source: Source) {
  if (source.monitor) return `monitor:${source.monitor}`;
  if (source.service_check) return `service:${source.device}:${source.service_check}`;
  return `device:${source.device}`;
}

const iso = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

class ManageApi {
  pages: StoredPage[] = [
    { id: 1, slug: "ops", name: "Ops", visibility: "private", items: [
      { id: 11, source: { device: 1 }, display_name: "Core router" },
      { id: 12, source: { device: 2 }, display_name: "Office switch" },
    ] },
    { id: 2, slug: "customers", name: "Customers", visibility: "public", items: [
      { id: 21, source: { device: 1 }, display_name: "Internet" },
      { id: 22, source: { monitor: 5 }, display_name: "Portal" },
    ] },
  ];
  incidents: Incident[] = [];
  notices: Notice[] = [];
  windows: Window[] = [];
  tokens: Token[] = [];
  requests: { method: string; path: string; body: unknown }[] = [];
  nextId = 100;

  bodies(method: string, pattern: RegExp) {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path)).map((r) => r.body as Record<string, unknown>);
  }

  async install(page: Page) {
    await page.route("**/api/v1/status-pages**", (route) => this.handle(route));
  }

  private detail(p: StoredPage) {
    return {
      id: p.id, slug: p.slug, name: p.name, title: null, visibility: p.visibility, heartbeat_window: "1h", logo: null, accent: null,
      custom_css: null, created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z",
      groups: [{ id: p.id * 10, name: "Services", collapsed_by_default: false, items: p.items.map((item) => ({
        ...item, source_key: sourceKey(item.source), extras: NO_EXTRAS,
      })) }],
    };
  }

  private preview(p: StoredPage, audience: string) {
    const now = new Date();
    return {
      slug: p.slug, title: p.name, accent: null, logo: null, heartbeat_window: "1h", custom_css: null,
      generated_at: now.toISOString(), valid_until: new Date(now.getTime() + 30_000).toISOString(),
      summary: { state: "affected", label: "Some systems are affected", counts: { operational: 1, degraded: 1, down: 0, maintenance: 0, unknown: 0 } },
      notices: [], maintenance: [], past: [],
      incidents: this.incidents.filter((i) => i.page_ids.includes(p.id) && i.status !== "resolved").map((i) => ({
        id: i.id, title: i.title, severity: i.severity, status: i.status, opened_at: i.opened_at, resolved_at: null, ticket: null,
        updates: i.updates
          .filter((u) => (u.page_id === null || u.page_id === p.id) && (audience === "private" || u.is_public))
          .map((u) => ({ id: u.id, at: u.at, status: u.status, message: u.message, author: "Status team", internal: !u.is_public })),
      })),
      groups: [{ id: 1, name: "Services", state: "operational", collapsed: false, items: p.items.map((item) => ({
        id: item.id, name: item.display_name, state: "operational", availability: { percent: 1, label: "ok", coverage: 1 },
        heartbeats: Array.from({ length: 60 }, () => "healthy"), response: null, metrics: null, incident_ids: [],
      })) }],
    };
  }

  private async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1\/status-pages\/?/, "");
    const parts = path.split("/").filter(Boolean);
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    this.requests.push({ method, path, body });
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });

    if (parts.length === 0 && method === "GET") return json(this.pages.map((p) => { const { groups: _g, ...rest } = this.detail(p); return rest; }));
    if (parts[0] === "sources") return json({ devices: [], monitors: [] });

    if (parts[0] === "incidents") {
      if (parts.length === 1 && method === "GET") return json(this.incidents);
      if (parts.length === 1 && method === "POST") {
        const id = this.nextId++;
        const items = (body.items as Source[]).flatMap((source) => body.page_ids.flatMap((pid: number) => {
          const item = this.pages.find((p) => p.id === pid)!.items.find((i) => sourceKey(i.source) === sourceKey(source));
          return item ? [{ page_id: pid, source_key: sourceKey(source), display_name: item.display_name }] : [];
        }));
        const incident: Incident = {
          id, title: body.title, severity: body.severity, status: "investigating", source: "person", opened_at: iso(0), resolved_at: null,
          ticket: body.ticket ?? null, page_ids: body.page_ids, items, breaching: false,
          updates: [{ id: this.nextId++, at: iso(0), page_id: null, author: "Ada Admin", author_kind: "person", is_public: body.is_public, status: null, message: body.message, event_code: null }],
        };
        this.incidents.unshift(incident);
        return json(incident, 201);
      }
      const incident = this.incidents.find((i) => i.id === Number(parts[1]));
      if (!incident) return json({ detail: "Incident not found" }, 404);
      if (parts[2] === "pages" && parts[4] === "visibility" && method === "PUT") {
        const pid = Number(parts[3]);
        incident.hidden_page_ids = body.visible ? (incident.hidden_page_ids ?? []).filter(id => id !== pid) : [...(incident.hidden_page_ids ?? []), pid];
        return json(incident);
      }
      if (parts[2] === "updates") {
        if (body.status_change) incident.status = body.status_change;
        incident.updates.push({ id: this.nextId++, at: iso(0), page_id: body.page_id ?? null, author: "Ada Admin", author_kind: "person", is_public: body.is_public, status: body.status_change ?? null, message: body.message ?? null, event_code: null });
        return json(incident, 201);
      }
      if (parts[2] === "resolve") {
        if (incident.breaching && !body.reason) return json({ detail: "An affected system hasn't recovered yet. Give a reason to resolve this incident anyway." }, 422);
        incident.status = "resolved";
        incident.resolved_at = iso(0);
        return json(incident);
      }
      if (parts[2] === "publish") {
        incident.page_ids = [...incident.page_ids, ...body.page_ids];
        return json(incident);
      }
    }

    if (parts[0] === "notices" && method === "DELETE") {
      this.notices = this.notices.filter((n) => n.id !== Number(parts[1]));
      return route.fulfill({ status: 204, body: "" });
    }

    if (parts[0] === "maintenance") {
      if (parts.length === 1 && method === "GET") return json(this.windows);
      if (parts.length === 1 && method === "POST") {
        const window: Window = {
          id: this.nextId++, title: body.title, description: body.description ?? null, starts_at: body.starts_at, ends_at: body.ends_at,
          suppress_alerts: Boolean(body.suppress_alerts), state: "upcoming",
          items: body.items.map((source: Source) => ({ source, source_key: sourceKey(source) })), page_ids: body.page_ids ?? [1],
          created_by: "admin", created_by_token: null, created_at: iso(0),
        };
        this.windows.push(window);
        return json(window, 201);
      }
      const window = this.windows.find((w) => w.id === Number(parts[1]));
      if (!window) return json({ detail: "Not found" }, 404);
      if (method === "PATCH") {
        Object.assign(window, body);
        if (body.ends_at) window.state = "finished";
        return json(window);
      }
      if (method === "DELETE") {
        this.windows = this.windows.filter((w) => w !== window);
        return route.fulfill({ status: 204, body: "" });
      }
    }

    if (parts[0] === "tokens") {
      if (parts.length === 1 && method === "GET") return json(this.tokens);
      if (parts.length === 1 && method === "POST") {
        const token: Token = {
          id: this.nextId++, name: body.name, prefix: "nmst_AbCd1234", page_ids: body.page_ids, created_by: "admin", created_at: iso(0),
          expires_at: body.expires_at ?? null, revoked_at: null, last_used_at: null, active: true,
        };
        this.tokens.unshift(token);
        return json({ ...token, secret: SECRET, name_is_public: true }, 201);
      }
      if (method === "DELETE") {
        const token = this.tokens.find((t) => t.id === Number(parts[1]))!;
        token.revoked_at = iso(0);
        token.active = false;
        this.notices.forEach((n) => { if (n.owner_kind === "token" && n.owner_id === token.id) n.token_active = false; });
        return route.fulfill({ status: 204, body: "" });
      }
    }

    const target = this.pages.find((p) => p.id === Number(parts[0]));
    if (!target) return json({ detail: "Status page not found" }, 404);
    if (parts[1] === "notices") return json(this.notices.filter((n) => n.page_id === target.id));
    if (parts[1] === "notice" && method === "PUT") {
      let notice = this.notices.find((n) => n.page_id === target.id && n.mine);
      if (!notice) {
        notice = { id: this.nextId++, page_id: target.id, owner_kind: "user", owner_id: 1, author: "Ada Admin", created_at: iso(0), mine: true, token_active: null } as Notice;
        this.notices.push(notice);
      }
      Object.assign(notice, body);
      return json(notice);
    }
    if (parts[1] === "notice" && method === "DELETE") {
      this.notices = this.notices.filter((n) => !(n.page_id === target.id && n.mine));
      return route.fulfill({ status: 204, body: "" });
    }
    if (parts[1] === "preview") return json(this.preview(target, url.searchParams.get("audience") ?? "public"));
    if (method === "GET") return json(this.detail(target));
    return json({ detail: "Unexpected request" }, 405);
  }
}

function seedIncident(api: ManageApi, overrides: Partial<Incident> = {}): Incident {
  const incident: Incident = {
    id: 50, title: "Mail delays", severity: "partial", status: "investigating", source: "person", opened_at: iso(-30), resolved_at: null,
    ticket: null, page_ids: [1], items: [{ page_id: 1, source_key: "device:1", display_name: "Core router" }], breaching: false,
    updates: [{ id: 51, at: iso(-30), page_id: null, author: "Ada Admin", author_kind: "person", is_public: true, status: null, message: "We are looking into it.", event_code: null }],
    ...overrides,
  };
  api.incidents.push(incident);
  return incident;
}

async function openApp(page: Page, theme: "light" | "dark" = "light", permissions?: string[]) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, []);
  await setupMonitoringMocks(page, []);
  if (permissions) {
    await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ...mockUser, role: "NetworkAdmin", permissions } }));
  }
  await page.addInitScript((selected) => window.localStorage.setItem("netmap.theme", selected), theme);
}

async function openTab(page: Page, api: ManageApi, tab: string, options: { theme?: "light" | "dark"; permissions?: string[] } = {}) {
  await openApp(page, options.theme, options.permissions);
  await api.install(page);
  await page.goto("/monitoring");
  await page.getByRole("link", { name: "Status pages", exact: true }).click();
  await page.locator(".status-pages-table tbody tr", { hasText: "Ops" }).getByRole("button", { name: "Edit" }).click();
  await page.getByRole("tab", { name: tab }).click();
}

async function resolveToken(locator: Locator, token: string, property: "backgroundColor" | "color" = "backgroundColor") {
  return locator.evaluate((node, [name, prop]) => {
    const probe = document.createElement("div");
    node.appendChild(probe);
    probe.style[prop as "color"] = getComputedStyle(node).getPropertyValue(name).trim();
    const resolved = getComputedStyle(probe)[prop as "color"];
    probe.remove();
    return resolved;
  }, [token, property] as const);
}

const computed = (locator: Locator, property: "backgroundColor" | "color") =>
  locator.evaluate((node, prop) => getComputedStyle(node)[prop as "color"], property);

async function expectCanonicalTable(page: Page, tableClass: string) {
  await expect(page.locator(`.nm-table-wrap.mon-embedded-table > table.nm-table.${tableClass}`)).toBeVisible();
  const th = page.locator(`.${tableClass} thead th`).first();
  expect(await computed(th, "backgroundColor")).toBe(await resolveToken(th, "--nm-table-header-bg"));
  expect(await computed(th, "color")).toBe(await resolveToken(th, "--nm-table-header-text", "color"));
  await expect(th).toHaveCSS("text-transform", "uppercase");
  const cell = page.locator(`.${tableClass} tbody tr`).first().locator("td").first();
  await page.mouse.move(0, 0);
  expect(await computed(cell, "backgroundColor")).toBe(await resolveToken(cell, "--nm-table-row-bg"));
  await cell.hover();
  await expect.poll(() => computed(cell, "backgroundColor")).toBe(await resolveToken(cell, "--nm-row-hover"));
  expect(await cell.evaluate((node) => getComputedStyle(node).boxShadow)).toBe("rgba(29, 154, 176, 0.3) 3px 0px 0px 0px inset");
}

async function expectCanonicalPanel(panel: Locator) {
  await expect(panel).toHaveClass(/\bnm-app-panel\b/);
  expect(await computed(panel, "backgroundColor")).toBe(await resolveToken(panel, "--nm-modal-section"));
  const header = panel.locator(".nm-app-panel-header").first();
  expect(await computed(header, "backgroundColor")).toBe(await resolveToken(header, "--nm-modal-header"));
  await expect(header).toHaveCSS("min-height", "44px");
}

test("incident audience shows all pages before save", async ({ page }) => {
  const api = new ManageApi();
  await openTab(page, api, "Incidents");
  await page.getByRole("button", { name: "Open incident" }).click();
  const dialog = page.getByRole("dialog", { name: "Open incident" });
  await dialog.getByLabel("Title").fill("Internet outage");
  await dialog.getByLabel("Message").fill("Our upstream provider is down.");
  await expect(dialog.getByRole("checkbox", { name: "Ops" })).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Customers" }).check();
  await dialog.getByRole("checkbox", { name: /Core router/ }).check();

  const audience = dialog.locator(".status-incident-audience");
  await expect(audience).toContainText("Ops");
  await expect(audience).toContainText("Customers");
  await expect(audience.locator(".mon-analysis-row", { hasText: "Ops" })).toContainText("Core router");
  await expect(audience.locator(".mon-analysis-row", { hasText: "Customers" })).toContainText("Internet");
  await expect(audience.locator(".mon-analysis-row", { hasText: "Customers" })).toContainText("Public");

  await dialog.getByRole("button", { name: "Open incident" }).click();
  await expect(dialog).toHaveCount(0);
  const [created] = api.bodies("POST", /^incidents$/);
  expect(created).toMatchObject({ title: "Internet outage", page_ids: [1, 2], items: [{ device: 1 }], is_public: true });
  await expect(page.locator(".status-incidents-table tbody tr", { hasText: "Internet outage" })).toBeVisible();
});

test("internal update marked in private preview and absent in public preview", async ({ page }) => {
  const api = new ManageApi();
  seedIncident(api);
  await openTab(page, api, "Incidents");
  await page.locator(".status-incidents-table tbody tr", { hasText: "Mail delays" }).getByRole("button", { name: "View" }).click();
  const dialog = page.getByRole("dialog", { name: "Mail delays" });
  await expect(dialog.getByText("Visitors only ever see \"Status team\"", { exact: false })).toBeVisible();
  const internalToggle = dialog.getByRole("checkbox", { name: /Internal update/ });
  await expect(internalToggle).not.toBeChecked();
  await internalToggle.check();
  await dialog.getByLabel("Update message").fill("Root cause: expired relay certificate");
  await expect(dialog.getByLabel("Show on")).toHaveValue("1");
  await dialog.getByRole("button", { name: "Post update" }).click();
  await expect(dialog.locator(".status-incident-update", { hasText: "expired relay certificate" })).toContainText("Internal");
  const [posted] = api.bodies("POST", /^incidents\/50\/updates$/);
  expect(posted).toMatchObject({ is_public: false, page_id: 1, message: "Root cause: expired relay certificate" });
  await dialog.getByRole("button", { name: "Close" }).first().click();

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const frame = page.frameLocator(".status-editor-preview-frame iframe");
  await frame.getByText("Incident log").click();
  await expect(frame.getByText("We are looking into it.")).toBeVisible();
  await expect(frame.getByText("expired relay certificate", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Private", exact: true }).click();
  const internal = frame.locator("[data-internal='true']", { hasText: "expired relay certificate" });
  await expect(internal).toHaveCount(1);
  await frame.getByText("Incident log").click();
  await expect(internal).toBeVisible();
  await expect(internal.locator(".sp-update-internal")).toHaveText("Internal");
});

test("resolve while breaching requires reason", async ({ page }) => {
  const api = new ManageApi();
  seedIncident(api, { source: "netmap", breaching: true, updates: [
    { id: 51, at: iso(-30), page_id: 1, author: "NetMap", author_kind: "netmap", is_public: true, status: null, message: null, event_code: "opened" },
  ] });
  await openTab(page, api, "Incidents");
  await page.locator(".status-incidents-table tbody tr", { hasText: "Mail delays" }).getByRole("button", { name: "View" }).click();
  const dialog = page.getByRole("dialog", { name: "Mail delays" });
  await expect(dialog.locator(".nm-alert--warning")).toContainText("hasn't recovered yet");
  const reason = dialog.getByLabel("Reason for resolving");
  const resolve = dialog.getByRole("button", { name: "Resolve incident" });
  await expect(resolve).toBeDisabled();
  await reason.fill("Known ISP outage, tracked with the provider");
  await expect(resolve).toBeEnabled();
  await resolve.click();
  await expect(page.getByText("Incident resolved")).toBeVisible();
  expect(api.bodies("POST", /^incidents\/50\/resolve$/)).toEqual([{ reason: "Known ISP outage, tracked with the provider" }]);
});

test("publishing to another page is explicit and warns about earlier updates", async ({ page }) => {
  const api = new ManageApi();
  seedIncident(api);
  await openTab(page, api, "Incidents");
  await page.locator(".status-incidents-table tbody tr", { hasText: "Mail delays" }).getByRole("button", { name: "View" }).click();
  const dialog = page.getByRole("dialog", { name: "Mail delays" });
  await dialog.getByRole("combobox", { name: "Page", exact: true }).selectOption("2");
  await expect(dialog.locator(".nm-alert--warning", { hasText: "Earlier updates" })).toBeVisible();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect.poll(() => api.bodies("POST", /^incidents\/50\/publish$/)).toEqual([{ page_ids: [2] }]);
});

test("suppress alerts checkbox hidden without alert_write", async ({ page }) => {
  const api = new ManageApi();
  await openTab(page, api, "Maintenance", { permissions: ["status_page_manage"] });
  await page.getByRole("button", { name: "Schedule maintenance" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule maintenance" });
  await expect(dialog.getByLabel("Title")).toBeVisible();
  await expect(dialog.getByText(/Times are in your timezone/)).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /Suppress monitoring alerts/ })).toHaveCount(0);

  const admin = await page.context().newPage();
  await openTab(admin, api, "Maintenance");
  await admin.getByRole("button", { name: "Schedule maintenance" }).click();
  const adminDialog = admin.getByRole("dialog", { name: "Schedule maintenance" });
  await expect(adminDialog.getByRole("checkbox", { name: /Suppress monitoring alerts/ })).toBeVisible();
  await expect(adminDialog.getByText(/throughout NetMap/)).toBeVisible();
});

test("maintenance create sends local times with the browser offset", async ({ page }) => {
  const api = new ManageApi();
  await openTab(page, api, "Maintenance");
  await page.getByRole("button", { name: "Schedule maintenance" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule maintenance" });
  await dialog.getByLabel("Title").fill("Firmware upgrade");
  await dialog.getByLabel("Starts", { exact: true }).fill("2030-06-01T22:00");
  await dialog.getByLabel(/^Ends/).fill("2030-06-01T22:30");
  await dialog.getByRole("checkbox", { name: /Core router/ }).check();
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(dialog).toHaveCount(0);
  const [created] = api.bodies("POST", /^maintenance$/);
  expect(created.starts_at).toMatch(/^2030-06-01T22:00:00[+-]\d\d:\d\d$/);
  expect(new Date(created.starts_at as string).getTime()).toBe(new Date(2030, 5, 1, 22, 0).getTime());
  expect(created).toMatchObject({ title: "Firmware upgrade", items: [{ device: 1 }] });
  expect(created).not.toHaveProperty("page_ids");
  expect(created).not.toHaveProperty("suppress_alerts", true);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`maintenance create lists the resolved pages and the generic-line note in ${colorScheme}`, async ({ page }) => {
    const api = new ManageApi();
    await openTab(page, api, "Maintenance", { theme: colorScheme });
    await page.getByRole("button", { name: "Schedule maintenance" }).click();
    const dialog = page.getByRole("dialog", { name: "Schedule maintenance" });
    const resolved = dialog.locator(".status-maintenance-audience");
    await expect(resolved).toHaveText("Choose affected items to see which pages will announce this window.");
    await dialog.getByRole("checkbox", { name: /Office switch/ }).check();
    await expect(resolved).toHaveText("Announces on Ops. Saved as this list of pages; pages that add these items later aren't included.");
    await dialog.getByRole("checkbox", { name: /Core router/ }).check();
    await expect(resolved).toContainText("Announces on Ops, Customers.");
    await dialog.getByRole("radio", { name: "Only the pages I choose" }).check();
    await expect(resolved).toHaveCount(0);
    await dialog.getByRole("radio", { name: "Every page showing an affected item" }).check();

    const note = dialog.getByText("Pages showing these items that you don't announce on will show a generic 'Scheduled maintenance' line.");
    await expect(note).toHaveCount(0);
    await dialog.getByRole("checkbox", { name: /Suppress monitoring alerts/ }).check();
    await expect(note).toBeVisible();
    const look = (node: Locator) => node.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).fontSize]);
    expect(await look(resolved)).toEqual(await look(dialog.getByText(/Times are in your timezone/)));
    expect(await look(note)).toEqual(await look(dialog.getByText(/throughout NetMap/)));
    expect(await dialog.evaluate(() => document.body.classList.contains("theme-dark"))).toBe(colorScheme === "dark");
  });
}

test("maintenance PATCH sends only changed fields and End now sends ends_at", async ({ page }) => {
  const api = new ManageApi();
  api.windows.push(
    { id: 70, title: "Switch swap", description: null, starts_at: iso(120), ends_at: iso(180), suppress_alerts: false, state: "upcoming",
      items: [{ source: { device: 2 }, source_key: "device:2" }], page_ids: [1], created_by: "admin", created_by_token: null, created_at: iso(-60) },
    { id: 71, title: "Core reboot", description: null, starts_at: iso(-10), ends_at: iso(50), suppress_alerts: false, state: "active",
      items: [{ source: { device: 1 }, source_key: "device:1" }], page_ids: [1], created_by: "admin", created_by_token: null, created_at: iso(-60) },
  );
  await openTab(page, api, "Maintenance");
  await page.locator(".status-maintenance-table tbody tr", { hasText: "Switch swap" }).getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit maintenance" });
  await dialog.getByLabel("Title").fill("Access switch swap");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.bodies("PATCH", /^maintenance\/70$/)).toEqual([{ title: "Access switch swap" }]);

  await page.locator(".status-maintenance-table tbody tr", { hasText: "Core reboot" }).getByRole("button", { name: "Edit" }).click();
  const started = page.getByRole("dialog", { name: "Edit maintenance" });
  await expect(started.getByLabel("Starts", { exact: true })).toBeDisabled();
  await expect(started.getByRole("checkbox", { name: /Core router/ })).toBeDisabled();
  await expect(started.getByText(/has started/)).toBeVisible();
  await expect(started.getByRole("checkbox", { name: /Suppress monitoring alerts/ })).toBeDisabled();
  await expect(started.getByText("Alert suppression can't be changed after a window starts. End the window early instead.")).toBeVisible();
  await started.getByRole("button", { name: "Cancel" }).click();

  const before = Date.now();
  await page.locator(".status-maintenance-table tbody tr", { hasText: "Core reboot" }).getByRole("button", { name: "End now" }).click();
  await page.getByRole("dialog", { name: "End Core reboot now?" }).getByRole("button", { name: "End now" }).click();
  await expect.poll(() => api.bodies("PATCH", /^maintenance\/71$/).length).toBe(1);
  const [ended] = api.bodies("PATCH", /^maintenance\/71$/);
  expect(Object.keys(ended)).toEqual(["ends_at"]);
  expect(Math.abs(new Date(ended.ends_at as string).getTime() - before)).toBeLessThan(60_000);
});

test("token secret shown once and the name is flagged as public", async ({ page }) => {
  const api = new ManageApi();
  await openTab(page, api, "Tokens");
  await page.getByRole("button", { name: "Create token" }).click();
  const dialog = page.getByRole("dialog", { name: "Create integration token" });
  await expect(dialog.locator(".nm-alert")).toContainText("shown publicly");
  await dialog.getByLabel("Name").fill("backup-server");
  await expect(dialog.getByRole("checkbox", { name: "Ops" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create token" }).click();

  const callout = dialog.locator(".nm-alert.nm-alert--info");
  await expect(callout).toContainText(SECRET);
  await expect(callout).toContainText("won't be shown again");
  await expect(dialog.getByRole("button", { name: "Copy secret" })).toBeVisible();
  expect(api.bodies("POST", /^tokens$/)).toEqual([{ name: "backup-server", page_ids: [1] }]);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".status-tokens-table tbody tr", { hasText: "backup-server" })).toContainText("Active");
  await expect(page.getByText(SECRET)).toHaveCount(0);
});

test("revoking a token offers to clear its notices and notices from inactive tokens are flagged", async ({ page }) => {
  const api = new ManageApi();
  api.tokens.push({ id: 9, name: "backup-server", prefix: "nmst_Zz", page_ids: [1, 2], created_by: "admin", created_at: iso(-600), expires_at: null, revoked_at: null, last_used_at: iso(-5), active: true });
  api.notices.push(
    { id: 31, page_id: 1, owner_kind: "token", owner_id: 9, level: "warning", title: "Backups running", body: null, link: null, author: "backup-server", created_at: iso(-5), expires_at: null, mine: false, token_active: true },
    { id: 32, page_id: 2, owner_kind: "token", owner_id: 9, level: "info", title: "Backups finished", body: null, link: null, author: "backup-server", created_at: iso(-5), expires_at: null, mine: false, token_active: true },
  );
  await openTab(page, api, "Tokens");
  await page.locator(".status-tokens-table tbody tr", { hasText: "backup-server" }).getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog", { name: "Revoke backup-server?" }).getByRole("button", { name: "Revoke token" }).click();
  const offer = page.getByRole("dialog", { name: "Also clear this token's notices?" });
  await expect(offer).toContainText("2 notices");
  await expect(offer).toContainText("Ops");
  await expect(offer).toContainText("Customers");
  await offer.getByRole("button", { name: "Keep notices" }).click();
  await expect(page.locator(".status-tokens-table tbody tr", { hasText: "backup-server" })).toContainText("Revoked");
  expect(api.requests.filter((r) => r.method === "DELETE" && r.path.startsWith("notices/"))).toEqual([]);

  await page.getByRole("tab", { name: "Notices" }).click();
  const row = page.locator(".status-notices-table tbody tr", { hasText: "Backups running" });
  await expect(row.locator(".nm-status--disabled")).toHaveText("Token inactive");

  api.tokens[0].revoked_at = null;
  api.tokens[0].active = true;
  await page.getByRole("tab", { name: "Tokens" }).click();
  await page.locator(".status-tokens-table tbody tr", { hasText: "backup-server" }).getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog", { name: "Revoke backup-server?" }).getByRole("button", { name: "Revoke token" }).click();
  await page.getByRole("dialog", { name: "Also clear this token's notices?" }).getByRole("button", { name: "Clear notices" }).click();
  await expect.poll(() => api.requests.filter((r) => r.method === "DELETE" && r.path.startsWith("notices/")).map((r) => r.path).sort())
    .toEqual(["notices/31", "notices/32"]);
});

test("own notice saves level, link and expiry with the browser offset", async ({ page }) => {
  const api = new ManageApi();
  await openTab(page, api, "Notices");
  const form = page.locator(".status-notice-form");
  await form.getByLabel("Level").selectOption("critical");
  await form.getByLabel("Title").fill("Power work in the data centre");
  await form.getByLabel("Link").fill("https://status.example.com/power");
  await form.getByLabel("Expires").fill("2030-06-02T08:00");
  await form.getByRole("button", { name: "Save notice" }).click();
  await expect(page.getByText("Notice saved")).toBeVisible();
  const [saved] = api.bodies("PUT", /^1\/notice$/);
  expect(saved).toMatchObject({ level: "critical", title: "Power work in the data centre", link: "https://status.example.com/power" });
  expect(saved.expires_at).toMatch(/^2030-06-02T08:00:00[+-]\d\d:\d\d$/);
  await expect(page.locator(".status-notices-table tbody tr", { hasText: "Power work" })).toContainText("You");
});

test("own notice form stays locked until the page's notices load so edits are not overwritten", async ({ page }) => {
  const api = new ManageApi();
  api.notices.push({ id: 40, page_id: 1, owner_kind: "user", owner_id: 1, level: "warning", title: "Cabling work", body: null, link: null, author: "Ada Admin", created_at: iso(-5), expires_at: null, mine: true, token_active: null });
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await openApp(page);
  await api.install(page);
  await page.route("**/api/v1/status-pages/1/notices", async (route) => { await held; await route.fallback(); });
  await page.goto("/monitoring");
  await page.getByRole("link", { name: "Status pages", exact: true }).click();
  await page.locator(".status-pages-table tbody tr", { hasText: "Ops" }).getByRole("button", { name: "Edit" }).click();
  await page.getByRole("tab", { name: "Notices" }).click();
  const form = page.locator(".status-notice-form");
  await expect(form.getByLabel("Title")).toBeDisabled();
  await expect(form.getByLabel("Level")).toBeDisabled();
  await expect(form.getByRole("button", { name: "Save notice" })).toBeDisabled();
  release();
  await expect(form.getByLabel("Title")).toBeEnabled();
  await expect(form.getByLabel("Title")).toHaveValue("Cabling work");
  await expect(form.getByLabel("Level")).toHaveValue("warning");
});

test("own notice form offers a retry when the first notices request fails", async ({ page }) => {
  const api = new ManageApi();
  api.notices.push({ id: 40, page_id: 1, owner_kind: "user", owner_id: 1, level: "warning", title: "Cabling work", body: null, link: null, author: "Ada Admin", created_at: iso(-5), expires_at: null, mine: true, token_active: null });
  let attempts = 0;
  await openApp(page);
  await api.install(page);
  await page.route("**/api/v1/status-pages/1/notices", async (route) => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 500, json: { detail: "Database is busy" } });
    return route.fallback();
  });
  await page.goto("/monitoring");
  await page.getByRole("link", { name: "Status pages", exact: true }).click();
  await page.locator(".status-pages-table tbody tr", { hasText: "Ops" }).getByRole("button", { name: "Edit" }).click();
  await page.getByRole("tab", { name: "Notices" }).click();
  const form = page.locator(".status-notice-form");
  const alert = page.locator(".status-notices-panel .nm-alert--error");
  await expect(alert).toBeVisible();
  await expect(form.getByLabel("Title")).toBeDisabled();
  const retry = alert.getByRole("button", { name: "Try again" });
  await expect(retry).toHaveClass(/\bnm-btn\b/);
  await expect(retry).toHaveClass(/\bnm-btn--sm\b/);
  await expect(retry).toHaveClass(/\bnm-btn--secondary\b/);
  await retry.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(alert).toHaveCount(0);
  await expect(form.getByLabel("Title")).toBeEnabled();
  await expect(form.getByLabel("Title")).toHaveValue("Cabling work");
  await expect(form.getByLabel("Level")).toHaveValue("warning");
  await expect(form.getByRole("button", { name: "Save notice" })).toBeEnabled();
});

test("alert rule incident toggle defaults on for device offline and off for rtt", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, []);
  await page.route("**/api/v1/admin/settings", (route) => route.fulfill({ json: {
    app_name: "NetMap", login_message: "", announcement: "", support_email: "", support_url: "", live_ping_enabled: true,
    monitor_interval_seconds: 60, idle_timeout_minutes: 15, active_network_public_targets_enabled: false,
    ip_reservation_default_expiry_enabled: false, ip_reservation_reminder_enabled: false, ip_reservation_reminder_days: 3,
    ip_reservation_reminder_channels: [], backup_schedule_enabled: false, backup_schedule_interval_hours: 24, backup_retention_count: 7,
  } }));
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: {
    enabled: false, udp_enabled: false, tcp_enabled: false, tls_enabled: false, udp_port: 1514, tcp_port: 1514, tls_port: 6514,
    retention_days: 7, allowlist_enabled: false, total_events: 0, retention_last_run_at: null, retention_last_deleted: 0,
    retention_last_error: null, last_event_received_at: null, received_packets: 0, stored_events: 0, dropped_unparsed: 0, denied_senders: 0,
  } }));
  await page.route("**/api/v1/admin/notification-profiles", (route) => route.fulfill({ json: [
    { id: 4, name: "Ops email", enabled: true, config: { method: "email" }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
  ] }));
  const posted: Record<string, unknown>[] = [];
  await page.route("**/api/v1/alerts/rules", (route) => {
    if (route.request().method() === "POST") {
      posted.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { id: 1, ...route.request().postDataJSON() } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/admin");
  await page.getByRole("link", { name: "Alerts", exact: true }).click();
  await page.getByRole("button", { name: "+ Add rule" }).click();
  const incident = page.getByRole("checkbox", { name: /Open an incident on status pages/ });
  const checks = page.getByLabel("Consecutive breaching checks");
  await expect(incident).toBeChecked();
  await expect(checks).toHaveValue("3");
  await expect(checks).toHaveAttribute("min", "1");
  await expect(checks).toHaveAttribute("max", "20");

  const trigger = page.getByRole("combobox", { name: /^Trigger/ });
  await trigger.selectOption("rtt_above");
  await expect(incident).not.toBeChecked();
  await expect(incident).toBeEnabled();
  await trigger.selectOption("device_online");
  await expect(incident).not.toBeChecked();
  await expect(incident).toBeDisabled();
  await trigger.selectOption("monitor_down");
  await expect(incident).toBeChecked();

  await page.getByLabel("Rule name").fill("Portal down");
  await checks.fill("5");
  await page.getByRole("checkbox", { name: /Ops email/ }).check();
  await page.getByRole("button", { name: "Create rule" }).click();
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toMatchObject({ event_type: "monitor_down", open_incident: true, incident_min_failures: 5 });
});

for (const theme of ["light", "dark"] as const) {
  test(`incident popup sections match the device monitoring popup in ${theme} mode`, async ({ page }) => {
    const api = new ManageApi();
    seedIncident(api, { page_ids: [1] });
    await openTab(page, api, "Incidents", { theme });
    await page.locator(".status-incidents-table tbody tr", { hasText: "Mail delays" }).getByRole("button", { name: "View" }).click();
    const dialog = page.getByRole("dialog", { name: "Mail delays" });
    const sections = dialog.locator(".mon-hero-section");
    await expect(sections).toHaveCount(5);
    await expect(sections.locator("> .mon-hero-section-title")).toHaveText([/Shown on/i, /Timeline/i, /Post an update/i, /Resolve/i, /Publish to another page/i]);
    const section = sections.first();
    const title = section.locator(".mon-hero-section-title");
    const expected = theme === "dark"
      ? { section: await resolveToken(section, "--nm-modal-header"), title: await resolveToken(section, "--nm-modal-section") }
      : { section: "rgb(254, 254, 254)", title: await resolveToken(section, "--nm-surface") };
    expect(await computed(section, "backgroundColor")).toBe(expected.section);
    expect(await computed(title, "backgroundColor")).toBe(expected.title);
    await expect(title).toHaveCSS("text-transform", "uppercase");
    await expect(title).toHaveCSS("font-size", "11px");
    await expect(section).toHaveCSS("border-top-left-radius", "10px");
    await expect(dialog.locator(".nm-field-label")).toHaveCount(0);
    const rows = section.locator(".mon-analysis-row");
    await expect(rows).toHaveCount(1);
    await expectPopupSectionColours(sections.nth(1), theme);
    await expectPopupRulesUseTokens(page);
  });

  test(`management panels use canonical surfaces in ${theme} mode`, async ({ page }) => {
    const api = new ManageApi();
    seedIncident(api);
    api.notices.push({ id: 31, page_id: 1, owner_kind: "user", owner_id: 1, level: "info", title: "Heads up", body: null, link: null, author: "Ada Admin", created_at: iso(-5), expires_at: null, mine: true, token_active: null });
    api.windows.push({ id: 70, title: "Switch swap", description: null, starts_at: iso(120), ends_at: iso(180), suppress_alerts: false, state: "upcoming",
      items: [{ source: { device: 2 }, source_key: "device:2" }], page_ids: [1], created_by: "admin", created_by_token: null, created_at: iso(-60) });
    api.tokens.push({ id: 9, name: "backup-server", prefix: "nmst_Zz", page_ids: [1], created_by: "admin", created_at: iso(-600), expires_at: null, revoked_at: null, last_used_at: null, active: true });
    await openTab(page, api, "Incidents", { theme });
    await expectCanonicalPanel(page.locator(".status-incidents-panel"));
    await expectCanonicalTable(page, "status-incidents-table");
    await expect(page.locator(".status-incidents-table .nm-status").first()).toHaveClass(/nm-status--(online|offline|warning|unknown|paused|disabled)\b/);

    await page.getByRole("tab", { name: "Notices" }).click();
    await expectCanonicalPanel(page.locator(".status-notices-panel"));
    await expectCanonicalTable(page, "status-notices-table");
    const level = page.getByLabel("Level");
    await expect(level).toHaveClass(/\bnm-select\b/);
    await level.focus();
    await expect(level).toHaveCSS("outline-style", "solid");

    await page.getByRole("tab", { name: "Maintenance" }).click();
    await expectCanonicalPanel(page.locator(".status-maintenance-panel"));
    await expectCanonicalTable(page, "status-maintenance-table");

    await page.getByRole("tab", { name: "Tokens" }).click();
    await expectCanonicalPanel(page.locator(".status-tokens-panel"));
    await expectCanonicalTable(page, "status-tokens-table");
    await page.getByRole("button", { name: "Create token" }).click();
    const dialog = page.getByRole("dialog", { name: "Create integration token" });
    await dialog.getByLabel("Name").fill("monitor-bridge");
    await dialog.getByRole("button", { name: "Create token" }).click();
    const callout = dialog.locator(".nm-alert.nm-alert--info");
    await expect(callout).toHaveClass(/\btotp-key-note\b/);
    expect(await computed(callout, "backgroundColor")).toBe(await resolveToken(callout, "--nm-accent-soft"));
    const secret = callout.locator("code");
    expect(await computed(secret, "color")).toBe(await resolveToken(secret, "--nm-text", "color"));
    await expect(secret).toHaveCSS("font-family", /JetBrains Mono|monospace/);
  });
}


for (const theme of ["light", "dark"] as const) {
  test(`resolved incidents can leave and return to the board with history intact in ${theme}`, async ({ page }) => {
    const api = new ManageApi();
    api.incidents.push({ id: 90, title: "Resolved mail outage", severity: "partial", status: "resolved", source: "person",
      opened_at: iso(-60), resolved_at: iso(-10), ticket: null, page_ids: [1, 2], items: [], updates: [], breaching: false });
    await openTab(page, api, "Incidents", { theme });
    await page.getByRole("button", { name: "Remove from board", exact: true }).click();
    await expect(page.getByText("No incidents on this page.", { exact: true })).toBeVisible();
    expect(api.incidents[0].page_ids).toEqual([1, 2]);
    expect(api.incidents[0].hidden_page_ids).toEqual([1]);
    await page.screenshot({ path: test.info().outputPath(`board-removed-${theme}.png`), fullPage: true });
    await page.getByLabel("Show removed incidents").check();
    await expect(page.getByText("Removed from board", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Timeline");
    await page.getByRole("dialog").locator(".modal-close-btn").click();
    await page.getByRole("button", { name: "Restore to board", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove from board", exact: true })).toBeVisible();
    expect(api.incidents[0].hidden_page_ids).toEqual([]);
  });
}


test("failed board removal keeps the resolved incident and reports the failure", async ({ page }) => {
  const api = new ManageApi();
  api.incidents.push({ id: 90, title: "Retain after failure", severity: "partial", status: "resolved", source: "person",
    opened_at: iso(-60), resolved_at: iso(-10), ticket: null, page_ids: [1], items: [], updates: [], breaching: false });
  await openTab(page, api, "Incidents");
  await page.route("**/incidents/90/pages/1/visibility", route => route.fulfill({ status: 503, json: { detail: "Board temporarily unavailable" } }));
  await page.getByRole("button", { name: "Remove from board", exact: true }).click();
  await expect(page.getByText("Board temporarily unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove from board", exact: true })).toBeEnabled();
  expect(api.incidents[0].hidden_page_ids).toBeUndefined();
});

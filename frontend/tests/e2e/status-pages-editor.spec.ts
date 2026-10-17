import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mockUser, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

type Source = { device?: number; monitor?: number; service_check?: number };
type Extras = {
  rtt_graph: boolean; uptime_period: "24h" | "7d" | "30d" | null; avg_response: boolean;
  p95_response: boolean; failure_rate: boolean; last_check: boolean;
};
type Item = { id?: number | null; source: Source; display_name: string; extras?: Extras };
type Group = { id?: number | null; name: string; collapsed_by_default: boolean; items: Item[] };
type StoredPage = {
  id: number; slug: string; name: string; title: string | null; visibility: "public" | "private";
  heartbeat_window: "1h" | "24h"; logo: string | null; accent: string | null; custom_css: string | null;
  created_at: string; updated_at: string; groups: Group[];
};

const NO_EXTRAS: Extras = { rtt_graph: false, uptime_period: null, avg_response: false, p95_response: false, failure_rate: false, last_check: false };

const SOURCES = {
  devices: [
    {
      id: 1, name: "router-core-01", ip_address: "192.168.100.1",
      service_checks: [{ id: 7, label: "HTTPS", port: 443, check_type: "tcp", enabled: true, global: false }],
    },
    { id: 2, name: "switch-access-01", ip_address: "192.168.100.2", service_checks: [] },
    { id: 3, name: "fw-edge-01", ip_address: "192.168.100.3", service_checks: [] },
  ],
  monitors: [{ id: 5, name: "Customer portal", url: "https://portal.internal.example" }],
};

function sourceKey(source: Source) {
  if (source.monitor) return `monitor:${source.monitor}`;
  if (source.service_check) return `service:${source.device}:${source.service_check}`;
  return `device:${source.device}`;
}

function newPage(id: number, overrides: Partial<StoredPage> = {}): StoredPage {
  return {
    id, slug: `page-${id}`, name: `Page ${id}`, title: null, visibility: "public", heartbeat_window: "1h",
    logo: null, accent: null, custom_css: null, created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z",
    groups: [], ...overrides,
  };
}

function previewPayload(page: StoredPage) {
  const now = new Date();
  const beats = Array.from({ length: 60 }, () => "healthy");
  return {
    slug: page.slug, title: page.title || page.name, accent: page.accent, logo: page.logo,
    heartbeat_window: page.heartbeat_window, custom_css: page.custom_css,
    generated_at: now.toISOString(), valid_until: new Date(now.getTime() + 30_000).toISOString(),
    summary: { state: "operational", label: "All systems operational", counts: { operational: 1, degraded: 0, down: 0, maintenance: 0, unknown: 0 } },
    notices: [], incidents: [], maintenance: [], past: [],
    groups: page.groups.map((group, gi) => ({
      id: gi + 1, name: group.name, state: "operational", collapsed: group.collapsed_by_default,
      items: group.items.map((item, ii) => ({
        id: gi * 100 + ii + 1, name: item.display_name, state: "operational",
        availability: { percent: 1, label: "ok", coverage: 1 }, heartbeats: beats, response: null, metrics: null, incident_ids: [],
      })),
    })),
  };
}

class StatusPagesApi {
  pages: StoredPage[] = [];
  nextId = 1;
  nextItemId = 1000;
  layoutPuts: Group[][] = [];
  previewAudiences: string[] = [];

  seed(page: StoredPage) {
    this.pages.push(page);
    this.nextId = Math.max(this.nextId, page.id + 1);
    return page;
  }

  detail(page: StoredPage) {
    return {
      ...page,
      groups: page.groups.map((group, gi) => ({
        id: group.id ?? gi + 1, name: group.name, collapsed_by_default: group.collapsed_by_default,
        items: group.items.map((item) => ({
          id: item.id ?? this.nextItemId++, source: item.source, source_key: sourceKey(item.source),
          display_name: item.display_name, extras: item.extras ?? NO_EXTRAS,
        })),
      })),
    };
  }

  summary(page: StoredPage) {
    const { groups: _groups, ...rest } = page;
    return rest;
  }

  async install(page: Page) {
    await page.route("**/api/v1/status-pages**", (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.replace(/^\/api\/v1\/status-pages\/?/, "").split("/").filter(Boolean);
    const method = request.method();
    if (parts.length === 0) {
      if (method === "GET") return route.fulfill({ json: this.pages.map((p) => this.summary(p)) });
      if (method === "POST") {
        const body = request.postDataJSON();
        const created = this.seed(newPage(this.nextId, { ...body }));
        return route.fulfill({ status: 201, json: this.summary(created) });
      }
    }
    if (parts[0] === "sources") return route.fulfill({ json: SOURCES });
    const target = this.pages.find((p) => p.id === Number(parts[0]));
    if (!target) return route.fulfill({ status: 404, json: { detail: "Status page not found" } });
    if (parts[1] === "layout" && method === "PUT") {
      const body = request.postDataJSON() as { groups: Group[] };
      this.layoutPuts.push(body.groups);
      target.groups = body.groups.map((group, gi) => ({
        ...group, id: group.id ?? 500 + gi,
        items: group.items.map((item) => ({ ...item, id: item.id ?? this.nextItemId++ })),
      }));
      return route.fulfill({ json: this.detail(target) });
    }
    if (parts[1] === "preview") {
      this.previewAudiences.push(url.searchParams.get("audience") ?? "");
      return route.fulfill({ json: previewPayload(target) });
    }
    if (method === "GET") return route.fulfill({ json: this.detail(target) });
    if (method === "PATCH") {
      Object.assign(target, request.postDataJSON());
      return route.fulfill({ json: this.summary(target) });
    }
    if (method === "DELETE") {
      this.pages = this.pages.filter((p) => p !== target);
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 405, json: { detail: "Unexpected request" } });
  }
}

async function openApp(page: Page, theme: "light" | "dark" = "light") {
  await setupCoreMocks(page);
  await setupTopologyMocks(page, []);
  await setupMonitoringMocks(page, []);
  await page.addInitScript((selected) => window.localStorage.setItem("netmap.theme", selected), theme);
}

async function openStatusPages(page: Page) {
  await page.goto("/monitoring");
  await page.getByRole("link", { name: "Status pages", exact: true }).click();
  await expect(page.locator(".status-pages-window")).toBeVisible();
}

async function openEditor(page: Page, name: string) {
  await page.locator(".status-pages-table tbody tr", { hasText: name }).getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("tab", { name: "Settings" })).toBeVisible();
}

/** Resolves a `--nm-*` token in the context of the element that inherits it. */
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

const computed = (locator: Locator, property: "backgroundColor" | "color" | "boxShadow" | "textTransform") =>
  locator.evaluate((node, prop) => getComputedStyle(node)[prop as "color"], property);

test("status pages view appears only with permission", async ({ page }) => {
  const api = new StatusPagesApi();
  await openApp(page);
  await api.install(page);
  await openStatusPages(page);
  await expect(page.locator(".status-pages-window .nm-app-panel-header")).toContainText("Status pages");

  const viewer = await page.context().newPage();
  await setupCoreMocks(viewer);
  await setupTopologyMocks(viewer, []);
  await setupMonitoringMocks(viewer, []);
  await api.install(viewer);
  await viewer.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ...mockUser, role: "Viewer", permissions: ["tools_passive"] } }));
  await viewer.goto("/monitoring");
  await expect(viewer.getByRole("link", { name: "Devices", exact: true })).toBeVisible();
  await expect(viewer.getByRole("link", { name: "Endpoints", exact: true })).toBeVisible();
  await expect(viewer.getByRole("link", { name: "Status pages", exact: true })).toHaveCount(0);
  await viewer.evaluate(() => { window.location.hash = "status-pages"; });
  await expect(viewer).toHaveURL(/#status-pages$/);
  await expect(viewer.locator(".mon-view-window--devices")).toBeVisible();
  await expect(viewer.locator(".status-pages-window")).toHaveCount(0);
  await expect(viewer.getByRole("link", { name: "Devices", exact: true })).toHaveAttribute("aria-current", "page");
});

test("create page, add device with alias, save, preview shows alias not hostname", async ({ page }) => {
  const api = new StatusPagesApi();
  await openApp(page);
  await api.install(page);
  await openStatusPages(page);

  await page.getByRole("button", { name: "New status page" }).click();
  const dialog = page.getByRole("dialog", { name: "New status page" });
  await dialog.getByLabel("Name").fill("Customer status");
  await dialog.getByLabel("Slug").fill("customers");
  await dialog.getByRole("button", { name: "Create page" }).click();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  expect(api.pages[0]).toMatchObject({ name: "Customer status", slug: "customers" });

  await page.getByRole("tab", { name: "Layout" }).click();
  await page.getByRole("button", { name: "Add group" }).click();
  await page.getByLabel("Group name").fill("Core network");
  await page.getByRole("button", { name: "Add item to Core network" }).click();

  const picker = page.getByRole("dialog", { name: "Add item" });
  await expect(picker).toContainText("Visitors see only the display name");
  const routerRow = picker.locator("tr", { hasText: "router-core-01" }).first();
  await expect(routerRow).toContainText("Device #1");
  await expect(routerRow).toContainText("192.168.100.1");
  await routerRow.getByRole("button", { name: "Add" }).click();
  await expect(picker).toHaveCount(0);

  const displayName = page.getByLabel("Display name for router-core-01");
  await expect(displayName).toHaveValue("");
  await displayName.fill("Edge router");
  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByText("Layout saved")).toBeVisible();
  expect(api.layoutPuts).toHaveLength(1);
  expect(api.layoutPuts[0]).toEqual([
    { id: null, name: "Core network", collapsed_by_default: false, items: [{ id: null, source: { device: 1 }, display_name: "Edge router", extras: NO_EXTRAS }] },
  ]);

  await page.getByRole("tab", { name: "Preview" }).click();
  const frame = page.locator("iframe.status-page-frame");
  await expect(page.frameLocator("iframe.status-page-frame").locator(".sp-row-name")).toHaveText("Edge router");
  const doc = (await frame.getAttribute("srcdoc")) ?? "";
  expect(doc).not.toContain("router-core-01");
  expect(doc).not.toContain("192.168.100.1");
  expect(api.previewAudiences).toEqual(["public"]);

  await page.getByRole("button", { name: "Private", exact: true }).click();
  await expect(page.getByRole("button", { name: "Private", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => api.previewAudiences).toEqual(["public", "private"]);
});

test("cannot save item without display name", async ({ page }) => {
  const api = new StatusPagesApi();
  api.seed(newPage(1, { name: "Ops", slug: "ops", groups: [{ id: 1, name: "Services", collapsed_by_default: false, items: [] }] }));
  await openApp(page);
  await api.install(page);
  await openStatusPages(page);
  await openEditor(page, "Ops");
  await page.getByRole("tab", { name: "Layout" }).click();

  await page.getByRole("button", { name: "Add item to Services" }).click();
  await page.getByRole("dialog", { name: "Add item" }).locator("tr", { hasText: "Customer portal" }).getByRole("button", { name: "Add" }).click();

  const save = page.getByRole("button", { name: "Save layout" });
  const displayName = page.getByLabel("Display name for Customer portal");
  await expect(displayName).toHaveValue("");
  await expect(displayName).toHaveAttribute("aria-invalid", "true");
  await expect(save).toBeDisabled();
  await expect(page.getByText("Every item needs a display name before you can save.")).toBeVisible();

  await displayName.fill("   ");
  await expect(save).toBeDisabled();
  await displayName.fill("Portal");
  await expect(save).toBeEnabled();
  await displayName.fill("");
  await expect(save).toBeDisabled();
  expect(api.layoutPuts).toHaveLength(0);
});

test("drag reorders items and persists order", async ({ page }) => {
  const api = new StatusPagesApi();
  api.seed(newPage(1, {
    name: "Ops", slug: "ops",
    groups: [{
      id: 1, name: "Services", collapsed_by_default: false,
      items: [
        { id: 11, source: { device: 1 }, display_name: "Alpha" },
        { id: 12, source: { device: 2 }, display_name: "Bravo" },
        { id: 13, source: { device: 3 }, display_name: "Charlie" },
      ],
    }],
  }));
  await openApp(page);
  await api.install(page);
  await openStatusPages(page);
  await openEditor(page, "Ops");
  await page.getByRole("tab", { name: "Layout" }).click();

  const names = () => page.locator(".status-layout-item input[aria-label^='Display name']").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  await expect.poll(names).toEqual(["Alpha", "Bravo", "Charlie"]);

  const alphaRow = page.locator(".status-layout-item", { has: page.locator("input[value='Alpha']") });
  await page.getByRole("button", { name: "Drag Charlie to reorder" }).dragTo(alphaRow, { targetPosition: { x: 40, y: 4 } });
  await expect.poll(names).toEqual(["Charlie", "Alpha", "Bravo"]);

  await page.getByRole("button", { name: "Save layout" }).click();
  await expect(page.getByText("Layout saved")).toBeVisible();
  expect(api.layoutPuts.at(-1)?.[0].items.map((item) => item.id)).toEqual([13, 11, 12]);

  await page.reload();
  await page.getByRole("link", { name: "Status pages", exact: true }).click();
  await expect(page.locator(".status-pages-window")).toBeVisible();
  await openEditor(page, "Ops");
  await page.getByRole("tab", { name: "Layout" }).click();
  await expect.poll(names).toEqual(["Charlie", "Alpha", "Bravo"]);
});

for (const theme of ["light", "dark"] as const) {
  test(`editor uses canonical table and panel styles in light and dark (${theme})`, async ({ page }) => {
    const api = new StatusPagesApi();
    api.seed(newPage(1, {
      name: "Ops", slug: "ops",
      groups: [{ id: 1, name: "Services", collapsed_by_default: false, items: [{ id: 11, source: { device: 1 }, display_name: "Alpha" }] }],
    }));
    await openApp(page, theme);
    await api.install(page);
    await openStatusPages(page);
    await expect(page.locator("body.theme-dark")).toHaveCount(theme === "dark" ? 1 : 0);

    const panel = page.locator(".status-pages-window");
    await expect(panel).toHaveClass(/\bnm-app-panel\b/);
    expect(await computed(panel, "backgroundColor")).toBe(await resolveToken(panel, "--nm-modal-section"));
    const panelHeader = panel.locator(".nm-app-panel-header").first();
    expect(await computed(panelHeader, "backgroundColor")).toBe(await resolveToken(panelHeader, "--nm-modal-header"));

    // Layout rules only hold when the editor stylesheet loads after components.css.
    await expect(panelHeader).toHaveCSS("column-gap", "16px");
    await expect(page.locator(".status-pages-table-wrap")).toHaveCSS("border-top-width", "0px");

    await expect(page.locator(".nm-table-wrap > table.nm-table.status-pages-table")).toBeVisible();
    const th = page.locator(".status-pages-table thead th").first();
    await expect(th).toHaveCSS("position", "sticky");
    await expect(th).toHaveCSS("text-transform", "uppercase");
    await expect(th).toHaveCSS("font-size", "11px");
    await expect(th).toHaveCSS("font-weight", "700");
    expect(await computed(th, "backgroundColor")).toBe(await resolveToken(th, "--nm-table-header-bg"));
    expect(await computed(th, "color")).toBe(await resolveToken(th, "--nm-table-header-text", "color"));

    const row = page.locator(".status-pages-table tbody tr").first();
    const cell = row.locator("td").first();
    expect(await computed(cell, "backgroundColor")).toBe(await resolveToken(cell, "--nm-table-row-bg"));
    await row.hover();
    expect(await computed(cell, "boxShadow")).toContain("29, 154, 176");
    expect(await computed(cell, "backgroundColor")).toBe(await resolveToken(cell, "--nm-row-hover"));

    await openEditor(page, "Ops");
    const stage = page.locator(".status-editor .nm-workspace-stage");
    expect(await computed(stage, "backgroundColor")).toBe(await resolveToken(stage, "--nm-modal-shell"));
    const settings = page.locator(".status-editor-panel").first();
    await expect(settings).toHaveClass(/\bnm-app-panel\b/);
    expect(await computed(settings, "backgroundColor")).toBe(await resolveToken(settings, "--nm-modal-section"));
    const settingsHeader = settings.locator(".nm-app-panel-header");
    expect(await computed(settingsHeader, "backgroundColor")).toBe(await resolveToken(settingsHeader, "--nm-modal-header"));
    await expect(settingsHeader).toHaveCSS("min-height", "44px");
    await expect(page.locator(".status-editor-settings label.nm-field .nm-input").first()).toBeVisible();
    await expect(page.locator(".status-editor-settings .nm-file")).toBeVisible();
    await expect(page.locator(".status-editor-settings .nm-file strong")).toHaveCSS("text-transform", "none");

    await page.getByRole("tab", { name: "Layout" }).click();
    const layoutTh = page.locator(".status-layout-table thead th").first();
    await expect(page.locator(".nm-table-wrap > table.nm-table.status-layout-table")).toBeVisible();
    expect(await computed(layoutTh, "backgroundColor")).toBe(await resolveToken(layoutTh, "--nm-table-header-bg"));
    expect(await computed(layoutTh, "color")).toBe(await resolveToken(layoutTh, "--nm-table-header-text", "color"));
  });
}

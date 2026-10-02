import { expect, test, type Page } from "@playwright/test";
import { mockUser, setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const settings = {
  app_name: "NetMap",
  login_message: "",
  announcement: "",
  support_email: "help@example.com",
  support_url: "https://example.com/support",
  live_ping_enabled: true,
  monitor_interval_seconds: 120,
  idle_timeout_minutes: 15,
  active_network_public_targets_enabled: false,
  ip_reservation_default_expiry_enabled: true,
  ip_reservation_reminder_enabled: false,
  ip_reservation_reminder_days: 3,
  ip_reservation_reminder_channels: [],
  backup_schedule_enabled: false,
  backup_schedule_interval_hours: 24,
  backup_retention_count: 7,
};

const syslogStatus = {
  enabled: true,
  udp_enabled: true,
  tcp_enabled: true,
  tls_enabled: false,
  udp_port: 1514,
  tcp_port: 1514,
  tls_port: 6514,
  retention_days: 7,
  allowlist_enabled: false,
  total_events: 0,
  retention_last_run_at: null,
  retention_last_deleted: 0,
  retention_last_error: null,
  last_event_received_at: null,
  received_packets: 0,
  stored_events: 0,
  dropped_unparsed: 0,
  denied_senders: 0,
  last_packet_at: null,
  last_packet_sender: null,
  last_stored_at: null,
  last_stored_sender: null,
  last_drop_at: null,
  last_drop_sender: null,
  last_drop_raw: null,
  last_denied_at: null,
  last_denied_sender: null,
};

const oidcSettings = {
  enabled: false,
  issuer: "",
  client_id: "",
  client_secret_set: false,
  redirect_url: "",
  effective_redirect_url: "http://localhost:4173/api/v1/auth/oidc/callback",
  scopes: "openid profile email",
  allowed_email_domains: "",
  auto_provision: false,
  provider_name: "SSO",
  link_by_email: true,
  allow_unverified_email: false,
  group_claim: "groups",
  role_mappings: "{}",
  manage_roles: false,
  default_role: "Viewer",
  allow_super_admin: false,
  require_sso: false,
  env_configured: false,
};

const emailBranding = {
  email_brand_theme: "login_banner",
  email_brand_name: "",
  email_brand_accent: "#1d9ab0",
  email_brand_logo: "",
  email_brand_footer: "",
  email_brand_url: "",
  email_brand_show_support: true,
};

async function setupAdminMocks(page: Page) {
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page);

  await page.route("**/api/v1/auth/users", (route) =>
    route.fulfill({
      json: [{
        ...mockUser,
        display_name: "Network Administrator",
        avatar_data: null,
        auth_source: "local",
        entity_colors_enabled: true,
      }],
    }),
  );
  await page.route("**/api/v1/admin/settings", (route) => route.fulfill({ json: settings }));
  await page.route("**/api/v1/syslog/status", (route) => route.fulfill({ json: syslogStatus }));
  await page.route("**/api/v1/exports/scheduled-backups", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/admin/notification-profiles", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/admin/email-branding", (route) => route.fulfill({ json: emailBranding }));
  await page.route("**/api/v1/admin/email-branding/preview", (route) => {
    const body = route.request().postDataJSON() as typeof emailBranding;
    const name = body.email_brand_name || "NetMap";
    return route.fulfill({
      json: { html: `<!doctype html><html><body style="margin:0"><div class="preview-email" data-theme="${body.email_brand_theme}" style="height:700px">${name}</div></body></html>` },
    });
  });
  await page.route("**/api/v1/admin/device-types", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/topology/sites", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/admin/role-permissions", (route) =>
    route.fulfill({
      json: {
        permissions: [
          { key: "devices.read", label: "View devices", description: "View inventory and device details" },
          { key: "devices.write", label: "Manage devices", description: "Create and edit inventory records" },
        ],
        roles: {
          SuperAdmin: ["devices.read", "devices.write"],
          NetworkAdmin: ["devices.read", "devices.write"],
          SecurityAnalyst: ["devices.read"],
          Viewer: ["devices.read"],
        },
      },
    }),
  );
  await page.route("**/api/v1/tools/snmp/profiles", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/discovery/schedules", (route) => route.fulfill({ json: [{
    id: 11,
    owner_user_id: mockUser.id,
    name: "Core network",
    target: "192.168.1.0/24",
    scan_type: "ping",
    enabled: true,
    interval_minutes: 60,
    confirm_large_scan: false,
    topology_group_id: null,
    site_id: null,
    snmp_profile_id: null,
    snmp_targets: [],
    notification_targets: [],
    last_run_at: null,
    next_run_at: null,
    last_scan_id: null,
    last_status: null,
    last_error: null,
    open_observation_count: 0,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  }] }));
  await page.route("**/api/v1/discovery/observations*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/alerts/rules", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/alerts/deliveries*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/monitoring/service-checks", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/monitors", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/admin/oidc-settings", (route) => route.fulfill({ json: oidcSettings }));
  await page.route("**/api/v1/api-keys/admin/all", (route) => route.fulfill({ json: [{
    id: 7,
    name: "automation-agent",
    prefix: "AbCdEf123456",
    suffix: "7QpL",
    created_at: "2026-08-01T00:00:00Z",
    expires_at: null,
    last_used_at: null,
    last_used_ip: null,
    revoked_at: null,
    user_id: mockUser.id,
    username: mockUser.username,
  }] }));
  await page.route("**/api/v1/audit/logs*", (route) =>
    route.fulfill({ json: { total: 0, limit: 50, offset: 0, records: [] } }),
  );
}

const tabs = [
  ["System", "App settings", "system"],
  ["Devices & Icons", "Device types", "devices-icons"],
  ["Cloud providers", "Cloud providers", "cloud-providers"],
  ["Users", "Users", "users"],
  ["Groups", "Role Permissions", "groups"],
  ["SNMP Profiles", "SNMP profiles", "credentials"],
  ["Notifications", "Notification methods", "notifications"],
  ["Alerts", "Alert Rules", "alerts"],
  ["Automation", "Scheduled scans", "automation"],
  ["Security", "Single Sign-On (OIDC)", "security"],
] as const;

test("email branding uses the approved banner and saves only controlled fields", async ({ page }) => {
  await setupAdminMocks(page);
  let saved: typeof emailBranding | null = null;
  await page.route("**/api/v1/admin/email-branding", async (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON() as typeof emailBranding;
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ json: emailBranding });
  });

  await page.goto("/admin");
  await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Notifications", exact: true }).click();
  const panel = page.locator(".email-branding-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Template")).toHaveValue("login_banner");
  const preview = panel.frameLocator("iframe[title='Email branding preview']").locator(".preview-email");
  await expect(preview).toHaveAttribute("data-theme", "login_banner");

  await panel.getByLabel("Brand name").fill("Acme Networks");
  await panel.getByLabel("Installation URL").fill("https://netmap.example");
  await panel.getByLabel("Template").selectOption("clean_stripe");
  // The preview is re-rendered from the unsaved form, before anything is saved.
  await expect(preview).toHaveText("Acme Networks");
  await expect(preview).toHaveAttribute("data-theme", "clean_stripe");
  expect(saved).toBeNull();
  await panel.getByRole("button", { name: "Save email branding" }).click();

  await expect.poll(() => saved?.email_brand_name).toBe("Acme Networks");
  expect(saved).toEqual({
    ...emailBranding,
    email_brand_name: "Acme Networks",
    email_brand_url: "https://netmap.example",
    email_brand_theme: "clean_stripe",
  });
});

test("email branding reflows without horizontal overflow at the narrow breakpoint", async ({ page }) => {
  await setupAdminMocks(page);
  await page.addInitScript(() => window.localStorage.setItem("netmap.theme", "dark"));
  await page.goto("/admin");
  await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Notifications", exact: true }).click();
  await page.setViewportSize({ width: 480, height: 900 });

  const panel = page.locator(".email-branding-panel");
  await expect(panel).toBeVisible();
  const geometry = await panel.evaluate((node) => ({
    panelRight: node.getBoundingClientRect().right,
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.panelRight).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);
  await expect(panel.frameLocator("iframe[title='Email branding preview']").locator(".preview-email")).toBeVisible();
});

test("email branding upload is a standard button and the preview shows the whole email", async ({ page }) => {
  await setupAdminMocks(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin");
  await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Notifications", exact: true }).click();
  const panel = page.locator(".email-branding-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Message structure and security text")).toHaveCount(0);

  // The upload control must be the canonical button, not a form label restyled by `.tool-form label`.
  const upload = panel.getByRole("button", { name: "Upload logo" });
  const save = panel.getByRole("button", { name: "Save email branding" });
  await expect(upload).not.toHaveCSS("display", "grid");
  const [uploadBox, saveBox, iconBox] = await Promise.all([
    upload.boundingBox(),
    save.boundingBox(),
    upload.locator("svg").boundingBox(),
  ]);
  expect(uploadBox!.height).toBe(saveBox!.height);
  // Icon sits beside the text, not stacked above it.
  expect(iconBox!.y + iconBox!.height / 2).toBeCloseTo(uploadBox!.y + uploadBox!.height / 2, 0);
  for (const property of ["font-size", "font-weight"]) {
    expect(await upload.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), property))
      .toBe(await save.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), property));
  }

  // Checkbox sits beside its copy, matching Security's inline checks.
  const check = panel.locator(".tool-form-inline-check");
  await expect(check).toHaveCSS("display", "flex");
  const [boxBox, copyBox] = await Promise.all([
    check.locator("input[type='checkbox']").boundingBox(),
    check.locator(".tool-form-check-copy").boundingBox(),
  ]);
  expect(boxBox!.x + boxBox!.width).toBeLessThanOrEqual(copyBox!.x);
  expect(boxBox!.y).toBeLessThan(copyBox!.y + 12);

  // The preview never makes the panel taller than the form: it ends level with the save button,
  // shows the email at a readable 80%, and scrolls for the rest.
  const frame = panel.locator("iframe[title='Email branding preview']");
  await expect(frame).toBeVisible();
  const box = panel.locator(".email-branding-preview");
  const [boxRect, saveRect] = [(await box.boundingBox())!, (await save.boundingBox())!];
  expect(Math.abs(boxRect.y + boxRect.height - (saveRect.y + saveRect.height))).toBeLessThanOrEqual(1);
  await expect.poll(() => frame.evaluate((node: HTMLIFrameElement) => node.style.zoom)).toBe("0.8");
  const scroll = await box.evaluate((node) => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  await box.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const scrolled = await box.evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1);
  expect(scrolled).toBe(true);

  // The box is sized to the zoomed email plus its scrollbar: no empty margin beside it.
  await box.evaluate((node) => { node.scrollTop = 0; });
  const frameRect = (await frame.boundingBox())!;
  const fitted = (await box.boundingBox())!;
  const chrome = await box.evaluate((node) => node.offsetWidth - node.clientWidth);
  expect(frameRect.x + frameRect.width).toBeLessThanOrEqual(fitted.x + fitted.width - chrome + 2);
  expect(fitted.width - chrome - frameRect.width).toBeLessThanOrEqual(4);
});

test("every cloud provider can be removed, built-in or not", async ({ page }) => {
  // Built-ins used to be undeletable (422 from the API, no Remove button in the UI). They
  // are a convenience seed from migration 0068, not a fixed set, and that seed runs once —
  // so a deleted built-in stays deleted. An install using neither AWS nor Azure should not
  // be stuck with them in every provider picker.
  const providers = [
    { id: 1, key: "aws", name: "AWS", aliases: ["Amazon"], icon: "aws", icon_data: null, builtin: true },
    { id: 2, key: "oracle-cloud", name: "Oracle Cloud", aliases: [], icon: "custom", icon_data: null, builtin: false },
  ];
  const deleted: string[] = [];
  // After setupAdminMocks: it installs a `**/api/v1/**` catch-all, and Playwright matches
  // the most recently registered route first.
  await setupAdminMocks(page);
  await page.route("**/api/v1/admin/cloud-providers", (route) => route.fulfill({ json: providers }));
  await page.route("**/api/v1/admin/cloud-providers/*", (route) => {
    if (route.request().method() === "DELETE") {
      deleted.push(new URL(route.request().url()).pathname.split("/").pop() ?? "");
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ json: providers[0] });
  });

  await page.goto("/admin");
  await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Cloud providers", exact: true }).click();

  const rows = page.locator(".cloud-provider-row");
  await expect(rows).toHaveCount(2);
  // Every row offers Remove — not just the custom one.
  await expect(rows.getByRole("button", { name: "Remove" })).toHaveCount(2);

  await rows.filter({ hasText: "AWS" }).getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Remove provider" }).click();
  await expect.poll(() => deleted).toEqual(["aws"]);
});

test("keeps Users actions evenly spaced on one right-aligned row", async ({ page }) => {
  await setupAdminMocks(page);
  await page.goto("/admin");
  await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Users", exact: true }).click();

  const row = page.locator(".admin-users-table--accounts .admin-users-row").first();
  const buttons = row.locator(".admin-user-row-actions").getByRole("button");
  await expect(buttons).toHaveCount(4);

  const geometry = await row.evaluate((rowNode) => {
    const headingNode = rowNode.parentElement?.querySelector(".admin-users-actions-heading");
    const actionNode = rowNode.querySelector(".admin-user-row-actions");
    const buttonNodes = Array.from(actionNode?.querySelectorAll("button") ?? []);
    const rowRect = rowNode.getBoundingClientRect();
    const headingRect = headingNode?.getBoundingClientRect();
    const actionRect = actionNode?.getBoundingClientRect();
    const buttonRects = buttonNodes.map((button) => button.getBoundingClientRect());
    return {
      rowRight: rowRect.right,
      headingRight: headingRect?.right ?? 0,
      actionRight: actionRect?.right ?? 0,
      buttonTops: buttonRects.map((rect) => rect.top),
      buttonHeights: buttonRects.map((rect) => rect.height),
      gaps: buttonRects.slice(1).map((rect, index) => rect.left - buttonRects[index].right),
    };
  });

  expect(Math.abs(geometry.rowRight - geometry.actionRight - 12)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.headingRight - geometry.actionRight)).toBeLessThanOrEqual(1);
  expect(Math.max(...geometry.buttonTops) - Math.min(...geometry.buttonTops)).toBeLessThanOrEqual(1);
  expect(Math.max(...geometry.buttonHeights) - Math.min(...geometry.buttonHeights)).toBeLessThanOrEqual(1);
  for (const gap of geometry.gaps) expect(Math.abs(gap - 6)).toBeLessThanOrEqual(1);
});

for (const theme of ["light", "dark"] as const) {
  test(`focused text fields show a muted indicator, not a coloured glow (${theme})`, async ({ page }) => {
    // Inputs used to take the full accent border plus a 3px --nm-accent-soft halo, which
    // read as an illuminated box while typing. Both halves matter: the halo must be gone,
    // and a focus indicator must still exist — removing it outright is a WCAG 2.4.7 failure.
    await setupAdminMocks(page);
    await page.addInitScript((t) => window.localStorage.setItem("netmap.theme", t), theme);
    await page.goto("/admin");
    await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Cloud providers", exact: true }).click();

    const field = page.locator(".cloud-provider-create .nm-input").first();
    const other = page.locator(".cloud-provider-create .nm-input").nth(1);
    await field.focus();
    await page.mouse.move(5, 5); // hover has its own border colour; keep it out of the reading

    const read = (l: typeof field) => l.evaluate((n) => {
      const s = getComputedStyle(n);
      return { shadow: s.boxShadow, outlineStyle: s.outlineStyle, outlineColor: s.outlineColor };
    });
    const focused = await read(field);
    const resting = await read(other);

    // No coloured halo anywhere.
    expect(focused.shadow).toBe("none");
    // ...but the focused field is still distinguishable from an unfocused one.
    expect(focused.outlineStyle).not.toBe("none");
    expect(resting.outlineStyle).toBe("none");
    // ...and the indicator is the muted token, not the accent.
    const accent = await field.evaluate((n) => {
      const probe = document.createElement("div");
      n.parentElement!.appendChild(probe);
      probe.style.color = getComputedStyle(n).getPropertyValue("--nm-accent").trim();
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    });
    expect(focused.outlineColor).not.toBe(accent);
  });
}

test("shows every built-in role and the complete permission matrix", async ({ page }) => {
  await setupAdminMocks(page);
  await page.goto("/admin");
  await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Groups", exact: true }).click();
  const cards = page.locator(".rbac-role-card");
  await expect(cards).toHaveCount(4);
  await expect(cards.locator(".rbac-role-name")).toHaveText(["SuperAdmin", "Network Admin", "Security Analyst", "Viewer"]);
  const superAdmin = cards.filter({ hasText: "SuperAdmin" });
  await expect(superAdmin.locator('input[type="checkbox"]')).toHaveCount(2);
  for (const checkbox of await superAdmin.locator('input[type="checkbox"]').all()) {
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeDisabled();
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`all Admin tabs use the canonical panel hierarchy in ${theme} mode`, async ({ page }) => {
    await setupAdminMocks(page);
    await page.addInitScript((selectedTheme) => {
      window.localStorage.setItem("netmap.theme", selectedTheme);
    }, theme);
    await page.goto("/admin");

    const adminNav = page.getByLabel("Administration sections", { exact: true });
    const adminParent = page.getByRole("link", { name: "Admin", exact: true });
    // The chevron is its own control beside the link, not part of it: the link navigates,
    // the chevron opens and closes the menu.
    const adminToggle = page.getByRole("button", { name: /(Collapse|Expand) Admin sections/ });
    await expect(adminToggle.locator(".sidebar-parent-chevron")).toBeVisible();
    await expect(page.getByRole("button", { name: /(Collapse|Expand) Monitoring sections/ })).toBeVisible();
    await expect(adminToggle).toHaveAttribute("aria-expanded", "true");
    await expect(adminNav).toBeVisible();
    await expect(adminNav.getByRole("link")).toHaveCount(tabs.length);
    await expect(page.locator(".admin-live-console")).toHaveCount(0);
    await expect(page.locator(".admin-system-stats")).toHaveCount(0);
    await expect(page.locator(".admin-purpose-content")).toBeVisible();

    await adminToggle.click();
    await expect(adminToggle).toHaveAttribute("aria-expanded", "false");
    await expect(adminNav).toBeHidden();
    await adminToggle.click();
    await expect(adminToggle).toHaveAttribute("aria-expanded", "true");
    await expect(adminNav).toBeVisible();

    // The parent link drops the menu down rather than closing it.
    await adminParent.click();
    await expect(adminNav).toBeVisible();

    const headingStyles: Record<string, string> = {};
    for (const [tabName, heading, hash] of tabs) {
      const sectionLink = adminNav.getByRole("link", { name: tabName, exact: true });
      await sectionLink.click();
      await expect(sectionLink).toHaveAttribute("aria-current", "page");
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#${hash}`);
      // Two header patterns coexist while Admin migrates: the legacy `.admin-section-title`
      // copy block, and the canonical compact bar (`.admin-panel-title` + `.admin-panel-icon`)
      // that Devices & Icons and Cloud providers now use. Assert the intent — the header
      // names its section — not which class spells it.
      const headingEl = page.locator(".admin-section-title, .admin-panel-title").filter({ hasText: heading }).first();
      await expect(headingEl).toBeVisible();
      headingStyles[tabName] = await headingEl.evaluate((node) => {
        const s = getComputedStyle(node);
        return `${s.fontSize}/${s.fontWeight}`;
      });

      const panel = page.locator(".admin-tab-content .nm-app-panel").first();
      const header = panel.locator(":scope > .nm-app-panel-header").first();
      await expect(panel).toBeVisible();
      await expect(header).toBeVisible();
      await expect(panel).toHaveCSS("background-image", "none");
      await expect(header).toHaveCSS("background-image", "none");
      expect((await header.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      const headerBox = await header.boundingBox();
      const iconBox = await header.locator(".admin-section-title svg, .admin-panel-icon svg").first().boundingBox();
      expect(headerBox).not.toBeNull();
      expect(iconBox).not.toBeNull();
      if (headerBox && iconBox) {
        expect(iconBox.x - headerBox.x).toBeGreaterThanOrEqual(14);
      }

      if (tabName === "SNMP Profiles") {
        const form = panel.locator(".admin-create-form");
        await expect(form).toBeVisible();
        const usesCanonicalShell = await form.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.background = "var(--nm-modal-shell)";
          element.appendChild(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return getComputedStyle(element).backgroundColor === expected;
        });
        expect(usesCanonicalShell).toBe(true);
      }

      if (tabName === "Automation" || tabName === "Security") {
        const panels = page.locator(".admin-tab-content > .nm-app-panel");
        const panelCount = await panels.count();
        expect(panelCount).toBeGreaterThanOrEqual(2);
        for (let index = 1; index < panelCount; index += 1) {
          const previous = await panels.nth(index - 1).boundingBox();
          const current = await panels.nth(index).boundingBox();
          expect(previous).not.toBeNull();
          expect(current).not.toBeNull();
          if (previous && current) expect(current.y - (previous.y + previous.height)).toBeGreaterThanOrEqual(15);
        }
      }

      if (tabName === "Automation") {
        const formBox = await panel.locator(".admin-create-form").boundingBox();
        const library = panel.locator(".admin-schedule-library");
        const libraryBox = await library.boundingBox();
        expect(formBox).not.toBeNull();
        expect(libraryBox).not.toBeNull();
        if (formBox && libraryBox) {
          expect(libraryBox.x).toBeGreaterThan(formBox.x + formBox.width);
          expect(Math.abs(libraryBox.y - formBox.y)).toBeLessThanOrEqual(1);
        }
        await expect(library).toContainText("Created schedules");
        await expect(library).toContainText("Core network");
      }

      if (tabName === "Security") {
        const keyCell = page.locator(".admin-tab-content .nm-table tbody tr").filter({ hasText: "automation-agent" }).locator("td").nth(2);
        await expect(keyCell).toContainText("•••• •••• •••• 7QpL");
      }
    }

    await page.goBack();
    await expect(adminNav.getByRole("link", { name: "Automation", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".admin-section-title", { hasText: "Scheduled scans" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(adminNav).toBeHidden();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(adminNav).toBeVisible();
    // Every tab's section heading is the same size and weight. Admin used to mix a legacy
    // --nm-text-lg/750 heading with the canonical bar, which is what made the tabs read as
    // separate products bolted together.
    const distinct = new Set(Object.values(headingStyles));
    expect(distinct.size, `heading styles differ across tabs: ${JSON.stringify(headingStyles)}`).toBe(1);
  });

  test(`security tab saves the two-factor requirement in ${theme} mode`, async ({ page }) => {
    await setupAdminMocks(page);
    await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
    let saved: Record<string, unknown> | null = null;
    await page.route("**/api/v1/admin/settings", async (route) => {
      if (route.request().method() === "PUT") saved = route.request().postDataJSON();
      await route.fulfill({ json: { ...settings, totp_required: "off", ...saved } });
    });
    await page.goto("/admin");
    await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Security", exact: true }).click();
    const panel = page.locator(".admin-panel", { hasText: "Two-factor authentication" });
    await panel.getByLabel("Require two-factor authentication").selectOption("admins");
    await panel.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => saved?.totp_required).toBe("admins");
    expect(Object.keys(saved ?? {})).toEqual(["totp_required"]);
    await expect(panel).toContainText("Single sign-on sign-ins are not affected");
    const noteSize = await panel.getByText("Single sign-on sign-ins are not affected").evaluate((n) => getComputedStyle(n).fontSize);
    const siblingSize = await page.locator(".admin-panel", { hasText: "API Keys" }).locator(".auth-field-hint").first().evaluate((n) => getComputedStyle(n).fontSize);
    expect(noteSize).toBe(siblingSize);
  });

  test(`login history labels a failed 2FA code like other failed sign-ins in ${theme} mode`, async ({ page }) => {
    await setupAdminMocks(page);
    await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
    await page.route("**/api/v1/audit/logs*", (route) => route.fulfill({ json: { total: 2, limit: 50, offset: 0, records: [
      { id: 2, created_at: "2026-10-02T10:01:00Z", action: "auth.mfa_failed", actor_user_id: mockUser.id, target: `user:${mockUser.username}`, detail: "attempts=1 ip=10.0.0.9" },
      { id: 1, created_at: "2026-10-02T10:00:00Z", action: "auth.login_failed", actor_user_id: null, target: "user:bob", detail: "attempts=1 ip=10.0.0.2" },
    ] } }));
    await page.goto("/admin");
    await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Security", exact: true }).click();
    await page.getByRole("button", { name: "Login history", exact: true }).click();
    const mfa = page.locator(".audit-log-table--login .audit-log-row", { hasText: "10.0.0.9" }).locator(".notif-result");
    const failed = page.locator(".audit-log-table--login .audit-log-row", { hasText: "10.0.0.2" }).locator(".notif-result");
    await expect(mfa).toHaveText("Failed (2FA code)");
    const look = (node: Element) => {
      const s = getComputedStyle(node);
      return { className: node.className, color: s.color, background: s.backgroundColor, border: s.borderTopColor };
    };
    expect(await mfa.evaluate(look)).toEqual(await failed.evaluate(look));
  });

  test(`users list shows 2FA status and resets it after confirmation in ${theme} mode`, async ({ page }) => {
    await setupAdminMocks(page);
    await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
    await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [{ ...mockUser, id: 7, username: "bob", role: "Viewer", display_name: null, avatar_data: null, auth_source: "local", totp_enabled: true }] }));
    let reset = false;
    await page.route("**/api/v1/auth/users/7/totp", async (route) => { reset = route.request().method() === "DELETE"; await route.fulfill({ status: 204, body: "" }); });
    await page.goto("/admin");
    await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Users", exact: true }).click();
    const row = page.locator(".admin-users-row", { hasText: "bob" });
    const pill = row.getByText("2FA", { exact: true });
    await expect(pill).toBeVisible();
    const pillStyle = await pill.evaluate((node) => {
      const probe = document.createElement("span");
      node.parentElement!.appendChild(probe);
      probe.style.color = getComputedStyle(node).getPropertyValue("--nm-success").trim();
      const success = getComputedStyle(probe).color;
      probe.remove();
      return { color: getComputedStyle(node).color, success, display: getComputedStyle(node).display };
    });
    expect(pillStyle.color).toBe(pillStyle.success);
    expect(pillStyle.display).toBe("inline-flex");
    await row.getByRole("button", { name: "Reset 2FA" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reset 2FA" }).click();
    await expect.poll(() => reset).toBe(true);
    await expect(row.getByText("2FA", { exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Reset 2FA" })).toHaveCount(0);
  });

  test(`Reset 2FA fits the Users actions column without covering the status in ${theme} mode`, async ({ page }) => {
    await setupAdminMocks(page);
    await page.addInitScript((selectedTheme) => window.localStorage.setItem("netmap.theme", selectedTheme), theme);
    await page.route("**/api/v1/auth/users", (route) => route.fulfill({ json: [
      { ...mockUser, id: 7, username: "bob", role: "Viewer", display_name: null, avatar_data: null, auth_source: "oidc", totp_enabled: true },
      { ...mockUser, id: 8, username: "carol", role: "Viewer", display_name: null, avatar_data: null, auth_source: "local", totp_enabled: false },
    ] }));
    await page.goto("/admin");
    await page.getByLabel("Administration sections", { exact: true }).getByRole("link", { name: "Users", exact: true }).click();
    for (const name of ["bob", "carol"]) {
      const row = page.locator(".admin-users-row", { hasText: name });
      const geometry = await row.evaluate((rowNode) => {
        const status = rowNode.querySelector(".admin-status-pill")!.getBoundingClientRect();
        const actions = rowNode.querySelector(".admin-user-row-actions")!;
        const first = actions.querySelector("button")!.getBoundingClientRect();
        const heading = rowNode.parentElement!.querySelector(".admin-users-actions-heading")!.getBoundingClientRect();
        return { statusRight: status.right, firstLeft: first.left, actionsRight: actions.getBoundingClientRect().right, headingRight: heading.right };
      });
      expect(geometry.firstLeft).toBeGreaterThanOrEqual(geometry.statusRight + 6);
      expect(Math.abs(geometry.actionsRight - geometry.headingRight)).toBeLessThanOrEqual(1);
    }
    const bob = page.locator(".admin-users-row", { hasText: "bob" });
    const pillGap = await bob.evaluate((rowNode) => {
      const [sso, totp] = Array.from(rowNode.querySelectorAll(".admin-user-name .nm-pill")).map((n) => n.getBoundingClientRect());
      return totp.left - sso.right;
    });
    expect(pillGap).toBeGreaterThanOrEqual(4);
  });
}

test("API keys stay masked after creation and clearly warn about one-time display", async ({ page }) => {
  const storedKey = {
    id: 7,
    name: "automation-agent",
    prefix: "AbCdEf123456",
    suffix: "7QpL",
    created_at: "2026-08-01T00:00:00Z",
    expires_at: null,
    last_used_at: null,
    last_used_ip: null,
    revoked_at: null,
  };
  const plaintext = "nm_ZxYwVu987654_ThisIsTheOneTimeSecretValue1234567890123";

  await setupAdminMocks(page);
  await page.route("**/api/v1/api-keys", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        json: { ...storedKey, id: 8, name: "new-integration", suffix: plaintext.slice(-4), key: plaintext },
      });
    }
    return route.fulfill({ json: [storedKey] });
  });
  await page.goto("/profile");

  const storedRow = page.locator(".profile-api-panel .nm-table tbody tr").filter({ hasText: storedKey.name });
  await expect(storedRow).toContainText("•••• •••• •••• 7QpL");

  await page.getByRole("button", { name: "Create API key", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "Create API key" });
  await expect(createDialog).toContainText("shown once after creation");
  await createDialog.getByLabel("Name").fill("new-integration");
  await createDialog.getByRole("button", { name: "Create key" }).click();

  const createdDialog = page.getByRole("dialog", { name: "API key created" });
  await expect(createdDialog).toContainText("never be shown again");
  await expect(createdDialog.getByLabel("Your new API key")).toHaveValue(plaintext);
  await createdDialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog", { name: "API key created" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(plaintext);
});

test("system settings save never sends the two-factor requirement", async ({ page }) => {
  await setupAdminMocks(page);
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/v1/admin/settings", async (route) => {
    if (route.request().method() === "PUT") saved = route.request().postDataJSON();
    await route.fulfill({ json: { ...settings, totp_required: "all", ...saved } });
  });
  await page.goto("/admin");
  await expect(page.getByRole("button", { name: "Save settings" })).toBeEnabled();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => saved).not.toBeNull();
  expect(saved).not.toHaveProperty("totp_required");
});

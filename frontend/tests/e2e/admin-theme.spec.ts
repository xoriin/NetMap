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
  ["Users", "Users", "users"],
  ["Groups", "Role Permissions", "groups"],
  ["SNMP Profiles", "SNMP profiles", "credentials"],
  ["Notifications", "Notification methods", "notifications"],
  ["Alerts", "Alert Rules", "alerts"],
  ["Automation", "Scheduled scans", "automation"],
  ["Security", "Single Sign-On (OIDC)", "security"],
] as const;

for (const theme of ["light", "dark"] as const) {
  test(`all Admin tabs use the canonical panel hierarchy in ${theme} mode`, async ({ page }) => {
    await setupAdminMocks(page);
    await page.addInitScript((selectedTheme) => {
      window.localStorage.setItem("netmap.theme", selectedTheme);
    }, theme);
    await page.goto("/admin");

    const adminNav = page.getByLabel("Administration sections");
    const adminParent = page.getByRole("button", { name: "Admin", exact: true });
    await expect(adminParent.locator(".sidebar-parent-chevron")).toBeVisible();
    await expect(page.getByRole("button", { name: "Monitoring", exact: true }).locator(".sidebar-parent-chevron")).toBeVisible();
    await expect(adminParent).toHaveAttribute("aria-expanded", "true");
    await expect(adminNav).toBeVisible();
    await expect(adminNav.getByRole("button")).toHaveCount(tabs.length);
    await expect(page.locator(".admin-live-console")).toHaveCount(0);
    await expect(page.locator(".admin-system-stats")).toHaveCount(0);
    await expect(page.locator(".admin-purpose-content")).toBeVisible();

    await adminParent.click();
    await expect(adminParent).toHaveAttribute("aria-expanded", "false");
    await expect(adminNav).toBeHidden();
    await adminParent.click();
    await expect(adminParent).toHaveAttribute("aria-expanded", "true");
    await expect(adminNav).toBeVisible();

    for (const [tabName, heading, hash] of tabs) {
      const sectionLink = adminNav.getByRole("button", { name: tabName, exact: true });
      await sectionLink.click();
      await expect(sectionLink).toHaveAttribute("aria-current", "page");
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#${hash}`);
      await expect(page.locator(".admin-section-title", { hasText: heading }).first()).toBeVisible();

      const panel = page.locator(".admin-tab-content .nm-app-panel").first();
      const header = panel.locator(":scope > .nm-app-panel-header").first();
      await expect(panel).toBeVisible();
      await expect(header).toBeVisible();
      await expect(panel).toHaveCSS("background-image", "none");
      await expect(header).toHaveCSS("background-image", "none");
      expect((await header.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      const headerBox = await header.boundingBox();
      const iconBox = await header.locator(".admin-section-title svg").first().boundingBox();
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
        await expect(keyCell).toContainText("••••");
        await expect(keyCell).not.toContainText("AbCdEf123456");
      }
    }

    await page.goBack();
    await expect(adminNav.getByRole("button", { name: "Automation", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".admin-section-title", { hasText: "Scheduled scans" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(adminNav).toBeHidden();
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(adminNav).toBeVisible();
  });
}

test("API keys stay masked after creation and clearly warn about one-time display", async ({ page }) => {
  const storedKey = {
    id: 7,
    name: "automation-agent",
    prefix: "AbCdEf123456",
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
      return route.fulfill({ json: { ...storedKey, id: 8, name: "new-integration", key: plaintext } });
    }
    return route.fulfill({ json: [storedKey] });
  });
  await page.goto("/profile");

  const storedRow = page.locator(".profile-api-panel .nm-table tbody tr").filter({ hasText: storedKey.name });
  await expect(storedRow).toContainText("••••");
  await expect(storedRow).not.toContainText(storedKey.prefix);

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

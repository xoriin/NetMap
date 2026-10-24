import { expect, test, type Page } from "@playwright/test";
import type { VersionInfo } from "../../src/api/client";
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

async function versionMocks(page: Page, info: VersionInfo) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.route("**/api/v1/admin/settings", route => route.fulfill({ json: settings }));
  await page.route("**/api/v1/syslog/status", route => route.fulfill({ json: syslogStatus }));
  await page.route("**/api/v1/exports/scheduled-backups", route => route.fulfill({ json: [] }));
  await page.route("**/api/v1/admin/notification-profiles", route => route.fulfill({ json: [] }));
  await page.route("**/api/v1/admin/status-page-default-css", route => route.fulfill({ json: { css: null } }));
  await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { ...mockUser, whats_new_acknowledged_version: info.current } }));
  await page.route("**/api/v1/auth/users", route => route.fulfill({ json: [] }));
  await page.route("**/api/v1/admin/role-permissions", route => route.fulfill({ json: { permissions: [], roles: { SuperAdmin: [], Viewer: [] } } }));
  await page.route("**/api/v1/system/version", route => route.fulfill({ json: info }));
}

function versionInfo(state: "current" | "update" | "unavailable"): VersionInfo {
  return {
    current: "1.7.0", channel: state === "current" ? null : state === "update" ? "Test" : "Dev",
    latest: state === "unavailable" ? null : state === "current" ? "1.7.0" : "1.8.0",
    up_to_date: state === "current", release_url: "https://github.com/xoriin/netmap/releases/tag/v1.8.0",
    current_release_url: "https://github.com/xoriin/netmap/releases/tag/v1.7.0",
    whats_new: [{ version: "1.7.0", sections: [{ category: "Changed", items: ["Clearer administration panels."] }] }],
  };
}

for (const theme of ["light", "slate", "zinc"] as const) {
  for (const state of ["current", "update", "unavailable"] as const) {
    test(`Admin version summary is readable and responsive: ${theme}, ${state}`, async ({ page }) => {
      await page.addInitScript(value => {
        localStorage.setItem("netmap.theme", value === "light" ? "light" : "dark");
        localStorage.setItem("netmap.dark_style", value === "zinc" ? "zinc" : "slate");
      }, theme);
      const info = versionInfo(state);
      await versionMocks(page, info);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto("/admin#system");
      const card = page.locator(".admin-system-card").filter({ has: page.getByRole("heading", { name: "Version", exact: true }) });
      await expect(page.locator(".app-topbar-version")).toHaveCount(0);
      await expect(card.getByText("Installed", { exact: true })).toBeVisible();
      await expect(card.locator(".admin-version-now strong")).toHaveText(`${info.channel ? `${info.channel}: ` : "v"}${info.current}`);
      await expect(card.getByText("Latest", { exact: true })).toBeVisible();
      if (state === "update") {
        const link = card.getByRole("link", { name: "Update available" });
        await expect(link).toHaveAttribute("href", info.release_url);
        await expect(link).toHaveAttribute("rel", "noreferrer");
        await expect(card.locator(".admin-version-facts dd")).toHaveText("v1.8.0");
        await link.focus();
        await expect(link).toBeFocused();
        await link.hover();
      } else if (state === "current") {
        await expect(card.getByText("Up to date", { exact: true })).toBeVisible();
        await expect(card.locator(".admin-version-facts dd")).toHaveText("v1.7.0");
      } else {
        await expect(card.locator(".admin-version-facts dd")).toHaveText("unavailable");
      }
      const header = card.locator(".nm-app-panel-header");
      await expect(header).toHaveCSS("height", "44px");
      await expect(header.locator("svg")).toBeVisible();
      for (const width of [1600, 1000, 780, 390]) {
        await page.setViewportSize({ width, height: 950 });
        await card.scrollIntoViewIfNeeded();
        const geometry = await card.evaluate(node => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right, viewport: window.innerWidth, overflow: document.documentElement.scrollWidth - window.innerWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        await card.screenshot({ path: test.info().outputPath(`version-${theme}-${state}-${width}.png`) });
      }
      const whatsNew = card.getByRole("button", { name: "What's new" });
      await whatsNew.focus();
      await expect(whatsNew).toBeFocused();
      await whatsNew.press("Enter");
      await expect(page.getByRole("dialog", { name: "What's new in v1.7.0" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.goto("/overview");
      await expect(page.getByLabel("NetMap version")).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}

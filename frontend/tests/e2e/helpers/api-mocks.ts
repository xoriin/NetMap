import { type Page } from "@playwright/test";

export const mockUser = {
  id: 1,
  username: "admin",
  email: "admin@example.com",
  role: "SuperAdmin",
  is_active: true,
};

export const mockTokenPair = {
  access_token: "mock-access-token",
  token_type: "bearer",
};

export function mockDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    hostname: "router-01",
    ip_address: "192.168.1.1",
    status: "active",
    monitor_status: "online",
    lifecycle: "active",
    monitoring_paused: false,
    expected_status: "online",
    topology_group: "Ungrouped",
    color: null,
    icon: null,
    notes: "",
    site_id: null,
    is_favourite: false,
    tags: [],
    mac_address: null,
    vendor: null,
    device_type: null,
    os: null,
    description: null,
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function mockRelationship(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    source_device_id: 1,
    target_device_id: 2,
    relationship_type: "uplink",
    notes: "",
    allow_outbound: true,
    allow_inbound: true,
    ...overrides,
  };
}

// Sets up the auth bootstrap mocks so the app reaches the dashboard.
// Route order matters: register before page.goto().
export async function setupCoreMocks(page: Page, announcement: string | null = null) {
  await page.route("**/api/v1/admin/settings/public", (route) =>
    route.fulfill({
      json: { app_name: "NetMap", idle_timeout_minutes: 15, announcement },
    })
  );
  await page.route("**/api/v1/admin/public-settings", (route) =>
    route.fulfill({
      json: { app_name: "NetMap", idle_timeout_minutes: 15, announcement },
    })
  );
  await page.route("**/api/v1/setup/status", (route) =>
    route.fulfill({ json: { needs_setup: false } })
  );
  await page.route("**/api/v1/auth/setup-required", (route) =>
    route.fulfill({ json: { needs_setup: false } })
  );
  await page.route("**/api/v1/auth/oidc/status", (route) =>
    route.fulfill({ json: { enabled: false, provider_name: "SSO", require_sso: false } })
  );
  await page.route("**/api/v1/auth/refresh", (route) =>
    route.fulfill({ json: mockTokenPair })
  );
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({ json: mockUser })
  );
  await page.route("**/api/v1/system/version", (route) =>
    route.fulfill({ json: { version: "1.2.4", latest: "1.2.4", update_available: false } })
  );
  await page.route("**/api/v1/icon-packs", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/discovery/observations*", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/topology/devices/favourites", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/devices/favourites", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/dashboard/summary", (route) =>
    route.fulfill({ json: { device_count: 0, online_count: 0, offline_count: 0, subnet_count: 0 } })
  );
}

export async function setupTopologyMocks(
  page: Page,
  devices: ReturnType<typeof mockDevice>[] = [],
  relationships: ReturnType<typeof mockRelationship>[] = []
) {
  await page.route("**/api/v1/topology/graph", (route) =>
    route.fulfill({ json: { devices, relationships } })
  );
  await page.route("**/api/v1/topology/layouts*", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/topology/groups*", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/topology/sites*", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/tools/snmp/profiles", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/monitoring/devices", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/monitoring/devices?*", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/topology/live-statuses", (route) =>
    route.fulfill({ json: { statuses: [] } })
  );
  await page.route("**/api/v1/security/device-event-counts*", (route) =>
    route.fulfill({ json: [] })
  );
}

export async function setupInventoryMocks(
  page: Page,
  devices: ReturnType<typeof mockDevice>[] = []
) {
  await page.route("**/api/v1/devices*", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({ json: { devices, total: devices.length } });
    } else {
      route.continue();
    }
  });
  await page.route("**/api/v1/topology/groups*", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/sites*", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route(/\/api\/v1\/monitoring\/devices\/\d+$/, (route) => {
    const deviceId = Number(route.request().url().split("/").pop());
    const device = devices.find((row) => row.id === deviceId) ?? devices[0];
    const status = device?.monitor_status ?? device?.status ?? "unknown";
    const expectedStatus = device?.expected_status ?? "online";
    route.fulfill({
      json: mockMonitoringDevice({
        device_id: deviceId,
        display_name: device?.display_name ?? null,
        hostname: device?.hostname ?? null,
        ip_address: device?.ip_address ?? "0.0.0.0",
        status,
        expected_status: expectedStatus,
        health_status: status === "online" || status === "offline"
          ? status === expectedStatus ? "healthy" : "unhealthy"
          : "unknown",
        avg_rtt_24h: 20.1,
        rtt_sparkline: [16.8, 18.6],
      }),
    });
  });
}

export function mockMonitoringDevice(overrides: Record<string, unknown> = {}) {
  return {
    device_id: 1,
    display_name: "Core Router",
    hostname: "router-01",
    ip_address: "192.168.1.1",
    device_type: "router",
    icon: "router",
    status: "online",
    lifecycle: "active",
    monitoring_paused: false,
    expected_status: "online",
    health_status: "healthy",
    topology_group: "Core",
    site_id: null,
    site_name: null,
    vlan_id: null,
    last_checked: "2026-06-14T00:00:00Z",
    uptime_24h: 1,
    uptime_7d: 0.998,
    compliance_24h: 1,
    compliance_7d: 0.998,
    avg_rtt_24h: 2.4,
    latest_port_results: [
      { target_id: 1, port: 443, label: "https", check_type: "tcp", open: true, status: "open" },
    ],
    heartbeat: Array.from({ length: 48 }, (_, i) => (i % 12 === 0 ? "warning" : "online")),
    heartbeat_health: Array.from({ length: 48 }, (_, i) => (i % 12 === 0 ? "unknown" : "healthy")),
    rtt_sparkline: Array.from({ length: 36 }, (_, i) => 2 + Math.sin(i / 4) * 0.4),
    is_favourite: false,
    ...overrides,
  };
}

export async function setupMonitoringMocks(
  page: Page,
  devices: ReturnType<typeof mockMonitoringDevice>[] = [mockMonitoringDevice()]
) {
  await page.route("**/api/v1/monitoring/summary", (route) =>
    route.fulfill({
      json: {
        total: devices.length,
        online: devices.filter((d) => d.status === "online").length,
        offline: devices.filter((d) => d.status === "offline").length,
        unknown: devices.filter((d) => d.status === "unknown").length,
        paused: devices.filter((d) => d.health_status === "paused").length,
        healthy: devices.filter((d) => d.health_status === "healthy").length,
        unhealthy: devices.filter((d) => d.health_status === "unhealthy").length,
        avg_rtt_ms: 2.4,
        last_checked: "2026-06-14T00:00:00Z",
      },
    })
  );
  await page.route("**/api/v1/monitoring/devices", (route) =>
    route.fulfill({ json: devices })
  );
  await page.route("**/api/v1/monitoring/devices?*", (route) =>
    route.fulfill({ json: devices })
  );
  await page.route("**/api/v1/monitoring/service-checks", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/monitors", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/monitoring/devices/*/history?*", (route) =>
    route.fulfill({ json: [] })
  );
  await page.route("**/api/v1/monitoring/devices/*/analysis", (route) =>
    route.fulfill({
      json: {
        device_id: 1,
        baseline_rtt_ms: null,
        rtt_stddev: null,
        rtt_p50: null,
        rtt_p95: null,
        current_rtt_ms: null,
        anomaly_score: null,
        anomaly_level: "insufficient_data",
        trend: "insufficient_data",
        trend_pct: null,
        flap_count_24h: 0,
        longest_outage_minutes: null,
      },
    })
  );
}

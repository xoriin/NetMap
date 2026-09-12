import { type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./api-mocks";

/**
 * Shared fixtures for the flat External IP address register.
 *
 * The page is one `nm-table` of addresses with a Group-by lens over it, so these
 * mocks model exactly that: a mutable in-memory register that answers
 * GET/POST/PATCH/DELETE on `/ipam/external/addresses`, plus the locations and
 * accounts the Location picker offers. Expansion of a CIDR or a start–end range
 * mirrors `services/external_addresses.py` closely enough for the browser tests
 * to observe real row counts rather than a canned list.
 */

export const AWS = { id: 1, key: "aws", name: "AWS", aliases: [], icon: "aws", icon_data: null, builtin: true };
export const AZURE = { id: 2, key: "azure", name: "Azure", aliases: [], icon: "azure", icon_data: null, builtin: true };

export const MAX_ADDRESSES_PER_ADD = 256;

export type MockLocation = { id: number; account_id: number | null; name: string; region: string | null };
export type MockAccount = { id: number; provider_id: number | null; name: string };

export type MockAddress = {
  id: number;
  ip_address: string;
  location_id: number | null;
  device_id: number | null;
  device: Record<string, unknown> | null;
  status: "in_use" | "reserved" | "available";
  label: string | null;
  url: string | null;
  owner: string | null;
  tags: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export function mockAddress(overrides: Partial<MockAddress> = {}): MockAddress {
  return {
    id: 1,
    ip_address: "203.0.113.10",
    location_id: null,
    device_id: null,
    device: null,
    status: "in_use",
    label: null,
    url: null,
    owner: null,
    tags: null,
    notes: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

// ── Address expansion (IPv4 only; that is all the specs use) ─────────────────

function parseIpv4(text: string): number | null {
  const parts = text.trim().split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function formatIpv4(value: number) {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

/** Returns the addresses a single `ip_address` input expands to, or an error string. */
export function expandInput(raw: string): { addresses: string[] } | { error: string } {
  const text = raw.trim();
  const dash = text.indexOf("-");
  if (dash !== -1) {
    const start = parseIpv4(text.slice(0, dash));
    const end = parseIpv4(text.slice(dash + 1));
    if (start === null || end === null) return { error: "Enter a valid address, CIDR or range" };
    if (end < start) return { error: "End address must not be before the start address" };
    return materialise(start, end);
  }
  const slash = text.indexOf("/");
  const base = parseIpv4(slash === -1 ? text : text.slice(0, slash));
  if (base === null) return { error: "Enter a valid address, CIDR or range" };
  if (slash === -1) return { addresses: [formatIpv4(base)] };
  const prefix = Number(text.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return { error: "Enter a valid CIDR prefix" };
  const size = 2 ** (32 - prefix);
  const network = Math.floor(base / size) * size;
  // /31 and /32 have no network/broadcast to drop.
  const first = prefix <= 30 ? network + 1 : network;
  const last = prefix <= 30 ? network + size - 2 : network + size - 1;
  return materialise(first, last);
}

function materialise(first: number, last: number): { addresses: string[] } | { error: string } {
  const count = last - first + 1;
  if (count > MAX_ADDRESSES_PER_ADD) {
    return { error: `${count.toLocaleString("en-US")} addresses is over the ${MAX_ADDRESSES_PER_ADD} limit for one add` };
  }
  const out: string[] = [];
  for (let value = first; value <= last; value += 1) out.push(formatIpv4(value));
  return { addresses: out };
}

// ── The mock register ────────────────────────────────────────────────────────

export type ExternalState = {
  addresses: MockAddress[];
  locations: MockLocation[];
  accounts: MockAccount[];
  /** Every POST body the page sent to `/ipam/external/addresses`. */
  addressPosts: Record<string, unknown>[];
  /** Every PATCH body, keyed in arrival order, as `[id, body]`. */
  addressPatches: [number, Record<string, unknown>][];
  locationPosts: Record<string, unknown>[];
  accountPosts: Record<string, unknown>[];
  migrationDismissed: boolean;
};

export type ExternalOptions = {
  theme?: "light" | "dark";
  addresses?: MockAddress[];
  locations?: MockLocation[];
  accounts?: MockAccount[];
  providers?: Record<string, unknown>[];
  migration?: { migrated: number; declined: { cidr: string; location: string; kept: number }[] } | null;
  devices?: Record<string, unknown>[];
  /** Extra routes registered last, so they win over the defaults. */
  beforeGoto?: (page: Page) => Promise<void>;
};

/**
 * Registers every route the External IPs page reads, seeds the theme, and lands
 * on `/ipam#external`. Returns the live state so a test can assert on what the
 * page actually sent.
 */
export async function setupExternalIps(page: Page, options: ExternalOptions = {}): Promise<ExternalState> {
  const state: ExternalState = {
    addresses: (options.addresses ?? []).map((address) => ({ ...address })),
    locations: (options.locations ?? []).map((location) => ({ ...location })),
    accounts: (options.accounts ?? []).map((account) => ({ ...account })),
    addressPosts: [],
    addressPatches: [],
    locationPosts: [],
    accountPosts: [],
    migrationDismissed: false,
  };
  let nextId = 5000;
  const stamp = "2026-09-10T00:00:00Z";

  await setupCoreMocks(page);
  await setupTopologyMocks(page, options.devices as never[] ?? []);

  // Internal IPAM: present but empty. The External page shares the workspace shell.
  await page.route("**/api/v1/ipam/summary", (route) => route.fulfill({
    json: { subnet_count: 0, total_hosts: 0, used: 0, free: 0, utilization: 0, conflict_count: 0, dhcp_lease_count: 0, reservation_count: 0 },
  }));
  await page.route("**/api/v1/ipam/subnets", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/ipam/conflicts", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/ipam/dhcp-leases", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/ipam/reservations", (route) => route.fulfill({ json: [] }));

  await page.route("**/api/v1/monitoring/summary", (route) => route.fulfill({
    json: { total: 0, online: 0, offline: 0, unknown: 0, paused: 0, healthy: 0, unhealthy: 0, avg_rtt_ms: null, last_checked: null },
  }));

  await page.route("**/api/v1/admin/cloud-providers", (route) =>
    route.fulfill({ json: options.providers ?? [AWS, AZURE] }));

  await page.route("**/api/v1/ipam/external/summary", (route) => route.fulfill({
    json: {
      pool_count: 0,
      total: state.addresses.length,
      in_use: state.addresses.filter((address) => address.status === "in_use").length,
      reserved: state.addresses.filter((address) => address.status === "reserved").length,
      free: state.addresses.filter((address) => address.status === "available").length,
      asset_count: 0,
      unassigned_address_count: 0,
    },
  }));

  await page.route("**/api/v1/ipam/external/migration-report", (route) => {
    if (route.request().method() === "DELETE") {
      state.migrationDismissed = true;
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ json: options.migration ?? null });
  });

  // Accounts: list + create.
  await page.route("**/api/v1/ipam/external/accounts", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: state.accounts });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.accountPosts.push(body);
    const created: MockAccount = {
      id: (nextId += 1),
      provider_id: (body.provider_id as number | null) ?? null,
      name: (body.name as string) ?? "",
    };
    state.accounts.push(created);
    return route.fulfill({ json: created });
  });

  // Locations: list + create. `/locations/:id` is registered after so it wins.
  await page.route("**/api/v1/ipam/external/locations", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: state.locations });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.locationPosts.push(body);
    const created: MockLocation = {
      id: (nextId += 1),
      account_id: (body.account_id as number | null) ?? null,
      name: (body.name as string) ?? "",
      region: (body.region as string | null) ?? null,
    };
    state.locations.push(created);
    return route.fulfill({ json: created });
  });

  await page.route("**/api/v1/ipam/external/locations/*", async (route) => {
    const id = Number(route.request().url().split("/").pop());
    if (route.request().method() === "DELETE") {
      state.locations = state.locations.filter((location) => location.id !== id);
      return route.fulfill({ status: 204, body: "" });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.locations = state.locations.map((location) =>
      location.id === id ? { ...location, ...body, id } as MockLocation : location);
    return route.fulfill({ json: state.locations.find((location) => location.id === id) });
  });

  // The flat register: list + bulk create.
  await page.route("**/api/v1/ipam/external/addresses", async (route) => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: state.addresses });
    if (method !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.addressPosts.push(body);
    const expanded = expandInput(String(body.ip_address ?? ""));
    if ("error" in expanded) {
      return route.fulfill({ status: 400, json: { detail: expanded.error } });
    }
    const created = expanded.addresses.map((ip) => mockAddress({
      ...body,
      id: (nextId += 1),
      ip_address: ip,
      created_at: stamp,
      updated_at: stamp,
      device: null,
    } as Partial<MockAddress>));
    state.addresses.push(...created);
    return route.fulfill({ json: created });
  });

  await page.route("**/api/v1/ipam/external/addresses?*", (route) => route.fulfill({ json: state.addresses }));

  await page.route("**/api/v1/ipam/external/addresses/*", async (route) => {
    const id = Number(route.request().url().split("/").pop());
    if (route.request().method() === "DELETE") {
      state.addresses = state.addresses.filter((address) => address.id !== id);
      return route.fulfill({ status: 204, body: "" });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.addressPatches.push([id, body]);
    state.addresses = state.addresses.map((address) =>
      address.id === id ? { ...address, ...body, updated_at: stamp } as MockAddress : address);
    return route.fulfill({ json: state.addresses.find((address) => address.id === id) });
  });

  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("netmap.theme", selectedTheme);
  }, options.theme ?? "dark");

  await options.beforeGoto?.(page);
  await page.goto("/ipam");
  await page.locator(".ipam-workspace").waitFor({ state: "visible", timeout: 10000 });
  await openExternalIps(page);
  return state;
}

/**
 * External IPs is an IPAM sub-view reached through the sidebar sub-nav. Using the
 * real nav also exercises the sub-view routing, and `page.goto("/ipam#external")`
 * does not work: the fragment is not preserved through the preview server's SPA
 * fallback, so the workspace boots on Internal networks.
 */
export async function openExternalIps(page: Page) {
  const link = page.getByRole("link", { name: "External IPs" });
  if (!await link.isVisible().catch(() => false)) {
    await page.getByRole("link", { name: "IPAM", exact: true }).click();
  }
  await link.click();
  await page.locator(".external-ip-panel").waitFor({ state: "visible", timeout: 10000 });
}

/** Resolves a `--nm-*` token against the element it is inherited on. */
export async function resolveToken(page: Page, selector: string, token: string) {
  return page.locator(selector).first().evaluate((node, name) => {
    const probe = document.createElement("div");
    node.appendChild(probe);
    probe.style.backgroundColor = getComputedStyle(node).getPropertyValue(name).trim();
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, token);
}

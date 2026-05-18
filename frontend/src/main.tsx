import React, { Fragment, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { Activity, AlertTriangle, Check, ChevronDown, ChevronRight, ChevronUp, Download, Globe, LogOut, MapPin, Moon, Network, Pause, Pencil, Play, RefreshCw, Search, Settings, Shield, Star, Sun, Upload, UserCircle, UserPlus, Wrench, X } from "lucide-react";
import { IconAlertCircle, IconArrowRight, IconBolt, IconChartBar, IconClock, IconDeviceDesktop, IconDeviceLaptop, IconLayoutDashboard, IconMap, IconMapPin, IconServer, IconShieldCheck, IconTopologyRing, IconUsers, IconWifi, IconWifiOff, IconWorld } from "@tabler/icons-react";
import cytoscape, { Core } from "cytoscape";

import {
  AlertEvent,
  AlertRule,
  AlertRuleEventType,
  AlertRulePayload,
  AuditLog,
  AuditLogList,
  CorrelatedFirewallEvent,
  DashboardSummary,
  Device,
  DeviceEventCount,
  DeviceIcon,
  DevicePayload,
  DownloadResult,
  DnsLookupResult,
  DnsRecordType,
  DeviceSecurityEventSummary,
  DeviceLiveStatus,
  DeviceStatus,
  DiscoveryHost,
  DiscoveryScan,
  DiscoveryScanType,
  FirewallEvent,
  FirewallEventList,
  FirewallEventSearchParams,
  PingResult,
  Relationship,
  RelationshipPayload,
  ReverseDnsResult,
  SubnetCalculatorResult,
  SyslogStatus,
  SystemSettings,
  NotificationSettings,
  TcpPortCheckResult,
  TokenPair,
  TopologyLayout,
  TopologyGroup,
  TopologyGraph,
  Site,
  TracerouteResult,
  User,
  DeviceAnalysis,
  DeviceMonitorSummary,
  DhcpLease,
  FleetSummary,
  IpAddressEntry,
  IpamConflict,
  IpamSubnet,
  IpamSummary,
  MonitorHistoryPoint,
  PortResult,
  PortTarget,
  SubnetPayload,
  VlanSuggestion,
  PermissionMeta,
  RolePermissions,
  api,
} from "./api/client";
import "./styles/global.css";

const tokenStorageKey = "netmap.tokens";
const themeStorageKey = "netmap.theme";
const iconPackStorageKey = "netmap.icon_pack";
const localIconPacksStorageKey = "netmap.icon_packs.local";
const deviceTypeIconMapStorageKey = "netmap.device_type_icons";

type IconGlyphDefinition = { value: string; label: string; path?: string; url?: string; symbol?: string };
type IconPack = { id: string; name: string; icons: IconGlyphDefinition[] };

// All paths are Tabler Icons (MIT), viewBox 0 0 24 24, stroke-width 1.5
const builtInIconPack: IconPack = {
  id: "built-in",
  name: "Built-in (Tabler)",
  icons: [
    { value: "device",      label: "Device",      symbol: "◻", path: '<path d="M3 19l18 0"/><path d="M5 7a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v8a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1l0 -8"/>' },
    { value: "router",      label: "Router",      symbol: "⇄", path: '<path d="M3 15a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -4"/><path d="M17 17l0 .01"/><path d="M13 17l0 .01"/><path d="M15 13l0 -2"/><path d="M11.75 8.75a4 4 0 0 1 6.5 0"/><path d="M8.5 6.5a8 8 0 0 1 13 0"/>' },
    { value: "switch",      label: "Switch",      symbol: "▦", path: '<path d="M6 9a6 6 0 1 0 12 0a6 6 0 0 0 -12 0"/><path d="M12 3c1.333 .333 2 2.333 2 6s-.667 5.667 -2 6"/><path d="M12 3c-1.333 .333 -2 2.333 -2 6s.667 5.667 2 6"/><path d="M6 9h12"/><path d="M3 20h7"/><path d="M14 20h7"/><path d="M10 20a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M12 15v3"/>' },
    { value: "firewall",    label: "Firewall",    symbol: "🛡", path: '<path d="M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06"/><path d="M15 19l2 2l4 -4"/>' },
    { value: "server",      label: "Server",      symbol: "🖥", path: '<path d="M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3"/><path d="M3 15a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3l0 -2"/><path d="M7 8l0 .01"/><path d="M7 16l0 .01"/>' },
    { value: "wireless",    label: "Wireless AP", symbol: "📶", path: '<path d="M12 12l0 .01"/><path d="M14.828 9.172a4 4 0 0 1 0 5.656"/><path d="M17.657 6.343a8 8 0 0 1 0 11.314"/><path d="M9.168 14.828a4 4 0 0 1 0 -5.656"/><path d="M6.337 17.657a8 8 0 0 1 0 -11.314"/>' },
    { value: "workstation", label: "Workstation", symbol: "💻", path: '<path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10"/><path d="M7 20h10"/><path d="M9 16v4"/><path d="M15 16v4"/>' },
    { value: "cloud",       label: "Cloud",       symbol: "☁", path: '<path d="M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878"/>' },
    { value: "database",    label: "Database",    symbol: "🗄", path: '<path d="M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/>' },
    { value: "nas",         label: "NAS",         symbol: "💾", path: '<path d="M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-2"/><path d="M3 15a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3l0 -2"/><path d="M7 8l0 .01"/><path d="M7 16l0 .01"/><path d="M11 8h6"/><path d="M11 16h6"/>' },
    { value: "camera",      label: "Camera",      symbol: "📷", path: '<path d="M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2"/><path d="M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>' },
    { value: "printer",     label: "Printer",     symbol: "🖨", path: '<path d="M17 17h2a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-14a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h2"/><path d="M17 9v-4a2 2 0 0 0 -2 -2h-6a2 2 0 0 0 -2 2v4"/><path d="M7 15a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2l0 -4"/>' },
    { value: "iot",         label: "IoT Device",  symbol: "⚙", path: '<path d="M5 6a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1l0 -12"/><path d="M9 9h6v6h-6l0 -6"/><path d="M3 10h2"/><path d="M3 14h2"/><path d="M10 3v2"/><path d="M14 3v2"/><path d="M21 10h-2"/><path d="M21 14h-2"/><path d="M14 21v-2"/><path d="M10 21v-2"/>' },
    { value: "hypervisor",  label: "Hypervisor",  symbol: "⬡", path: '<path d="M10 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M3 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M17 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M6.5 17.5l5.5 -4.5l5.5 4.5"/><path d="M12 7l0 6"/>' },
    { value: "phone",       label: "Phone",       symbol: "📱", path: '<path d="M6 5a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-14"/><path d="M11 4h2"/><path d="M12 17v.01"/>' },
    { value: "unknown",     label: "Unknown",     symbol: "?",  path: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 16v.01"/><path d="M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483"/>' },
  ],
};

let runtimeIconPackId = builtInIconPack.id;
let runtimeIconDefs = new Map<string, IconGlyphDefinition>(builtInIconPack.icons.map((icon) => [icon.value, icon]));
let runtimeIconOptions = builtInIconPack.icons.map(({ label, value }) => ({ label, value }));
let allRuntimePacks: IconPack[] = [builtInIconPack];

const deviceColors = [
  { label: "Green", value: "#2d9d78" },
  { label: "Blue", value: "#3276b1" },
  { label: "Teal", value: "#1d6472" },
  { label: "Amber", value: "#d99a22" },
  { label: "Red", value: "#b44444" },
  { label: "Slate", value: "#5b7c91" },
  { label: "Gray", value: "#8a96a3" },
];

const deviceTypeOptions = [
  "router",
  "switch",
  "firewall",
  "server",
  "wireless",
  "workstation",
  "database",
  "nas",
  "camera",
  "printer",
  "iot",
  "hypervisor",
  "phone",
  "cloud",
  "unknown",
];

const defaultDeviceTypeIconMap: Record<string, string> = {
  router: "router",
  switch: "switch",
  firewall: "firewall",
  server: "server",
  wireless: "wireless",
  workstation: "workstation",
  database: "database",
  nas: "nas",
  camera: "camera",
  printer: "printer",
  iot: "iot",
  hypervisor: "hypervisor",
  phone: "phone",
  cloud: "cloud",
  "virtual-machine": "hypervisor",
  unknown: "unknown",
};

let deviceTypeIconMap: Record<string, string> = { ...defaultDeviceTypeIconMap };

function readDeviceTypeIconMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(deviceTypeIconMapStorageKey);
    if (!raw) return { ...defaultDeviceTypeIconMap };
    const parsed = JSON.parse(raw) as Record<string, string>;
    return { ...defaultDeviceTypeIconMap, ...parsed };
  } catch {
    return { ...defaultDeviceTypeIconMap };
  }
}

function writeDeviceTypeIconMap(map: Record<string, string>): void {
  window.localStorage.setItem(deviceTypeIconMapStorageKey, JSON.stringify(map));
}

function applyDeviceTypeIconMap(map: Record<string, string>): void {
  deviceTypeIconMap = { ...defaultDeviceTypeIconMap, ...map };
  writeDeviceTypeIconMap(map);
}

function formatDeviceTypeLabel(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function prefixToMask(prefix: number): string {
  if (prefix === 0) return "0.0.0.0";
  const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return [(mask >>> 24) & 0xFF, (mask >>> 16) & 0xFF, (mask >>> 8) & 0xFF, mask & 0xFF].join(".");
}

function wildcardMask(netmask: string): string {
  return netmask.split(".").map((o) => 255 - Number(o)).join(".");
}

function ipClass(ip: string): string {
  const first = Number(ip.split(".")[0]);
  if (first < 128) return "A";
  if (first < 192) return "B";
  if (first < 224) return "C";
  if (first < 240) return "D";
  return "E";
}

function ipType(ip: string): string {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return "Private";
  if (a === 172 && b >= 16 && b <= 31) return "Private";
  if (a === 192 && b === 168) return "Private";
  if (a === 127) return "Loopback";
  if (a === 169 && b === 254) return "Link-local";
  return "Public";
}

const SUBNET_REF = [
  { prefix: 8,  mask: "255.0.0.0",       hosts: 16_777_214 },
  { prefix: 12, mask: "255.240.0.0",      hosts: 1_048_574  },
  { prefix: 16, mask: "255.255.0.0",      hosts: 65_534     },
  { prefix: 20, mask: "255.255.240.0",    hosts: 4_094      },
  { prefix: 22, mask: "255.255.252.0",    hosts: 1_022      },
  { prefix: 24, mask: "255.255.255.0",    hosts: 254        },
  { prefix: 25, mask: "255.255.255.128",  hosts: 126        },
  { prefix: 26, mask: "255.255.255.192",  hosts: 62         },
  { prefix: 27, mask: "255.255.255.224",  hosts: 30         },
  { prefix: 28, mask: "255.255.255.240",  hosts: 14         },
  { prefix: 29, mask: "255.255.255.248",  hosts: 6          },
  { prefix: 30, mask: "255.255.255.252",  hosts: 2          },
] as const;

function sanitizeIconDefs(raw: unknown): IconGlyphDefinition[] {
  if (!Array.isArray(raw)) return [];
  const sanitized: IconGlyphDefinition[] = [];
  raw.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const value = String((item as { value?: unknown }).value ?? "").trim();
    const label = String((item as { label?: unknown }).label ?? "").trim();
    const pathRaw = (item as { path?: unknown }).path;
    const path = typeof pathRaw === "string" ? pathRaw.trim() : undefined;
    const symbolRaw = (item as { symbol?: unknown }).symbol;
    const symbol = typeof symbolRaw === "string" ? symbolRaw.trim() : undefined;
    const urlRaw = (item as { url?: unknown }).url;
    const url = typeof urlRaw === "string" ? urlRaw.trim() : undefined;
    if (!value || !label || (!path && !url)) return;
    sanitized.push({ value, label, path: path || undefined, url, symbol });
  });
  return sanitized;
}

function slugifyIconValue(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim()
    .slice(0, 100);
}

function labelFromIconValue(input: string) {
  return input
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractSvgIconMarkup(svgText: string) {
  const matches = svgText.match(/<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*\/?>/gi) || [];
  return matches.join("");
}

async function loadIconPacks(): Promise<IconPack[]> {
  try {
    const indexResponse = await fetch("/icon-packs/index.json", { cache: "no-store" });
    if (!indexResponse.ok) return [];
    const indexJson = await indexResponse.json() as { packs?: Array<{ id?: string; name?: string; file?: string }> };
    const entries = Array.isArray(indexJson.packs) ? indexJson.packs : [];
    const loaded = await Promise.all(entries.map(async (entry) => {
      const id = String(entry.id ?? "").trim();
      const name = String(entry.name ?? id).trim();
      const file = String(entry.file ?? "").trim();
      if (!id || !file) return null;
      try {
        const packResponse = await fetch(`/icon-packs/${file}`, { cache: "no-store" });
        if (!packResponse.ok) return null;
        const packJson = await packResponse.json() as { icons?: unknown };
        const icons = sanitizeIconDefs(packJson.icons);
        if (icons.length === 0) return null;
        return { id, name: name || id, icons };
      } catch {
        return null;
      }
    }));
    return loaded.filter((pack): pack is IconPack => Boolean(pack));
  } catch {
    return [];
  }
}

function readLocalIconPacks(): IconPack[] {
  try {
    const raw = window.localStorage.getItem(localIconPacksStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ id?: unknown; name?: unknown; icons?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((pack) => {
        const id = String(pack.id ?? "").trim();
        const name = String(pack.name ?? id).trim();
        const icons = sanitizeIconDefs(pack.icons);
        if (!id || !name || icons.length === 0) return null;
        return { id, name, icons };
      })
      .filter((pack): pack is IconPack => Boolean(pack));
  } catch {
    return [];
  }
}

function writeLocalIconPacks(packs: IconPack[]) {
  window.localStorage.setItem(localIconPacksStorageKey, JSON.stringify(packs));
}

function applyIconPackSelection(iconPacks: IconPack[], packId: string) {
  const selected = iconPacks.find((pack) => pack.id === packId) ?? builtInIconPack;
  // Merge ALL packs so any icon from any pack is resolvable, selected pack takes priority
  const merged = new Map<string, IconGlyphDefinition>();
  iconPacks.forEach((pack) => pack.icons.forEach((icon) => merged.set(icon.value, icon)));
  selected.icons.forEach((icon) => merged.set(icon.value, icon));
  const ordered = [
    ...selected.icons,
    ...builtInIconPack.icons.filter((icon) => !selected.icons.some((row) => row.value === icon.value)),
  ];
  runtimeIconPackId = selected.id;
  runtimeIconDefs = merged;
  runtimeIconOptions = ordered.map(({ label, value }) => ({ label, value }));
  allRuntimePacks = iconPacks;
}

const topologyLayoutStoragePrefix = "netmap.topology-layout";
const topologyLayoutVersion = 3;
const topologyDisplayPrefsStoragePrefix = "netmap.topology-display-prefs";

type AppRoute = "/overview" | "/topology" | "/inventory" | "/vlans" | "/locations" | "/monitoring" | "/ipam" | "/tools" | "/security" | "/exports" | "/admin" | "/profile";

type RouteDefinition = {
  href: AppRoute;
  icon: typeof Network;
  label: string;
  section?: string;
  requiresSecurityRole?: boolean;
  requiresSuperAdmin?: boolean;
};

const appRoutes: RouteDefinition[] = [
  { href: "/overview", icon: Activity, label: "Overview", section: "Network" },
  { href: "/topology", icon: Globe, label: "Topology" },
  { href: "/inventory", icon: Network, label: "Inventory" },
  { href: "/vlans", icon: Settings, label: "VLANs" },
  { href: "/locations", icon: MapPin, label: "Locations" },
  { href: "/monitoring", icon: Activity, label: "Monitoring" },
  { href: "/ipam", icon: Network, label: "IPAM" },
  { href: "/tools", icon: Wrench, label: "Tools", section: "Tools" },
  { href: "/security", icon: Shield, label: "Security", requiresSecurityRole: true },
  { href: "/exports", icon: Download, label: "Exports" },
  { href: "/admin", icon: Settings, label: "Admin", requiresSuperAdmin: true, section: "Account" },
  { href: "/profile", icon: UserCircle, label: "Profile" },
];

function readStoredTokens(): TokenPair | null {
  const raw = window.localStorage.getItem(tokenStorageKey);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as TokenPair;
  } catch {
    window.localStorage.removeItem(tokenStorageKey);
    return null;
  }
}

function storeTokens(tokens: TokenPair | null) {
  if (tokens) {
    window.localStorage.setItem(tokenStorageKey, JSON.stringify(tokens));
  } else {
    window.localStorage.removeItem(tokenStorageKey);
  }
}

function readRouteFromLocation(): AppRoute {
  const pathname = window.location.pathname;
  if (
    pathname === "/topology" ||
    pathname === "/inventory" ||
    pathname === "/vlans" ||
    pathname === "/locations" ||
    pathname === "/tools" ||
    pathname === "/security" ||
    pathname === "/exports" ||
    pathname === "/admin" ||
    pathname === "/profile"
  ) {
    return pathname;
  }
  return "/overview";
}

function navigateToRoute(route: AppRoute, replace = false) {
  const method = replace ? "replaceState" : "pushState";
  window.history[method](null, "", route);
}

function isMethodNotAllowedError(error: Error): boolean {
  const message = (error.message || "").toLowerCase();
  return message.includes("method not allowed") || message.includes("status 405") || message.includes("status: 405") || message.includes("405");
}

function App() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [tokens, setTokens] = useState<TokenPair | null>(() => readStoredTokens());
  const [user, setUser] = useState<User | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [graph, setGraph] = useState<TopologyGraph>({ devices: [], relationships: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentRoute, setCurrentRoute] = useState<AppRoute>(() => readRouteFromLocation());
  const [appSettings, setAppSettings] = useState<SystemSettings | null>(null);
  const idleTimeoutMs = (appSettings?.idle_timeout_minutes ?? 15) * 60 * 1000;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem("netmap.sidebar_collapsed") === "1");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = window.localStorage.getItem(themeStorageKey);
    return stored === "dark" ? "dark" : "light";
  });
  const [iconPacks, setIconPacks] = useState<IconPack[]>([]);
  const [localIconPacks, setLocalIconPacks] = useState<IconPack[]>(() => readLocalIconPacks());
  const [iconPackLoading, setIconPackLoading] = useState(true);
  const [activeIconPackId, setActiveIconPackId] = useState(() => window.localStorage.getItem(iconPackStorageKey) || builtInIconPack.id);
  const [iconPackError, setIconPackError] = useState<string | null>(null);
  const topologyRefreshRequestIdRef = useRef(0);
  const [resetToken, setResetToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("reset_token");
  });

  const accessToken = tokens?.access_token ?? null;
  const canViewSecurity =
    user?.role === "SuperAdmin" || user?.role === "NetworkAdmin" || user?.role === "SecurityAnalyst";
  const canAccessExports = user?.role !== "Viewer";
  const canAccessAdmin = user?.role === "SuperAdmin";

  useEffect(() => {
    void api.adminPublicSettings().then(setAppSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    void api.adminPublicSettings().then(setAppSettings).catch(() => {});
  }, [accessToken]);

  useEffect(() => {
    const syncRoute = () => setCurrentRoute(readRouteFromLocation());
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, theme);
    document.body.classList.toggle("theme-dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrapIconPacks() {
      setIconPackLoading(true);
      const loaded = await loadIconPacks();
      if (cancelled) return;
      setIconPacks(loaded);
      setIconPackLoading(false);
      setIconPackError(null);
    }
    void bootstrapIconPacks();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeLocalIconPacks(localIconPacks);
  }, [localIconPacks]);

  useEffect(() => {
    const merged = [...iconPacks];
    localIconPacks.forEach((pack) => {
      const existingIndex = merged.findIndex((row) => row.id === pack.id);
      if (existingIndex >= 0) merged[existingIndex] = pack;
      else merged.push(pack);
    });
    const available = [builtInIconPack, ...merged];
    const selected = available.some((pack) => pack.id === activeIconPackId) ? activeIconPackId : builtInIconPack.id;
    applyIconPackSelection(available, selected);
    deviceTypeIconMap = readDeviceTypeIconMap();
    if (selected !== activeIconPackId) {
      setActiveIconPackId(selected);
      setIconPackError("Selected icon pack was not found; reverted to Built-in.");
      return;
    }
    window.localStorage.setItem(iconPackStorageKey, selected);
  }, [activeIconPackId, iconPacks, localIconPacks]);

  useEffect(() => {
    document.body.classList.toggle("route-topology", currentRoute === "/topology");
    document.body.classList.toggle("route-security", currentRoute === "/security");
    return () => {
      document.body.classList.remove("route-topology");
      document.body.classList.remove("route-security");
    };
  }, [currentRoute]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      setLoading(true);
      setError(null);
      const token = tokens?.access_token ?? null;
      try {
        const setup = await api.setupStatus();
        if (cancelled) {
          return;
        }
        setNeedsSetup(setup.needs_setup);

        if (setup.needs_setup || !token) {
          return;
        }

        const currentUser = await api.me(token);
        if (cancelled) {
          return;
        }
        setUser(currentUser);

        const [dashboardResult, topologyResult] = await Promise.allSettled([
          api.dashboardSummary(token),
          api.topologyGraph(token),
        ]);
        if (cancelled) {
          return;
        }
        if (dashboardResult.status === "fulfilled") {
          setSummary(dashboardResult.value);
        } else if (dashboardResult.reason instanceof Error) {
          if (!isMethodNotAllowedError(dashboardResult.reason)) {
            setError(dashboardResult.reason.message);
          }
        }
        if (topologyResult.status === "fulfilled") {
          setGraph(topologyResult.value);
        } else if (topologyResult.reason instanceof Error) {
          if (!isMethodNotAllowedError(topologyResult.reason)) {
            setError(topologyResult.reason.message);
          }
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof Error && isMethodNotAllowedError(err)) {
            setError(null);
          } else {
            setError(err instanceof Error ? err.message : "Unable to load NetMap");
          }
          storeTokens(null);
          setTokens(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [tokens?.access_token]);

  const screen = useMemo(() => {
    if (resetToken) return "reset-password";
    if (loading || needsSetup === null) return "loading";
    if (needsSetup) return "setup";
    if (!accessToken || !user) return "login";
    return "dashboard";
  }, [accessToken, loading, needsSetup, user, resetToken]);

  async function handleSetup(username: string, password: string) {
    setError(null);
    await api.createAdmin(username, password);
    const newTokens = await api.login(username, password);
    storeTokens(newTokens);
    setTokens(newTokens);
    setNeedsSetup(false);
    navigateToRoute("/overview", true);
    setCurrentRoute("/overview");
  }

  async function handleLogin(username: string, password: string) {
    setError(null);
    const newTokens = await api.login(username, password);
    storeTokens(newTokens);
    setTokens(newTokens);
    navigateToRoute("/overview", true);
    setCurrentRoute("/overview");
  }

  async function handleLogout(reason: "user" | "idle" = "user") {
    const token = tokens?.access_token;
    const refreshToken = tokens?.refresh_token;
    if (token && refreshToken) {
      try {
        await api.logout(token, refreshToken);
      } catch {
        // Session cleanup must proceed even when logout revoke fails.
      }
    }
    storeTokens(null);
    setTokens(null);
    setUser(null);
    setSummary(null);
    window.history.replaceState(null, "", "/");
    setCurrentRoute("/overview");
    if (reason === "idle") {
      setError("Session timed out after 15 minutes of inactivity");
    }
  }

  useEffect(() => {
    if (screen !== "dashboard" || !tokens?.access_token) {
      return;
    }
    let timeoutId = window.setTimeout(() => {
      void handleLogout("idle");
    }, idleTimeoutMs);
    const reset = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        void handleLogout("idle");
      }, idleTimeoutMs);
    };
    const events = ["pointerdown", "keydown", "mousemove", "touchstart", "scroll"];
    events.forEach((eventName) => window.addEventListener(eventName, reset, { passive: true }));
    return () => {
      window.clearTimeout(timeoutId);
      events.forEach((eventName) => window.removeEventListener(eventName, reset));
    };
  }, [screen, tokens?.access_token, idleTimeoutMs]);

  async function refreshTopology(token = accessToken) {
    if (!token) {
      return;
    }
    const requestId = ++topologyRefreshRequestIdRef.current;
    const [dashboard, topology] = await Promise.all([
      api.dashboardSummary(token),
      api.topologyGraph(token),
    ]);
    if (requestId !== topologyRefreshRequestIdRef.current) {
      return;
    }
    setSummary(dashboard);
    setGraph(topology);
  }

  useEffect(() => {
    if (screen !== "dashboard" || !user) {
      if (window.location.pathname !== "/") {
        window.history.replaceState(null, "", "/");
      }
      return;
    }
    if (currentRoute === "/security" && !canViewSecurity) {
      navigateToRoute("/overview", true);
      setCurrentRoute("/overview");
      return;
    }
    if (currentRoute === "/exports" && !canAccessExports) {
      navigateToRoute("/overview", true);
      setCurrentRoute("/overview");
      return;
    }
    if (currentRoute === "/admin" && !canAccessAdmin) {
      navigateToRoute("/overview", true);
      setCurrentRoute("/overview");
      return;
    }
    if (window.location.pathname === "/") {
      navigateToRoute(currentRoute, true);
    }
  }, [canAccessAdmin, canAccessExports, canViewSecurity, currentRoute, screen, user]);

  if (screen !== "dashboard" || !user) {
    return (
      <main className="auth-shell">
        <button
          className="auth-theme-toggle"
          type="button"
          onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
        <section className="auth-workspace">
          {error && <div className="error-banner">{error}</div>}
          {screen === "loading" && <LoadingView />}
          {screen === "setup" && <SetupView onSubmit={handleSetup} />}
          {screen === "login" && <LoginView onSubmit={handleLogin} loginMessage={appSettings?.login_message} />}
          {screen === "reset-password" && (
            <ResetPasswordView
              resetToken={resetToken!}
              onSuccess={() => {
                window.history.replaceState(null, "", "/");
                setResetToken(null);
              }}
            />
          )}
        </section>
      </main>
    );
  }

  return (
    <main className={sidebarCollapsed ? "app-shell app-shell--sidebar-collapsed" : "app-shell"}>
      <Sidebar
        canAccessAdmin={canAccessAdmin}
        canAccessExports={canAccessExports}
        canViewSecurity={canViewSecurity}
        collapsed={sidebarCollapsed}
        currentRoute={currentRoute}
        onLogout={() => void handleLogout("user")}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        onToggleCollapse={() => {
          setSidebarCollapsed((c) => {
            const next = !c;
            window.localStorage.setItem("netmap.sidebar_collapsed", next ? "1" : "0");
            return next;
          });
        }}
        theme={theme}
        onNavigate={(route) => {
          if (route === currentRoute) {
            return;
          }
          navigateToRoute(route);
          setCurrentRoute(route);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
      <section className="workspace">
        {error && <div className="error-banner">{error}</div>}
        {appSettings?.announcement && (
          <div className="announcement-banner">{appSettings.announcement}</div>
        )}
        <DashboardView
          accessToken={accessToken}
          currentRoute={currentRoute}
          graph={graph}
          livePingEnabled={appSettings?.live_ping_enabled !== false}
          onGraphChange={refreshTopology}
          onNavigate={(route) => {
            navigateToRoute(route);
            setCurrentRoute(route);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onUserUpdate={setUser}
          theme={theme}
          summary={summary}
          user={user}
          activeIconPackId={activeIconPackId}
          iconPackLoading={iconPackLoading}
          iconPacks={iconPacks}
          localIconPacks={localIconPacks}
          iconPackError={iconPackError}
          onSelectIconPack={(packId) => {
            setIconPackError(null);
            setActiveIconPackId(packId);
          }}
          onAddLocalIconPack={(pack) => {
            setLocalIconPacks((current) => {
              const index = current.findIndex((row) => row.id === pack.id);
              if (index >= 0) {
                const next = [...current];
                next[index] = pack;
                return next;
              }
              return [...current, pack];
            });
          }}
          onRemoveLocalIconPack={(packId) => {
            setLocalIconPacks((current) => current.filter((row) => row.id !== packId));
            if (activeIconPackId === packId) {
              setActiveIconPackId(builtInIconPack.id);
            }
          }}
        />
      </section>
    </main>
  );
}

function Sidebar({
  canAccessAdmin,
  canAccessExports,
  canViewSecurity,
  collapsed,
  currentRoute,
  onLogout,
  onToggleTheme,
  onToggleCollapse,
  theme,
  onNavigate,
}: {
  canAccessAdmin: boolean;
  canAccessExports: boolean;
  canViewSecurity: boolean;
  collapsed: boolean;
  currentRoute: AppRoute;
  onLogout: () => void;
  onToggleTheme: () => void;
  onToggleCollapse: () => void;
  theme: "light" | "dark";
  onNavigate: (route: AppRoute) => void;
}) {
  return (
    <aside className={collapsed ? "sidebar sidebar--collapsed" : "sidebar"} aria-label="Primary navigation">
      <div className="brand">
        <Network size={24} aria-hidden="true" />
        {!collapsed && <span>NetMap</span>}
      </div>
      <button
        type="button"
        className="sidebar-collapse-btn"
        onClick={onToggleCollapse}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} style={{ transform: "rotate(90deg)" }} />}
        {!collapsed && <span className="nav-label">Collapse</span>}
      </button>
      <nav>
        {appRoutes
          .filter((route) => !route.requiresSecurityRole || canViewSecurity)
          .filter((route) => !route.requiresSuperAdmin || canAccessAdmin)
          .filter((route) => route.href !== "/exports" || canAccessExports)
          .map((route) => {
            const Icon = route.icon;
            return (
              <div key={route.href}>
                {route.section && !collapsed && (
                  <div className="sidebar-section-label">{route.section}</div>
                )}
                <button
                  className={route.href === currentRoute ? "sidebar-link active" : "sidebar-link"}
                  type="button"
                  title={collapsed ? route.label : undefined}
                  onClick={() => onNavigate(route.href)}
                >
                  <Icon size={18} aria-hidden="true" />
                  {!collapsed && route.label}
                </button>
              </div>
            );
          })}
      </nav>
      <button className="sidebar-theme-toggle" type="button" onClick={onToggleTheme} title={collapsed ? (theme === "dark" ? "Light mode" : "Dark mode") : undefined}>
        {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
        {!collapsed && (theme === "dark" ? "Light mode" : "Dark mode")}
      </button>
      <button className="sidebar-logout" type="button" onClick={onLogout} title={collapsed ? "Sign out" : undefined}>
        <LogOut size={16} aria-hidden="true" />
        {!collapsed && "Sign out"}
      </button>
    </aside>
  );
}

function LoadingView() {
  return (
    <section className="auth-surface">
      <div className="auth-card">
        <h1>NetMap</h1>
        <p>Loading secure workspace</p>
      </div>
    </section>
  );
}

function SetupView({ onSubmit }: { onSubmit: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await onSubmit(username, password);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-surface">
      <form className="auth-card" onSubmit={submit}>
        <div className="form-icon">
          <UserPlus size={22} aria-hidden="true" />
        </div>
        <h1>Create SuperAdmin</h1>
        <p>No default credentials exist. Create the first administrator to continue.</p>
        <label>
          Username
          <input
            autoComplete="username"
            minLength={3}
            maxLength={80}
            pattern="[A-Za-z0-9_.-]+"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            autoComplete="new-password"
            minLength={12}
            maxLength={256}
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {formError && <div className="form-error">{formError}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Creating..." : "Create admin"}
        </button>
      </form>
    </section>
  );
}

function LoginView({ onSubmit, loginMessage }: { onSubmit: (username: string, password: string) => Promise<void>; loginMessage?: string }) {
  const [view, setView] = useState<"login" | "forgot">("login");

  if (view === "forgot") {
    return <ForgotPasswordView onBack={() => setView("login")} />;
  }

  return <LoginForm onSubmit={onSubmit} loginMessage={loginMessage} onForgotPassword={() => setView("forgot")} />;
}

function LoginForm({
  onSubmit,
  loginMessage,
  onForgotPassword,
}: {
  onSubmit: (username: string, password: string) => Promise<void>;
  loginMessage?: string;
  onForgotPassword: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await onSubmit(username, password);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-surface">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="auth-brand-row">
            <div className="auth-brand-icon">
              <Network size={20} />
            </div>
            <span className="auth-brand-name">NetMap</span>
          </div>
          <p className="auth-slogan">{loginMessage || "The Blueprint for Your Infrastructure"}</p>
        </div>
        <h2 className="auth-form-heading">Sign in</h2>
        <label>
          Username
          <input
            autoComplete="username"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            autoComplete="current-password"
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {formError && <div className="form-error">{formError}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in..." : "Sign in"}
        </button>
        <button type="button" className="auth-forgot-link" onClick={onForgotPassword}>
          Forgot password?
        </button>
      </form>
    </section>
  );
}

function ForgotPasswordView({ onBack }: { onBack: () => void }) {
  const [identifier, setIdentifier] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await api.requestPasswordReset(identifier);
      setSubmitted(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to send reset email");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-surface">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-row">
            <div className="auth-brand-icon"><Network size={20} /></div>
            <span className="auth-brand-name">NetMap</span>
          </div>
        </div>
        {submitted ? (
          <>
            <h2 className="auth-form-heading">Check your email</h2>
            <p className="auth-reset-info">
              If an account matching <strong>{identifier}</strong> exists, a password reset link has been sent. Check your inbox and follow the link to set a new password.
            </p>
            <button type="button" onClick={onBack}>Back to sign in</button>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h2 className="auth-form-heading">Reset password</h2>
            <p className="auth-reset-info">
              Enter your username or email address. If an account exists, we'll send a reset link.
            </p>
            <label>
              Username or email
              <input
                required
                autoComplete="username email"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
              />
            </label>
            {formError && <div className="form-error">{formError}</div>}
            <button type="submit" disabled={submitting}>
              {submitting ? "Sending..." : "Send reset link"}
            </button>
            <button type="button" className="auth-forgot-link" onClick={onBack}>
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

function ResetPasswordView({ resetToken, onSuccess }: { resetToken: string; onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setFormError("Passwords do not match");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      await api.resetPasswordWithToken(resetToken, password);
      setDone(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to reset password — the link may have expired");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-surface">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-row">
            <div className="auth-brand-icon"><Network size={20} /></div>
            <span className="auth-brand-name">NetMap</span>
          </div>
        </div>
        {done ? (
          <>
            <h2 className="auth-form-heading">Password updated</h2>
            <p className="auth-reset-info">Your password has been reset. You can now sign in with your new password.</p>
            <button type="button" onClick={onSuccess}>Go to sign in</button>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h2 className="auth-form-heading">Set new password</h2>
            <p className="auth-reset-info">Choose a strong password of at least 12 characters.</p>
            <label>
              New password
              <input
                required
                type="password"
                minLength={12}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              Confirm new password
              <input
                required
                type="password"
                minLength={12}
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
            {formError && <div className="form-error">{formError}</div>}
            <button type="submit" disabled={submitting}>
              {submitting ? "Resetting..." : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

function DashboardView({
  accessToken,
  currentRoute,
  graph,
  livePingEnabled,
  onGraphChange,
  onNavigate,
  onUserUpdate,
  theme,
  user,
  summary,
  activeIconPackId,
  iconPackLoading,
  iconPacks,
  localIconPacks,
  iconPackError,
  onSelectIconPack,
  onAddLocalIconPack,
  onRemoveLocalIconPack,
}: {
  accessToken: string | null;
  currentRoute: AppRoute;
  graph: TopologyGraph;
  livePingEnabled: boolean;
  onGraphChange: () => Promise<void>;
  onNavigate: (route: AppRoute) => void;
  onUserUpdate: (user: User) => void;
  theme: "light" | "dark";
  user: User;
  summary: DashboardSummary | null;
  activeIconPackId: string;
  iconPackLoading: boolean;
  iconPacks: IconPack[];
  localIconPacks: IconPack[];
  iconPackError: string | null;
  onSelectIconPack: (packId: string) => void;
  onAddLocalIconPack: (pack: IconPack) => void;
  onRemoveLocalIconPack: (packId: string) => void;
}) {
  const canWrite = user.role === "SuperAdmin" || user.role === "NetworkAdmin";
  const canViewSecurity = user.role === "SuperAdmin" || user.role === "NetworkAdmin" || user.role === "SecurityAnalyst";
  const [jumpTarget, setJumpTarget] = useState<{ deviceId: number; token: number } | null>(null);
  const [selectedTopologyDevice, setSelectedTopologyDevice] = useState<Device | null>(null);

  function jumpToTopologyDevice(deviceId: number) {
    setJumpTarget({ deviceId, token: Date.now() });
    onNavigate("/topology");
  }

  return (
    <>
      {currentRoute === "/overview" && (
        <OverviewWorkspace
          accessToken={accessToken}
          graph={graph}
          onNavigate={onNavigate}
          summary={summary}
          user={user}
        />
      )}
      {currentRoute === "/topology" && (
        <TopologyWorkspace
          accessToken={accessToken}
          activeIconPackId={activeIconPackId}
          canViewSecurity={canViewSecurity}
          canWrite={canWrite}
          graph={graph}
          onGraphChange={onGraphChange}
          jumpTarget={jumpTarget}
          livePingEnabled={livePingEnabled}
          onSelectedDeviceChange={setSelectedTopologyDevice}
          theme={theme}
          userId={user.id}
        />
      )}
      {currentRoute === "/inventory" && accessToken && (
        <InventoryWorkspace accessToken={accessToken} canWrite={canWrite} graph={graph} onGraphChange={onGraphChange} livePingEnabled={livePingEnabled} />
      )}
      {currentRoute === "/vlans" && accessToken && (
        <VlanWorkspace accessToken={accessToken} canWrite={canWrite} graph={graph} onGraphChange={onGraphChange} />
      )}
      {currentRoute === "/locations" && accessToken && (
        <LocationsWorkspace accessToken={accessToken} canWrite={canWrite} graph={graph} onGraphChange={onGraphChange} />
      )}
      {currentRoute === "/monitoring" && accessToken && (
        <MonitoringWorkspace accessToken={accessToken} canWrite={canWrite} userRole={user.role} />
      )}
      {currentRoute === "/ipam" && accessToken && (
        <IpamWorkspace accessToken={accessToken} canWrite={canWrite} />
      )}
      {currentRoute === "/tools" && accessToken && (
        <ToolsWorkspace
          accessToken={accessToken}
          graph={graph}
          selectedDevice={selectedTopologyDevice}
          userRole={user.role}
        />
      )}
      {currentRoute === "/exports" && accessToken && user.role !== "Viewer" && (
        <ExportsWorkspace accessToken={accessToken} user={user} />
      )}
      {currentRoute === "/security" && canViewSecurity && (
        <SecurityWorkspace
          accessToken={accessToken}
          graph={graph}
          onJumpToTopologyDevice={jumpToTopologyDevice}
        />
      )}
      {currentRoute === "/admin" && user.role === "SuperAdmin" && accessToken && (
        <AdminWorkspace
          accessToken={accessToken}
          graph={graph}
          summary={summary}
          activeIconPackId={activeIconPackId}
          iconPackLoading={iconPackLoading}
          iconPacks={iconPacks}
          localIconPacks={localIconPacks}
          iconPackError={iconPackError}
          onSelectIconPack={onSelectIconPack}
          onAddLocalIconPack={onAddLocalIconPack}
          onRemoveLocalIconPack={onRemoveLocalIconPack}
        />
      )}
      {currentRoute === "/profile" && accessToken && (
        <ProfileWorkspace accessToken={accessToken} user={user} onUserUpdate={onUserUpdate} />
      )}
    </>
  );
}

function OverviewWorkspace({
  accessToken,
  graph,
  onNavigate,
  summary,
  user,
}: {
  accessToken: string | null;
  graph: TopologyGraph;
  onNavigate: (route: AppRoute) => void;
  summary: DashboardSummary | null;
  user: User;
}) {
  const [clockNow, setClockNow] = useState(new Date());
  const [monFleet, setMonFleet] = useState<FleetSummary | null>(null);
  const [monDevices, setMonDevices] = useState<DeviceMonitorSummary[]>([]);
  useEffect(() => {
    const id = setInterval(() => setClockNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    void Promise.all([
      api.getMonitoringSummary(accessToken),
      api.listMonitoringDevices(accessToken),
    ]).then(([f, d]) => { setMonFleet(f); setMonDevices(d); }).catch(() => {});
  }, [accessToken]);

  const statusCounts = useMemo(() => {
    const c = { online: 0, offline: 0, warning: 0, unknown: 0 };
    for (const d of monDevices) {
      if (d.status === "online") c.online++;
      else if (d.status === "offline") c.offline++;
      else if (d.status === "warning") c.warning++;
      else c.unknown++;
    }
    return c;
  }, [monDevices]);

  const total = monDevices.length > 0 ? monDevices.length : graph.devices.length;

  const groupCount = useMemo(
    () => new Set(graph.devices.map((d) => d.topology_group).filter(Boolean)).size,
    [graph.devices],
  );

  const recentDevices = useMemo(
    () => [...graph.devices].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 8),
    [graph.devices],
  );

  const offlineDevices = useMemo(
    () => monDevices.filter((d) => d.status === "offline"),
    [monDevices],
  );

  const typeBreakdown = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of graph.devices) {
      const k = d.device_type || "Unknown";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [graph.devices]);

  const vendorBreakdown = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of graph.devices) {
      if (d.vendor) m.set(d.vendor, (m.get(d.vendor) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [graph.devices]);

  const groupBreakdown = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of graph.devices) {
      if (d.topology_group) m.set(d.topology_group, (m.get(d.topology_group) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [graph.devices]);

  const hour = clockNow.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const dateStr = clockNow.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeStr = clockNow.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const onlinePct = total > 0 ? Math.round((statusCounts.online / total) * 100) : 0;

  const favouriteDevices = useMemo(
    () => monDevices.filter((d) => d.is_favourite),
    [monDevices],
  );

  async function toggleFav(deviceId: number) {
    if (!accessToken) return;
    try {
      await api.toggleFavourite(accessToken, deviceId);
      setMonDevices((prev) => prev.map((d) => d.device_id === deviceId ? { ...d, is_favourite: !d.is_favourite } : d));
    } catch { /* ignore */ }
  }

  return (
    <section className="dash-layout">
      {/* Header */}
      <div className="dash-header">
        <div>
          <h1 className="dash-title">{greeting}, {user.display_name || user.username}</h1>
          <p className="dash-subtitle" style={{ marginTop: 6 }}>{dateStr} &middot; <span className="dash-clock">{timeStr}</span> <span className="dash-role-badge">{user.role}</span></p>
        </div>
        <div className="dash-header-meta">
          <IconClock size={14} />
          <span>Live data</span>
        </div>
      </div>

      {/* Stat row */}
      <div className="dash-stats">
        <DashStat label="Total devices" value={total} sub={total === 0 ? "none yet" : `${onlinePct}% reachable`} icon={<IconServer size={20} />} accent="teal" />
        <DashStat label="Online" value={statusCounts.online} sub="reachable" icon={<IconWifi size={20} />} accent="green" />
        <DashStat label="Offline" value={statusCounts.offline} sub={statusCounts.offline > 0 ? "need attention" : "all clear"} icon={<IconWifiOff size={20} />} accent={statusCounts.offline > 0 ? "red" : "green"} />
        <DashStat label="Groups / VLANs" value={groupCount} sub="topology segments" icon={<IconMap size={20} />} accent="purple" />
        <DashStat label="Links" value={graph.relationships.length} sub="connections" icon={<IconBolt size={20} />} accent="blue" />
        <DashStat label="Users" value={summary?.user_count ?? 0} sub="accounts" icon={<IconUsers size={20} />} accent="indigo" />
      </div>

      {/* Offline alert */}
      {offlineDevices.length > 0 && (
        <div className="dash-alert">
          <IconAlertCircle size={15} />
          <span>
            <strong>{offlineDevices.length} device{offlineDevices.length !== 1 ? "s" : ""} offline</strong>
            {" — "}
            {offlineDevices.slice(0, 4).map((d) => d.display_name || d.hostname || d.ip_address).join(", ")}
            {offlineDevices.length > 4 && ` and ${offlineDevices.length - 4} more`}
          </span>
          <button type="button" className="dash-alert-link" onClick={() => onNavigate("/inventory")}>
            View inventory <IconArrowRight size={13} />
          </button>
        </div>
      )}

      {/* Main grids */}
      <div className="dash-grids">

      {/* Top row: Network health | Device types | Top groups */}
      <div className="dash-grid-3">

        {/* Network health */}
        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Network health</span>
            <span className="dash-panel-meta">{total} device{total !== 1 ? "s" : ""}</span>
          </div>
          <div className="dash-panel-body">
            {total === 0 ? (
              <p className="dash-empty">No devices yet. Add some from the Inventory tab.</p>
            ) : (
              <div className="dash-health">
                {([
                  { key: "online" as const, label: "Online", color: "var(--dash-green)" },
                  { key: "offline" as const, label: "Offline", color: "var(--dash-red)" },
                  { key: "warning" as const, label: "Warning", color: "var(--dash-amber)" },
                  { key: "unknown" as const, label: "Unknown", color: "var(--dash-muted)" },
                ] as const).map(({ key, label, color }) => {
                  const count = statusCounts[key];
                  const pct = total > 0 ? (count / total) * 100 : 0;
                  return (
                    <div key={key} className="dash-health-row">
                      <span className="dash-health-label">{label}</span>
                      <div className="dash-health-track">
                        <div className="dash-health-fill" style={{ width: `${pct}%`, background: color }} />
                      </div>
                      <span className="dash-health-count">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Device types */}
        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Device types</span>
            <span className="dash-panel-meta">{typeBreakdown.length} types</span>
          </div>
          <div className="dash-panel-body">
            {typeBreakdown.length === 0 ? (
              <p className="dash-empty">No data yet.</p>
            ) : (
              <>
                <div className="dash-breakdown">
                  {typeBreakdown.map(([type, count]) => (
                    <div key={type} className="dash-breakdown-row">
                      <span className="dash-breakdown-label">{formatDeviceTypeLabel(type)}</span>
                      <div className="dash-mini-track">
                        <div className="dash-mini-fill" style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }} />
                      </div>
                      <span className="dash-breakdown-count">{count}</span>
                    </div>
                  ))}
                </div>
                {vendorBreakdown.length > 0 && (
                  <>
                    <div className="dash-panel-divider" />
                    <div className="dash-panel-sub-title">Top vendors</div>
                    <div className="dash-tag-cloud">
                      {vendorBreakdown.map(([vendor, count]) => (
                        <span key={vendor} className="dash-tag">{vendor} <span className="dash-tag-count">{count}</span></span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* Top groups */}
        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Top groups</span>
            <button type="button" className="dash-panel-link" onClick={() => onNavigate("/vlans")}>
              Manage <IconArrowRight size={12} />
            </button>
          </div>
          <div className="dash-panel-body">
            {groupBreakdown.length === 0 ? (
              <p className="dash-empty">No groups yet.</p>
            ) : (
              <div className="dash-breakdown">
                {groupBreakdown.map(([group, count]) => (
                  <div key={group} className="dash-breakdown-row">
                    <span className="dash-breakdown-label">{group}</span>
                    <div className="dash-mini-track">
                      <div className="dash-mini-fill dash-mini-fill--purple" style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }} />
                    </div>
                    <span className="dash-breakdown-count">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Bottom row: Recently updated | Navigate */}
      <div className="dash-grid-2">

        {/* Recently updated */}
        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Recently updated</span>
            <button type="button" className="dash-panel-link" onClick={() => onNavigate("/inventory")}>
              View all <IconArrowRight size={12} />
            </button>
          </div>
          <div className="dash-panel-body">
            {recentDevices.length === 0 ? (
              <p className="dash-empty">No devices yet.</p>
            ) : (
              <div className="dash-device-list">
                {recentDevices.map((d) => {
                  const liveStatus = d.monitor_status ?? d.status;
                  return (
                    <div key={d.id} className="dash-device-row">
                      <span className={`dash-status-dot dash-status-dot--${liveStatus}`} />
                      <div className="dash-device-info">
                        <span className="dash-device-name">{d.display_name || d.hostname || d.ip_address}</span>
                        <span className="dash-device-meta">{d.ip_address}{d.device_type ? ` · ${formatDeviceTypeLabel(d.device_type)}` : ""}</span>
                      </div>
                      <span className="dash-device-group">{d.topology_group || <span className="dash-dim">—</span>}</span>
                      <span className={`dash-status-pill dash-status-pill--${liveStatus}`}>{liveStatus}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Monitoring snapshot */}
        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Favourites</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button type="button" className="dash-panel-link" onClick={() => onNavigate("/monitoring")}>
                View all <IconArrowRight size={12} />
              </button>
            </div>
          </div>
          <div className="dash-panel-body">
            {monDevices.length === 0 ? (
              <p className="dash-empty">No monitoring data yet — the background monitor polls every 5 minutes.</p>
            ) : favouriteDevices.length === 0 ? (
              <p className="dash-empty">No favourites yet — star devices in monitoring or inventory to pin them here.</p>
            ) : (
              <div className="dash-device-list">
                {favouriteDevices.map((d) => (
                  <div key={d.device_id} className="dash-device-row">
                    <MonStatusDot status={d.status} />
                    <div className="dash-device-info">
                      <span className="dash-device-name">{d.display_name ?? d.hostname ?? d.ip_address}</span>
                      {d.heartbeat.length > 0 && <HeartbeatBar beats={d.heartbeat} size="sm" />}
                    </div>
                    <UptimeBadge value={d.uptime_24h} />
                    <span className="dash-panel-meta" style={{ minWidth: 60, textAlign: "right" }}>
                      {d.avg_rtt_24h != null ? `${d.avg_rtt_24h.toFixed(1)} ms` : "—"}
                    </span>
                    <button
                      type="button"
                      className="fav-btn fav-btn--active"
                      title="Remove from favourites"
                      onClick={() => void toggleFav(d.device_id)}
                    >
                      <Star size={13} fill="currentColor" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>

      </div>{/* end dash-grids */}
    </section>
  );
}

function DashStat({ label, value, sub, icon, accent }: {
  label: string;
  value: number;
  sub: string;
  icon: React.ReactNode;
  accent: "teal" | "green" | "red" | "purple" | "blue" | "indigo";
}) {
  return (
    <div className={`dash-stat dash-stat--${accent}`}>
      <div className="dash-stat-icon">{icon}</div>
      <div className="dash-stat-body">
        <strong className="dash-stat-value">{value.toLocaleString()}</strong>
        <span className="dash-stat-label">{label}</span>
        <span className="dash-stat-sub">{sub}</span>
      </div>
    </div>
  );
}

type SecurityFilters = {
  q: string;
  src_ip: string;
  dst_ip: string;
  src_port: string;
  dst_port: string;
  action: string;
  protocol: string;
  interface: string;
  start_time: string;
  end_time: string;
};

const emptySecurityFilters: SecurityFilters = {
  q: "",
  src_ip: "",
  dst_ip: "",
  src_port: "",
  dst_port: "",
  action: "",
  protocol: "",
  interface: "",
  start_time: "",
  end_time: "",
};

function SecurityWorkspace({
  accessToken,
  graph,
  onJumpToTopologyDevice,
}: {
  accessToken: string | null;
  graph: TopologyGraph;
  onJumpToTopologyDevice: (deviceId: number) => void;
}) {
  const [filters, setFilters] = useState<SecurityFilters>(emptySecurityFilters);
  const [events, setEvents] = useState<FirewallEvent[]>([]);
  const [status, setStatus] = useState<SyslogStatus | null>(null);
  const [resultMeta, setResultMeta] = useState<FirewallEventList | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState("received_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const [liveTail, setLiveTail] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const pageSize = 100;
  const devicesByIp = useMemo(() => {
    const mapping = new Map<string, Device[]>();
    graph.devices.forEach((device) => {
      const key = device.ip_address.trim();
      if (!key) {
        return;
      }
      const current = mapping.get(key) ?? [];
      current.push(device);
      mapping.set(key, current);
    });
    return mapping;
  }, [graph.devices]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    const token = accessToken;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [nextStatus, nextEvents] = await Promise.all([
          api.syslogStatus(token),
          api.firewallEvents(token, buildSearchParams(filters, offset, pageSize, sortBy, sortDir)),
        ]);
        if (!cancelled) {
          setStatus(nextStatus);
          setResultMeta(nextEvents);
          setEvents(nextEvents.events);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load firewall events");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, filters, offset, sortBy, sortDir]);

  useEffect(() => {
    if (!accessToken || !liveTail) {
      return;
    }
    const socket = new WebSocket(buildFirewallEventsWsUrl(accessToken));
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as FirewallEvent;
      if (!eventMatchesFilters(event, filters)) {
        return;
      }
      setEvents((current) => [event, ...current.filter((existing) => existing.id !== event.id)].slice(0, pageSize));
      setStatus((current) => (current ? { ...current, total_events: current.total_events + 1 } : current));
      setResultMeta((current) => (current ? { ...current, total: current.total + 1 } : current));
      if (autoScroll) {
        requestAnimationFrame(() => {
          if (tableRef.current) {
            tableRef.current.scrollTop = 0;
          }
        });
      }
    };
    socket.onerror = () => setError("Live firewall event stream disconnected");
    return () => socket.close();
  }, [accessToken, autoScroll, filters, liveTail]);

  function updateFilter(field: keyof SecurityFilters, value: string) {
    setOffset(0);
    setFilters((current) => ({ ...current, [field]: value }));
  }

  function applyFilter(field: keyof SecurityFilters, value: string | number | null) {
    if (value === null || value === "") {
      return;
    }
    updateFilter(field, String(value));
  }

  function applyQuickFilter(kind: "blocked" | "passed" | "wan" | "hour" | "day") {
    const now = new Date();
    setOffset(0);
    setFilters((current) => {
      if (kind === "blocked") {
        return { ...current, action: "block" };
      }
      if (kind === "passed") {
        return { ...current, action: "pass" };
      }
      if (kind === "wan") {
        return { ...current, interface: "wan" };
      }
      const start = new Date(now.getTime() - (kind === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000));
      return { ...current, start_time: toDateTimeLocal(start), end_time: "" };
    });
  }

  function changeSort(nextSortBy: string) {
    if (nextSortBy === sortBy) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(nextSortBy);
    setSortDir("desc");
  }

  const total = resultMeta?.total ?? 0;
  const canPrevious = offset > 0;
  const canNext = offset + pageSize < total;

  return (
    <section className="security-layout" id="security">
      <div className="security-toolbar">
        <div>
          <h2>Security</h2>
          <p>
            {status?.total_events ?? 0} retained events · {status?.retention_days ?? 7} day retention ·{" "}
            {liveTail ? "live tail active" : "live tail paused"}
          </p>
          {status && (
            <p className="tool-note">
              Last cleanup {status.retention_last_run_at ? formatEventTime(status.retention_last_run_at) : "not yet run"} ·
              deleted {status.retention_last_deleted} ·
              last event {status.last_event_received_at ? formatEventTime(status.last_event_received_at) : "none"}
              {status.retention_last_error ? ` · cleanup error: ${status.retention_last_error}` : ""}
            </p>
          )}
        </div>
        <div className="security-live-controls">
          <button className="icon-button" type="button" onClick={() => setLiveTail((current) => !current)}>
            {liveTail ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            {liveTail ? "Pause" : "Resume"}
          </button>
          <label className="inline-toggle">
            <input checked={autoScroll} type="checkbox" onChange={(event) => setAutoScroll(event.target.checked)} />
            Auto-scroll
          </label>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="security-content">
        <aside className="security-filters" aria-label="Firewall event filters">
          <label className="security-search">
            <Search size={16} aria-hidden="true" />
            <input
              placeholder="Search raw log, IP, rule, reason"
              value={filters.q}
              onChange={(event) => updateFilter("q", event.target.value)}
            />
          </label>
          <div className="quick-filters">
            <button type="button" onClick={() => applyQuickFilter("blocked")}>Blocked Traffic</button>
            <button type="button" onClick={() => applyQuickFilter("passed")}>Passed Traffic</button>
            <button type="button" onClick={() => applyQuickFilter("wan")}>WAN</button>
            <button type="button" onClick={() => applyQuickFilter("hour")}>Last Hour</button>
            <button type="button" onClick={() => applyQuickFilter("day")}>Last 24 Hours</button>
          </div>
          <SecurityFilterInput label="Source IP" value={filters.src_ip} onChange={(value) => updateFilter("src_ip", value)} />
          <SecurityFilterInput label="Destination IP" value={filters.dst_ip} onChange={(value) => updateFilter("dst_ip", value)} />
          <SecurityFilterInput label="Source Port" value={filters.src_port} onChange={(value) => updateFilter("src_port", value)} />
          <SecurityFilterInput label="Destination Port" value={filters.dst_port} onChange={(value) => updateFilter("dst_port", value)} />
          <SecurityFilterInput label="Action" value={filters.action} onChange={(value) => updateFilter("action", value)} />
          <SecurityFilterInput label="Protocol" value={filters.protocol} onChange={(value) => updateFilter("protocol", value)} />
          <SecurityFilterInput label="Interface" value={filters.interface} onChange={(value) => updateFilter("interface", value)} />
          <label>
            Start time
            <input type="datetime-local" value={filters.start_time} onChange={(event) => updateFilter("start_time", event.target.value)} />
          </label>
          <label>
            End time
            <input type="datetime-local" value={filters.end_time} onChange={(event) => updateFilter("end_time", event.target.value)} />
          </label>
          <button className="clear-filters" type="button" onClick={() => { setOffset(0); setFilters(emptySecurityFilters); }}>
            Clear filters
          </button>
        </aside>
        <div className="security-results">
          <div className="security-results-meta">
            <span>{loading ? "Searching..." : `${total} matching events`}</span>
            <span>
              Showing {total === 0 ? 0 : offset + 1}-{Math.min(offset + pageSize, total)}
            </span>
          </div>
          <div className="security-table" ref={tableRef}>
            <div className="security-table-header">
              <button type="button" onClick={() => changeSort("received_at")}>Time</button>
              <button type="button" onClick={() => changeSort("interface")}>Interface</button>
              <span>Source</span>
              <span>Destination</span>
              <span>Topology</span>
              <button type="button" onClick={() => changeSort("protocol")}>Protocol</button>
              <button type="button" onClick={() => changeSort("src_port")}>Source Port</button>
              <button type="button" onClick={() => changeSort("dst_port")}>Destination Port</button>
              <button type="button" onClick={() => changeSort("action")}>Action</button>
              <span>Rule</span>
              <span>Reason</span>
            </div>
            {events.length === 0 ? (
              <div className="security-empty">No firewall events match the current filters.</div>
            ) : (
              events.map((event) => {
                const relatedDevices = relatedDevicesForEvent(event, devicesByIp);
                const primaryDevice = relatedDevices[0] ?? null;
                return (
                  <div key={event.id} className="security-row-group">
                    <button
                      className="security-row"
                      type="button"
                      onClick={() => {
                        setExpandedId((current) => (current === event.id ? null : event.id));
                        if (primaryDevice) {
                          onJumpToTopologyDevice(primaryDevice.id);
                        }
                      }}
                    >
                      <span className="row-time">
                        {expandedId === event.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        {formatEventTime(event.received_at)}
                      </span>
                      <ClickableCell value={event.interface} onClick={() => applyFilter("interface", event.interface)} />
                      <ClickableCell value={event.src_ip} onClick={() => applyFilter("src_ip", event.src_ip)} />
                      <ClickableCell value={event.dst_ip} onClick={() => applyFilter("dst_ip", event.dst_ip)} />
                      {primaryDevice ? (
                        <ClickableCell
                          className="topology-link-cell"
                          value={deviceLabel(primaryDevice)}
                          onClick={() => onJumpToTopologyDevice(primaryDevice.id)}
                        />
                      ) : (
                        <span className="clickable-cell">-</span>
                      )}
                      <ClickableCell value={event.protocol} onClick={() => applyFilter("protocol", event.protocol)} />
                      <ClickableCell value={event.src_port} onClick={() => applyFilter("src_port", event.src_port)} />
                      <ClickableCell value={event.dst_port} onClick={() => applyFilter("dst_port", event.dst_port)} />
                      <ClickableCell value={event.action} className={`action-pill ${event.action ?? "unknown"}`} onClick={() => applyFilter("action", event.action)} />
                      <ClickableCell value={event.rule_id} onClick={() => applyFilter("q", event.rule_id)} />
                      <ClickableCell value={event.reason} onClick={() => applyFilter("q", event.reason)} />
                    </button>
                    {expandedId === event.id && (
                      <>
                        {relatedDevices.length > 0 && (
                          <div className="related-devices">
                            <span>Related devices:</span>
                            {relatedDevices.map((device) => (
                              <button
                                className="topology-jump-button"
                                key={`${event.id}-${device.id}`}
                                type="button"
                                onClick={() => onJumpToTopologyDevice(device.id)}
                              >
                                {deviceLabel(device)}
                              </button>
                            ))}
                          </div>
                        )}
                        <pre className="raw-log">{event.raw_log}</pre>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="security-pagination">
            <button type="button" disabled={!canPrevious} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
              Previous
            </button>
            <button type="button" disabled={!canNext} onClick={() => setOffset(offset + pageSize)}>
              Next
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SecurityFilterInput({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ToolsWorkspace({
  accessToken,
  graph,
  selectedDevice,
  userRole,
}: {
  accessToken: string;
  graph: TopologyGraph;
  selectedDevice: Device | null;
  userRole: User["role"];
}) {
  const canRunActiveTools = userRole === "SuperAdmin" || userRole === "NetworkAdmin";
  const [dnsName, setDnsName] = useState("");
  const [dnsRecordType, setDnsRecordType] = useState<DnsRecordType>("A");
  const [dnsResult, setDnsResult] = useState<DnsLookupResult | null>(null);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [reverseDnsIp, setReverseDnsIp] = useState("");
  const [reverseDnsResult, setReverseDnsResult] = useState<ReverseDnsResult | null>(null);
  const [reverseDnsError, setReverseDnsError] = useState<string | null>(null);
  const [reverseDnsLoading, setReverseDnsLoading] = useState(false);
  const [pingHostValue, setPingHostValue] = useState("");
  const [pingCount, setPingCount] = useState("4");
  const [pingTimeout, setPingTimeout] = useState("3");
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [pingLoading, setPingLoading] = useState(false);
  const [tracerouteHostValue, setTracerouteHostValue] = useState("");
  const [tracerouteMaxHops, setTracerouteMaxHops] = useState("20");
  const [tracerouteTimeout, setTracerouteTimeout] = useState("3");
  const [tracerouteResult, setTracerouteResult] = useState<TracerouteResult | null>(null);
  const [tracerouteError, setTracerouteError] = useState<string | null>(null);
  const [tracerouteLoading, setTracerouteLoading] = useState(false);
  const [tcpHostValue, setTcpHostValue] = useState("");
  const [tcpPort, setTcpPort] = useState("443");
  const [tcpTimeout, setTcpTimeout] = useState("3");
  const [tcpResult, setTcpResult] = useState<TcpPortCheckResult | null>(null);
  const [tcpError, setTcpError] = useState<string | null>(null);
  const [tcpLoading, setTcpLoading] = useState(false);
  const [subnetIp, setSubnetIp] = useState("");
  const [subnetPrefix, setSubnetPrefix] = useState(24);
  const [subnetSubmittedIp, setSubnetSubmittedIp] = useState("");
  const [subnetResult, setSubnetResult] = useState<SubnetCalculatorResult | null>(null);
  const [subnetError, setSubnetError] = useState<string | null>(null);
  const [subnetLoading, setSubnetLoading] = useState(false);

  const activeTarget = selectedDevice?.ip_address ?? "";
  const [activeTool, setActiveTool] = useState("dns");

  useEffect(() => {
    if (!selectedDevice) {
      return;
    }
    const ip = selectedDevice.ip_address ?? "";
    setReverseDnsIp(ip);
    setPingHostValue((current) => current || ip);
    setTracerouteHostValue((current) => current || ip);
    setTcpHostValue((current) => current || ip);
    if (selectedDevice.subnet) {
      const parts = selectedDevice.subnet.split("/");
      setSubnetIp(parts[0]);
      if (parts.length === 2) setSubnetPrefix(Number(parts[1]) || 24);
    } else {
      setSubnetIp((cur) => cur || selectedDevice.ip_address || "");
    }
  }, [selectedDevice]);

  async function runDnsLookup(event: FormEvent) {
    event.preventDefault();
    setDnsLoading(true);
    setDnsError(null);
    try {
      setDnsResult(await api.dnsLookup(accessToken, { name: dnsName, record_type: dnsRecordType }));
    } catch (err) {
      setDnsError(err instanceof Error ? err.message : "DNS lookup failed");
    } finally {
      setDnsLoading(false);
    }
  }

  async function runReverseDns(event: FormEvent) {
    event.preventDefault();
    setReverseDnsLoading(true);
    setReverseDnsError(null);
    try {
      setReverseDnsResult(await api.reverseDns(accessToken, { ip_address: reverseDnsIp }));
    } catch (err) {
      setReverseDnsError(err instanceof Error ? err.message : "Reverse DNS lookup failed");
    } finally {
      setReverseDnsLoading(false);
    }
  }

  async function runPing(event: FormEvent) {
    event.preventDefault();
    if (!canRunActiveTools) {
      return;
    }
    setPingLoading(true);
    setPingError(null);
    try {
      setPingResult(
        await api.ping(accessToken, {
          host: pingHostValue,
          count: Number(pingCount),
          timeout_seconds: Number(pingTimeout),
        }),
      );
    } catch (err) {
      setPingError(err instanceof Error ? err.message : "Ping failed");
    } finally {
      setPingLoading(false);
    }
  }

  async function runTraceroute(event: FormEvent) {
    event.preventDefault();
    if (!canRunActiveTools) {
      return;
    }
    setTracerouteLoading(true);
    setTracerouteError(null);
    try {
      setTracerouteResult(
        await api.traceroute(accessToken, {
          host: tracerouteHostValue,
          max_hops: Number(tracerouteMaxHops),
          timeout_seconds: Number(tracerouteTimeout),
        }),
      );
    } catch (err) {
      setTracerouteError(err instanceof Error ? err.message : "Traceroute failed");
    } finally {
      setTracerouteLoading(false);
    }
  }

  async function runTcpCheck(event: FormEvent) {
    event.preventDefault();
    if (!canRunActiveTools) {
      return;
    }
    setTcpLoading(true);
    setTcpError(null);
    try {
      setTcpResult(
        await api.tcpCheck(accessToken, {
          host: tcpHostValue,
          port: Number(tcpPort),
          timeout_seconds: Number(tcpTimeout),
        }),
      );
    } catch (err) {
      setTcpError(err instanceof Error ? err.message : "TCP check failed");
    } finally {
      setTcpLoading(false);
    }
  }

  async function runSubnetCalculation(event: FormEvent) {
    event.preventDefault();
    setSubnetLoading(true);
    setSubnetError(null);
    setSubnetSubmittedIp(subnetIp.trim());
    try {
      setSubnetResult(await api.subnetCalculate(accessToken, { cidr: `${subnetIp.trim()}/${subnetPrefix}` }));
    } catch (err) {
      setSubnetError(err instanceof Error ? err.message : "Subnet calculation failed");
    } finally {
      setSubnetLoading(false);
    }
  }

  function applySelectedDevice() {
    if (!selectedDevice) {
      return;
    }
    const ip = selectedDevice.ip_address ?? "";
    setReverseDnsIp(ip);
    setPingHostValue(ip);
    setTracerouteHostValue(ip);
    setTcpHostValue(ip);
    if (selectedDevice.subnet) {
      const parts = selectedDevice.subnet.split("/");
      setSubnetIp(parts[0]);
      if (parts.length === 2) setSubnetPrefix(Number(parts[1]) || 24);
    }
  }

  return (
    <section className="tools-layout" id="tools">
      <div className="tools-toolbar">
        <div>
          <h2>Tools</h2>
        </div>
        {selectedDevice && (
          <div className="tool-target-strip">
            <span>Selected topology device</span>
            <strong>{deviceLabel(selectedDevice)}</strong>
            <button type="button" onClick={applySelectedDevice}>
              Use in forms
            </button>
          </div>
        )}
      </div>
      <div className="tools-content">
        <nav className="tools-nav">
          {([
            { id: "dns",         label: "DNS Lookup",        Icon: Search,               passive: true  },
            { id: "reverse-dns", label: "Reverse DNS",       Icon: IconWorld,             passive: true  },
            { id: "ping",        label: "Ping Test",         Icon: IconWifi,              passive: false },
            { id: "traceroute",  label: "Traceroute",        Icon: Network,               passive: false },
            { id: "tcp",         label: "TCP Port Check",    Icon: IconServer,            passive: false },
            { id: "subnet",      label: "Subnet Calculator", Icon: IconLayoutDashboard,   passive: true  },
          ] as const).map(({ id, label, Icon, passive }) => {
            const available = passive || canRunActiveTools;
            return (
              <button
                key={id}
                type="button"
                className={`tools-nav-item${activeTool === id ? " tools-nav-item--active" : ""}${!available ? " tools-nav-item--locked" : ""}`}
                onClick={() => setActiveTool(id)}
              >
                <Icon size={15} />
                <span className="tools-nav-label">{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="tools-main">
          <div className="tools-main-inner">
          {activeTool === "dns" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>DNS lookup</h3>
              <span className="tool-badge">Passive</span>
            </div>
            <form className="tool-form" onSubmit={runDnsLookup}>
              <label>
                Name
                <input required value={dnsName} onChange={(event) => setDnsName(event.target.value)} />
              </label>
              <label>
                Record type
                <select value={dnsRecordType} onChange={(event) => setDnsRecordType(event.target.value as DnsRecordType)}>
                  <option value="A">A</option>
                  <option value="AAAA">AAAA</option>
                  <option value="MX">MX</option>
                  <option value="TXT">TXT</option>
                  <option value="NS">NS</option>
                  <option value="CNAME">CNAME</option>
                </select>
              </label>
              <div className="tool-form-actions">
                <button type="submit" disabled={dnsLoading}>
                  {dnsLoading ? "Running..." : "Lookup"}
                </button>
              </div>
            </form>
            {dnsError && <div className="form-error">{dnsError}</div>}
            {dnsResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{dnsResult.source}</span>
                  <span>{dnsResult.duration_ms} ms</span>
                </div>
                {dnsResult.records.length === 0 ? (
                  <p className="tool-result-empty">No records returned.</p>
                ) : (
                  <ul className="tool-result-list">
                    {dnsResult.records.map((record) => (
                      <li key={`${dnsResult.record_type}-${record.value}`}>{record.value}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>}

          {activeTool === "reverse-dns" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>Reverse DNS</h3>
              <span className="tool-badge">Passive</span>
            </div>
            <form className="tool-form" onSubmit={runReverseDns}>
              <label>
                IP address
                <input required value={reverseDnsIp} onChange={(event) => setReverseDnsIp(event.target.value)} />
              </label>
              <div className="tool-form-actions">
                <button type="submit" disabled={reverseDnsLoading}>
                  {reverseDnsLoading ? "Running..." : "Lookup"}
                </button>
              </div>
            </form>
            {reverseDnsError && <div className="form-error">{reverseDnsError}</div>}
            {reverseDnsResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{reverseDnsResult.source}</span>
                  <span>{reverseDnsResult.duration_ms} ms</span>
                </div>
                {reverseDnsResult.ptr_records.length === 0 ? (
                  <p className="tool-result-empty">No PTR records returned.</p>
                ) : (
                  <ul className="tool-result-list">
                    {reverseDnsResult.ptr_records.map((record) => (
                      <li key={record}>{record}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>}

          {activeTool === "ping" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>Ping test</h3>
              <span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>
                {canRunActiveTools ? "Active" : "Restricted"}
              </span>
            </div>
            <form className="tool-form" onSubmit={runPing}>
              <label>
                Host
                <input required disabled={!canRunActiveTools} value={pingHostValue} onChange={(event) => setPingHostValue(event.target.value)} />
              </label>
              <div className="tool-form-grid">
                <label>
                  Count
                  <input
                    min={1}
                    max={10}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={pingCount}
                    onChange={(event) => setPingCount(event.target.value)}
                  />
                </label>
                <label>
                  Timeout
                  <input
                    min={1}
                    max={30}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={pingTimeout}
                    onChange={(event) => setPingTimeout(event.target.value)}
                  />
                </label>
              </div>
              <div className="tool-form-actions">
                <button type="submit" disabled={pingLoading || !canRunActiveTools}>
                  {pingLoading ? "Running..." : "Ping"}
                </button>
              </div>
            </form>
            {!canRunActiveTools && <p className="tool-note">Active tools are disabled for this role.</p>}
            {pingError && <div className="form-error">{pingError}</div>}
            {pingResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{pingResult.host}</span>
                  <span>{pingResult.duration_ms} ms</span>
                </div>
                <dl className="tool-result-pairs">
                  <dt>Packets</dt>
                  <dd>{`${pingResult.received ?? 0}/${pingResult.transmitted ?? 0}`}</dd>
                  <dt>Loss</dt>
                  <dd>{pingResult.packet_loss !== null ? `${pingResult.packet_loss}%` : "-"}</dd>
                  <dt>Avg RTT</dt>
                  <dd>{formatMs(pingResult.average_ms)}</dd>
                </dl>
                <pre className="tool-output">{pingResult.raw_output}</pre>
              </div>
            )}
          </section>}

          {activeTool === "traceroute" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>Traceroute</h3>
              <span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>
                {canRunActiveTools ? "Active" : "Restricted"}
              </span>
            </div>
            <form className="tool-form" onSubmit={runTraceroute}>
              <label>
                Host
                <input required disabled={!canRunActiveTools} value={tracerouteHostValue} onChange={(event) => setTracerouteHostValue(event.target.value)} />
              </label>
              <div className="tool-form-grid">
                <label>
                  Max hops
                  <input
                    min={1}
                    max={64}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={tracerouteMaxHops}
                    onChange={(event) => setTracerouteMaxHops(event.target.value)}
                  />
                </label>
                <label>
                  Timeout
                  <input
                    min={1}
                    max={60}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={tracerouteTimeout}
                    onChange={(event) => setTracerouteTimeout(event.target.value)}
                  />
                </label>
              </div>
              <div className="tool-form-actions">
                <button type="submit" disabled={tracerouteLoading || !canRunActiveTools}>
                  {tracerouteLoading ? "Running..." : "Trace route"}
                </button>
              </div>
            </form>
            {!canRunActiveTools && <p className="tool-note">Active tools are disabled for this role.</p>}
            {tracerouteError && <div className="form-error">{tracerouteError}</div>}
            {tracerouteResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{tracerouteResult.host}</span>
                  <span>{tracerouteResult.duration_ms} ms</span>
                </div>
                {tracerouteResult.hops.length === 0 ? (
                  <p className="tool-result-empty">No hops parsed from traceroute output.</p>
                ) : (
                  <div className="tool-hop-list">
                    {tracerouteResult.hops.map((hop) => (
                      <div className="tool-hop-row" key={`${hop.hop}-${hop.address || "unknown"}`}>
                        <span>Hop {hop.hop}</span>
                        <span>{hop.address || hop.host || "*"}</span>
                        <span>{formatMs(hop.rtt_ms)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>}

          {activeTool === "tcp" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>TCP port check</h3>
              <span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>
                {canRunActiveTools ? "Active" : "Restricted"}
              </span>
            </div>
            <form className="tool-form" onSubmit={runTcpCheck}>
              <label>
                Host
                <input required disabled={!canRunActiveTools} value={tcpHostValue} onChange={(event) => setTcpHostValue(event.target.value)} />
              </label>
              <div className="tool-form-grid">
                <label>
                  Port
                  <input
                    min={1}
                    max={65535}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={tcpPort}
                    onChange={(event) => setTcpPort(event.target.value)}
                  />
                </label>
                <label>
                  Timeout
                  <input
                    min={1}
                    max={30}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={tcpTimeout}
                    onChange={(event) => setTcpTimeout(event.target.value)}
                  />
                </label>
              </div>
              <div className="tool-form-actions">
                <button type="submit" disabled={tcpLoading || !canRunActiveTools}>
                  {tcpLoading ? "Running..." : "Check port"}
                </button>
              </div>
            </form>
            {!canRunActiveTools && <p className="tool-note">Active tools are disabled for this role.</p>}
            {tcpError && <div className="form-error">{tcpError}</div>}
            {tcpResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{`${tcpResult.host}:${tcpResult.port}`}</span>
                  <span>{tcpResult.duration_ms} ms</span>
                </div>
                <p className={tcpResult.reachable ? "tool-status success" : "tool-status danger"}>
                  {tcpResult.reachable ? "Reachable" : "Unreachable"}
                </p>
                <p className="tool-note">{tcpResult.detail}</p>
              </div>
            )}
          </section>}

          {activeTool === "subnet" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>Subnet calculator</h3>
              <span className="tool-badge">Passive</span>
            </div>
            <form className="tool-form" onSubmit={runSubnetCalculation}>
              <div className="subnet-input-row">
                <label className="subnet-ip-label">
                  IP Address
                  <input required placeholder="192.168.1.0" value={subnetIp} onChange={(e) => setSubnetIp(e.target.value)} />
                </label>
                <label className="subnet-prefix-label">
                  Prefix / Mask
                  <select value={subnetPrefix} onChange={(e) => setSubnetPrefix(Number(e.target.value))}>
                    {Array.from({ length: 32 }, (_, i) => i + 1).map((p) => (
                      <option key={p} value={p}>{`/${p} — ${prefixToMask(p)}`}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="tool-form-actions">
                <button type="submit" disabled={subnetLoading}>
                  {subnetLoading ? "Calculating…" : "Calculate"}
                </button>
              </div>
            </form>
            {subnetError && <div className="form-error">{subnetError}</div>}
            {subnetResult && (
              <div className="tool-result">
                <dl className="subnet-result-dl">
                  <div className="subnet-row subnet-row--highlight">
                    <dt>Usable host range</dt>
                    <dd>
                      {subnetResult.first_host && subnetResult.last_host
                        ? `${subnetResult.first_host} – ${subnetResult.last_host}`
                        : "N/A (host address)"}
                    </dd>
                  </div>
                  <div className="subnet-row">
                    <dt>Network address</dt>
                    <dd>{subnetResult.network}/{subnetResult.prefix_length}</dd>
                  </div>
                  {subnetResult.broadcast && (
                    <div className="subnet-row">
                      <dt>Broadcast address</dt>
                      <dd>{subnetResult.broadcast}</dd>
                    </div>
                  )}
                  <div className="subnet-row">
                    <dt>Subnet mask</dt>
                    <dd>{subnetResult.netmask}</dd>
                  </div>
                  <div className="subnet-row">
                    <dt>Wildcard mask</dt>
                    <dd>{wildcardMask(subnetResult.netmask)}</dd>
                  </div>
                  <div className="subnet-row">
                    <dt>Total hosts</dt>
                    <dd>{subnetResult.total_addresses.toLocaleString()}</dd>
                  </div>
                  <div className="subnet-row">
                    <dt>Usable hosts</dt>
                    <dd>{subnetResult.usable_hosts.toLocaleString()}</dd>
                  </div>
                  {subnetResult.version === 4 && subnetSubmittedIp && (
                    <>
                      <div className="subnet-row">
                        <dt>IP class</dt>
                        <dd>Class {ipClass(subnetSubmittedIp)}</dd>
                      </div>
                      <div className="subnet-row">
                        <dt>IP type</dt>
                        <dd>{ipType(subnetSubmittedIp)}</dd>
                      </div>
                    </>
                  )}
                </dl>
                <div className="subnet-ref">
                  <div className="subnet-ref-title">Common subnet reference</div>
                  <table className="subnet-ref-table">
                    <thead>
                      <tr>
                        <th>Prefix</th>
                        <th>Subnet mask</th>
                        <th>Usable hosts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SUBNET_REF.map((row) => (
                        <tr key={row.prefix} className={row.prefix === subnetResult.prefix_length ? "subnet-ref-current" : ""}>
                          <td>/{row.prefix}</td>
                          <td>{row.mask}</td>
                          <td>{row.hosts.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>}

          </div>
        </div>
      </div>
    </section>
  );
}

function ExportsWorkspace({
  accessToken,
  user,
}: {
  accessToken: string;
  user: User;
}) {
  const canExportInventory = user.role === "SuperAdmin" || user.role === "NetworkAdmin";
  const canExportFirewall =
    user.role === "SuperAdmin" || user.role === "NetworkAdmin" || user.role === "SecurityAnalyst";
  const [firewallFormat, setFirewallFormat] = useState<"csv" | "json">("csv");
  const [inventoryFormat, setInventoryFormat] = useState<"csv" | "json">("csv");
  const [firewallFilters, setFirewallFilters] = useState({
    q: "",
    src_ip: "",
    dst_ip: "",
    action: "",
    protocol: "",
    interface: "",
    limit: "5000",
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runDownload(key: string, action: () => Promise<DownloadResult>) {
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      triggerDownload(result);
      setMessage(`Downloaded ${result.filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="exports-layout">
      <div className="tools-toolbar">
        <div>
          <h2>Exports</h2>
          <p>Data portability, reporting, and backup operations with role-based access and audit logging.</p>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      <div className="tools-grid exports-grid">
        <section className="tool-card">
          <div className="tool-card-header">
            <h3>Device Inventory</h3>
            <span className={`tool-badge ${canExportInventory ? "active" : "locked"}`}>
              {canExportInventory ? "Allowed" : "Restricted"}
            </span>
          </div>
          <div className="tool-form">
            <label>
              Format
              <select
                disabled={!canExportInventory}
                value={inventoryFormat}
                onChange={(event) => setInventoryFormat(event.target.value as "csv" | "json")}
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </label>
            <button
              type="button"
              disabled={!canExportInventory || busyKey === "inventory"}
              onClick={() => runDownload("inventory", () => api.downloadInventory(accessToken, inventoryFormat))}
            >
              {busyKey === "inventory" ? "Preparing..." : "Download inventory"}
            </button>
          </div>
          {!canExportInventory && <p className="tool-note">Only NetworkAdmin and SuperAdmin can export inventory data.</p>}
        </section>

        <section className="tool-card">
          <div className="tool-card-header">
            <h3>Firewall Events</h3>
            <span className={`tool-badge ${canExportFirewall ? "active" : "locked"}`}>
              {canExportFirewall ? "Allowed" : "Restricted"}
            </span>
          </div>
          <div className="tool-form">
            <label>
              Format
              <select
                disabled={!canExportFirewall}
                value={firewallFormat}
                onChange={(event) => setFirewallFormat(event.target.value as "csv" | "json")}
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </label>
            <div className="tool-form-grid">
              <label>
                Search
                <input
                  disabled={!canExportFirewall}
                  value={firewallFilters.q}
                  onChange={(event) => setFirewallFilters((current) => ({ ...current, q: event.target.value }))}
                />
              </label>
              <label>
                Source IP
                <input
                  disabled={!canExportFirewall}
                  value={firewallFilters.src_ip}
                  onChange={(event) => setFirewallFilters((current) => ({ ...current, src_ip: event.target.value }))}
                />
              </label>
              <label>
                Destination IP
                <input
                  disabled={!canExportFirewall}
                  value={firewallFilters.dst_ip}
                  onChange={(event) => setFirewallFilters((current) => ({ ...current, dst_ip: event.target.value }))}
                />
              </label>
              <label>
                Action
                <input
                  disabled={!canExportFirewall}
                  value={firewallFilters.action}
                  onChange={(event) => setFirewallFilters((current) => ({ ...current, action: event.target.value }))}
                />
              </label>
              <label>
                Protocol
                <input
                  disabled={!canExportFirewall}
                  value={firewallFilters.protocol}
                  onChange={(event) => setFirewallFilters((current) => ({ ...current, protocol: event.target.value }))}
                />
              </label>
              <label>
                Interface
                <input
                  disabled={!canExportFirewall}
                  value={firewallFilters.interface}
                  onChange={(event) => setFirewallFilters((current) => ({ ...current, interface: event.target.value }))}
                />
              </label>
            </div>
            <label>
              Row limit
              <input
                min={1}
                max={10000}
                type="number"
                disabled={!canExportFirewall}
                value={firewallFilters.limit}
                onChange={(event) => setFirewallFilters((current) => ({ ...current, limit: event.target.value }))}
              />
            </label>
            <button
              type="button"
              disabled={!canExportFirewall || busyKey === "firewall"}
              onClick={() =>
                runDownload("firewall", () =>
                  api.downloadFirewallExport(accessToken, {
                    format: firewallFormat,
                    q: firewallFilters.q,
                    src_ip: firewallFilters.src_ip,
                    dst_ip: firewallFilters.dst_ip,
                    action: firewallFilters.action,
                    protocol: firewallFilters.protocol,
                    interface: firewallFilters.interface,
                    limit: Number(firewallFilters.limit) || 5000,
                  }),
                )
              }
            >
              {busyKey === "firewall" ? "Preparing..." : "Download firewall export"}
            </button>
          </div>
          {!canExportFirewall && <p className="tool-note">Viewer cannot export firewall data.</p>}
        </section>

        <section className="tool-card">
          <div className="tool-card-header">
            <h3>Network Report</h3>
            <span className={`tool-badge ${canExportInventory ? "active" : "locked"}`}>
              {canExportInventory ? "Allowed" : "Restricted"}
            </span>
          </div>
          <p className="tool-note">
            Generates a simple PDF with topology summary, inventory snapshot, subnet summary, and blocked traffic leaders.
          </p>
          <button
            type="button"
            disabled={!canExportInventory || busyKey === "report"}
            onClick={() => runDownload("report", () => api.downloadReport(accessToken))}
          >
            {busyKey === "report" ? "Preparing..." : "Download PDF report"}
          </button>
        </section>

      </div>
    </section>
  );
}

function IconPickerGlyph({
  def,
  active,
  strokeColor,
}: {
  def: IconGlyphDefinition;
  active: boolean;
  strokeColor: string;
}) {
  if (def.url) {
    return <img src={def.url} width={32} height={32} alt={def.label} className="icon-picker-img" />;
  }
  return (
    <svg viewBox="0 0 24 24" width={32} height={32} fill="none" stroke={active ? strokeColor : "#5b7c91"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <g dangerouslySetInnerHTML={{ __html: def.path ?? "" }} />
    </svg>
  );
}

function IconPickerModal({
  value,
  strokeColor = "#3b7cc9",
  onSelect,
  onClose,
}: {
  value: string;
  strokeColor?: string;
  onSelect: (icon: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<string>("all");
  const packs = allRuntimePacks;
  const showTabs = packs.length > 1;

  const allIcons = useMemo<IconGlyphDefinition[]>(() => {
    const seen = new Set<string>();
    const out: IconGlyphDefinition[] = [];
    for (const pack of packs) {
      for (const icon of pack.icons) {
        if (!seen.has(icon.value)) {
          seen.add(icon.value);
          out.push(icon);
        }
      }
    }
    return out;
  }, [packs]);

  const tabIcons = useMemo<IconGlyphDefinition[]>(() => {
    if (activeTab === "all") return allIcons;
    return packs.find((p) => p.id === activeTab)?.icons ?? [];
  }, [activeTab, allIcons, packs]);

  const q = search.trim().toLowerCase();
  const filtered = q ? tabIcons.filter((o) => o.label.toLowerCase().includes(q)) : tabIcons;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="icon-picker-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="icon-picker-modal" role="dialog" aria-label="Choose icon">
        <div className="icon-picker-header">
          <span className="icon-picker-title">Choose icon</span>
          <button type="button" className="icon-picker-close" onClick={onClose}>✕</button>
        </div>
        <div className="icon-picker-search-row">
          <input
            autoFocus
            className="icon-picker-search"
            placeholder="Search icons…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {showTabs && (
          <div className="icon-picker-tabs">
            <button
              type="button"
              className={`icon-picker-tab${activeTab === "all" ? " active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              All
            </button>
            {packs.map((pack) => (
              <button
                key={pack.id}
                type="button"
                className={`icon-picker-tab${activeTab === pack.id ? " active" : ""}`}
                onClick={() => setActiveTab(pack.id)}
              >
                {pack.name}
              </button>
            ))}
          </div>
        )}
        <div className="icon-picker-grid">
          {filtered.map((def) => {
            const active = def.value === value;
            return (
              <button
                key={def.value}
                type="button"
                className={`icon-picker-item${active ? " selected" : ""}`}
                title={def.label}
                onClick={() => { onSelect(def.value); onClose(); }}
              >
                <IconPickerGlyph def={def} active={active} strokeColor={strokeColor} />
                <span>{def.label}</span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="icon-picker-empty">
              {q ? `No icons match "${search}"` : "No icons in this pack"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DeviceTypeIconPicker({
  currentIcon,
  onSelect,
}: {
  currentIcon: string;
  onSelect: (icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dtype-icon-picker">
      <button
        type="button"
        className="dtype-icon-current"
        title="Click to change icon"
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="#3b7cc9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <g dangerouslySetInnerHTML={{ __html: deviceIconPath(currentIcon) }} />
        </svg>
        <span>{iconLabel(currentIcon)}</span>
        <ChevronDown size={10} />
      </button>
      {open && (
        <IconPickerModal
          value={currentIcon}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function IconPickerTrigger({
  value,
  color,
  onChange,
}: {
  value: string;
  color?: string;
  onChange: (icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const strokeColor = color || "#3b7cc9";
  return (
    <div className="icon-picker-trigger-wrap">
      <button
        type="button"
        className="icon-picker-trigger-btn"
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <g dangerouslySetInnerHTML={{ __html: deviceIconPath(value) }} />
        </svg>
        <div className="icon-picker-trigger-text">
          <span className="icon-picker-trigger-name">{iconLabel(value)}</span>
          <span className="icon-picker-trigger-hint">Click to change</span>
        </div>
        <ChevronDown size={13} className="icon-picker-trigger-chevron" />
      </button>
      {open && (
        <IconPickerModal
          value={value}
          strokeColor={strokeColor}
          onSelect={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function IconManagerModal({
  activeIconPackId,
  iconPacks,
  localIconPacks,
  iconPackLoading,
  iconPackError,
  onSelectIconPack,
  onAddLocalIconPack,
  onRemoveLocalIconPack,
  onClose,
}: {
  activeIconPackId: string;
  iconPacks: IconPack[];
  localIconPacks: IconPack[];
  iconPackLoading: boolean;
  iconPackError: string | null;
  onSelectIconPack: (id: string) => void;
  onAddLocalIconPack: (pack: IconPack) => void;
  onRemoveLocalIconPack: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"packs" | "import" | "device-types">("packs");
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalSuccess, setModalSuccess] = useState<string | null>(null);
  const [typeIconMap, setTypeIconMap] = useState<Record<string, string>>(() => readDeviceTypeIconMap());
  const [typeIconSaved, setTypeIconSaved] = useState(false);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const allPacksList = [
    { pack: builtInIconPack, isLocal: false },
    ...iconPacks.map((p) => ({ pack: p, isLocal: false })),
    ...localIconPacks.filter((lp) => !iconPacks.some((sp) => sp.id === lp.id)).map((p) => ({ pack: p, isLocal: true })),
  ];

  async function handleImportJson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("icon_pack_file") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;
    setBusy(true); setModalError(null); setModalSuccess(null);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as { id?: unknown; name?: unknown; icons?: unknown };
      const id = String(parsed.id ?? file.name.replace(/\.json$/i, "")).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      const name = String(parsed.name ?? id).trim();
      const icons = sanitizeIconDefs(parsed.icons);
      if (!id || !name || icons.length === 0) throw new Error("Invalid icon pack JSON. Expected: { id, name, icons[] }");
      onAddLocalIconPack({ id, name, icons });
      onSelectIconPack(id);
      setModalSuccess(`Imported "${name}" — ${icons.length} icons`);
      event.currentTarget.reset();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Failed to import icon pack");
    } finally { setBusy(false); }
  }

  async function handleImportSvg(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fileInput = event.currentTarget.elements.namedItem("icon_pack_svg_folder") as HTMLInputElement | null;
    const nameInput = event.currentTarget.elements.namedItem("icon_pack_svg_name") as HTMLInputElement | null;
    const idInput = event.currentTarget.elements.namedItem("icon_pack_svg_id") as HTMLInputElement | null;
    const files = Array.from(fileInput?.files ?? []).filter((f) => f.name.toLowerCase().endsWith(".svg"));
    const requestedName = nameInput?.value.trim() || "";
    const requestedId = slugifyIconValue(idInput?.value.trim() || requestedName || "custom-svg-pack");
    if (!requestedId || files.length === 0) { setModalError("Select a folder of SVG files and provide a pack name."); return; }
    setBusy(true); setModalError(null); setModalSuccess(null);
    try {
      const icons: IconGlyphDefinition[] = [];
      for (const file of files) {
        const path = extractSvgIconMarkup(await file.text());
        if (!path) continue;
        const base = file.name.replace(/\.svg$/i, "");
        const value = slugifyIconValue(base);
        if (value) icons.push({ value, label: labelFromIconValue(base), path });
      }
      if (icons.length === 0) throw new Error("No valid SVG shapes found in the selected folder.");
      const deduped = new Map<string, IconGlyphDefinition>();
      icons.forEach((i) => deduped.set(i.value, i));
      const pack: IconPack = { id: requestedId, name: requestedName || labelFromIconValue(requestedId), icons: Array.from(deduped.values()) };
      onAddLocalIconPack(pack); onSelectIconPack(pack.id);
      setModalSuccess(`Imported ${pack.icons.length} SVG icons as "${pack.name}"`);
      event.currentTarget.reset();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Failed to import SVG folder");
    } finally { setBusy(false); }
  }

  async function handleImportPng(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fileInput = event.currentTarget.elements.namedItem("icon_pack_png_folder") as HTMLInputElement | null;
    const nameInput = event.currentTarget.elements.namedItem("icon_pack_png_name") as HTMLInputElement | null;
    const idInput = event.currentTarget.elements.namedItem("icon_pack_png_id") as HTMLInputElement | null;
    const files = Array.from(fileInput?.files ?? []).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f.name));
    const requestedName = nameInput?.value.trim() || "";
    const requestedId = slugifyIconValue(idInput?.value.trim() || requestedName || "custom-png-pack");
    if (!requestedId || files.length === 0) { setModalError("Select a folder of image files and provide a pack name."); return; }
    setBusy(true); setModalError(null); setModalSuccess(null);
    try {
      const MAX = 256 * 1024;
      const icons: IconGlyphDefinition[] = [];
      for (const file of files) {
        if (file.size > MAX) throw new Error(`"${file.name}" exceeds the 256 KB limit.`);
        const url = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = () => rej(new Error(`Failed to read ${file.name}`));
          r.readAsDataURL(file);
        });
        const base = file.name.replace(/\.(png|jpg|jpeg|gif|webp)$/i, "");
        const value = slugifyIconValue(base);
        if (value) icons.push({ value, label: labelFromIconValue(base), url });
      }
      if (icons.length === 0) throw new Error("No valid image files found.");
      const deduped = new Map<string, IconGlyphDefinition>();
      icons.forEach((i) => deduped.set(i.value, i));
      const pack: IconPack = { id: requestedId, name: requestedName || labelFromIconValue(requestedId), icons: Array.from(deduped.values()) };
      onAddLocalIconPack(pack); onSelectIconPack(pack.id);
      setModalSuccess(`Imported ${pack.icons.length} images as "${pack.name}"`);
      event.currentTarget.reset();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Failed to import images");
    } finally { setBusy(false); }
  }

  return (
    <div className="icon-mgr-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="icon-mgr-modal" role="dialog" aria-label="Icon manager">
        <div className="icon-mgr-header">
          <span className="icon-mgr-title">Icon Manager</span>
          <button type="button" className="icon-picker-close" onClick={onClose}>✕</button>
        </div>
        <div className="icon-mgr-tabs">
          {(["packs", "import", "device-types"] as const).map((t) => (
            <button key={t} type="button" className={`icon-mgr-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {t === "packs" ? "Packs" : t === "import" ? "Import" : "Device types"}
            </button>
          ))}
        </div>

        {(modalError || iconPackError) && (
          <div className="icon-mgr-banner icon-mgr-banner--error">{modalError ?? iconPackError}</div>
        )}
        {modalSuccess && <div className="icon-mgr-banner icon-mgr-banner--success">{modalSuccess}</div>}

        <div className="icon-mgr-body">
          {tab === "packs" && (
            <div className="icon-mgr-packs-list">
              {iconPackLoading && <p className="tool-note" style={{ padding: "8px 16px" }}>Loading server packs…</p>}
              {allPacksList.map(({ pack, isLocal }) => {
                const isActive = pack.id === activeIconPackId;
                return (
                  <div key={pack.id} className={`icon-mgr-pack-row${isActive ? " active" : ""}`}>
                    <div className="icon-mgr-pack-meta">
                      <div className="icon-mgr-pack-name-row">
                        <span className="icon-mgr-pack-name">{pack.name}</span>
                        {isActive && <span className="icon-mgr-badge">Active</span>}
                        {isLocal && <span className="icon-mgr-badge icon-mgr-badge--local">Local</span>}
                      </div>
                      <span className="icon-mgr-pack-count">{pack.icons.length} icon{pack.icons.length !== 1 ? "s" : ""}</span>
                      <div className="icon-mgr-pack-preview">
                        {pack.icons.slice(0, 10).map((icon) => (
                          <div key={icon.value} className="icon-mgr-preview-item" title={icon.label}>
                            {icon.url ? (
                              <img src={icon.url} width={18} height={18} alt={icon.label} style={{ objectFit: "contain" }} />
                            ) : (
                              <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke={isActive ? "#2196a0" : "#7a9fb8"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <g dangerouslySetInnerHTML={{ __html: icon.path ?? "" }} />
                              </svg>
                            )}
                          </div>
                        ))}
                        {pack.icons.length > 10 && <span className="icon-mgr-preview-more">+{pack.icons.length - 10}</span>}
                      </div>
                    </div>
                    <div className="icon-mgr-pack-actions">
                      {!isActive && (
                        <button type="button" className="icon-mgr-btn" onClick={() => { onSelectIconPack(pack.id); setModalSuccess(`Switched to "${pack.name}"`); }}>
                          Use this pack
                        </button>
                      )}
                      {isLocal && (
                        <button type="button" className="icon-mgr-btn icon-mgr-btn--danger" onClick={() => onRemoveLocalIconPack(pack.id)}>
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              <p className="tool-note" style={{ padding: "12px 16px 4px", fontSize: 11 }}>
                Server packs can also be added via <code>dev/frontend/public/icon-packs/</code>.
              </p>
            </div>
          )}

          {tab === "import" && (
            <div className="icon-mgr-import-sections">
              <div className="icon-mgr-import-section">
                <div className="icon-mgr-section-header">
                  <span className="icon-mgr-section-title">JSON Pack</span>
                  <span className="icon-mgr-section-desc">Import a pre-built icon pack <code>.json</code> file</span>
                </div>
                <form className="icon-mgr-form" onSubmit={(e) => void handleImportJson(e)}>
                  <input name="icon_pack_file" type="file" accept="application/json,.json" />
                  <button type="submit" disabled={busy}>{busy ? "Importing…" : "Import"}</button>
                </form>
              </div>
              <div className="icon-mgr-import-section">
                <div className="icon-mgr-section-header">
                  <span className="icon-mgr-section-title">SVG Folder</span>
                  <span className="icon-mgr-section-desc">Icons adapt to device colors automatically</span>
                </div>
                <form className="icon-mgr-form" onSubmit={(e) => void handleImportSvg(e)}>
                  <label>SVG files
                    <input name="icon_pack_svg_folder" type="file" accept=".svg,image/svg+xml" multiple
                      {...({ webkitdirectory: "true", directory: "true" } as Record<string, string>)} />
                  </label>
                  <div className="icon-mgr-form-row">
                    <label>Pack name <input name="icon_pack_svg_name" placeholder="My SVG Pack" /></label>
                    <label>Pack id <input name="icon_pack_svg_id" placeholder="my-svg-pack" /></label>
                  </div>
                  <button type="submit" disabled={busy}>{busy ? "Importing…" : "Import SVG folder"}</button>
                </form>
              </div>
              <div className="icon-mgr-import-section">
                <div className="icon-mgr-section-header">
                  <span className="icon-mgr-section-title">PNG / Image Folder</span>
                  <span className="icon-mgr-section-desc">PNG, JPG, GIF or WebP — stored as-is, max 256 KB per file</span>
                </div>
                <form className="icon-mgr-form" onSubmit={(e) => void handleImportPng(e)}>
                  <label>Image files
                    <input name="icon_pack_png_folder" type="file"
                      accept=".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp" multiple
                      {...({ webkitdirectory: "true", directory: "true" } as Record<string, string>)} />
                  </label>
                  <div className="icon-mgr-form-row">
                    <label>Pack name <input name="icon_pack_png_name" placeholder="My PNG Pack" /></label>
                    <label>Pack id <input name="icon_pack_png_id" placeholder="my-png-pack" /></label>
                  </div>
                  <button type="submit" disabled={busy}>{busy ? "Importing…" : "Import image folder"}</button>
                </form>
              </div>
            </div>
          )}

          {tab === "device-types" && (
            <div className="icon-mgr-device-types">
              <p className="tool-note" style={{ padding: "0 0 12px" }}>
                Set the default icon for each device type — applied automatically when a type is selected in the device form.
              </p>
              <div className="device-type-icon-grid">
                {deviceTypeOptions.map((type) => (
                  <div key={type} className="device-type-icon-row">
                    <span className="dtype-type-label">{formatDeviceTypeLabel(type)}</span>
                    <DeviceTypeIconPicker
                      currentIcon={typeIconMap[type] || "unknown"}
                      onSelect={(icon) => setTypeIconMap((c) => ({ ...c, [type]: icon }))}
                    />
                  </div>
                ))}
              </div>
              <div className="icon-mgr-device-types-actions">
                <button type="button" onClick={() => { applyDeviceTypeIconMap(typeIconMap); setTypeIconSaved(true); setTimeout(() => setTypeIconSaved(false), 2000); }}>
                  Save mapping
                </button>
                <button type="button" onClick={() => { const d = { ...defaultDeviceTypeIconMap }; setTypeIconMap(d); applyDeviceTypeIconMap(d); }}>
                  Reset to defaults
                </button>
                {typeIconSaved && <span className="icon-mgr-saved-tick">Saved ✓</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminWorkspace({
  accessToken,
  graph,
  summary,
  activeIconPackId,
  iconPackError,
  iconPackLoading,
  iconPacks,
  localIconPacks,
  onSelectIconPack,
  onAddLocalIconPack,
  onRemoveLocalIconPack,
}: {
  accessToken: string;
  graph: TopologyGraph;
  summary: DashboardSummary | null;
  activeIconPackId: string;
  iconPackError: string | null;
  iconPackLoading: boolean;
  iconPacks: IconPack[];
  localIconPacks: IconPack[];
  onSelectIconPack: (packId: string) => void;
  onAddLocalIconPack: (pack: IconPack) => void;
  onRemoveLocalIconPack: (packId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<"system" | "users" | "security" | "notifications" | "alerts" | "groups">("system");
  const [users, setUsers] = useState<User[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [syslogStatus, setSyslogStatus] = useState<SyslogStatus | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLogsTotal, setAuditLogsTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditUserFilter, setAuditUserFilter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [resetPasswordForm, setResetPasswordForm] = useState<{ userId: number | null; password: string }>({ userId: null, password: "" });
  const [editingEmailId, setEditingEmailId] = useState<number | null>(null);
  const [editingEmailValue, setEditingEmailValue] = useState("");
  const [settingsForm, setSettingsForm] = useState<SystemSettings>({ app_name: "NetMap", login_message: "", announcement: "", live_ping_enabled: true, idle_timeout_minutes: 15 });
  const [idleTimeoutRaw, setIdleTimeoutRaw] = useState("15");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({ username: "", password: "", email: "", role: "Viewer", is_active: true });
  const [iconModalOpen, setIconModalOpen] = useState(false);
  const [notifSettings, setNotifSettings] = useState<NotificationSettings>({
    ntfy_url: "", ntfy_token: "",
    telegram_bot_token: "", telegram_chat_id: "",
    signal_url: "", signal_number: "", signal_recipient: "",
    smtp_host: "", smtp_port: "587", smtp_user: "", smtp_password: "", smtp_from: "", smtp_to: "", smtp_tls: "true",
  });
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifTestResult, setNotifTestResult] = useState<Record<string, string>>({});
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [alertRulesBusy, setAlertRulesBusy] = useState(false);
  const [alertRulesError, setAlertRulesError] = useState<string | null>(null);
  const [alertTestResults, setAlertTestResults] = useState<Record<number, Record<string, string>>>({});
  const [alertTestBusy, setAlertTestBusy] = useState<number | null>(null);
  const [showAlertForm, setShowAlertForm] = useState(false);
  const [editingAlertRule, setEditingAlertRule] = useState<AlertRule | null>(null);
  const [alertForm, setAlertForm] = useState<AlertRulePayload>({
    name: "",
    enabled: true,
    event_type: "device_offline",
    device_id: null,
    channels: [],
    cooldown_minutes: 30,
  });
  const [rolePermissions, setRolePermissions] = useState<RolePermissions | null>(null);
  const [localRolePerms, setLocalRolePerms] = useState<Record<string, string[]>>({});
  const [groupsBusy, setGroupsBusy] = useState(false);
  const [showNewGroupForm, setShowNewGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  async function loadAdminData() {
    setLoading(true);
    setError(null);
    try {
      const [userRows, syslog, settingsData] = await Promise.all([
        api.listUsers(accessToken),
        api.syslogStatus(accessToken),
        api.adminSettings(accessToken),
      ]);
      setUsers(userRows);
      setSyslogStatus(syslog);
      setSettingsForm(settingsData);
      setIdleTimeoutRaw(String(settingsData.idle_timeout_minutes));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load admin data");
    } finally {
      setLoading(false);
    }
  }

  async function loadAuditLogs(offset = 0, userId: number | null = null) {
    try {
      const params: { limit: number; offset: number; actor_user_id?: number } = { limit: 50, offset };
      if (userId !== null) params.actor_user_id = userId;
      const result = await api.listAuditLogs(accessToken, params);
      setAuditLogs(result.records);
      setAuditLogsTotal(result.total);
      setAuditOffset(offset);
      setAuditUserFilter(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load audit logs");
    }
  }

  useEffect(() => { void loadAdminData(); }, [accessToken]);
  useEffect(() => { if (activeTab === "security") void loadAuditLogs(0, null); }, [activeTab]);
  useEffect(() => {
    if (activeTab !== "notifications") return;
    void api.getNotificationSettings(accessToken).then(setNotifSettings).catch(() => {});
  }, [activeTab, accessToken]);
  useEffect(() => { if (activeTab === "alerts") void loadAlertRules(); }, [activeTab]);
  useEffect(() => {
    if (activeTab !== "groups") return;
    void api.getRolePermissions(accessToken).then((data) => {
      setRolePermissions(data);
      setLocalRolePerms(data.roles);
    }).catch(() => {});
  }, [activeTab, accessToken]);

  async function saveRolePermissions() {
    setGroupsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateRolePermissions(accessToken, localRolePerms);
      setRolePermissions(updated);
      setLocalRolePerms(updated.roles);
      setSuccess("Role permissions saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save role permissions");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function createGroup(name: string) {
    if (!name.trim()) return;
    setGroupsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.createRole(accessToken, name.trim());
      setRolePermissions(updated);
      setLocalRolePerms(updated.roles);
      setNewGroupName("");
      setShowNewGroupForm(false);
      setSuccess(`Role "${name.trim()}" created.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create role");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function deleteGroup(name: string) {
    setGroupsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.deleteRole(accessToken, name);
      setRolePermissions(updated);
      setLocalRolePerms(updated.roles);
      setSuccess(`Role "${name}" deleted. Affected users reassigned to Viewer.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete role");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function saveNotifSettings() {
    setNotifBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateNotificationSettings(accessToken, notifSettings);
      setNotifSettings(updated);
      setSuccess("Notification settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save notification settings");
    } finally { setNotifBusy(false); }
  }

  async function testNotif(channel: string) {
    setNotifTestResult((c) => ({ ...c, [channel]: "Sending…" }));
    try {
      await api.updateNotificationSettings(accessToken, notifSettings);
      const res = await api.testNotification(accessToken, channel);
      setNotifTestResult((c) => ({ ...c, [channel]: res.status === "ok" ? "Sent successfully" : res.status }));
    } catch (err) {
      setNotifTestResult((c) => ({ ...c, [channel]: err instanceof Error ? err.message : "Failed" }));
    }
  }

  async function loadAlertRules() {
    try {
      const rules = await api.listAlertRules(accessToken);
      setAlertRules(rules);
    } catch {
      // silent
    }
  }

  async function saveAlertRule() {
    setAlertRulesBusy(true);
    setAlertRulesError(null);
    try {
      if (editingAlertRule) {
        await api.updateAlertRule(accessToken, editingAlertRule.id, alertForm);
      } else {
        await api.createAlertRule(accessToken, alertForm);
      }
      setShowAlertForm(false);
      setEditingAlertRule(null);
      await loadAlertRules();
    } catch (err) {
      setAlertRulesError(err instanceof Error ? err.message : "Failed to save rule");
    } finally {
      setAlertRulesBusy(false);
    }
  }

  async function deleteAlertRule(id: number) {
    try {
      await api.deleteAlertRule(accessToken, id);
      await loadAlertRules();
    } catch {
      // silent
    }
  }

  async function toggleAlertRule(rule: AlertRule) {
    await api.updateAlertRule(accessToken, rule.id, { enabled: !rule.enabled });
    await loadAlertRules();
  }

  async function runAlertTest(ruleId: number) {
    setAlertTestBusy(ruleId);
    setAlertTestResults((prev) => ({ ...prev, [ruleId]: {} }));
    try {
      const raw = await api.testAlertRule(accessToken, ruleId);
      // Backend returns "ok" on success — normalise to a readable label
      const normalised = Object.fromEntries(
        Object.entries(raw).map(([ch, res]) => [ch, res === "ok" ? "Sent successfully" : res])
      );
      setAlertTestResults((prev) => ({ ...prev, [ruleId]: normalised }));
    } catch (err) {
      setAlertTestResults((prev) => ({ ...prev, [ruleId]: { error: err instanceof Error ? err.message : "Test failed" } }));
    } finally {
      setAlertTestBusy(null);
    }
  }

  async function updateUser(userId: number, payload: { role?: string; is_active?: boolean; email?: string | null; avatar_data?: string | null }) {
    setBusyUserId(userId);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateUser(accessToken, userId, payload);
      setUsers((current) => current.map((u) => (u.id === updated.id ? updated : u)));
      setSuccess(`Updated ${updated.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update user");
    } finally { setBusyUserId(null); }
  }

  function handleAdminAvatarUpload(userId: number, file: File) {
    if (!file.type.startsWith("image/")) { setError("Please select an image file."); return; }
    if (file.size > 2 * 1024 * 1024) { setError("Image must be under 2 MB."); return; }
    const reader = new FileReader();
    reader.onload = (e) => { void updateUser(userId, { avatar_data: e.target?.result as string }); };
    reader.readAsDataURL(file);
  }

  async function saveEmail(userId: number, email: string) {
    setEditingEmailId(null);
    const value = email.trim() || null;
    const user = users.find((u) => u.id === userId);
    if (value === (user?.email ?? null)) return;
    await updateUser(userId, { email: value });
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    if (resetPasswordForm.userId === null || !resetPasswordForm.password) return;
    setBusyUserId(resetPasswordForm.userId);
    setError(null); setSuccess(null);
    try {
      await api.resetUserPassword(accessToken, resetPasswordForm.userId, resetPasswordForm.password);
      const user = users.find((u) => u.id === resetPasswordForm.userId);
      setSuccess(`Password reset for ${user?.username ?? "user"}`);
      setResetPasswordForm({ userId: null, password: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset password");
    } finally { setBusyUserId(null); }
  }

  async function forceLogout(userId: number) {
    setBusyUserId(userId);
    setError(null); setSuccess(null);
    try {
      await api.forceLogoutUser(accessToken, userId);
      const user = users.find((u) => u.id === userId);
      setSuccess(`Logged out all sessions for ${user?.username ?? "user"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to force logout");
    } finally { setBusyUserId(null); }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setError(null); setSuccess(null);
    try {
      const created = await api.createUser(accessToken, createForm);
      setUsers((current) => [...current, created].sort((a, b) => a.username.localeCompare(b.username)));
      setCreateForm({ username: "", password: "", email: "", role: "Viewer", is_active: true });
      setSuccess(`Created ${created.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create user");
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSettingsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateAdminSettings(accessToken, settingsForm);
      setSettingsForm(updated);
      setIdleTimeoutRaw(String(updated.idle_timeout_minutes));
      setSuccess("Settings saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save settings");
    } finally { setSettingsBusy(false); }
  }

  async function runBackup() {
    setBackupBusy("backup");
    setError(null); setSuccess(null);
    try {
      const result = await api.downloadBackup(accessToken);
      triggerDownload(result);
      setSuccess(`Downloaded ${result.filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    } finally { setBackupBusy(null); }
  }

  async function runRestore() {
    if (!restoreFile) return;
    setBackupBusy("restore");
    setError(null); setSuccess(null);
    try {
      await api.restoreBackup(accessToken, restoreFile);
      setSuccess(`Restored from ${restoreFile.name}`);
      setRestoreFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally { setBackupBusy(null); }
  }

  const filteredUsers = useMemo(
    () => users.filter((u) => !userSearch || u.username.toLowerCase().includes(userSearch.toLowerCase())),
    [users, userSearch],
  );

  return (
    <section className="admin-layout">
      <div className="admin-tabs">
        {(["system", "users", "groups", "notifications", "alerts", "security"] as const).map((tab) => (
          <button key={tab} type="button" className={`admin-tab-btn${activeTab === tab ? " active" : ""}`} onClick={() => setActiveTab(tab)}>
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {error && <div className="form-error">{error}</div>}
      {success && <div className="success-banner">{success}</div>}

      {activeTab === "users" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2>Users</h2>
              <button type="button" onClick={() => void loadAdminData()}>Refresh</button>
            </div>
            <input className="admin-search" type="search" placeholder="Search users…" value={userSearch} onChange={(e) => setUserSearch(e.target.value)} />
            {loading ? <p>Loading…</p> : (
              <div className="admin-users-table">
                <div className="admin-users-header">
                  <span>User</span>
                  <span className="admin-col-center">Role</span>
                  <span className="admin-col-center">Status</span>
                  <span className="admin-col-center">Actions</span>
                </div>
                {filteredUsers.map((row) => (
                  <div className="admin-users-row" key={row.id}>
                    <div className="admin-user-identity">
                      <div className="admin-user-avatar-wrap">
                        <label className={`admin-user-avatar admin-user-avatar--${row.role.toLowerCase()}`} title="Upload photo">
                          {row.avatar_data
                            ? <img src={row.avatar_data} alt={row.username} className="admin-avatar-img" />
                            : <span className="admin-avatar-initials">{userInitials(row.username)}</span>
                          }
                          <span className="admin-avatar-overlay" aria-hidden="true">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                          </span>
                          <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAdminAvatarUpload(row.id, f); e.target.value = ""; }} />
                        </label>
                        {row.avatar_data && (
                          <button type="button" className="admin-avatar-clear" title="Remove photo" onClick={() => void updateUser(row.id, { avatar_data: null })}>×</button>
                        )}
                      </div>
                      <div className="admin-user-info">
                        <span className="admin-user-name">{row.username}</span>
                        {editingEmailId === row.id ? (
                          <div className="admin-email-edit-row">
                            <input
                              className="admin-email-input"
                              type="email"
                              autoFocus
                              maxLength={254}
                              placeholder="Email address"
                              value={editingEmailValue}
                              onChange={(e) => setEditingEmailValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); void saveEmail(row.id, editingEmailValue); }
                                if (e.key === "Escape") setEditingEmailId(null);
                              }}
                              onBlur={() => void saveEmail(row.id, editingEmailValue)}
                            />
                            <button type="button" className="admin-email-btn admin-email-btn--save" onMouseDown={(e) => { e.preventDefault(); void saveEmail(row.id, editingEmailValue); }}><Check size={11} /></button>
                            <button type="button" className="admin-email-btn" onMouseDown={(e) => { e.preventDefault(); setEditingEmailId(null); }}><X size={11} /></button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="admin-email-display"
                            onClick={() => { setEditingEmailId(row.id); setEditingEmailValue(row.email ?? ""); }}
                          >
                            {row.email
                              ? <span className="admin-user-email">{row.email}</span>
                              : <span className="admin-email-placeholder">Add email…</span>
                            }
                            <Pencil size={10} className="admin-email-pencil" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div>
                      <select
                        className={`admin-role-select admin-role-select--${row.role.toLowerCase()}`}
                        value={row.role}
                        disabled={busyUserId === row.id}
                        onChange={(e) => void updateUser(row.id, { role: e.target.value })}
                      >
                        <option value="SuperAdmin">SuperAdmin</option>
                        <option value="NetworkAdmin">NetworkAdmin</option>
                        <option value="SecurityAnalyst">SecurityAnalyst</option>
                        <option value="Viewer">Viewer</option>
                        {Object.keys(localRolePerms).filter(r => !["SuperAdmin","NetworkAdmin","SecurityAnalyst","Viewer"].includes(r)).sort().map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                    <div className="admin-col-center">
                      <label className="admin-status-toggle">
                        <input type="checkbox" checked={row.is_active} disabled={busyUserId === row.id} onChange={(e) => void updateUser(row.id, { is_active: e.target.checked })} />
                        <span className={`admin-status-pill ${row.is_active ? "active" : "suspended"}`}>
                          {row.is_active ? "Active" : "Disabled"}
                        </span>
                      </label>
                    </div>
                    <div className="admin-row-actions">
                      <button type="button" className="admin-action-btn" disabled={busyUserId === row.id} onClick={() => setResetPasswordForm({ userId: row.id, password: "" })}>Reset PW</button>
                      <button type="button" className="admin-action-btn admin-action-btn--danger" disabled={busyUserId === row.id} onClick={() => void forceLogout(row.id)}>Logout</button>
                      <button type="button" className="admin-action-btn" onClick={() => { setActiveTab("security"); void loadAuditLogs(0, row.id); }}>Audit</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {resetPasswordForm.userId !== null && (
              <form className="tool-form admin-reset-form" onSubmit={resetPassword}>
                <h3>Reset password — {users.find((u) => u.id === resetPasswordForm.userId)?.username}</h3>
                <label>
                  New password (min 12 chars)
                  <input required minLength={12} type="password" value={resetPasswordForm.password} onChange={(e) => setResetPasswordForm((c) => ({ ...c, password: e.target.value }))} />
                </label>
                <div className="admin-reset-actions">
                  <button type="submit" disabled={busyUserId === resetPasswordForm.userId}>Save</button>
                  <button type="button" onClick={() => setResetPasswordForm({ userId: null, password: "" })}>Cancel</button>
                </div>
              </form>
            )}
            <form className="tool-form admin-create-form" onSubmit={createUser}>
              <h3>Add user</h3>
              <div className="tool-form-grid">
                <label>Username <input required minLength={3} maxLength={80} value={createForm.username} onChange={(e) => setCreateForm((c) => ({ ...c, username: e.target.value }))} /></label>
                <label>Password <input required minLength={12} type="password" value={createForm.password} onChange={(e) => setCreateForm((c) => ({ ...c, password: e.target.value }))} /></label>
              </div>
              <div className="tool-form-grid">
                <label>Email <input type="email" maxLength={254} placeholder="Optional — for password reset emails" value={createForm.email} onChange={(e) => setCreateForm((c) => ({ ...c, email: e.target.value }))} /></label>
                <label>Role
                  <select value={createForm.role} onChange={(e) => setCreateForm((c) => ({ ...c, role: e.target.value }))}>
                    <option value="Viewer">Viewer</option>
                    <option value="SecurityAnalyst">SecurityAnalyst</option>
                    <option value="NetworkAdmin">NetworkAdmin</option>
                    <option value="SuperAdmin">SuperAdmin</option>
                    {Object.keys(localRolePerms).filter(r => !["SuperAdmin","NetworkAdmin","SecurityAnalyst","Viewer"].includes(r)).sort().map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="inline-toggle"><input checked={createForm.is_active} type="checkbox" onChange={(e) => setCreateForm((c) => ({ ...c, is_active: e.target.checked }))} />Active on create</label>
              <button type="submit">Create user</button>
            </form>
          </section>
        </div>
      )}

      {activeTab === "security" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2>{auditUserFilter ? `Activity — ${users.find((u) => u.id === auditUserFilter)?.username ?? "user"}` : "Login & Audit History"}</h2>
              <div className="admin-panel-actions">
                {auditUserFilter && <button type="button" onClick={() => void loadAuditLogs(0, null)}>All users</button>}
                <button type="button" onClick={() => void loadAuditLogs(auditOffset, auditUserFilter)}>Refresh</button>
              </div>
            </div>
            <div className="audit-log-table">
              <div className="audit-log-header">
                <span>Time</span>
                <span>Event</span>
                <span>Actor</span>
                <span>Context</span>
              </div>
              {auditLogs.length === 0 && <p className="audit-empty">No audit records found.</p>}
              {auditLogs.map((log) => {
                const dt = new Date(log.created_at);
                const category = log.action.split(".")[0];
                const actor = log.actor_user_id
                  ? (users.find((u) => u.id === log.actor_user_id)?.username ?? `#${log.actor_user_id}`)
                  : "system";
                return (
                  <div className="audit-log-row" key={log.id}>
                    <div className="audit-time-cell">
                      <span className="audit-date">{dt.toLocaleDateString()}</span>
                      <span className="audit-time">{dt.toLocaleTimeString()}</span>
                    </div>
                    <div className="audit-event-cell">
                      <span className={`audit-category-badge audit-category-badge--${category}`}>{category}</span>
                      <span className="audit-action">{log.action.includes(".") ? log.action.slice(log.action.indexOf(".") + 1) : log.action}</span>
                    </div>
                    <span className="audit-actor">{actor}</span>
                    <div className="audit-context-cell">
                      {log.target && <span className="audit-target">{log.target}</span>}
                      {log.detail && <span className="audit-detail">{log.detail}</span>}
                      {!log.target && !log.detail && <span className="audit-detail">—</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="audit-pagination">
              <button type="button" disabled={auditOffset === 0} onClick={() => void loadAuditLogs(Math.max(0, auditOffset - 50), auditUserFilter)}>← Prev</button>
              <span>{auditOffset + 1}–{Math.min(auditOffset + 50, auditLogsTotal)} of {auditLogsTotal}</span>
              <button type="button" disabled={auditOffset + 50 >= auditLogsTotal} onClick={() => void loadAuditLogs(auditOffset + 50, auditUserFilter)}>Next →</button>
            </div>
          </section>
        </div>
      )}

      {activeTab === "system" && (
        <div className="admin-tab-content">
          <div className="admin-system-stats">
            <div className="admin-system-stat">
              <strong>{summary?.device_count ?? graph.devices.length}</strong>
              <span>Devices</span>
            </div>
            <div className="admin-system-stat">
              <strong>{summary?.relationship_count ?? graph.relationships.length}</strong>
              <span>Links</span>
            </div>
            <div className="admin-system-stat">
              <strong>{summary?.group_count ?? new Set(graph.devices.map((d) => d.topology_group).filter(Boolean)).size}</strong>
              <span>Groups</span>
            </div>
            <div className="admin-system-stat">
              <strong>{users.length}</strong>
              <span>Users</span>
            </div>
          </div>
          <div className="system-tab-grid">
            <div className="system-tab-col">
              <section className="panel admin-panel">
                <h2>App settings</h2>
                <form className="tool-form" onSubmit={saveSettings}>
                  <label>App name <input maxLength={80} value={settingsForm.app_name} onChange={(e) => setSettingsForm((c) => ({ ...c, app_name: e.target.value }))} /></label>
                  <label>Login page message <textarea maxLength={300} rows={2} value={settingsForm.login_message} onChange={(e) => setSettingsForm((c) => ({ ...c, login_message: e.target.value }))} /></label>
                  <label>
                    Announcement banner
                    <textarea maxLength={500} rows={3} placeholder="Leave empty to hide. Shown to all logged-in users." value={settingsForm.announcement} onChange={(e) => setSettingsForm((c) => ({ ...c, announcement: e.target.value }))} />
                  </label>
                  <label className="tool-form-inline-check">
                    <input type="checkbox" checked={settingsForm.live_ping_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, live_ping_enabled: e.target.checked }))} />
                    Enable live ping monitoring
                    <span className="tool-note" style={{ margin: 0 }}>Uncheck to disable all background ping checks across the app</span>
                  </label>
                  <label>
                    Idle session timeout (minutes)
                    {(() => {
                      const n = parseInt(idleTimeoutRaw, 10);
                      const err = idleTimeoutRaw.trim() === "" || isNaN(n) ? "Must be a number" : n < 1 ? "Minimum is 1 minute" : n > 480 ? "Maximum is 480 minutes (8 hours)" : null;
                      return (
                        <>
                          <input
                            type="text"
                            inputMode="numeric"
                            placeholder="e.g. 15"
                            value={idleTimeoutRaw}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setIdleTimeoutRaw(raw);
                              const parsed = parseInt(raw, 10);
                              if (!isNaN(parsed) && parsed >= 1 && parsed <= 480) {
                                setSettingsForm((c) => ({ ...c, idle_timeout_minutes: parsed }));
                              }
                            }}
                            style={err ? { borderColor: "var(--dash-red)" } : undefined}
                          />
                          {err
                            ? <span className="tool-note" style={{ margin: 0, color: "var(--dash-red)" }}>{err}</span>
                            : <span className="tool-note" style={{ margin: 0 }}>Users are logged out after this many minutes of inactivity (1–480). Set to 480 to effectively disable.</span>
                          }
                        </>
                      );
                    })()}
                  </label>
                  <button type="submit" disabled={settingsBusy || (() => { const n = parseInt(idleTimeoutRaw, 10); return isNaN(n) || n < 1 || n > 480; })()}>
                    {settingsBusy ? "Saving…" : "Save settings"}
                  </button>
                </form>
              </section>
              <section className="panel admin-panel">
                <h2>Database backup &amp; restore</h2>
                <p className="tool-note">SuperAdmin only. Operates directly on the SQLite database file.</p>
                <div className="tool-form">
                  <button type="button" disabled={backupBusy === "backup"} onClick={() => void runBackup()}>
                    {backupBusy === "backup" ? "Preparing…" : "Download backup"}
                  </button>
                  <label>
                    Restore from backup
                    <input accept=".db,application/octet-stream" type="file" disabled={backupBusy === "restore"} onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} />
                  </label>
                  {restoreFile && (
                    <button type="button" disabled={backupBusy === "restore"} onClick={() => void runRestore()}>
                      {backupBusy === "restore" ? "Restoring…" : `Restore ${restoreFile.name}`}
                    </button>
                  )}
                </div>
              </section>
            </div>
            <div className="system-tab-col">
              <section className="panel admin-panel">
                <div className="system-icon-header">
                  <div>
                    <h2 style={{ margin: 0 }}>Icons</h2>
                    <p className="tool-note" style={{ margin: "2px 0 0" }}>
                      Active: <strong>{[builtInIconPack, ...iconPacks, ...localIconPacks].find((p) => p.id === activeIconPackId)?.name ?? "Built-in"}</strong>
                      {" · "}{allRuntimePacks.length} pack{allRuntimePacks.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <button type="button" className="system-icon-manage-btn" onClick={() => setIconModalOpen(true)}>
                    Manage icons →
                  </button>
                </div>
              </section>
              <section className="panel admin-panel">
                <h2>Syslog configuration</h2>
                {syslogStatus ? (
                  <dl className="admin-config-grid">
                    <dt>Firewall retention</dt><dd>{syslogStatus.retention_days} days</dd>
                    <dt>UDP listener</dt><dd>{syslogStatus.udp_enabled ? `enabled :${syslogStatus.udp_port}` : "disabled"}</dd>
                    <dt>TCP listener</dt><dd>{syslogStatus.tcp_enabled ? `enabled :${syslogStatus.tcp_port}` : "disabled"}</dd>
                    <dt>TLS listener</dt><dd>{syslogStatus.tls_enabled ? `enabled :${syslogStatus.tls_port}` : "disabled"}</dd>
                    <dt>Allowlist</dt><dd>{syslogStatus.allowlist_enabled ? "enabled" : "off"}</dd>
                    <dt>Stored events</dt><dd>{syslogStatus.total_events.toLocaleString()}</dd>
                    <dt>Last cleanup</dt><dd>{syslogStatus.retention_last_run_at ? new Date(syslogStatus.retention_last_run_at).toLocaleString() : "n/a"}</dd>
                    <dt>Last event</dt><dd>{syslogStatus.last_event_received_at ? new Date(syslogStatus.last_event_received_at).toLocaleString() : "n/a"}</dd>
                  </dl>
                ) : <p>Loading…</p>}
              </section>
            </div>
          </div>
          {iconModalOpen && (
            <IconManagerModal
              activeIconPackId={activeIconPackId}
              iconPacks={iconPacks}
              localIconPacks={localIconPacks}
              iconPackLoading={iconPackLoading}
              iconPackError={iconPackError}
              onSelectIconPack={onSelectIconPack}
              onAddLocalIconPack={onAddLocalIconPack}
              onRemoveLocalIconPack={onRemoveLocalIconPack}
              onClose={() => setIconModalOpen(false)}
            />
          )}
        </div>
      )}

      {activeTab === "notifications" && (
        <div className="admin-tab-content">
          <div className="admin-grid">

            <section className="panel admin-panel">
              <h2 className="notif-provider-heading">ntfy</h2>
              <p className="tool-note">Push notifications via ntfy.sh or a self-hosted ntfy server.</p>
              <div className="tool-form">
                <label>Topic URL
                  <input placeholder="https://ntfy.sh/my-topic" value={notifSettings.ntfy_url} onChange={(e) => setNotifSettings((c) => ({ ...c, ntfy_url: e.target.value }))} />
                </label>
                <label>Access token <span className="tool-note">(optional)</span>
                  <input type="password" placeholder="tk_…" value={notifSettings.ntfy_token} onChange={(e) => setNotifSettings((c) => ({ ...c, ntfy_token: e.target.value }))} />
                </label>
                <div className="notif-actions">
                  <button type="button" disabled={notifBusy} onClick={() => void saveNotifSettings()}>{notifBusy ? "Saving…" : "Save"}</button>
                  <button type="button" className="notif-test-btn" onClick={() => void testNotif("ntfy")}>Send test</button>
                  {notifTestResult.ntfy && <span className={`notif-result${notifTestResult.ntfy === "Sent successfully" ? " ok" : " err"}`}>{notifTestResult.ntfy}</span>}
                </div>
              </div>
            </section>

            <section className="panel admin-panel">
              <h2 className="notif-provider-heading">Telegram</h2>
              <p className="tool-note">Send messages via a Telegram bot to a chat or channel.</p>
              <div className="tool-form">
                <label>Bot token
                  <input type="password" placeholder="123456:ABC-DEF…" value={notifSettings.telegram_bot_token} onChange={(e) => setNotifSettings((c) => ({ ...c, telegram_bot_token: e.target.value }))} />
                </label>
                <label>Chat ID
                  <input placeholder="-100123456789" value={notifSettings.telegram_chat_id} onChange={(e) => setNotifSettings((c) => ({ ...c, telegram_chat_id: e.target.value }))} />
                </label>
                <div className="notif-actions">
                  <button type="button" disabled={notifBusy} onClick={() => void saveNotifSettings()}>{notifBusy ? "Saving…" : "Save"}</button>
                  <button type="button" className="notif-test-btn" onClick={() => void testNotif("telegram")}>Send test</button>
                  {notifTestResult.telegram && <span className={`notif-result${notifTestResult.telegram === "Sent successfully" ? " ok" : " err"}`}>{notifTestResult.telegram}</span>}
                </div>
              </div>
            </section>

            <section className="panel admin-panel">
              <h2 className="notif-provider-heading">Signal</h2>
              <p className="tool-note">Requires a running <a href="https://github.com/bbernhard/signal-cli-rest-api" target="_blank" rel="noreferrer">signal-cli REST API</a> instance.</p>
              <div className="tool-form">
                <label>REST API URL
                  <input placeholder="http://localhost:8080" value={notifSettings.signal_url} onChange={(e) => setNotifSettings((c) => ({ ...c, signal_url: e.target.value }))} />
                </label>
                <label>Sender number <span className="tool-note">(E.164)</span>
                  <input placeholder="+447700000000" value={notifSettings.signal_number} onChange={(e) => setNotifSettings((c) => ({ ...c, signal_number: e.target.value }))} />
                </label>
                <label>Recipient number <span className="tool-note">(E.164)</span>
                  <input placeholder="+447700000001" value={notifSettings.signal_recipient} onChange={(e) => setNotifSettings((c) => ({ ...c, signal_recipient: e.target.value }))} />
                </label>
                <div className="notif-actions">
                  <button type="button" disabled={notifBusy} onClick={() => void saveNotifSettings()}>{notifBusy ? "Saving…" : "Save"}</button>
                  <button type="button" className="notif-test-btn" onClick={() => void testNotif("signal")}>Send test</button>
                  {notifTestResult.signal && <span className={`notif-result${notifTestResult.signal === "Sent successfully" ? " ok" : " err"}`}>{notifTestResult.signal}</span>}
                </div>
              </div>
            </section>

            <section className="panel admin-panel">
              <h2 className="notif-provider-heading">SMTP / Email</h2>
              <p className="tool-note">Send email alerts via any SMTP server (Gmail, SendGrid, local relay, etc.).</p>
              <div className="tool-form">
                <label>SMTP host
                  <input placeholder="smtp.gmail.com" value={notifSettings.smtp_host} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_host: e.target.value }))} />
                </label>
                <label>Port
                  <input placeholder="587" value={notifSettings.smtp_port} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_port: e.target.value }))} />
                </label>
                <label>Username
                  <input placeholder="you@example.com" value={notifSettings.smtp_user} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_user: e.target.value }))} />
                </label>
                <label>Password
                  <input type="password" value={notifSettings.smtp_password} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_password: e.target.value }))} />
                </label>
                <label>From address <span className="tool-note">(defaults to username)</span>
                  <input placeholder="netmap@example.com" value={notifSettings.smtp_from} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_from: e.target.value }))} />
                </label>
                <label>Send alerts to
                  <input placeholder="admin@example.com" value={notifSettings.smtp_to} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_to: e.target.value }))} />
                </label>
                <label className="inline-toggle">
                  <input type="checkbox" checked={notifSettings.smtp_tls === "true"} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_tls: e.target.checked ? "true" : "false" }))} />
                  Use STARTTLS
                </label>
                <div className="notif-actions">
                  <button type="button" disabled={notifBusy} onClick={() => void saveNotifSettings()}>{notifBusy ? "Saving…" : "Save"}</button>
                  <button type="button" className="notif-test-btn" onClick={() => void testNotif("smtp")}>Send test</button>
                  {notifTestResult.smtp && <span className={`notif-result${notifTestResult.smtp === "Sent successfully" ? " ok" : " err"}`}>{notifTestResult.smtp}</span>}
                </div>
              </div>
            </section>

          </div>
        </div>
      )}

      {activeTab === "alerts" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2>Alert Rules</h2>
              <div className="admin-panel-actions">
                <button type="button" className="action-btn" onClick={() => {
                  setEditingAlertRule(null);
                  setAlertForm({ name: "", enabled: true, event_type: "device_offline", device_id: null, channels: [], cooldown_minutes: 30 });
                  setShowAlertForm(true);
                }}>+ Add rule</button>
              </div>
            </div>
            <p className="tool-note">Rules run every 5 minutes in the background. Notifications are sent via the channels configured in the Notifications tab.</p>
            {alertRulesError && <div className="form-error">{alertRulesError}</div>}

            {showAlertForm && (
              <div className="tool-form" style={{ marginBottom: 16, padding: '14px 16px', background: 'rgba(29,154,176,0.04)', borderRadius: 8, border: '1px solid rgba(29,154,176,0.15)' }}>
                <label>Rule name
                  <input value={alertForm.name} maxLength={120} onChange={(e) => setAlertForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Core router offline" />
                </label>
                <label>Trigger
                  <select value={alertForm.event_type} onChange={(e) => setAlertForm(f => ({...f, event_type: e.target.value as AlertRuleEventType}))}>
                    <option value="device_offline">Device goes offline</option>
                    <option value="device_online">Device comes back online</option>
                    <option value="device_warning">Device status becomes Warning</option>
                    <option value="any_status_change">Any status change</option>
                  </select>
                </label>
                <label>Device
                  <select value={alertForm.device_id ?? ""} onChange={(e) => setAlertForm(f => ({...f, device_id: e.target.value ? Number(e.target.value) : null}))}>
                    <option value="">All devices</option>
                    {graph.devices.map(d => (
                      <option key={d.id} value={d.id}>{d.display_name || d.hostname || d.ip_address}</option>
                    ))}
                  </select>
                </label>
                <fieldset style={{ border: '1px solid #d0dde6', borderRadius: 6, padding: '8px 12px' }}>
                  <legend style={{ fontSize: 12, fontWeight: 700, color: '#314656', padding: '0 4px' }}>Notify via</legend>
                  {(["smtp", "ntfy", "telegram", "signal"] as const).map(ch => (
                    <label key={ch} className="tool-form-inline-check" style={{ marginBottom: 4 }}>
                      <input type="checkbox" checked={alertForm.channels.includes(ch)}
                        onChange={(e) => setAlertForm(f => ({
                          ...f,
                          channels: e.target.checked ? [...f.channels, ch] : f.channels.filter(c => c !== ch)
                        }))} />
                      {ch === "smtp" ? "Email (SMTP)" : ch === "ntfy" ? "ntfy" : ch === "telegram" ? "Telegram" : "Signal"}
                    </label>
                  ))}
                </fieldset>
                <label>Cooldown
                  <select value={alertForm.cooldown_minutes} onChange={(e) => setAlertForm(f => ({...f, cooldown_minutes: Number(e.target.value)}))}>
                    <option value={5}>5 minutes</option>
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={240}>4 hours</option>
                    <option value={1440}>24 hours</option>
                  </select>
                </label>
                <label className="tool-form-inline-check">
                  <input type="checkbox" checked={alertForm.enabled} onChange={(e) => setAlertForm(f => ({...f, enabled: e.target.checked}))} />
                  Enabled
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" disabled={alertRulesBusy || !alertForm.name || alertForm.channels.length === 0} onClick={() => void saveAlertRule()}>
                    {alertRulesBusy ? "Saving…" : editingAlertRule ? "Update rule" : "Create rule"}
                  </button>
                  <button type="button" onClick={() => { setShowAlertForm(false); setEditingAlertRule(null); }}>Cancel</button>
                </div>
              </div>
            )}

            {alertRules.length === 0 ? (
              <p className="tool-note">No alert rules yet. Add one to start receiving automated notifications.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid rgba(175,198,216,0.5)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Name</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Trigger</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Device</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Channels</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Cooldown</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Status</th>
                    <th style={{ padding: '8px 10px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {alertRules.map(rule => {
                    const triggerLabels: Record<string, string> = {
                      device_offline: "Goes offline",
                      device_online: "Comes online",
                      device_warning: "Warning status",
                      any_status_change: "Any status change",
                    };
                    const deviceName = rule.device_id
                      ? (() => { const d = graph.devices.find(x => x.id === rule.device_id); return d ? (d.display_name || d.hostname || d.ip_address) : `#${rule.device_id}`; })()
                      : "All devices";
                    const testResult = alertTestResults[rule.id];
                    return (
                      <tr key={rule.id} style={{ borderBottom: '1px solid rgba(175,198,216,0.3)' }}>
                        <td style={{ padding: '10px 10px', fontWeight: 600 }}>{rule.name}</td>
                        <td style={{ padding: '10px 10px', color: '#4a6474' }}>{triggerLabels[rule.event_type] ?? rule.event_type}</td>
                        <td style={{ padding: '10px 10px', color: '#4a6474', fontSize: 12 }}>{deviceName}</td>
                        <td style={{ padding: '10px 10px', fontSize: 12 }}>{rule.channels.join(", ") || "—"}</td>
                        <td style={{ padding: '10px 10px', color: '#4a6474', fontSize: 12 }}>{rule.cooldown_minutes >= 60 ? `${rule.cooldown_minutes / 60}h` : `${rule.cooldown_minutes}m`}</td>
                        <td style={{ padding: '10px 10px' }}>
                          <span className={`alert-status-pill${rule.enabled ? " alert-status-pill--active" : ""}`}>
                            {rule.enabled ? "Active" : "Paused"}
                          </span>
                        </td>
                        <td style={{ padding: '10px 10px' }}>
                          <div className="admin-panel-actions">
                            <button type="button" className="admin-action-btn" disabled={alertTestBusy === rule.id} onClick={() => void runAlertTest(rule.id)}>
                              {alertTestBusy === rule.id ? "Testing…" : "Test"}
                            </button>
                            <button type="button" className="admin-action-btn" onClick={() => void toggleAlertRule(rule)}>
                              {rule.enabled ? "Pause" : "Enable"}
                            </button>
                            <button type="button" className="admin-action-btn" onClick={() => {
                              setEditingAlertRule(rule);
                              setAlertForm({ name: rule.name, enabled: rule.enabled, event_type: rule.event_type, device_id: rule.device_id, channels: rule.channels, cooldown_minutes: rule.cooldown_minutes });
                              setShowAlertForm(true);
                            }}>Edit</button>
                            <button type="button" className="admin-action-btn admin-action-btn--danger" onClick={() => void deleteAlertRule(rule.id)}>Delete</button>
                          </div>
                          {testResult && Object.keys(testResult).length > 0 && (
                            <div className="alert-test-results">
                              {Object.entries(testResult).map(([ch, res]) => (
                                <span key={ch} className={`notif-result${res === "Sent successfully" ? " ok" : " err"}`}>
                                  {ch}: {res}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}

      {activeTab === "groups" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2>Role Permissions</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="action-btn" onClick={() => { setShowNewGroupForm((v) => !v); setNewGroupName(""); }}>
                  {showNewGroupForm ? "Cancel" : "+ New group"}
                </button>
                <button type="button" className="action-btn" disabled={groupsBusy} onClick={() => void saveRolePermissions()}>
                  {groupsBusy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
            <p className="tool-note">SuperAdmin always has full access. Use the checkboxes below to configure which permissions each role is granted. Custom groups can be assigned to users.</p>

            {showNewGroupForm && (
              <div className="rbac-new-group-form">
                <input
                  className="rbac-new-group-input"
                  type="text"
                  placeholder="Group name (e.g. ReadOnly)"
                  maxLength={40}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createGroup(newGroupName); }}
                  autoFocus
                />
                <button
                  type="button"
                  className="action-btn"
                  disabled={groupsBusy || !newGroupName.trim() || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(newGroupName.trim())}
                  onClick={() => void createGroup(newGroupName)}
                >
                  Create
                </button>
                {newGroupName && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(newGroupName.trim()) && (
                  <span className="rbac-name-error">Must start with a letter, then letters/numbers/- only</span>
                )}
              </div>
            )}

            {rolePermissions ? (() => {
              const BUILT_IN = ["NetworkAdmin", "SecurityAnalyst", "Viewer"] as const;
              const customRoles = Object.keys(localRolePerms).filter(r => !["SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"].includes(r)).sort();
              const allRoles = [...BUILT_IN, ...customRoles];
              return (
                <div className="rbac-roles-grid">
                  {allRoles.map((role) => {
                    const isCustom = !["NetworkAdmin", "SecurityAnalyst", "Viewer"].includes(role);
                    const label = role === "NetworkAdmin" ? "Network Admin" : role === "SecurityAnalyst" ? "Security Analyst" : role;
                    return (
                      <div key={role} className={`rbac-role-card${isCustom ? " rbac-role-card--custom" : ""}`}>
                        <div className="rbac-role-header">
                          <h3 className="rbac-role-name">{label}</h3>
                          <button
                            type="button"
                            className="rbac-delete-btn"
                            title={`Delete "${role}" group`}
                            disabled={groupsBusy}
                            onClick={() => { if (confirm(`Delete role "${role}"? Users assigned this role will be moved to Viewer.`)) void deleteGroup(role); }}
                          >✕</button>
                        </div>
                        <ul className="rbac-perm-list">
                          {rolePermissions.permissions.map((perm) => {
                            const granted = (localRolePerms[role] ?? []).includes(perm.key);
                            return (
                              <li key={perm.key} className="rbac-perm-row">
                                <label className="rbac-perm-label">
                                  <input
                                    type="checkbox"
                                    checked={granted}
                                    onChange={(e) => {
                                      setLocalRolePerms((prev) => {
                                        const current = prev[role] ?? [];
                                        return {
                                          ...prev,
                                          [role]: e.target.checked
                                            ? [...current, perm.key]
                                            : current.filter((k) => k !== perm.key),
                                        };
                                      });
                                    }}
                                  />
                                  <span className="rbac-perm-label-text">
                                    <strong>{perm.label}</strong>
                                    <span className="rbac-perm-desc">{perm.description}</span>
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              );
            })() : (
              <p>Loading permissions…</p>
            )}
          </section>
        </div>
      )}

    </section>
  );
}

function ClickableCell({
  className = "",
  onClick,
  value,
}: {
  className?: string;
  onClick: () => void;
  value: string | number | null;
}) {
  return (
    <span
      className={`clickable-cell ${className}`}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {value ?? "-"}
    </span>
  );
}

function TopologyWorkspace({
  accessToken,
  activeIconPackId,
  canViewSecurity,
  canWrite,
  graph,
  onGraphChange,
  jumpTarget,
  livePingEnabled,
  onSelectedDeviceChange,
  theme,
  userId,
}: {
  accessToken: string | null;
  activeIconPackId: string;
  canViewSecurity: boolean;
  canWrite: boolean;
  graph: TopologyGraph;
  onGraphChange: () => Promise<void>;
  jumpTarget: { deviceId: number; token: number } | null;
  livePingEnabled: boolean;
  onSelectedDeviceChange: (device: Device | null) => void;
  theme: "light" | "dark";
  userId: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const layoutPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const fitOnNextRenderRef = useRef(true);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<number | null>(null);
  const [expandedEntitySection, setExpandedEntitySection] = useState<"devices" | "relationships" | "groups" | null>(null);
  const [cloningDevice, setCloningDevice] = useState<Device | null>(null);
  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [showRelationshipForm, setShowRelationshipForm] = useState(false);
  const [showRelationshipEditForm, setShowRelationshipEditForm] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [securityOverlayEnabled, setSecurityOverlayEnabled] = useState(true);
  const [showOnlyDevicesWithEvents, setShowOnlyDevicesWithEvents] = useState(false);
  const [eventCounts, setEventCounts] = useState<DeviceEventCount[]>([]);
  const [topAffected, setTopAffected] = useState<DeviceEventCount[]>([]);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [deviceSecuritySummary, setDeviceSecuritySummary] = useState<DeviceSecurityEventSummary | null>(null);
  const [deviceSecurityLoading, setDeviceSecurityLoading] = useState(false);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [savedLayouts, setSavedLayouts] = useState<TopologyLayout[]>([]);
  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [activeSavedLayoutId, setActiveSavedLayoutId] = useState<number | null>(null);
  const [liveStatuses, setLiveStatuses] = useState<DeviceLiveStatus[]>([]);
  const [showDisplaySettings, setShowDisplaySettings] = useState(false);
  const [groupZoneOpacityPercent, setGroupZoneOpacityPercent] = useState(10);
  const [showGroupZoneBorders, setShowGroupZoneBorders] = useState(true);
  const [showNodeIcons, setShowNodeIcons] = useState(true);
  const [showNodeLabels, setShowNodeLabels] = useState(true);
  const [selectedGroupForDisplay, setSelectedGroupForDisplay] = useState("Ungrouped");
  const [groupDisplayPrefs, setGroupDisplayPrefs] = useState<Record<string, { nodeScalePercent: number; spacingScalePercent: number; maxDevicesPerRow: number }>>({});
  const [overlayNodes, setOverlayNodes] = useState<
    Array<{ id: number; x: number; y: number; lines: string[]; color: string; icon: DeviceIcon; size: number }>
  >([]);
  const refreshOverlayNodesRef = useRef<() => void>(() => {});
  const userIdRef = useRef(userId);
  const previousShowDeviceFormRef = useRef(false);
  const pendingDevicePatchesRef = useRef<Record<number, Partial<Device>>>({});
  const pendingRelationshipPatchesRef = useRef<Record<number, Partial<Relationship>>>({});
  const correlationWindowHours = 24;
  const [liveGraph, setLiveGraph] = useState<TopologyGraph>(graph);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  useEffect(() => {
    setLiveGraph((current) => ({
      devices: graph.devices.map((incoming) => ({
        ...incoming,
        ...pendingDevicePatchesRef.current[incoming.id],
      })),
      relationships: graph.relationships.map((incoming) => {
        const existing = current.relationships.find((row) => row.id === incoming.id);
        const pending = pendingRelationshipPatchesRef.current[incoming.id];
        return {
          ...incoming,
          ...pending,
          allow_outbound: pending?.allow_outbound ?? incoming.allow_outbound ?? existing?.allow_outbound ?? true,
          allow_inbound: pending?.allow_inbound ?? incoming.allow_inbound ?? existing?.allow_inbound ?? true,
        };
      }),
    }));
  }, [graph]);

  const selectedDevice = liveGraph.devices.find((device) => device.id === selectedDeviceId) ?? null;
  const selectedRelationship = liveGraph.relationships.find((relationship) => relationship.id === selectedRelationshipId) ?? null;
  const showDetailsPanel = selectedDevice !== null || selectedRelationship !== null;

  useEffect(() => {
    onSelectedDeviceChange(selectedDevice);
  }, [onSelectedDeviceChange, selectedDevice]);

  useEffect(() => {
    layoutPositionsRef.current = readSavedTopologyLayout(userId);
    const displayPrefs = readTopologyDisplayPrefs(userId);
    setGroupDisplayPrefs(displayPrefs.groups);
    fitOnNextRenderRef.current = true;
    setLayoutRevision((current) => current + 1);
  }, [userId]);

  useEffect(() => {
    writeTopologyDisplayPrefs(userId, { groups: groupDisplayPrefs });
  }, [groupDisplayPrefs, userId]);

  useEffect(() => {
    if (!accessToken) {
      setSavedLayouts([]);
      setGroups([]);
      setSites([]);
      return;
    }
    const token = accessToken;
    let cancelled = false;
    async function loadSavedLayouts() {
      try {
        const layouts = await api.topologyLayouts(token);
        if (!cancelled) {
          setSavedLayouts(layouts);
        }
      } catch (err) {
        if (!cancelled) {
          setTopologyError(err instanceof Error ? err.message : "Unable to load saved layouts");
        }
      }
    }
    async function loadGroups() {
      try {
        const rows = await api.topologyGroups(token);
        if (!cancelled) {
          setGroups(rows);
        }
      } catch {
        // topology remains functional without group metadata
      }
    }
    async function loadSites() {
      try {
        const rows = await api.sites(token);
        if (!cancelled) {
          setSites(rows);
        }
      } catch {
        // topology remains functional without site metadata
      }
    }
    loadSavedLayouts();
    void loadGroups();
    void loadSites();
    return () => {
      cancelled = true;
    };
  }, [accessToken, userId]);

  const eventCountByDeviceId = useMemo(
    () => new Map(eventCounts.map((row) => [row.device_id, row])),
    [eventCounts],
  );
  const liveStatusByDeviceId = useMemo(
    () => new Map(liveStatuses.map((row) => [row.device_id, row])),
    [liveStatuses],
  );
  const filteredGraph = useMemo(() => {
    const disabledIds = new Set(
      liveGraph.devices.filter((d) => d.status === "disabled").map((d) => d.id),
    );
    let base: TopologyGraph = disabledIds.size > 0 ? {
      devices: liveGraph.devices.filter((d) => d.status !== "disabled"),
      relationships: liveGraph.relationships.filter(
        (r) => !disabledIds.has(r.source_device_id) && !disabledIds.has(r.target_device_id),
      ),
    } : liveGraph;

    if (canViewSecurity && showOnlyDevicesWithEvents) {
      const allowed = new Set(
        eventCounts.filter((count) => count.event_count > 0).map((count) => count.device_id),
      );
      base = {
        devices: base.devices.filter((device) => allowed.has(device.id)),
        relationships: base.relationships.filter(
          (r) => allowed.has(r.source_device_id) && allowed.has(r.target_device_id),
        ),
      };
    }

    if (selectedSiteId !== null) {
      const siteDeviceIds = new Set(
        base.devices.filter((d) => d.site_id === selectedSiteId).map((d) => d.id),
      );
      base = {
        devices: base.devices.filter((d) => siteDeviceIds.has(d.id)),
        relationships: base.relationships.filter(
          (r) => siteDeviceIds.has(r.source_device_id) && siteDeviceIds.has(r.target_device_id),
        ),
      };
    }

    return base;
  }, [canViewSecurity, eventCounts, liveGraph, showOnlyDevicesWithEvents, selectedSiteId]);
  const visibleGroupNames = useMemo(
    () => [...new Set(filteredGraph.devices.map((device) => device.topology_group))].sort(compareGroupLabels),
    [filteredGraph.devices],
  );
  const topoStatusCounts = useMemo(() => {
    let online = 0, offline = 0;
    for (const d of filteredGraph.devices) {
      const s = liveStatusByDeviceId.get(d.id)?.status ?? d.monitor_status ?? d.status;
      if (s === "online") online++;
      else if (s === "offline") offline++;
    }
    return { online, offline };
  }, [filteredGraph.devices, liveStatusByDeviceId]);
  const activeGroupDisplay =
    groupDisplayPrefs[selectedGroupForDisplay] ?? { nodeScalePercent: 140, spacingScalePercent: 120, maxDevicesPerRow: 4 };

  const refreshOverlayNodes = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const nextNodes = filteredGraph.devices
      .map((device) => {
        const node = cy.$id(`device-${device.id}`);
        if (node.length === 0) {
          return null;
        }
        const position = node.renderedPosition();
        const count = eventCountByDeviceId.get(device.id)?.event_count ?? 0;
        const hasEvents = securityOverlayEnabled && count > 0;
        const label = hasEvents
          ? `${deviceLabel(device)}\n${count} ${count === 1 ? "event" : "events"}`
          : deviceLabel(device);
        const nodeScale = Math.max(0.7, Math.min(2.2, Number(node.data("nodeScale") ?? 1)));
        return {
          id: device.id,
          x: position.x,
          y: position.y,
          lines: label.split("\n"),
          color: device.color || statusColor(device.monitor_status ?? device.status),
          icon: resolveDeviceIcon(device.icon),
          size: Math.round(30 * nodeScale),
        };
      })
      .filter((row): row is { id: number; x: number; y: number; lines: string[]; color: string; icon: DeviceIcon; size: number } => row !== null);
    setOverlayNodes(nextNodes);
  }, [activeIconPackId, eventCountByDeviceId, filteredGraph.devices, securityOverlayEnabled]);

  useEffect(() => {
    refreshOverlayNodesRef.current = refreshOverlayNodes;
  }, [refreshOverlayNodes]);

  useEffect(() => {
    const justClosed = previousShowDeviceFormRef.current && !showDeviceForm;
    previousShowDeviceFormRef.current = showDeviceForm;
    if (!justClosed) {
      return;
    }
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    window.requestAnimationFrame(() => {
      cy.resize();
      refreshOverlayNodes();
    });
  }, [refreshOverlayNodes, showDeviceForm]);

  useEffect(() => {
    if (visibleGroupNames.length === 0) {
      return;
    }
    if (!visibleGroupNames.includes(selectedGroupForDisplay)) {
      setSelectedGroupForDisplay(visibleGroupNames[0]);
    }
  }, [selectedGroupForDisplay, visibleGroupNames]);

  async function refreshLiveStatuses(silent = false) {
    if (!accessToken || !livePingEnabled) {
      setLiveStatuses([]);
      return;
    }
    try {
      const deviceIds = liveGraph.devices.slice(0, 64).map((device) => device.id);
      const response = await api.topologyLiveStatuses(accessToken, {
        device_ids: deviceIds,
        timeout_seconds: 2,
      });
      setLiveStatuses(response.statuses);
    } catch (err) {
      if (!silent) {
        setTopologyError(err instanceof Error ? err.message : "Unable to refresh live status");
      }
    }
  }

  useEffect(() => {
    if (!canViewSecurity || !accessToken) {
      setEventCounts([]);
      setTopAffected([]);
      return;
    }
    const token = accessToken;
    let cancelled = false;
    async function loadCorrelationData() {
      setSecurityLoading(true);
      try {
        const [counts, top] = await Promise.all([
          api.topologyDeviceEventCounts(token, { window_hours: correlationWindowHours }),
          api.topAffectedDevices(token, { window_hours: correlationWindowHours, limit: 6 }),
        ]);
        if (!cancelled) {
          setEventCounts(counts.devices);
          setTopAffected(top.devices);
        }
      } catch (err) {
        if (!cancelled) {
          setTopologyError(err instanceof Error ? err.message : "Unable to load topology security overlay");
        }
      } finally {
        if (!cancelled) {
          setSecurityLoading(false);
        }
      }
    }
    loadCorrelationData();
    return () => {
      cancelled = true;
    };
  }, [accessToken, canViewSecurity, correlationWindowHours, liveGraph.devices, liveGraph.relationships.length]);

  useEffect(() => {
    if (!livePingEnabled || !accessToken || liveGraph.devices.length === 0) {
      setLiveStatuses([]);
      return;
    }
    let cancelled = false;
    let intervalId = 0;
    async function loadStatuses(initialLoad: boolean) {
      if (initialLoad) {
        await refreshLiveStatuses();
        return;
      }
      if (cancelled) {
        return;
      }
      await refreshLiveStatuses(true);
    }
    void loadStatuses(true);
    intervalId = window.setInterval(() => {
      void loadStatuses(false);
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessToken, livePingEnabled, liveGraph.devices]);

  useEffect(() => {
    if (!canViewSecurity || !accessToken || !selectedDevice) {
      setDeviceSecuritySummary(null);
      return;
    }
    const token = accessToken;
    const deviceId = selectedDevice.id;
    let cancelled = false;
    async function loadDeviceSummary() {
      setDeviceSecurityLoading(true);
      try {
        const summary = await api.deviceSecurityEvents(token, deviceId, {
          window_hours: correlationWindowHours,
          limit: 8,
        });
        if (!cancelled) {
          setDeviceSecuritySummary(summary);
        }
      } catch (err) {
        if (!cancelled) {
          setTopologyError(err instanceof Error ? err.message : "Unable to load device security activity");
        }
      } finally {
        if (!cancelled) {
          setDeviceSecurityLoading(false);
        }
      }
    }
    loadDeviceSummary();
    return () => {
      cancelled = true;
    };
  }, [accessToken, canViewSecurity, correlationWindowHours, selectedDevice]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    if (!cyRef.current) {
      cyRef.current = cytoscape({
        container: containerRef.current,
        layout: { name: "preset", fit: true, padding: 36 },
        boxSelectionEnabled: false,
        zoomingEnabled: true,
        userZoomingEnabled: true,
        style: [
          {
            selector: "node.device",
            style: {
              "background-color": "transparent",
              "background-opacity": 0,
              "border-color": "transparent",
              "border-width": 0,
              "bounds-expansion": 12,
              "font-size": 1,
              height: "data(hitSize)",
              label: "",
              "overlay-opacity": 0,
              shape: "rectangle",
              width: "data(hitSize)",
              "z-index": 10,
            },
          },
          {
            selector: "node.device.hovered",
            style: {
              height: 56,
              opacity: 0.92,
              width: 56,
              "z-index": 50,
            },
          },
          {
            selector: "node.device.security-alert",
            style: {
              opacity: 0.88,
              "text-border-color": "#f0b9b9",
              "text-border-width": 2,
              "z-index": 55,
            },
          },
          {
            selector: "node.device.status-online",
            style: {
              "text-background-color": "#effaf5",
            },
          },
          {
            selector: "node.device.status-offline",
            style: {
              "text-background-color": "#f7f7f9",
            },
          },
          {
            selector: "node.device.status-warning",
            style: {
              "text-background-color": "#fff8ea",
            },
          },
          {
            selector: "node.device.status-unknown",
            style: {
              "text-background-color": "#f4f8fa",
            },
          },
          {
            selector: "node.device.focus-pulse",
            style: {
              opacity: 0.75,
              "z-index": 70,
            },
          },
          {
            selector: "node.zone",
            style: {
              "background-color": "data(zoneBgColor)",
              "background-opacity": 0.1,
              "border-color": "data(zoneBorderColor)",
              "border-opacity": 0.1,
              "border-style": "dashed",
              "border-width": 2,
              color: "data(zoneLabelColor)",
              "font-size": 24,
              "font-weight": 700,
              label: "data(label)",
              padding: "34px",
              shape: "round-rectangle",
              "text-halign": "center",
              "text-margin-y": -26,
              "text-valign": "top",
            },
          },
          {
            selector: "edge",
            style: {
              "curve-style": "bezier",
              label: "data(label)",
              "line-color": "#6f8798",
              "line-style": "solid",
              "target-arrow-color": "#6f8798",
              "target-arrow-shape": "triangle",
              color: "data(edgeLabelColor)",
              "font-size": 11,
              "font-weight": 700,
              "overlay-opacity": 0,
              "text-background-color": "data(edgeLabelBg)",
              "text-background-opacity": 0.9,
              "text-background-padding": "2px",
              width: 2,
            },
          },
          {
            selector: "edge.hovered",
            style: {
              "line-color": "#1d6472",
              "target-arrow-color": "#1d6472",
              width: 4,
              "z-index": 40,
            },
          },
          {
            selector: "edge:selected",
            style: {
              "line-color": "#1d6472",
              "target-arrow-color": "#1d6472",
              width: 5,
              "z-index": 60,
            },
          },
          {
            selector: "node.device:selected",
            style: {
              height: 58,
              opacity: 0.9,
              width: 58,
            },
          },
        ],
      });
      cyRef.current.on("tap", "node.device", (event) => {
        setSelectedDeviceId(Number(event.target.id().replace("device-", "")));
        setSelectedRelationshipId(null);
      });
      cyRef.current.on("tap", "edge", (event) => {
        setSelectedRelationshipId(Number(event.target.id().replace("relationship-", "")));
        setSelectedDeviceId(null);
      });
      cyRef.current.on("mouseover", "node.device", (event) => {
        const node = event.target;
        node.addClass("hovered");
        node.connectedEdges().addClass("hovered");
      });
      cyRef.current.on("mouseout", "node.device", (event) => {
        const node = event.target;
        node.removeClass("hovered");
        node.connectedEdges().removeClass("hovered");
      });
      cyRef.current.on("tap", (event) => {
        if (event.target === cyRef.current) {
          setSelectedDeviceId(null);
          setSelectedRelationshipId(null);
        }
      });
      cyRef.current.on("dragfree", "node.device", () => {
        persistCurrentTopologyLayout(cyRef.current, userIdRef.current, layoutPositionsRef);
        refreshOverlayNodesRef.current();
      });
      cyRef.current.on("zoom", () => {
        refreshOverlayNodesRef.current();
      });
      cyRef.current.on("pan", () => {
        refreshOverlayNodesRef.current();
      });
      cyRef.current.on("render", () => {
        refreshOverlayNodesRef.current();
      });
      refreshOverlayNodes();
    }
  }, [userId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const textColor = theme === "dark" ? "#ffffff" : "#111111";
    const zoneColor = theme === "dark" ? "#c8d8e8" : "#263b4b";
    const zoneBgColor = theme === "dark" ? "#f4f8fa" : "#1a3a5c";
    const zoneBorderColor = theme === "dark" ? "#aebfcb" : "#3a6080";
    const edgeLabelBg = theme === "dark" ? "#16202b" : "#ffffff";
    cy.$("node.device").style("color", textColor);
    cy.$("node.zone").forEach((n) => {
      n.data("zoneLabelColor", zoneColor);
      n.data("zoneBgColor", zoneBgColor);
      n.data("zoneBorderColor", zoneBorderColor);
    });
    cy.$("edge").style("color", textColor);
    cy.$("edge").style("text-background-color", edgeLabelBg);
  }, [theme, layoutRevision, filteredGraph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const hadVisibleElements = cy.$("node.device").length > 0;
    persistCurrentTopologyLayout(cy, userId, layoutPositionsRef);
    const layout = buildDiagramLayout(filteredGraph, layoutPositionsRef.current, {
      groupOptions: Object.fromEntries(
        Object.entries(groupDisplayPrefs).map(([groupName, prefs]) => [
          groupName,
          {
            spacingScale: prefs.spacingScalePercent / 100,
            maxDevicesPerRow: prefs.maxDevicesPerRow,
          },
        ]),
      ),
    });
    const validNodeIds = new Set<string>([
      ...layout.groups.map((group) => group.id),
      ...filteredGraph.devices.map((device) => `device-${device.id}`),
    ]);
    cy.elements().remove();
    cy.add([
      ...layout.groups.map((group) => ({
        group: "nodes" as const,
        classes: "zone",
        data: {
          id: group.id,
          label: group.label,
          zoneLabelColor: theme === "dark" ? "#c8d8e8" : "#263b4b",
          zoneBgColor: theme === "dark" ? "#f4f8fa" : "#1a3a5c",
          zoneBorderColor: theme === "dark" ? "#aebfcb" : "#3a6080",
        },
      })),
      ...filteredGraph.devices.map((device) => {
        const count = eventCountByDeviceId.get(device.id)?.event_count ?? 0;
        const hasEvents = securityOverlayEnabled && count > 0;
        const liveStatus = liveStatusByDeviceId.get(device.id)?.status ?? device.monitor_status ?? "unknown";
        const nodeScale = (groupDisplayPrefs[device.topology_group]?.nodeScalePercent ?? 140) / 100;
        const iconSize = Math.round(30 * Math.max(0.7, Math.min(2.2, nodeScale)));
        const hitSize = Math.max(36, iconSize + 14);
        return {
          group: "nodes" as const,
          classes: `${hasEvents ? "device security-alert" : "device"} status-${liveStatus}`,
          data: {
            id: `device-${device.id}`,
            label:
              hasEvents
                ? `${deviceLabel(device)}\n${count} ${count === 1 ? "event" : "events"}`
                : deviceLabel(device),
            labelColor: theme === "dark" ? "#ffffff" : "#111111",
            color: device.color || statusColor(device.monitor_status ?? device.status),
            iconUrl: deviceIconUrl(device.icon, device.color || statusColor(device.monitor_status ?? device.status)),
            icon: resolveDeviceIcon(device.icon),
            parent: groupId(device.topology_group),
            nodeScale,
            hitSize,
          },
          position: layout.positions[`device-${device.id}`],
        };
      }),
      ...filteredGraph.relationships.map((relationship) => {
        // If a metadata-based group endpoint is unavailable in current view,
        // fall back to the backing device endpoint so render never crashes.
        const preferredSource = relationshipVisualSourceNodeId(relationship);
        const preferredTarget = relationshipVisualTargetNodeId(relationship);
        const source = validNodeIds.has(preferredSource) ? preferredSource : `device-${relationship.source_device_id}`;
        const target = validNodeIds.has(preferredTarget) ? preferredTarget : `device-${relationship.target_device_id}`;
        return {
          group: "edges" as const,
          data: {
            id: `relationship-${relationship.id}`,
            source,
            target,
            label: relationship.relationship_type,
            notes: relationship.notes,
            edgeLabelColor: theme === "dark" ? "#ffffff" : "#111111",
            edgeLabelBg: theme === "dark" ? "#16202b" : "#ffffff",
          },
        };
      }),
    ]);
    cy.layout({ name: "preset", fit: false, padding: 36 }).run();
    refreshOverlayNodes();
    if (fitOnNextRenderRef.current || !hadVisibleElements) {
      cy.fit(undefined, 36);
      fitOnNextRenderRef.current = false;
    }
  }, [activeIconPackId, eventCountByDeviceId, filteredGraph, groupDisplayPrefs, layoutRevision, liveStatusByDeviceId, securityOverlayEnabled, theme, userId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.$("node.device").unselect();
    if (selectedDeviceId === null) {
      return;
    }
    const node = cy.$id(`device-${selectedDeviceId}`);
    if (node.length > 0) {
      node.select();
      return;
    }
    setSelectedDeviceId(null);
  }, [selectedDeviceId, filteredGraph.devices]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.$("edge").unselect();
    if (selectedRelationshipId === null) {
      return;
    }
    const edge = cy.$id(`relationship-${selectedRelationshipId}`);
    if (edge.length > 0) {
      edge.select();
      return;
    }
    setSelectedRelationshipId(null);
  }, [selectedRelationshipId, filteredGraph.relationships]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const timeout = window.setTimeout(() => {
      cy.resize();
      cy.fit(undefined, 36);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [showDetailsPanel]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.$("node.zone").style({
      "background-opacity": Math.max(0, Math.min(1, groupZoneOpacityPercent / 100)),
      "border-opacity": showGroupZoneBorders ? 0.1 : 0,
      "border-width": showGroupZoneBorders ? 2 : 0,
    });
  }, [groupZoneOpacityPercent, layoutRevision, filteredGraph, showGroupZoneBorders]);

  useEffect(() => {
    if (!jumpTarget) {
      return;
    }
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const node = cy.$id(`device-${jumpTarget.deviceId}`);
    if (node.length === 0) {
      return;
    }
    setSelectedDeviceId(jumpTarget.deviceId);
    node.select();
    cy.animate({
      center: { eles: node },
      duration: 220,
    });
    node.addClass("focus-pulse");
    const timeout = window.setTimeout(() => node.removeClass("focus-pulse"), 1200);
    return () => window.clearTimeout(timeout);
  }, [jumpTarget]);

  async function updateDevice(deviceId: number, payload: DevicePayload) {
    if (!accessToken) return;
    setBusy(true);
    setTopologyError(null);
    pendingDevicePatchesRef.current[deviceId] = {
      display_name: payload.display_name,
      hostname: payload.hostname,
      ip_address: payload.ip_address ?? "",
      mac_address: payload.mac_address,
      vendor: payload.vendor,
      device_type: payload.device_type,
      status: payload.status,
      icon: payload.icon,
      color: payload.color,
      vlan_id: payload.vlan_id,
      subnet: payload.subnet,
      topology_group_id: payload.topology_group_id,
      tags: payload.tags,
      notes: payload.notes,
    };
    setLiveGraph((current) => ({
      ...current,
      devices: current.devices.map((device) =>
        device.id === deviceId
          ? {
              ...device,
              display_name: payload.display_name,
              hostname: payload.hostname,
              ip_address: payload.ip_address ?? "",
              mac_address: payload.mac_address,
              vendor: payload.vendor,
              device_type: payload.device_type,
              status: payload.status,
              icon: payload.icon,
              color: payload.color,
              vlan_id: payload.vlan_id,
              subnet: payload.subnet,
              topology_group_id: payload.topology_group_id,
              topology_group: current.devices.find((row) => row.id === deviceId)?.topology_group ?? device.topology_group,
              tags: payload.tags,
              notes: payload.notes,
            }
          : device,
      ),
    }));
    try {
      const updated = await api.updateDevice(accessToken, deviceId, payload);
      setLiveGraph((current) => ({
        ...current,
        devices: current.devices.map((device) =>
          device.id === updated.id
            ? { ...updated, ...pendingDevicePatchesRef.current[updated.id] }
            : device,
        ),
      }));
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to update device");
    } finally {
      setBusy(false);
    }
  }

  async function submitDevice(payload: DevicePayload) {
    if (!accessToken) return;
    setBusy(true);
    setTopologyError(null);
    try {
      const created = await api.createDevice(accessToken, payload);
      setLiveGraph((current) => ({
        ...current,
        devices: [...current.devices, created],
      }));
      setShowDeviceForm(false);
      setCloningDevice(null);
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to save device");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedDevice() {
    if (!accessToken || !selectedDevice) {
      return;
    }
    setBusy(true);
    setTopologyError(null);
    try {
      await api.deleteDevice(accessToken, selectedDevice.id);
      setLiveGraph((current) => ({
        ...current,
        devices: current.devices.filter((device) => device.id !== selectedDevice.id),
        relationships: current.relationships.filter(
          (relationship) =>
            relationship.source_device_id !== selectedDevice.id && relationship.target_device_id !== selectedDevice.id,
        ),
      }));
      setSelectedDeviceId(null);
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to delete device");
    } finally {
      setBusy(false);
    }
  }

  async function submitRelationship(payload: RelationshipPayload) {
    if (!accessToken) {
      return;
    }
    setBusy(true);
    setTopologyError(null);
    try {
      const created = await api.createRelationship(accessToken, payload);
      setLiveGraph((current) => ({
        ...current,
        relationships: [...current.relationships, created],
      }));
      setShowRelationshipForm(false);
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to save relationship");
    } finally {
      setBusy(false);
    }
  }

  async function updateSelectedRelationship(payload: {
    source_device_id: number;
    target_device_id: number;
    relationship_type: string;
    allow_outbound: boolean;
    allow_inbound: boolean;
    notes: string | null;
  }) {
    if (!accessToken || !selectedRelationship) {
      return;
    }
    setBusy(true);
    setTopologyError(null);
    pendingRelationshipPatchesRef.current[selectedRelationship.id] = {
      source_device_id: payload.source_device_id,
      target_device_id: payload.target_device_id,
      relationship_type: payload.relationship_type,
      allow_outbound: payload.allow_outbound,
      allow_inbound: payload.allow_inbound,
      notes: payload.notes,
    };
    setLiveGraph((current) => ({
      ...current,
      relationships: current.relationships.map((relationship) =>
        relationship.id === selectedRelationship.id
          ? {
              ...relationship,
              source_device_id: payload.source_device_id,
              target_device_id: payload.target_device_id,
              relationship_type: payload.relationship_type,
              allow_outbound: payload.allow_outbound,
              allow_inbound: payload.allow_inbound,
              notes: payload.notes,
            }
          : relationship,
      ),
    }));
    try {
      const updated = await api.updateRelationship(accessToken, selectedRelationship.id, payload);
      setLiveGraph((current) => ({
        ...current,
        relationships: current.relationships.map((relationship) =>
          relationship.id === updated.id
            ? {
                ...relationship,
                ...updated,
                allow_outbound: updated.allow_outbound ?? payload.allow_outbound,
                allow_inbound: updated.allow_inbound ?? payload.allow_inbound,
              }
            : relationship,
        ),
      }));
      setShowRelationshipEditForm(false);
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to update relationship");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedRelationship() {
    if (!accessToken || !selectedRelationship) {
      return;
    }
    if (!window.confirm(`Delete link "${selectedRelationship.relationship_type}"?`)) {
      return;
    }
    setBusy(true);
    setTopologyError(null);
    try {
      await api.deleteRelationship(accessToken, selectedRelationship.id);
      setLiveGraph((current) => ({
        ...current,
        relationships: current.relationships.filter((relationship) => relationship.id !== selectedRelationship.id),
      }));
      setSelectedRelationshipId(null);
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to delete relationship");
    } finally {
      setBusy(false);
    }
  }

  function fitTopology() {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.fit(undefined, 36);
  }

  function resetLayout() {
    clearSavedTopologyLayout(userId);
    layoutPositionsRef.current = {};
    fitOnNextRenderRef.current = true;
    setActiveSavedLayoutId(null);
    setLayoutRevision((current) => current + 1);
  }

  async function refreshSavedLayouts() {
    if (!accessToken) {
      return;
    }
    const layouts = await api.topologyLayouts(accessToken);
    setSavedLayouts(layouts);
  }

  async function saveNamedLayout(name: string) {
    if (!accessToken) {
      return;
    }
    const normalizedName = name.trim();
    if (!normalizedName) {
      setTopologyError("Layout name is required");
      return;
    }
    const positions = {
      ...layoutPositionsRef.current,
      ...collectCurrentTopologyLayoutPositions(cyRef.current),
    };
    if (Object.keys(positions).length === 0) {
      setTopologyError("No topology nodes are available to save");
      return;
    }
    setLayoutBusy(true);
    setTopologyError(null);
    try {
      const saved = await api.saveTopologyLayout(accessToken, { name: normalizedName, positions });
      setActiveSavedLayoutId(saved.id);
      await refreshSavedLayouts();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to save layout");
    } finally {
      setLayoutBusy(false);
    }
  }

  function loadSavedLayout(layout: TopologyLayout) {
    layoutPositionsRef.current = { ...layout.positions };
    window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(layout.positions));
    fitOnNextRenderRef.current = true;
    setActiveSavedLayoutId(layout.id);
    setLayoutRevision((current) => current + 1);
  }

  async function deleteSavedLayout(layout: TopologyLayout) {
    if (!accessToken) {
      return;
    }
    setLayoutBusy(true);
    setTopologyError(null);
    try {
      await api.deleteTopologyLayout(accessToken, layout.id);
      if (activeSavedLayoutId === layout.id) {
        setActiveSavedLayoutId(null);
      }
      await refreshSavedLayouts();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to delete layout");
    } finally {
      setLayoutBusy(false);
    }
  }

  async function saveLayoutPrompt() {
    const defaultName =
      savedLayouts.find((layout) => layout.id === activeSavedLayoutId)?.name ?? "";
    const entered = window.prompt("Save layout as", defaultName);
    if (entered === null) {
      return;
    }
    await saveNamedLayout(entered);
  }

  function autoArrangeSelectedGroup() {
    const cy = cyRef.current;
    if (!cy || !selectedGroupForDisplay) {
      return;
    }
    const groupDevices = filteredGraph.devices
      .filter((device) => device.topology_group === selectedGroupForDisplay)
      .sort(compareDevices);
    if (groupDevices.length === 0) {
      return;
    }
    const spacingScale = Math.max(0.8, Math.min(2.2, activeGroupDisplay.spacingScalePercent / 100));
    const maxPerRow = Math.max(1, activeGroupDisplay.maxDevicesPerRow);
    const gapX = Math.round(126 * spacingScale);
    const gapY = Math.round(112 * spacingScale);
    const rows = buildGroupVisualRows(devicesByHierarchy(groupDevices), maxPerRow);
    const zoneNode = cy.$id(groupId(selectedGroupForDisplay));
    const anchor = zoneNode.length > 0 ? zoneNode.position() : estimateGroupCenter(groupDevices, layoutPositionsRef.current);

    const nextPositions = { ...layoutPositionsRef.current };
    const startY = anchor.y - ((rows.length - 1) * gapY) / 2;
    rows.forEach((rowDevices, rowIndex) => {
      rowDevices.forEach((device, index) => {
        const id = `device-${device.id}`;
        const x = anchor.x + centeredOffset(index, rowDevices.length, gapX);
        const y = startY + rowIndex * gapY;
        const node = cy.$id(id);
        if (node.length > 0) {
          node.position({ x, y });
        }
        nextPositions[id] = { x, y };
      });
    });
    layoutPositionsRef.current = nextPositions;
    window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(nextPositions));
    refreshOverlayNodes();
    return;
  }

  function exportTopologyPng() {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    downloadDataUrl(cy.png({ full: true, bg: "#fbfdfe", scale: 2 }), "netmap-topology.png");
  }

  function exportTopologySvg() {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    downloadTextFile(buildTopologySvg(cy), "netmap-topology.svg", "image/svg+xml");
  }

  return (
    <section className="topology-layout" id="topology">
      {expandedEntitySection && (
        <div className="topo-entity-backdrop" onClick={() => setExpandedEntitySection(null)} />
      )}
      <div className="topo-entity-panel">
        {(["devices", "relationships", "groups"] as const).map((section) => {
          const isActive = expandedEntitySection === section;
          const count = section === "devices"
            ? filteredGraph.devices.length
            : section === "relationships"
            ? filteredGraph.relationships.length
            : new Set(filteredGraph.devices.map((d) => d.topology_group).filter(Boolean)).size;
          const icon = section === "devices"
            ? <IconServer size={13} />
            : section === "relationships"
            ? <Network size={13} />
            : <IconTopologyRing size={13} />;
          const label = section === "devices" ? "Devices" : section === "relationships" ? "Links" : "Groups";
          return (
            <button
              key={section}
              type="button"
              className={`topo-stat-btn${isActive ? " topo-stat-btn--active" : ""} topo-stat-btn--${section}`}
              onClick={() => setExpandedEntitySection(isActive ? null : section)}
            >
              <span className="topo-stat-icon">{icon}</span>
              <span className="topo-stat-count">{count}</span>
              <span className="topo-stat-label">{label}</span>
              {isActive ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </button>
          );
        })}
        {expandedEntitySection && (
          <div className="topo-entity-list">
            {expandedEntitySection === "devices" && (
              filteredGraph.devices.length === 0
                ? <p className="topo-entity-empty">No devices</p>
                : filteredGraph.devices.map((device) => {
                    const liveStatus = liveStatusByDeviceId.get(device.id);
                    const dotStatus = device.status === "disabled" ? "disabled" : (liveStatus?.status ?? device.monitor_status ?? device.status);
                    return (
                      <button
                        key={device.id}
                        type="button"
                        className={`topo-entity-row${selectedDeviceId === device.id ? " topo-entity-row--active" : ""}`}
                        onClick={() => { setSelectedDeviceId(device.id); setSelectedRelationshipId(null); setExpandedEntitySection(null); }}
                      >
                        <span className={`status-dot status-dot--sm ${dotStatus}`} />
                        <span className="topo-entity-name">{deviceLabel(device)}</span>
                        <span className="topo-entity-meta">{device.ip_address}</span>
                      </button>
                    );
                  })
            )}
            {expandedEntitySection === "relationships" && (
              filteredGraph.relationships.length === 0
                ? <p className="topo-entity-empty">No links</p>
                : filteredGraph.relationships.map((rel) => {
                    const src = liveGraph.devices.find((d) => d.id === rel.source_device_id);
                    const tgt = liveGraph.devices.find((d) => d.id === rel.target_device_id);
                    return (
                      <button
                        key={rel.id}
                        type="button"
                        className={`topo-entity-row${selectedRelationshipId === rel.id ? " topo-entity-row--active" : ""}`}
                        onClick={() => { setSelectedRelationshipId(rel.id); setSelectedDeviceId(null); setExpandedEntitySection(null); }}
                      >
                        <span className="topo-entity-name">{src ? deviceLabel(src) : `#${rel.source_device_id}`}</span>
                        <span className="topo-entity-arrow">→</span>
                        <span className="topo-entity-name">{tgt ? deviceLabel(tgt) : `#${rel.target_device_id}`}</span>
                        {rel.relationship_type && <span className="topo-entity-tag">{rel.relationship_type}</span>}
                      </button>
                    );
                  })
            )}
            {expandedEntitySection === "groups" && (() => {
              const groupMap = new Map<string, Device[]>();
              for (const d of filteredGraph.devices) {
                if (!d.topology_group) continue;
                const arr = groupMap.get(d.topology_group) ?? [];
                arr.push(d);
                groupMap.set(d.topology_group, arr);
              }
              const entries = [...groupMap.entries()].sort(([a], [b]) => a.localeCompare(b));
              return entries.length === 0
                ? <p className="topo-entity-empty">No groups</p>
                : entries.map(([groupName, devices]) => (
                    <div key={groupName} className="topo-entity-row topo-entity-row--group">
                      <span className="topo-entity-group-dot" />
                      <span className="topo-entity-name">{groupName}</span>
                      <span className="topo-entity-meta">{devices.length} device{devices.length !== 1 ? "s" : ""}</span>
                    </div>
                  ));
            })()}
          </div>
        )}
      </div>
      <div className="topology-toolbar topology-toolbar--ribbon">
        <div className="toolbar-group">
          <div className="toolbar-group-controls">
            <select
              className="toolbar-select"
              value={selectedSiteId ?? 0}
              onChange={(event) => {
                const id = Number(event.target.value);
                setSelectedSiteId(id === 0 ? null : id);
              }}
            >
              <option value={0}>All Sites</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>{site.display_name ?? site.name}</option>
              ))}
            </select>
            <span className="inv-stat-chip inv-stat-chip--green">
              <IconWifi size={13} className="inv-stat-chip-icon" />
              <strong className="inv-stat-chip-count">{topoStatusCounts.online}</strong>
              <span className="inv-stat-chip-label">Online</span>
            </span>
            <span className={`inv-stat-chip ${topoStatusCounts.offline > 0 ? "inv-stat-chip--red" : "inv-stat-chip--muted"}`}>
              <IconWifiOff size={13} className="inv-stat-chip-icon" />
              <strong className="inv-stat-chip-count">{topoStatusCounts.offline}</strong>
              <span className="inv-stat-chip-label">Offline</span>
            </span>
          </div>
        </div>
        <div className="toolbar-divider" />
        <div className="toolbar-group">
          <div className="toolbar-group-controls">
            <button type="button" className="toolbar-btn" onClick={fitTopology}>Fit</button>
            <button type="button" className="toolbar-btn" onClick={resetLayout}>Reset</button>
            {canWrite && (
              <>
                <button type="button" className="toolbar-btn" onClick={exportTopologyPng}>PNG</button>
                <button type="button" className="toolbar-btn" onClick={exportTopologySvg}>SVG</button>
              </>
            )}
          </div>
        </div>
        <div className="toolbar-divider" />
        <div className="toolbar-group">
          <div className="toolbar-group-controls toolbar-group--toggles">
            <label className="toolbar-toggle">
              <input type="checkbox" checked={showNodeIcons} onChange={(e) => setShowNodeIcons(e.target.checked)} />
              Icons
            </label>
            <label className="toolbar-toggle">
              <input type="checkbox" checked={showNodeLabels} onChange={(e) => setShowNodeLabels(e.target.checked)} />
              Text
            </label>
          </div>
        </div>
        <div className="toolbar-divider" />
        <div className="toolbar-group">
          <div className="toolbar-group-controls">
            <div className="toolbar-dropdown-wrapper">
              <button
                type="button"
                className={showDisplaySettings ? "toolbar-btn toolbar-btn--active" : "toolbar-btn"}
                onClick={() => setShowDisplaySettings((c) => !c)}
              >
                Display
                <ChevronDown size={11} style={{ transition: "transform 0.18s", transform: showDisplaySettings ? "rotate(180deg)" : undefined }} />
              </button>
              {showDisplaySettings && (
                <div className="toolbar-display-panel">
                  <label>
                    Group
                    <select value={selectedGroupForDisplay} onChange={(e) => setSelectedGroupForDisplay(e.target.value)}>
                      {visibleGroupNames.map((groupName) => (
                        <option key={`display-${groupName}`} value={groupName}>{groupName}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="toolbar-btn" onClick={autoArrangeSelectedGroup} disabled={!visibleGroupNames.includes(selectedGroupForDisplay)}>
                    Auto-arrange group
                  </button>
                  <label>
                    Node size <span>{activeGroupDisplay.nodeScalePercent}%</span>
                    <input type="range" min={70} max={180} step={5} value={activeGroupDisplay.nodeScalePercent}
                      onChange={(e) => setGroupDisplayPrefs((c) => ({ ...c, [selectedGroupForDisplay]: { ...activeGroupDisplay, nodeScalePercent: Number(e.target.value) } }))} />
                  </label>
                  <label>
                    Spacing <span>{activeGroupDisplay.spacingScalePercent}%</span>
                    <input type="range" min={80} max={220} step={10} value={activeGroupDisplay.spacingScalePercent}
                      onChange={(e) => setGroupDisplayPrefs((c) => ({ ...c, [selectedGroupForDisplay]: { ...activeGroupDisplay, spacingScalePercent: Number(e.target.value) } }))} />
                  </label>
                  <label>
                    Per row <span>{activeGroupDisplay.maxDevicesPerRow}</span>
                    <input type="range" min={3} max={8} step={1} value={activeGroupDisplay.maxDevicesPerRow}
                      onChange={(e) => setGroupDisplayPrefs((c) => ({ ...c, [selectedGroupForDisplay]: { ...activeGroupDisplay, maxDevicesPerRow: Number(e.target.value) } }))} />
                  </label>
                  <label>
                    Background <span>{groupZoneOpacityPercent}%</span>
                    <input type="range" min={0} max={100} step={5} value={groupZoneOpacityPercent}
                      onChange={(e) => setGroupZoneOpacityPercent(Number(e.target.value))} />
                  </label>
                </div>
              )}
            </div>
            {canWrite && (
              <>
                <button type="button" className="toolbar-btn toolbar-btn--primary" onClick={() => setShowDeviceForm(true)}>+ Device</button>
                <button type="button" className="toolbar-btn" onClick={() => setShowScanModal(true)}>Scan</button>
                <button type="button" className="toolbar-btn" disabled={liveGraph.devices.length < 2} onClick={() => setShowRelationshipForm(true)}>+ Link</button>
              </>
            )}
          </div>
        </div>
      </div>
      {topologyError && <div className="form-error">{topologyError}</div>}
      <div className={showDetailsPanel ? "topology-content details-open" : "topology-content"}>
        <div className="graph-surface">
          <div className="graph-canvas" ref={containerRef} />
          <div className="topology-overlay-layer">
            {overlayNodes.map((node) => (
              <button
                key={`overlay-${node.id}`}
                type="button"
                className={`topology-overlay-node${selectedDeviceId === node.id ? " selected" : ""}`}
                style={{ left: `${node.x}px`, top: `${node.y}px` }}
                onClick={() => {
                  setSelectedDeviceId(node.id);
                  setSelectedRelationshipId(null);
                }}
                title={node.lines[0]}
              >
                {showNodeIcons && (
                  <svg viewBox="0 0 24 24" width={node.size} height={node.size} fill="none" stroke={node.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <g dangerouslySetInnerHTML={{ __html: deviceIconPath(node.icon) }} />
                  </svg>
                )}
                {showNodeLabels && (
                  <span className="topology-overlay-label">
                    {node.lines.map((line, index) => (
                      <span key={`${node.id}-line-${index}`}>{line}</span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </div>
          {filteredGraph.devices.length === 0 && <div className="empty-graph">No devices match the current view</div>}
        </div>
        {showDetailsPanel && (
          <aside className="details-panel">
            {selectedDevice ? (
              <DeviceDetails
                canViewSecurity={canViewSecurity}
                canWrite={canWrite}
                device={selectedDevice}
                disabled={busy}
                groups={groups}
                sites={sites}
                liveStatus={liveStatusByDeviceId.get(selectedDevice.id) ?? null}
                onDelete={deleteSelectedDevice}
                onClone={() => {
                  setCloningDevice(selectedDevice);
                  setShowDeviceForm(true);
                }}
                onSubmit={(payload) => updateDevice(selectedDevice.id, payload)}
                securityLoading={deviceSecurityLoading}
                securitySummary={deviceSecuritySummary}
              />
            ) : selectedRelationship ? (
              <RelationshipDetails
                canWrite={canWrite}
                devices={liveGraph.devices}
                disabled={busy}
                relationship={selectedRelationship}
                onDelete={() => void deleteSelectedRelationship()}
                onEdit={() => setShowRelationshipEditForm(true)}
              />
            ) : null}
          </aside>
        )}
      </div>
      {showDeviceForm && (
        <DeviceForm
          busy={busy}
          device={null}
          cloneSource={cloningDevice}
          groups={groups}
          sites={sites}
          onCancel={() => {
            setShowDeviceForm(false);
            setCloningDevice(null);
          }}
          onSubmit={submitDevice}
        />
      )}
      {showRelationshipForm && (
        <RelationshipForm
          busy={busy}
          devices={liveGraph.devices}
          onCancel={() => setShowRelationshipForm(false)}
          onSubmit={submitRelationship}
        />
      )}
      {showRelationshipEditForm && selectedRelationship && (
        <RelationshipEditForm
          busy={busy}
          devices={liveGraph.devices}
          relationship={selectedRelationship}
          onCancel={() => setShowRelationshipEditForm(false)}
          onSubmit={updateSelectedRelationship}
        />
      )}
      {showScanModal && (
        <DiscoveryModal
          accessToken={accessToken}
          onCancel={() => setShowScanModal(false)}
          onImported={async () => {
            setShowScanModal(false);
            await onGraphChange();
          }}
        />
      )}
    </section>
  );
}

// ── Device import helpers ────────────────────────────────────────────────────

type ImportRow = Partial<DevicePayload> & { ip_address: string; _rowError?: string };

const COLUMN_ALIASES: Record<string, string> = {
  ip: "ip_address", "ip address": "ip_address", ipaddress: "ip_address", "ip_address": "ip_address",
  host: "hostname", name: "hostname", hostname: "hostname",
  "display name": "display_name", displayname: "display_name", label: "display_name", display_name: "display_name", "friendly name": "display_name",
  mac: "mac_address", "mac address": "mac_address", macaddress: "mac_address", mac_address: "mac_address",
  vendor: "vendor", manufacturer: "vendor", make: "vendor",
  type: "device_type", "device type": "device_type", devicetype: "device_type", device_type: "device_type",
  vlan: "vlan_id", "vlan id": "vlan_id", vlanid: "vlan_id", vlan_id: "vlan_id",
  group: "topology_group", "topology group": "topology_group", topology_group: "topology_group", vlan_group: "topology_group", "vlan group": "topology_group",
  site: "topology_group", location: "topology_group",
  notes: "notes", description: "notes", note: "notes",
  tags: "tags", tag: "tags", labels: "tags",
};

function normalizeHeader(h: string): string {
  return COLUMN_ALIASES[h.toLowerCase().trim()] ?? h.toLowerCase().trim();
}

function rowsToImportRows(raw: Record<string, string>[]): ImportRow[] {
  return raw.map((obj) => {
    const mapped: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      mapped[normalizeHeader(k)] = v;
    }
    const ip = (mapped["ip_address"] ?? "").trim();
    if (!ip) return { ip_address: "", _rowError: "Missing IP address" } as ImportRow;
    const tags = mapped["tags"] ? mapped["tags"].split(",").map((t) => t.trim()).filter(Boolean) : [];
    return {
      ip_address: ip,
      display_name: mapped["display_name"]?.trim() || null,
      hostname: mapped["hostname"]?.trim() || null,
      mac_address: mapped["mac_address"]?.trim() || null,
      vendor: mapped["vendor"]?.trim() || null,
      device_type: mapped["device_type"]?.trim() || null,
      vlan_id: mapped["vlan_id"]?.trim() || null,
      topology_group: mapped["topology_group"]?.trim() || null,
      notes: mapped["notes"]?.trim() || null,
      tags,
    } as ImportRow;
  });
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
    return obj;
  });
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) { result.push(cur); cur = ""; }
    else cur += ch;
  }
  result.push(cur);
  return result.map((s) => s.trim());
}

function parseJSON(text: string): Record<string, string>[] {
  const data = JSON.parse(text);
  const arr: unknown[] = Array.isArray(data) ? data : data.devices ?? data.items ?? data.data ?? [];
  return arr.map((item) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.join(",");
      else out[k] = v != null ? String(v) : "";
    }
    return out;
  });
}

async function parseXLSX(file: File): Promise<Record<string, string>[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let xlsxLib: any;
  try {
    // Indirection prevents TS from statically resolving the uninstalled module
    const mod = "xlsx";
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    xlsxLib = await import(/* @vite-ignore */ /* webpackIgnore: true */ mod);
  } catch {
    throw new Error("Excel support requires the xlsx package. Run npm install in the frontend directory, then restart the dev server.");
  }
  const buf = await file.arrayBuffer();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const wb = xlsxLib.read(buf, { type: "array" });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const ws = wb.Sheets[wb.SheetNames[0]];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const rows = xlsxLib.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
  if (rows.length < 2) return [];
  const headers = (rows[0] as unknown[]).map(String);
  return (rows.slice(1) as unknown[][]).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = row[i] != null ? String(row[i]) : ""; });
    return obj;
  });
}

async function parseImportFile(file: File): Promise<Record<string, string>[]> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "json") return parseJSON(await file.text());
  if (ext === "xlsx" || ext === "xls") return parseXLSX(file);
  return parseCSV(await file.text()); // csv, txt, or default
}

function DeviceImportModal({
  accessToken,
  onClose,
  onImported,
}: {
  accessToken: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number; errors: string[] } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const validRows = rows.filter((r) => r.ip_address && !r._rowError);
  const errorRows = rows.filter((r) => !r.ip_address || r._rowError);

  async function handleFile(file: File) {
    setParseError(null); setRows([]); setResult(null);
    setFileName(file.name);
    try {
      const raw = await parseImportFile(file);
      setRows(rowsToImportRows(raw));
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Failed to parse file");
    }
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  async function doImport() {
    if (!validRows.length) return;
    setBusy(true);
    try {
      const res = await api.importDevices(accessToken, validRows);
      setResult(res);
      onImported();
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Import failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal import-modal">
        <div className="modal-header">
          <span className="modal-title">Import devices</span>
          <button type="button" className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="import-modal-body">
          {/* Drop zone */}
          {!fileName && (
            <label
              className={`import-dropzone${dragOver ? " import-dropzone--over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <Upload size={28} style={{ opacity: 0.5 }} />
              <span className="import-dropzone-label">Drop a file here or click to browse</span>
              <span className="import-dropzone-hint">Supports CSV, JSON, and XLSX (Excel)</span>
              <input type="file" accept=".csv,.json,.xlsx,.xls" style={{ display: "none" }} onChange={onFileInput} />
            </label>
          )}

          {/* File picked — show summary + preview */}
          {fileName && !result && (
            <>
              <div className="import-file-row">
                <span className="import-file-name">{fileName}</span>
                <button type="button" className="dash-panel-link" onClick={() => { setFileName(null); setRows([]); setParseError(null); }}>
                  Change file
                </button>
              </div>

              {parseError && <p className="import-error">{parseError}</p>}

              {rows.length > 0 && (
                <>
                  <div className="import-summary-row">
                    <span className="import-summary-ok">{validRows.length} valid row{validRows.length !== 1 ? "s" : ""}</span>
                    {errorRows.length > 0 && <span className="import-summary-err">{errorRows.length} row{errorRows.length !== 1 ? "s" : ""} with errors (will be skipped)</span>}
                  </div>

                  <div className="import-preview-wrap">
                    <table className="mon-table import-preview-table">
                      <thead>
                        <tr>
                          <th></th>
                          <th>IP address</th>
                          <th>Display name</th>
                          <th>Hostname</th>
                          <th>Vendor</th>
                          <th>Type</th>
                          <th>VLAN</th>
                          <th>Group</th>
                          <th>Tags</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 50).map((row, i) => (
                          <tr key={i} className={`mon-row${row._rowError ? " import-row--error" : ""}`}>
                            <td>{row._rowError ? <span title={row._rowError} style={{ color: "var(--dash-red)" }}>✕</span> : <span style={{ color: "var(--dash-green)" }}>✓</span>}</td>
                            <td className="mon-cell-mono">{row.ip_address || <em style={{ opacity: 0.5 }}>missing</em>}</td>
                            <td>{row.display_name ?? "—"}</td>
                            <td>{row.hostname ?? "—"}</td>
                            <td>{row.vendor ?? "—"}</td>
                            <td>{row.device_type ?? "—"}</td>
                            <td>{row.vlan_id ?? "—"}</td>
                            <td>{row.topology_group ?? "—"}</td>
                            <td>{row.tags?.join(", ") || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > 50 && <p className="import-truncate-note">Showing first 50 of {rows.length} rows.</p>}
                  </div>

                  <div className="import-actions">
                    <button type="button" className="vlan-action-btn" style={{ background: "#1d9ab0", color: "#fff", borderColor: "#1d9ab0" }} disabled={busy || validRows.length === 0} onClick={() => void doImport()}>
                      {busy ? "Importing…" : `Import ${validRows.length} device${validRows.length !== 1 ? "s" : ""}`}
                    </button>
                    <button type="button" className="vlan-action-btn" onClick={onClose}>Cancel</button>
                  </div>
                </>
              )}
            </>
          )}

          {/* Result */}
          {result && (
            <div className="import-result">
              <div className="import-result-stats">
                <span className="import-result-stat import-result-stat--ok">
                  <strong>{result.created}</strong> created
                </span>
                <span className="import-result-stat import-result-stat--warn">
                  <strong>{result.updated}</strong> updated
                </span>
                {result.errors.length > 0 && (
                  <span className="import-result-stat import-result-stat--err">
                    <strong>{result.errors.length}</strong> errors
                  </span>
                )}
              </div>
              {result.errors.length > 0 && (
                <ul className="import-result-errors">
                  {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
              <button type="button" className="vlan-action-btn" style={{ marginTop: 12 }} onClick={onClose}>Done</button>
            </div>
          )}
        </div>

        {/* Field reference */}
        <details className="import-field-ref">
          <summary>Supported column names</summary>
          <table className="import-ref-table">
            <thead><tr><th>Field</th><th>Accepted header names</th></tr></thead>
            <tbody>
              <tr><td>IP address <strong>*</strong></td><td>ip, ip_address, ip address</td></tr>
              <tr><td>Display name</td><td>display_name, display name, label, friendly name</td></tr>
              <tr><td>Hostname</td><td>hostname, host, name</td></tr>
              <tr><td>MAC address</td><td>mac, mac_address, mac address</td></tr>
              <tr><td>Vendor</td><td>vendor, manufacturer, make</td></tr>
              <tr><td>Device type</td><td>type, device_type, device type</td></tr>
              <tr><td>VLAN ID</td><td>vlan, vlan_id, vlan id</td></tr>
              <tr><td>Group</td><td>group, topology_group, site, location</td></tr>
              <tr><td>Notes</td><td>notes, description, note</td></tr>
              <tr><td>Tags</td><td>tags, tag, labels (comma-separated)</td></tr>
            </tbody>
          </table>
        </details>
      </div>
    </div>
  );
}

let _inventoryStatusCache: DeviceLiveStatus[] = [];

function InventoryWorkspace({
  accessToken,
  canWrite,
  graph,
  livePingEnabled,
  onGraphChange,
}: {
  accessToken: string;
  canWrite: boolean;
  graph: TopologyGraph;
  livePingEnabled: boolean;
  onGraphChange: () => Promise<void>;
}) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(graph.devices[0]?.id ?? null);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<number>>(new Set());
  const [selectedGroupFilter, setSelectedGroupFilter] = useState('all');
  const [selectedSiteFilter, setSelectedSiteFilter] = useState('all');
  const [bulkGroupId, setBulkGroupId] = useState('');
  const [bulkDeviceType, setBulkDeviceType] = useState('');
  const [bulkSiteId, setBulkSiteId] = useState('');
  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [liveStatusBusy, setLiveStatusBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [liveStatuses, setLiveStatuses] = useState<DeviceLiveStatus[]>(_inventoryStatusCache);
  const [inventorySortKey, setInventorySortKey] = useState<string>("device");
  const [inventorySortDir, setInventorySortDir] = useState<"asc" | "desc">("asc");
  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  const selectedDevice = graph.devices.find((device) => device.id === selectedDeviceId) ?? null;
  const groupOptions = useMemo(
    () => [...new Set(graph.devices.map((device) => device.topology_group))].filter(Boolean).sort(compareGroupLabels),
    [graph.devices],
  );
  const filteredDevices = useMemo(() => {
    let devs = selectedGroupFilter === 'all' ? graph.devices : graph.devices.filter((d) => d.topology_group === selectedGroupFilter);
    if (selectedSiteFilter === 'unassigned') {
      devs = devs.filter((d) => d.site_id === null);
    } else if (selectedSiteFilter !== 'all') {
      const siteId = Number(selectedSiteFilter);
      devs = devs.filter((d) => d.site_id === siteId);
    }
    return devs;
  }, [graph.devices, selectedGroupFilter, selectedSiteFilter]);
  const liveStatusByDeviceId = useMemo(() => new Map(liveStatuses.map((status) => [status.device_id, status])), [liveStatuses]);

  useEffect(() => {
    let cancelled = false;
    async function loadGroups() {
      try {
        const rows = await api.topologyGroups(accessToken);
        if (!cancelled) setGroups(rows);
      } catch {
        // inventory remains functional without group metadata
      }
    }
    async function loadSites() {
      try {
        const rows = await api.sites(accessToken);
        if (!cancelled) setSites(rows);
      } catch {
        // inventory remains functional without site metadata
      }
    }
    void loadGroups();
    void loadSites();
    return () => {
      cancelled = true;
    };
  }, [accessToken, graph.devices]);

  useEffect(() => {
    if ((!selectedDeviceId || !graph.devices.some((device) => device.id === selectedDeviceId)) && graph.devices.length > 0) {
      setSelectedDeviceId(graph.devices[0].id);
    }
  }, [graph.devices, selectedDeviceId]);

  useEffect(() => {
    setSelectedDeviceIds((current) => new Set([...current].filter((id) => graph.devices.some((device) => device.id === id))));
  }, [graph.devices]);

  async function refreshLiveStatuses(silent = false) {
    if (!livePingEnabled || graph.devices.length === 0) {
      setLiveStatuses([]);
      return;
    }
    if (!silent) {
      setLiveStatusBusy(true);
      setInventoryError(null);
    }
    try {
      const response = await api.topologyLiveStatuses(accessToken, {
        device_ids: graph.devices.slice(0, 64).map((device) => device.id),
        timeout_seconds: 2,
      });
      _inventoryStatusCache = response.statuses;
      setLiveStatuses(response.statuses);
    } catch (err) {
      if (!silent) {
        setInventoryError(err instanceof Error ? err.message : 'Unable to refresh live status');
      }
    } finally {
      if (!silent) {
        setLiveStatusBusy(false);
      }
    }
  }

  useEffect(() => {
    if (!livePingEnabled || graph.devices.length === 0) {
      setLiveStatuses([]);
      return;
    }
    const intervalId = window.setInterval(() => {
      void refreshLiveStatuses(true);
    }, 30_000);
    void refreshLiveStatuses();
    return () => window.clearInterval(intervalId);
  }, [accessToken, graph.devices, livePingEnabled]);

  async function applyBulkActions() {
    if (!canWrite || selectedDeviceIds.size === 0) return;
    const patch: Parameters<typeof api.updateDevice>[2] = {};
    if (bulkGroupId === '0') patch.topology_group_id = null;
    else if (bulkGroupId) patch.topology_group_id = Number(bulkGroupId);
    if (bulkDeviceType) {
      patch.device_type = bulkDeviceType;
      patch.icon = (deviceTypeIconMap[bulkDeviceType] || "device") as DeviceIcon;
    }
    if (bulkSiteId === 'unassign') patch.site_id = null;
    else if (bulkSiteId) patch.site_id = Number(bulkSiteId);
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    setInventoryError(null);
    try {
      await Promise.all([...selectedDeviceIds].map((id) => api.updateDevice(accessToken, id, patch)));
      await onGraphChange();
      setSelectedDeviceIds(new Set());
      setBulkGroupId('');
      setBulkDeviceType('');
      setBulkSiteId('');
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to apply bulk actions');
    } finally {
      setBusy(false);
    }
  }

  function selectAllFiltered() {
    setSelectedDeviceIds(new Set(filteredDevices.map((device) => device.id)));
  }

  function clearSelection() {
    setSelectedDeviceIds(new Set());
  }

  function toggleSort(key: string) {
    if (inventorySortKey === key) {
      setInventorySortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setInventorySortKey(key);
      setInventorySortDir("asc");
    }
  }

  async function deleteSelected() {
    if (!canWrite || selectedDeviceIds.size === 0) {
      return;
    }
    if (!window.confirm(`Delete ${selectedDeviceIds.size} selected devices?`)) {
      return;
    }
    setBusy(true);
    setInventoryError(null);
    try {
      await Promise.all([...selectedDeviceIds].map((deviceId) => api.deleteDevice(accessToken, deviceId)));
      setSelectedDeviceIds(new Set());
      await onGraphChange();
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to delete selected devices');
    } finally {
      setBusy(false);
    }
  }

  async function updateSelectedStatus(status: DeviceStatus) {
    if (!canWrite || selectedDeviceIds.size === 0) {
      return;
    }
    setBusy(true);
    setInventoryError(null);
    try {
      await Promise.all([...selectedDeviceIds].map((deviceId) => api.updateDevice(accessToken, deviceId, { status })));
      await onGraphChange();
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to update selected devices');
    } finally {
      setBusy(false);
    }
  }

  async function updateDeviceGroup(deviceId: number, groupId: string) {
    if (!canWrite) {
      return;
    }
    setBusy(true);
    setInventoryError(null);
    try {
      await api.updateDevice(accessToken, deviceId, {
        topology_group_id: groupId ? Number(groupId) : null,
      });
      await onGraphChange();
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : "Unable to update device group");
    } finally {
      setBusy(false);
    }
  }

  async function updateDeviceSite(deviceId: number, siteIdStr: string) {
    if (!canWrite) return;
    setBusy(true);
    setInventoryError(null);
    try {
      await api.updateDevice(accessToken, deviceId, { site_id: siteIdStr ? Number(siteIdStr) : null });
      await onGraphChange();
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to update device location');
    } finally {
      setBusy(false);
    }
  }

  async function submitDeviceUpdate(deviceId: number, payload: DevicePayload) {
    setBusy(true);
    setInventoryError(null);
    try {
      await api.updateDevice(accessToken, deviceId, payload);
      await onGraphChange();
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to save device');
    } finally {
      setBusy(false);
    }
  }

  async function toggleFav(deviceId: number) {
    try {
      await api.toggleFavourite(accessToken, deviceId);
      await onGraphChange();
    } catch { /* ignore */ }
  }

  async function submitNewDevice(payload: DevicePayload) {
    setBusy(true);
    setInventoryError(null);
    try {
      await api.createDevice(accessToken, payload);
      setShowDeviceForm(false);
      await onGraphChange();
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to create device');
    } finally {
      setBusy(false);
    }
  }

  const groupCount = new Set(graph.devices.map((d) => d.topology_group).filter(Boolean)).size;
  const invOnlineCount = liveStatuses.length > 0
    ? liveStatuses.filter((s) => s.status === "online").length
    : graph.devices.filter((d) => (d.monitor_status ?? d.status) === "online").length;
  const invOfflineCount = liveStatuses.length > 0
    ? liveStatuses.filter((s) => s.status === "offline").length
    : graph.devices.filter((d) => (d.monitor_status ?? d.status) === "offline").length;

  return (
    <section className="topology-layout">
      <div className="topology-toolbar topology-toolbar--ribbon">

        {/* Stat chips */}
        <div className="toolbar-group">
          <div className="toolbar-group-controls" style={{ gap: 6 }}>
            <span className="inv-stat-chip inv-stat-chip--teal">
              <IconServer size={13} className="inv-stat-chip-icon" />
              <strong className="inv-stat-chip-count">{graph.devices.length}</strong>
              <span className="inv-stat-chip-label">Devices</span>
            </span>
            <span className="inv-stat-chip inv-stat-chip--green">
              <IconWifi size={13} className="inv-stat-chip-icon" />
              <strong className="inv-stat-chip-count">{invOnlineCount}</strong>
              <span className="inv-stat-chip-label">Online</span>
            </span>
            <span className={`inv-stat-chip ${invOfflineCount > 0 ? "inv-stat-chip--red" : "inv-stat-chip--muted"}`}>
              <IconWifiOff size={13} className="inv-stat-chip-icon" />
              <strong className="inv-stat-chip-count">{invOfflineCount}</strong>
              <span className="inv-stat-chip-label">Offline</span>
            </span>
            <span className="inv-stat-chip inv-stat-chip--purple">
              <IconMap size={13} className="inv-stat-chip-icon" />
              <strong className="inv-stat-chip-count">{groupCount}</strong>
              <span className="inv-stat-chip-label">Groups</span>
            </span>
          </div>
        </div>

        <div className="toolbar-divider" />

        {/* Filter */}
        <div className="toolbar-group">
          <div className="toolbar-group-controls">
            <select className="toolbar-select" value={selectedGroupFilter} onChange={(e) => setSelectedGroupFilter(e.target.value)}>
              <option value="all">All groups</option>
              {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <select className="toolbar-select" value={selectedSiteFilter} onChange={(e) => setSelectedSiteFilter(e.target.value)}>
              <option value="all">All sites</option>
              <option value="unassigned">Unassigned</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.display_name ?? s.name}</option>)}
            </select>
          </div>
        </div>

        {canWrite && (
          <>
            <div className="toolbar-divider" />
            {/* Add / edit */}
            <div className="toolbar-group">
              <div className="toolbar-group-controls">
                <button type="button" className="toolbar-btn toolbar-btn--primary" onClick={() => setShowDeviceForm(true)}>+ Device</button>
                <button type="button" className="toolbar-btn" onClick={() => setShowScanModal(true)}>Scan</button>
                <button type="button" className="toolbar-btn" onClick={() => setShowImportModal(true)}>Import</button>
              </div>
            </div>
          </>
        )}

      </div>
      {inventoryError && <div className="form-error">{inventoryError}</div>}
      <div className={selectedDevice ? "topology-content details-open" : "topology-content"}>
        <div className="inventory-surface">
          <div className="inventory-bulk-edit">
            <button type="button" disabled={filteredDevices.length === 0} onClick={selectAllFiltered}>
              Select all
            </button>
            <button type="button" disabled={selectedDeviceIds.size === 0} onClick={clearSelection}>
              Clear All
            </button>
            {canWrite ? (
              <>
              <label>
                Group
                <select value={bulkGroupId} onChange={(event) => setBulkGroupId(event.target.value)}>
                  <option value="">— No change —</option>
                  <option value="0">Remove from group</option>
                  {groups.map((group) => (
                    <option key={`bulk-${group.id}`} value={group.id}>{group.display_name || group.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Type
                <select value={bulkDeviceType} onChange={(event) => setBulkDeviceType(event.target.value)}>
                  <option value="">— No change —</option>
                  {deviceTypeOptions.map((t) => (
                    <option key={`bulk-type-${t}`} value={t}>{formatDeviceTypeLabel(t)}</option>
                  ))}
                </select>
              </label>
              <label>
                Location
                <select value={bulkSiteId} onChange={(event) => setBulkSiteId(event.target.value)}>
                  <option value="">— No change —</option>
                  <option value="unassign">Remove location</option>
                  {sites.map((site) => (
                    <option key={`bulk-site-${site.id}`} value={site.id}>{site.display_name ?? site.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={busy || selectedDeviceIds.size === 0 || (!bulkGroupId && !bulkDeviceType && !bulkSiteId)}
                onClick={() => void applyBulkActions()}
              >
                Apply to {selectedDeviceIds.size} selected
              </button>
              <button type="button" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void updateSelectedStatus("online")}>
                Enable
              </button>
              <button type="button" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void updateSelectedStatus("disabled")}>
                Disable
              </button>
              <button className="danger-button" type="button" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void deleteSelected()}>
                Delete selected
              </button>
              </>
            ) : (
              <span className="tool-note">Bulk edit actions require NetworkAdmin or SuperAdmin.</span>
            )}
          </div>
          <div className="inventory-table">
            <div className="inventory-table-header">
              <span>Select</span>
              {["device", "ip", "type", "status", "latency", "group", "location"].map((key, i) => {
                const labels = ["Device", "IP", "Type", "Live status", "Latency", "Group", "Location"];
                const active = inventorySortKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`inventory-sort-btn${active ? " active" : ""}`}
                    onClick={() => toggleSort(key)}
                  >
                    {labels[i]}
                    {active && (inventorySortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                  </button>
                );
              })}
            </div>
            {filteredDevices.length === 0 ? (
              <div className="inventory-empty">No devices available.</div>
            ) : (
              filteredDevices.slice().sort((a, b) => {
                const dir = inventorySortDir === "asc" ? 1 : -1;
                let cmp = 0;
                switch (inventorySortKey) {
                  case "device": cmp = deviceLabel(a).toLowerCase().localeCompare(deviceLabel(b).toLowerCase()); break;
                  case "ip": cmp = ipSortKey(a.ip_address).localeCompare(ipSortKey(b.ip_address)); break;
                  case "type": cmp = (a.device_type ?? "").toLowerCase().localeCompare((b.device_type ?? "").toLowerCase()); break;
                  case "status": {
                    const sa = liveStatusByDeviceId.get(a.id)?.status ?? a.status;
                    const sb = liveStatusByDeviceId.get(b.id)?.status ?? b.status;
                    cmp = sa.localeCompare(sb);
                    break;
                  }
                  case "latency": {
                    const la = liveStatusByDeviceId.get(a.id)?.latency_ms ?? Infinity;
                    const lb = liveStatusByDeviceId.get(b.id)?.latency_ms ?? Infinity;
                    cmp = la - lb;
                    break;
                  }
                  case "group": cmp = (a.topology_group ?? "").toLowerCase().localeCompare((b.topology_group ?? "").toLowerCase()); break;
                  case "location": {
                    const siteLabel = (id: number | null) => {
                      const s = sites.find((x) => x.id === id);
                      return (s?.display_name ?? s?.name ?? "").toLowerCase();
                    };
                    cmp = siteLabel(a.site_id).localeCompare(siteLabel(b.site_id));
                    break;
                  }
                  default: cmp = compareDevices(a, b);
                }
                return cmp * dir;
              }).map((device) => {
                const liveStatus = liveStatusByDeviceId.get(device.id) ?? null;
                const status = device.status === 'disabled' ? 'disabled' : (liveStatus?.status ?? device.monitor_status ?? device.status);
                return (
                  <button key={device.id} className={device.id === selectedDeviceId ? 'inventory-row active' : 'inventory-row'} type="button" onClick={() => setSelectedDeviceId(device.id)}>
                    <span className="inventory-row-check">
                      <input
                        checked={selectedDeviceIds.has(device.id)}
                        type="checkbox"
                        onChange={(event) => {
                          event.stopPropagation();
                          setSelectedDeviceIds((current) => {
                            const next = new Set(current);
                            if (next.has(device.id)) {
                              next.delete(device.id);
                            } else {
                              next.add(device.id);
                            }
                            return next;
                          });
                        }}
                      />
                      <button
                        type="button"
                        className={`fav-btn${device.is_favourite ? " fav-btn--active" : ""}`}
                        title={device.is_favourite ? "Remove from favourites" : "Add to favourites"}
                        onClick={(event) => { event.stopPropagation(); void toggleFav(device.id); }}
                      >
                        <Star size={13} fill={device.is_favourite ? "currentColor" : "none"} />
                      </button>
                    </span>
                    <span>{deviceLabel(device)}</span>
                    <span>{device.ip_address || '—'}</span>
                    <span>{device.device_type ? formatDeviceTypeLabel(device.device_type) : iconLabel(device.icon)}</span>
                    <span className={`status-pill ${status}`}>{status}</span>
                    <span>{liveStatus?.latency_ms !== null && liveStatus?.latency_ms !== undefined ? `${liveStatus.latency_ms.toFixed(1)} ms` : '-'}</span>
                    <span>
                      {canWrite ? (
                        <select
                          className="inventory-group-select"
                          value={device.topology_group_id ? String(device.topology_group_id) : ""}
                          disabled={busy}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            event.stopPropagation();
                            void updateDeviceGroup(device.id, event.target.value);
                          }}
                        >
                          <option value="">Set to inferred</option>
                          {groups.map((group) => (
                            <option key={`row-group-${device.id}-${group.id}`} value={group.id}>
                              {group.display_name || group.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        device.topology_group || "—"
                      )}
                    </span>
                    <span>
                      {canWrite ? (
                        <select
                          className="inventory-group-select"
                          value={device.site_id ? String(device.site_id) : ""}
                          disabled={busy}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            event.stopPropagation();
                            void updateDeviceSite(device.id, event.target.value);
                          }}
                        >
                          <option value="">No location</option>
                          {sites.map((site) => (
                            <option key={`row-site-${device.id}-${site.id}`} value={site.id}>
                              {site.display_name ?? site.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        (() => { const s = sites.find((x) => x.id === device.site_id); return s ? (s.display_name ?? s.name) : "—"; })()
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        {selectedDevice && (
          <aside className="details-panel">
            <DeviceDetails
              canViewSecurity={false}
              canWrite={canWrite}
              device={selectedDevice}
              disabled={busy}
              groups={groups}
              sites={sites}
              liveStatus={liveStatusByDeviceId.get(selectedDevice.id) ?? null}
              onSubmit={(payload) => submitDeviceUpdate(selectedDevice.id, payload)}
              securityLoading={false}
              securitySummary={null}
            />
          </aside>
        )}
      </div>
      {showDeviceForm && (
        <DeviceForm
          busy={busy}
          device={null}
          cloneSource={null}
          groups={groups}
          sites={sites}
          onCancel={() => setShowDeviceForm(false)}
          onSubmit={submitNewDevice}
        />
      )}
      {showScanModal && (
        <DiscoveryModal
          accessToken={accessToken}
          onCancel={() => setShowScanModal(false)}
          onImported={async () => {
            setShowScanModal(false);
            await onGraphChange();
          }}
        />
      )}
      {showImportModal && (
        <DeviceImportModal
          accessToken={accessToken}
          onClose={() => setShowImportModal(false)}
          onImported={() => { void onGraphChange(); }}
        />
      )}
    </section>
  );
}

function VlanWorkspace({
  accessToken,
  canWrite,
  graph,
  onGraphChange,
}: {
  accessToken: string;
  canWrite: boolean;
  graph: TopologyGraph;
  onGraphChange: () => Promise<void>;
}) {
  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', display_name: '', vlan_id: '', ip_range: '', gateway: '', dns_servers: '', description: '' });
  const [vlanSearch, setVlanSearch] = useState('');
  const [vlanSortKey, setVlanSortKey] = useState('name');
  const [vlanSortDir, setVlanSortDir] = useState<'asc' | 'desc'>('asc');

  function toggleVlanSort(key: string) {
    if (vlanSortKey === key) {
      setVlanSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setVlanSortKey(key);
      setVlanSortDir('asc');
    }
  }
  const normalizeGroupName = (value: string) => value.trim().toLowerCase();
  const normalizeLoose = (value: string) => normalizeGroupName(value).replace(/\s+/g, "");
  const tokenizeRange = (value: string) =>
    value
      .split(/[\s,;|]+/)
      .map((token) => normalizeLoose(token))
      .filter(Boolean);
  const groupMatchesLabel = (group: TopologyGroup, label: string) => {
    const normalized = normalizeLoose(label);
    if (!normalized) return false;
    const name = normalizeLoose(group.name);
    const displayName = normalizeLoose(group.display_name ?? "");
    const ipRange = normalizeLoose(group.ip_range ?? "");
    const rangeTokens = tokenizeRange(group.ip_range ?? "");
    return (
      name === normalized ||
      displayName === normalized ||
      ipRange === normalized ||
      rangeTokens.includes(normalized) ||
      normalized.includes(name) ||
      normalized.includes(displayName)
    );
  };

  const deviceCountByGroup = useMemo(() => {
    const counts = new Map<string, number>();
    for (const device of graph.devices) {
      if (device.topology_group) {
        counts.set(device.topology_group, (counts.get(device.topology_group) ?? 0) + 1);
      }
    }
    return counts;
  }, [graph.devices]);

  // Merge entity groups with inferred group labels visible in the topology
  const mergedRows = useMemo(() => {
    const hasMatchingEntity = (label: string) => groups.some((group) => groupMatchesLabel(group, label));
    const inferredNames = [...new Set(
      graph.devices.map((d) => d.topology_group).filter((n): n is string => !!n && n !== 'Ungrouped')
    )].filter((n) => !hasMatchingEntity(n)).sort();
    return [
      ...groups.map((g) => ({ type: 'entity' as const, entity: g, name: g.name })),
      ...inferredNames.map((n) => ({ type: 'inferred' as const, entity: null as TopologyGroup | null, name: n })),
    ];
  }, [groups, graph.devices]);
  const filteredSortedRows = useMemo(() => {
    const q = vlanSearch.toLowerCase().trim();
    const rows = q
      ? mergedRows.filter((row) =>
          row.name.toLowerCase().includes(q) ||
          (row.entity?.display_name ?? '').toLowerCase().includes(q) ||
          (row.entity?.vlan_id ?? '').toLowerCase().includes(q) ||
          (row.entity?.ip_range ?? '').toLowerCase().includes(q) ||
          (row.entity?.gateway ?? '').toLowerCase().includes(q) ||
          (row.entity?.dns_servers ?? '').toLowerCase().includes(q) ||
          (row.entity?.description ?? '').toLowerCase().includes(q)
        )
      : mergedRows;
    return [...rows].sort((a, b) => {
      if (vlanSortKey === 'devices') {
        const diff = (deviceCountByGroup.get(a.name) ?? 0) - (deviceCountByGroup.get(b.name) ?? 0);
        return vlanSortDir === 'asc' ? diff : -diff;
      }
      const vals: Record<string, [string, string]> = {
        name: [a.name, b.name],
        vlan_id: [a.entity?.vlan_id ?? '', b.entity?.vlan_id ?? ''],
        ip_range: [a.entity?.ip_range ?? '', b.entity?.ip_range ?? ''],
      };
      const [aVal, bVal] = vals[vlanSortKey] ?? [a.name, b.name];
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return vlanSortDir === 'asc' ? cmp : -cmp;
    });
  }, [mergedRows, vlanSearch, vlanSortKey, vlanSortDir, deviceCountByGroup]);

  const normalizedFormName = normalizeGroupName(form.name);
  const effectiveEditingGroup =
    (editingId !== null ? groups.find((group) => group.id === editingId) : undefined) ??
    (normalizedFormName
      ? groups.find((group) => groupMatchesLabel(group, normalizedFormName))
      : undefined) ??
    null;

  async function loadGroups() {
    setError(null);
    const rows = await api.topologyGroups(accessToken);
    setGroups(rows);
  }

  useEffect(() => {
    void loadGroups().catch((err) => {
      setError(err instanceof Error ? err.message : 'Unable to load groups');
    });
  }, [accessToken]);

  function openCreateForm(prefillName = '') {
    setEditingId(null);
    setForm({ name: prefillName, display_name: '', vlan_id: '', ip_range: '', gateway: '', dns_servers: '', description: '' });
    setError(null);
    setShowForm(true);
  }

  function openEditForm(group: TopologyGroup) {
    setEditingId(group.id);
    setForm({
      name: group.name,
      display_name: group.display_name ?? '',
      vlan_id: group.vlan_id ?? '',
      ip_range: group.ip_range ?? '',
      gateway: group.gateway ?? '',
      dns_servers: group.dns_servers ?? '',
      description: group.description ?? '',
    });
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setError(null);
  }

  async function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    const name = form.name.trim();
    if (!name) {
      setError('Group name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const existingGroupId = effectiveEditingGroup?.id ?? null;
      const groupPayload = {
        name,
        display_name: blankToNull(form.display_name),
        vlan_id: blankToNull(form.vlan_id),
        ip_range: blankToNull(form.ip_range),
        gateway: blankToNull(form.gateway),
        dns_servers: blankToNull(form.dns_servers),
        description: blankToNull(form.description),
      };
      if (existingGroupId !== null) {
        await api.updateTopologyGroup(accessToken, existingGroupId, groupPayload);
      } else {
        await api.createTopologyGroup(accessToken, groupPayload);
      }
      await loadGroups();
      await onGraphChange();
      setShowForm(false);
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : effectiveEditingGroup ? 'Unable to update group' : 'Unable to create group');
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(groupId: number, groupName: string) {
    if (!canWrite) return;
    if (!window.confirm(`Delete group "${groupName}"? Assigned devices will be unlinked from this group.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTopologyGroup(accessToken, groupId);
      setGroups((current) => current.filter((g) => g.id !== groupId));
      await onGraphChange();
      if (editingId === groupId) setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete group');
    } finally {
      setBusy(false);
    }
  }

  const vlanSortCols: { key: string; label: string; sortable?: boolean }[] = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'vlan_id', label: 'VLAN', sortable: true },
    { key: 'ip_range', label: 'Subnet', sortable: true },
    { key: 'gateway', label: 'Gateway' },
    { key: 'dns', label: 'DNS' },
    { key: 'devices', label: 'Devices', sortable: true },
  ];

  return (
    <section className="dash-layout">
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Groups &amp; VLANs</h1>
          <p className="dash-subtitle">Topology groups and VLANs visible in your network map</p>
        </div>
        <div className="dash-header-meta">
          <input
            className="vlan-search-input"
            type="search"
            placeholder="Search groups…"
            value={vlanSearch}
            onChange={(e) => setVlanSearch(e.target.value)}
          />
          {canWrite && (
            <button type="button" className="toolbar-btn toolbar-btn--primary" disabled={busy} onClick={() => openCreateForm()}>+ New group</button>
          )}
        </div>
      </div>

      {error && <div className="form-error" style={{ margin: '0 0 8px' }}>{error}</div>}

      <div className="topology-content" style={{ gap: 12 }}>
        {showForm && (
          <div className="vlan-form-panel panel">
            <div className="vlan-form-heading">
              <h3>{effectiveEditingGroup ? 'Edit group' : 'New group'}</h3>
              <button type="button" className="vlan-form-close" onClick={closeForm} aria-label="Close">✕</button>
            </div>
            <form className="modal-form" onSubmit={(e) => void handleFormSubmit(e)}>
              <label>
                Name *
                <input
                  required
                  value={form.name}
                  onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
                />
              </label>
              <label>
                Display name
                <input
                  value={form.display_name}
                  onChange={(event) => setForm((c) => ({ ...c, display_name: event.target.value }))}
                />
              </label>
              <div className="vlan-form-row">
                <label>
                  VLAN ID
                  <input
                    placeholder="e.g. 10"
                    value={form.vlan_id}
                    onChange={(event) => setForm((c) => ({ ...c, vlan_id: event.target.value }))}
                  />
                </label>
                <label>
                  Subnet (CIDR)
                  <input
                    placeholder="192.168.10.0/24"
                    value={form.ip_range}
                    onChange={(event) => setForm((c) => ({ ...c, ip_range: event.target.value }))}
                  />
                </label>
              </div>
              <div className="vlan-form-row">
                <label>
                  Gateway
                  <input
                    placeholder="192.168.10.1"
                    value={form.gateway}
                    onChange={(event) => setForm((c) => ({ ...c, gateway: event.target.value }))}
                  />
                </label>
                <label>
                  DNS servers
                  <input
                    placeholder="8.8.8.8, 1.1.1.1"
                    value={form.dns_servers}
                    onChange={(event) => setForm((c) => ({ ...c, dns_servers: event.target.value }))}
                  />
                </label>
              </div>
              <label>
                Description
                <input
                  value={form.description}
                  onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))}
                />
              </label>
              <div className="detail-actions">
                <button type="submit" disabled={busy}>
                  {effectiveEditingGroup ? 'Save changes' : 'Create group'}
                </button>
                <button type="button" disabled={busy} onClick={closeForm}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        <div className="panel" style={{ flex: '1 1 auto', padding: 0, overflow: 'auto', minWidth: 0 }}>
          {filteredSortedRows.length === 0 ? (
            <p className="inventory-empty">
              {vlanSearch ? 'No groups match your search.' : 'No groups found. Add devices to the topology or create a group manually.'}
            </p>
          ) : (
            <div className={canWrite ? 'vlan-table-writable' : undefined}>
              <div className="vlan-table-header">
                {vlanSortCols.map(({ key, label, sortable }) => (
                  sortable ? (
                    <button
                      key={key}
                      type="button"
                      className={`inventory-sort-btn${vlanSortKey === key ? ' active' : ''}`}
                      onClick={() => toggleVlanSort(key)}
                    >
                      {label}
                      {vlanSortKey === key && (vlanSortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                    </button>
                  ) : (
                    <span key={key} className="vlan-header-cell">{label}</span>
                  )
                ))}
                {canWrite && <span />}
              </div>
              {filteredSortedRows.map((row) => {
                const deviceCount = deviceCountByGroup.get(row.name) ?? 0;
                const usable = row.entity ? cidrUsableHosts(row.entity.ip_range) : null;
                return (
                  <div key={`${row.type}-${row.name}`} className="vlan-row">
                    <span className="vlan-cell-name">
                      <span className="vlan-name-stack">
                        <span className="vlan-name-primary">{row.name}</span>
                        {row.type === 'entity' && row.entity!.display_name && (
                          <span className="vlan-name-sub">{row.entity!.display_name}</span>
                        )}
                      </span>
                      {row.type === 'inferred' && <span className="vlan-inferred-badge">inferred</span>}
                    </span>
                    <span>
                      {row.type === 'entity' && row.entity!.vlan_id
                        ? <span className="vlan-id-badge">{row.entity!.vlan_id}</span>
                        : <span className="vlan-empty-cell">—</span>}
                    </span>
                    <span className="vlan-subnet-cell">
                      {row.type === 'entity' && row.entity!.ip_range ? (
                        <>
                          <span className="vlan-ip-pill">{row.entity!.ip_range}</span>
                          {usable !== null && (
                            <span className="vlan-usable-count">{formatUsableHosts(usable)} usable</span>
                          )}
                        </>
                      ) : <span className="vlan-empty-cell">—</span>}
                    </span>
                    <span className="vlan-mono-cell">
                      {row.type === 'entity' && row.entity!.gateway
                        ? row.entity!.gateway
                        : <span className="vlan-empty-cell">—</span>}
                    </span>
                    <span className="vlan-mono-cell">
                      {row.type === 'entity' && row.entity!.dns_servers
                        ? row.entity!.dns_servers
                        : <span className="vlan-empty-cell">—</span>}
                    </span>
                    <span>
                      {deviceCount > 0
                        ? <span className="vlan-device-badge">{deviceCount}</span>
                        : <span className="vlan-empty-cell">0</span>}
                    </span>
                    {canWrite && (
                      <span className="vlan-row-actions">
                        <button
                          type="button"
                          className="vlan-action-btn"
                          disabled={busy}
                          onClick={() => {
                            const existingGroup =
                              row.type === 'entity'
                                ? row.entity
                                : groups.find((g) => groupMatchesLabel(g, row.name)) ?? null;
                            if (!existingGroup) {
                              openCreateForm(row.name);
                              return;
                            }
                            openEditForm(existingGroup);
                          }}
                        >
                          Edit
                        </button>
                        {row.type === 'entity' && (
                          <button
                            type="button"
                            className="vlan-action-btn vlan-action-btn--danger"
                            disabled={busy}
                            onClick={() => void deleteGroup(row.entity!.id, row.entity!.name)}
                          >
                            Delete
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function DiscoveryModal({
  accessToken,
  onCancel,
  onImported,
}: {
  accessToken: string | null;
  onCancel: () => void;
  onImported: () => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [scanType, setScanType] = useState<DiscoveryScanType>("ping");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupBusy, setNewGroupBusy] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<string>("");
  const [sites, setSites] = useState<Site[]>([]);
  const [showNewSite, setShowNewSite] = useState(false);
  const [newSiteName, setNewSiteName] = useState("");
  const [newSiteBusy, setNewSiteBusy] = useState(false);
  const [confirmLargeScan, setConfirmLargeScan] = useState(false);
  const [scan, setScan] = useState<DiscoveryScan | null>(null);
  const [selectedIps, setSelectedIps] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetEstimate = estimateScanTarget(target);
  const requiresConfirmation = targetEstimate.hostCount > 256;
  const canStartScan = !busy && target.trim().length > 0 && (!requiresConfirmation || confirmLargeScan);

  useEffect(() => {
    if (!accessToken) return;
    api.topologyGroups(accessToken).then(setGroups).catch(() => {});
    api.sites(accessToken).then(setSites).catch(() => {});
  }, [accessToken]);

  async function createNewGroup() {
    if (!accessToken || !newGroupName.trim()) return;
    setNewGroupBusy(true);
    try {
      const created = await api.createTopologyGroup(accessToken, {
        name: newGroupName.trim(),
        display_name: null,
        ip_range: null,
        description: null,
      });
      setGroups((prev) => [...prev, created]);
      setSelectedGroupId(String(created.id));
      setNewGroupName("");
      setShowNewGroup(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group");
    } finally {
      setNewGroupBusy(false);
    }
  }

  async function createNewSite() {
    if (!accessToken || !newSiteName.trim()) return;
    setNewSiteBusy(true);
    try {
      const created = await api.createSite(accessToken, {
        name: newSiteName.trim(),
        display_name: null,
        description: null,
        address: null,
        color: null,
      });
      setSites((prev) => [...prev, created]);
      setSelectedSiteId(String(created.id));
      setNewSiteName("");
      setShowNewSite(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create location");
    } finally {
      setNewSiteBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!accessToken) {
      return;
    }
    setBusy(true);
    setError(null);
    setScan(null);
    try {
      const nextScan = await api.startDiscoveryScan(accessToken, {
        target,
        scan_type: scanType,
        confirm_large_scan: confirmLargeScan,
      });
      setScan(nextScan);
      setSelectedIps(new Set(nextScan.results.map((host) => host.ip_address)));
      if (nextScan.status === "failed") {
        setError(nextScan.error || "Scan failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  }

  async function importSelected() {
    if (!accessToken || !scan) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const groupId = selectedGroupId ? Number(selectedGroupId) : null;
      const siteId = selectedSiteId ? Number(selectedSiteId) : null;
      await api.importDiscoveryResults(accessToken, scan.id, [...selectedIps], groupId, siteId);
      await onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  function toggleHost(host: DiscoveryHost) {
    setSelectedIps((current) => {
      const next = new Set(current);
      if (next.has(host.ip_address)) {
        next.delete(host.ip_address);
      } else {
        next.add(host.ip_address);
      }
      return next;
    });
  }

  return (
    <Modal title="Discover devices" onCancel={onCancel}>
      <form className="modal-form" onSubmit={submit}>
        <div className="scan-form-grid">
          <label>
            Target
            <input
              placeholder="10.30.30.0/24, 10.30.30.10, or 10.30.30.1-10.30.30.50"
              required
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
          <label>
            Scan type
            <select value={scanType} onChange={(event) => setScanType(event.target.value as DiscoveryScanType)}>
              <option value="ping">Ping sweep</option>
              <option value="basic_ports">Basic port detection</option>
            </select>
          </label>
          <div className="scan-group-row">
            <label className="scan-group-select-label">
              Assign to VLAN / group
              <select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)}>
                <option value="">— None (unassigned) —</option>
                {groups.map((g) => (
                  <option key={g.id} value={String(g.id)}>{g.display_name || g.name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="scan-new-group-btn"
              title="Create a new VLAN / group"
              onClick={() => { setShowNewGroup((v) => !v); setNewGroupName(""); }}
            >
              {showNewGroup ? "✕" : "+ New"}
            </button>
          </div>
          {showNewGroup && (
            <div className="scan-new-group-row">
              <input
                placeholder="Group name (e.g. Lab-VLAN-10)"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createNewGroup(); } }}
              />
              <button type="button" disabled={!newGroupName.trim() || newGroupBusy} onClick={() => void createNewGroup()}>
                {newGroupBusy ? "Creating…" : "Create"}
              </button>
            </div>
          )}
          <div className="scan-group-row">
            <label className="scan-group-select-label">
              Assign to location
              <select value={selectedSiteId} onChange={(e) => setSelectedSiteId(e.target.value)}>
                <option value="">— None (unassigned) —</option>
                {sites.map((s) => (
                  <option key={s.id} value={String(s.id)}>{s.display_name ?? s.name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="scan-new-group-btn"
              title="Create a new location"
              onClick={() => { setShowNewSite((v) => !v); setNewSiteName(""); }}
            >
              {showNewSite ? "✕" : "+ New"}
            </button>
          </div>
          {showNewSite && (
            <div className="scan-new-group-row">
              <input
                placeholder="Location name (e.g. London HQ)"
                value={newSiteName}
                onChange={(e) => setNewSiteName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createNewSite(); } }}
              />
              <button type="button" disabled={!newSiteName.trim() || newSiteBusy} onClick={() => void createNewSite()}>
                {newSiteBusy ? "Creating…" : "Create"}
              </button>
            </div>
          )}
        </div>
        <div className="scan-target-info">
          <span className={requiresConfirmation ? "scan-target-label warning" : "scan-target-label"}>
            {targetEstimate.label}
          </span>
          <span className="scan-target-help">{targetEstimate.help}</span>
          {requiresConfirmation && (
            <label className="scan-confirm-check">
              <input
                checked={confirmLargeScan}
                type="checkbox"
                onChange={(event) => setConfirmLargeScan(event.target.checked)}
              />
              Confirm large scan
            </label>
          )}
        </div>
        {busy && <ScanProgress scanType={scanType} />}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Close
          </button>
          <button type="submit" disabled={!canStartScan}>
            {busy ? "Scanning..." : "Start scan"}
          </button>
        </div>
      </form>
      {scan && (
        <div className="scan-results">
          <div className="scan-summary">
            <strong>{scan.result_count}</strong>
            <span>
              hosts found from {scan.host_count} target addresses · {scan.scan_type} · {scan.status}
            </span>
          </div>
          {scan.results.length === 0 ? (
            <div className="empty-results">No hosts responded to this scan.</div>
          ) : (
            <>
              <div className="scan-table-header">
                <span />
                <span>IP address</span>
                <span>Hostname</span>
                <span>MAC / vendor</span>
                <span>Ports</span>
              </div>
              <div className="scan-table">
                {scan.results.map((host) => (
                  <label key={host.ip_address} className="scan-row">
                    <input
                      checked={selectedIps.has(host.ip_address)}
                      type="checkbox"
                      onChange={() => toggleHost(host)}
                    />
                    <span>{host.ip_address}</span>
                    <span>{host.hostname || "No hostname"}</span>
                    <span>{host.vendor || host.mac_address || "No MAC/vendor"}</span>
                    <span>{host.open_ports.length ? host.open_ports.join(", ") : "No open ports"}</span>
                  </label>
                ))}
              </div>
              <div className="modal-actions scan-import-actions">
                <button type="button" disabled={busy || selectedIps.size === 0} onClick={importSelected}>
                  Import selected
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function LocationsWorkspace({
  accessToken,
  canWrite,
  graph,
  onGraphChange,
}: {
  accessToken: string;
  canWrite: boolean;
  graph: TopologyGraph;
  onGraphChange: () => Promise<void>;
}) {
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', display_name: '', description: '', address: '', color: '' });
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [detailSite, setDetailSite] = useState<Site | null>(null);
  const [geocodeResult, setGeocodeResult] = useState<{ lat: number; lon: number } | null | 'loading'>(null);
  const geocodeCache = useRef<Map<number, { lat: number; lon: number } | null>>(new Map());

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  const deviceCountBySite = useMemo(() => {
    const counts = new Map<number, number>();
    for (const device of graph.devices) {
      if (device.site_id !== null) {
        counts.set(device.site_id, (counts.get(device.site_id) ?? 0) + 1);
      }
    }
    return counts;
  }, [graph.devices]);

  const unassignedDeviceCount = useMemo(
    () => graph.devices.filter((d) => d.site_id === null).length,
    [graph.devices],
  );

  const filteredSortedSites = useMemo(() => {
    const q = search.toLowerCase().trim();
    const rows = q
      ? sites.filter((s) =>
          s.name.toLowerCase().includes(q) ||
          (s.display_name ?? '').toLowerCase().includes(q) ||
          (s.address ?? '').toLowerCase().includes(q) ||
          (s.description ?? '').toLowerCase().includes(q)
        )
      : sites;
    return [...rows].sort((a, b) => {
      if (sortKey === 'devices') {
        const diff = (deviceCountBySite.get(a.id) ?? 0) - (deviceCountBySite.get(b.id) ?? 0);
        return sortDir === 'asc' ? diff : -diff;
      }
      const vals: Record<string, [string, string]> = {
        name: [a.name, b.name],
        address: [a.address ?? '', b.address ?? ''],
      };
      const [aVal, bVal] = vals[sortKey] ?? [a.name, b.name];
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [sites, search, sortKey, sortDir, deviceCountBySite]);

  async function loadSites() {
    setSitesLoading(true);
    setError(null);
    try {
      const rows = await api.sites(accessToken);
      setSites(rows);
    } finally {
      setSitesLoading(false);
    }
  }

  useEffect(() => {
    void loadSites().catch((err) => {
      setError(err instanceof Error ? err.message : 'Unable to load locations');
      setSitesLoading(false);
    });
  }, [accessToken]);

  function openCreateForm() {
    setDetailSite(null);
    setEditingId(null);
    setForm({ name: '', display_name: '', description: '', address: '', color: '' });
    setError(null);
    setShowForm(true);
  }

  function openEditForm(site: Site) {
    setDetailSite(null);
    setEditingId(site.id);
    setForm({
      name: site.name,
      display_name: site.display_name ?? '',
      description: site.description ?? '',
      address: site.address ?? '',
      color: site.color ?? '',
    });
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setError(null);
  }

  async function showSiteDetail(site: Site) {
    if (showForm) return;
    setDetailSite(site);
    if (!site.address) {
      setGeocodeResult(null);
      return;
    }
    if (geocodeCache.current.has(site.id)) {
      setGeocodeResult(geocodeCache.current.get(site.id) ?? null);
      return;
    }
    setGeocodeResult('loading');
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(site.address)}`,
        { headers: { 'User-Agent': 'NetMap/1.0' } },
      );
      const data = await resp.json() as Array<{ lat: string; lon: string }>;
      const coords = data.length > 0 ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) } : null;
      geocodeCache.current.set(site.id, coords);
      setGeocodeResult(coords);
    } catch {
      geocodeCache.current.set(site.id, null);
      setGeocodeResult(null);
    }
  }

  async function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    const name = form.name.trim();
    if (!name) { setError('Location name is required'); return; }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name,
        display_name: blankToNull(form.display_name),
        description: blankToNull(form.description),
        address: blankToNull(form.address),
        color: blankToNull(form.color) as string | null,
      };
      if (editingId !== null) {
        await api.updateSite(accessToken, editingId, payload);
      } else {
        await api.createSite(accessToken, payload);
      }
      await loadSites();
      await onGraphChange();
      setShowForm(false);
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : editingId !== null ? 'Unable to update location' : 'Unable to create location');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSite(siteId: number, siteName: string) {
    if (!canWrite) return;
    if (!window.confirm(`Delete location "${siteName}"? Assigned devices will be unlinked.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteSite(accessToken, siteId);
      setSites((current) => current.filter((s) => s.id !== siteId));
      geocodeCache.current.delete(siteId);
      await onGraphChange();
      if (editingId === siteId) setShowForm(false);
      if (detailSite?.id === siteId) setDetailSite(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete location');
    } finally {
      setBusy(false);
    }
  }

  const sortCols: { key: string; label: string; sortable?: boolean }[] = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'address', label: 'Address', sortable: true },
    { key: 'devices', label: 'Devices', sortable: true },
  ];

  return (
    <section className="dash-layout">
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Locations</h1>
          <p className="dash-subtitle">Network sites and physical locations for your multi-site topology</p>
        </div>
        <div className="dash-header-meta">
          <input
            className="vlan-search-input"
            type="search"
            placeholder="Search locations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {canWrite && (
            <button type="button" className="toolbar-btn toolbar-btn--primary" disabled={busy} onClick={openCreateForm}>+ New location</button>
          )}
        </div>
      </div>

      {error && <div className="form-error" style={{ margin: '0 0 8px' }}>{error}</div>}

      <div className="topology-content" style={{ gap: 12 }}>
        {detailSite && !showForm && (
          <div className="vlan-form-panel panel">
            <div className="vlan-form-heading">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {detailSite.color && (
                  <span
                    style={{ width: 12, height: 12, borderRadius: '50%', background: detailSite.color, flexShrink: 0 }}
                    aria-hidden
                  />
                )}
                <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {detailSite.display_name ?? detailSite.name}
                </h3>
              </div>
              <button type="button" className="vlan-form-close" onClick={() => setDetailSite(null)} aria-label="Close">✕</button>
            </div>
            {canWrite && (
              <div className="detail-actions" style={{ marginBottom: 10 }}>
                <button type="button" onClick={() => openEditForm(detailSite)}>Edit location</button>
              </div>
            )}
            <dl style={{ margin: '0 0 8px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: '0.85em', alignItems: 'baseline' }}>
              {detailSite.display_name && <><dt style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>Name</dt><dd style={{ margin: 0 }}>{detailSite.name}</dd></>}
              {detailSite.description && <><dt style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>Description</dt><dd style={{ margin: 0 }}>{detailSite.description}</dd></>}
              {detailSite.address && <><dt style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>Address</dt><dd style={{ margin: 0 }}>{detailSite.address}</dd></>}
            </dl>
            {detailSite.address && (
              geocodeResult === 'loading' ? (
                <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--muted)', fontSize: '0.82em' }}>Locating on map…</div>
              ) : geocodeResult ? (
                <div style={{ marginBottom: 8 }}>
                  <iframe
                    src={`https://www.openstreetmap.org/export/embed.html?bbox=${geocodeResult.lon - 0.012},${geocodeResult.lat - 0.008},${geocodeResult.lon + 0.012},${geocodeResult.lat + 0.008}&layer=mapnik&marker=${geocodeResult.lat},${geocodeResult.lon}`}
                    style={{ width: '100%', height: 200, border: '1px solid var(--border)', borderRadius: 6, display: 'block' }}
                    title="Location map"
                    loading="lazy"
                  />
                  <a
                    href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(detailSite.address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.75em', color: 'var(--muted)', textDecoration: 'none' }}
                  >
                    View larger map ↗
                  </a>
                </div>
              ) : (
                <div style={{ fontSize: '0.82em', color: 'var(--muted)', marginBottom: 8 }}>
                  Address not found on map.{' '}
                  <a
                    href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(detailSite.address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Search manually ↗
                  </a>
                </div>
              )
            )}
          </div>
        )}
        {showForm && (
          <div className="vlan-form-panel panel">
            <div className="vlan-form-heading">
              <h3>{editingId !== null ? 'Edit location' : 'New location'}</h3>
              <button type="button" className="vlan-form-close" onClick={closeForm} aria-label="Close">✕</button>
            </div>
            <form className="modal-form" onSubmit={(e) => void handleFormSubmit(e)}>
              <label>
                Name *
                <input
                  required
                  value={form.name}
                  onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
                />
              </label>
              <label>
                Display name
                <input
                  placeholder="e.g. London HQ"
                  value={form.display_name}
                  onChange={(event) => setForm((c) => ({ ...c, display_name: event.target.value }))}
                />
              </label>
              <label>
                Address
                <input
                  placeholder="e.g. 123 Main St, London, UK"
                  value={form.address}
                  onChange={(event) => setForm((c) => ({ ...c, address: event.target.value }))}
                />
              </label>
              <div className="vlan-form-row">
                <label>
                  Colour
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                    <input
                      type="color"
                      value={form.color || '#6366f1'}
                      style={{ width: 44, height: 36, padding: 2, cursor: 'pointer', borderRadius: 6 }}
                      onChange={(event) => setForm((c) => ({ ...c, color: event.target.value }))}
                    />
                    <span style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.7 }}>{form.color || '#6366f1'}</span>
                    {form.color && (
                      <button type="button" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => setForm((c) => ({ ...c, color: '' }))}>Clear</button>
                    )}
                  </div>
                </label>
              </div>
              <label>
                Description
                <input
                  value={form.description}
                  onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))}
                />
              </label>
              <div className="detail-actions">
                <button type="submit" disabled={busy}>
                  {editingId !== null ? 'Save changes' : 'Create location'}
                </button>
                <button type="button" disabled={busy} onClick={closeForm}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        <div className="panel" style={{ flex: '1 1 auto', padding: 0, overflow: 'auto', minWidth: 0 }}>
          {sitesLoading ? (
            <p className="inventory-empty">Loading locations…</p>
          ) : filteredSortedSites.length === 0 ? (
            <p className="inventory-empty">
              {search
                ? 'No locations match your search.'
                : 'No locations yet. Create one to start organising your multi-site topology.'}
            </p>
          ) : (
            <div className={canWrite ? 'vlan-table-writable' : undefined}>
              <div className="vlan-table-header location-table-header">
                {sortCols.map(({ key, label, sortable }) => (
                  sortable ? (
                    <button
                      key={key}
                      type="button"
                      className={`inventory-sort-btn${sortKey === key ? ' active' : ''}`}
                      onClick={() => toggleSort(key)}
                    >
                      {label}
                      {sortKey === key && (sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                    </button>
                  ) : (
                    <span key={key} className="vlan-header-cell">{label}</span>
                  )
                ))}
                {canWrite && <span />}
              </div>
              {!search && unassignedDeviceCount > 0 && (
                <div className="vlan-row location-row location-row--unassigned">
                  <span className="vlan-cell-name">
                    <span className="location-name-stack">
                      <span className="vlan-name-stack">
                        <span className="vlan-name-primary">No location</span>
                        <span className="vlan-name-sub">Devices not assigned to any location</span>
                      </span>
                    </span>
                  </span>
                  <span className="vlan-mono-cell location-address-cell">—</span>
                  <span><span className="vlan-device-badge">{unassignedDeviceCount}</span></span>
                  {canWrite && (
                    <span className="vlan-row-actions">
                      <button
                        type="button"
                        className="vlan-action-btn"
                        onClick={() => {
                          setDetailSite(null);
                          setEditingId(null);
                          setForm({ name: '', display_name: '', description: '', address: '', color: '' });
                          setError(null);
                          setShowForm(true);
                        }}
                      >
                        Create location
                      </button>
                    </span>
                  )}
                </div>
              )}
              {filteredSortedSites.map((site) => {
                const deviceCount = deviceCountBySite.get(site.id) ?? 0;
                const isSelected = detailSite?.id === site.id && !showForm;
                return (
                  <div
                    key={site.id}
                    className={`vlan-row location-row${isSelected ? ' vlan-row--selected' : ''}`}
                    style={{ cursor: showForm ? undefined : 'pointer' }}
                    onClick={() => { if (!showForm) void showSiteDetail(site); }}
                  >
                    <span className="vlan-cell-name">
                      <span className="location-name-stack">
                        {site.color && (
                          <span
                            className="location-color-dot"
                            style={{ background: site.color }}
                            aria-hidden
                          />
                        )}
                        <span className="vlan-name-stack">
                          <span className="vlan-name-primary">{site.name}</span>
                          {site.display_name && (
                            <span className="vlan-name-sub">{site.display_name}</span>
                          )}
                        </span>
                      </span>
                    </span>
                    <span className="vlan-mono-cell location-address-cell">
                      {site.address ?? <span className="vlan-empty-cell">—</span>}
                    </span>
                    <span>
                      {deviceCount > 0
                        ? <span className="vlan-device-badge">{deviceCount}</span>
                        : <span className="vlan-empty-cell">0</span>}
                    </span>
                    {canWrite && (
                      <span className="vlan-row-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="vlan-action-btn"
                          disabled={busy}
                          onClick={() => openEditForm(site)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="vlan-action-btn vlan-action-btn--danger"
                          disabled={busy}
                          onClick={() => void handleDeleteSite(site.id, site.display_name ?? site.name)}
                        >
                          Delete
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ScanProgress({ scanType }: { scanType: DiscoveryScanType }) {
  return (
    <div className="scan-progress" role="status">
      <div className="scan-progress-pulse" />
      <div>
        <strong>Scanning network</strong>
        <span>
          Validating target, running {scanType === "ping" ? "ping sweep" : "basic port detection"}, parsing results.
        </span>
      </div>
    </div>
  );
}

function ProfileWorkspace({
  accessToken,
  user,
  onUserUpdate,
}: {
  accessToken: string;
  user: User;
  onUserUpdate: (user: User) => void;
}) {
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [profileEmail, setProfileEmail] = useState(user.email ?? "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(user.avatar_data ?? null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  function handleAvatarFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setProfileError("Please select an image file.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setProfileError("Image must be under 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setAvatarPreview(result);
      setProfileError(null);
    };
    reader.readAsDataURL(file);
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setProfileBusy(true);
    setProfileError(null);
    setProfileSuccess(false);
    try {
      const updated = await api.updateProfile(accessToken, {
        display_name: displayName.trim() || null,
        avatar_data: avatarPreview,
        email: profileEmail.trim() || null,
      });
      onUserUpdate(updated);
      setProfileSuccess(true);
      setTimeout(() => setProfileSuccess(false), 3000);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setProfileBusy(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match.");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    setPwSuccess(false);
    try {
      await api.changePassword(accessToken, currentPassword, newPassword);
      setPwSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPwSuccess(false), 3000);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwBusy(false);
    }
  }

  const initials = (user.display_name || user.username).slice(0, 2).toUpperCase();

  return (
    <section className="profile-layout">
      <div className="profile-header">
        <h1>Profile</h1>
        <p className="profile-subtitle">Manage your account details and password.</p>
      </div>

      <div className="profile-grid">
        <section className="panel profile-panel">
          <h2>Account details</h2>
          <form className="profile-form" onSubmit={saveProfile}>
            <div className="profile-avatar-row">
              <div className="profile-avatar">
                {avatarPreview
                  ? <img src={avatarPreview} alt="Profile avatar" className="profile-avatar-img" />
                  : <span className="profile-avatar-initials">{initials}</span>
                }
              </div>
              <div className="profile-avatar-actions">
                <label className="profile-avatar-upload-btn">
                  Upload photo
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAvatarFile(f); }}
                  />
                </label>
                {avatarPreview && (
                  <button type="button" className="profile-avatar-remove-btn" onClick={() => setAvatarPreview(null)}>
                    Remove
                  </button>
                )}
              </div>
            </div>

            <label className="profile-field-label">
              Username
              <input value={user.username} disabled className="profile-input" />
            </label>

            <label className="profile-field-label">
              Display name
              <input
                className="profile-input"
                placeholder={user.username}
                value={displayName}
                maxLength={100}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>

            <label className="profile-field-label">
              Email
              <input
                className="profile-input"
                type="email"
                maxLength={254}
                placeholder="Optional — used for password reset notifications"
                value={profileEmail}
                onChange={(e) => setProfileEmail(e.target.value)}
              />
            </label>

            <label className="profile-field-label">
              Role
              <input value={user.role} disabled className="profile-input" />
            </label>

            {profileError && <div className="form-error">{profileError}</div>}
            {profileSuccess && <div className="success-banner">Profile saved.</div>}

            <div className="profile-form-actions">
              <button type="submit" disabled={profileBusy}>
                {profileBusy ? "Saving…" : "Save profile"}
              </button>
            </div>
          </form>
        </section>

        <section className="panel profile-panel">
          <h2>Change password</h2>
          <form className="profile-form" onSubmit={changePassword}>
            <label className="profile-field-label">
              Current password
              <input
                className="profile-input"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </label>

            <label className="profile-field-label">
              New password
              <input
                className="profile-input"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={12}
                required
              />
            </label>

            <label className="profile-field-label">
              Confirm new password
              <input
                className="profile-input"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </label>

            {pwError && <div className="form-error">{pwError}</div>}
            {pwSuccess && <div className="success-banner">Password changed successfully.</div>}

            <div className="profile-form-actions">
              <button type="submit" disabled={pwBusy}>
                {pwBusy ? "Updating…" : "Change password"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </section>
  );
}

function formatMs(value: number | null): string {
  if (value === null) {
    return "-";
  }
  return `${value.toFixed(1)} ms`;
}

function DeviceDetails({
  canViewSecurity,
  canWrite,
  device,
  disabled,
  groups,
  sites,
  liveStatus,
  onDelete,
  onClone,
  onSubmit,
  securityLoading,
  securitySummary,
}: {
  canViewSecurity: boolean;
  canWrite: boolean;
  device: Device;
  disabled: boolean;
  groups: TopologyGroup[];
  sites: Site[];
  liveStatus: DeviceLiveStatus | null;
  onDelete?: () => void;
  onClone?: () => void;
  onSubmit: (payload: DevicePayload) => Promise<void>;
  securityLoading: boolean;
  securitySummary: DeviceSecurityEventSummary | null;
}) {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [fieldDraft, setFieldDraft] = useState<string>("");
  const committingRef = useRef(false);

  useEffect(() => {
    setEditingField(null);
    setFieldDraft("");
    committingRef.current = false;
  }, [device.id]);

  function startEdit(field: string, currentValue: string) {
    if (!canWrite || disabled) return;
    setEditingField(field);
    setFieldDraft(currentValue);
  }

  async function commitField(overrides: Partial<DevicePayload>) {
    if (committingRef.current) return;
    committingRef.current = true;
    setEditingField(null);
    setFieldDraft("");
    try {
      await onSubmit(buildDevicePayload(device, overrides));
    } finally {
      committingRef.current = false;
    }
  }

  function cancelEdit() {
    setEditingField(null);
    setFieldDraft("");
  }

  const editHint = canWrite && !disabled;
  const dotStatus = liveStatus?.status ?? device.monitor_status ?? device.status;

  return (
    <div>
      <div className="details-heading">
        <span className={`status-dot ${dotStatus}`} />
        <h3>
          {deviceLabel(device)}
          {liveStatus && liveStatus.status !== "unknown" && (
            <span className={`live-status-inline ${liveStatus.status}`}>
              {" "}— {liveStatus.status}
              {liveStatus.latency_ms != null ? ` · ${liveStatus.latency_ms.toFixed(0)} ms` : ""}
            </span>
          )}
        </h3>
      </div>
      <dl>
        <dt>Display name</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("display_name", device.display_name ?? "") : undefined}
        >
          {editingField === "display_name" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ display_name: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ display_name: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.display_name || "Not set")}
        </dd>
        <dt>Hostname</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("hostname", device.hostname ?? "") : undefined}
        >
          {editingField === "hostname" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ hostname: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ hostname: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.hostname || "Not set")}
        </dd>
        <dt>IP address</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("ip_address", device.ip_address ?? "") : undefined}
        >
          {editingField === "ip_address" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ ip_address: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ ip_address: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.ip_address || "Not set")}
        </dd>
        <dt>MAC address</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("mac_address", device.mac_address ?? "") : undefined}
        >
          {editingField === "mac_address" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ mac_address: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ mac_address: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.mac_address || "Not set")}
        </dd>
        <dt>Vendor</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("vendor", device.vendor ?? "") : undefined}
        >
          {editingField === "vendor" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ vendor: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ vendor: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.vendor || "Not set")}
        </dd>
        <dt>Type</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("device_type", device.device_type ?? "") : undefined}
        >
          {editingField === "device_type" ? (
            <select
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => {
                const value = e.target.value;
                void commitField({ device_type: value || null, icon: (deviceTypeIconMap[value] || "device") as DeviceIcon });
              }}
              onBlur={cancelEdit}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            >
              {deviceTypeOptions.map((type) => (
                <option key={type} value={type}>{formatDeviceTypeLabel(type)}</option>
              ))}
            </select>
          ) : (device.device_type ? formatDeviceTypeLabel(device.device_type) : "Not set")}
        </dd>
        <dt>Status</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("status", device.status) : undefined}
        >
          {editingField === "status" ? (
            <select
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => { void commitField({ status: e.target.value as DeviceStatus }); }}
              onBlur={cancelEdit}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            >
              <option value="unknown">unknown</option>
              <option value="online">online</option>
              <option value="offline">offline</option>
              <option value="warning">warning</option>
            </select>
          ) : device.status}
        </dd>
        <dt>Color</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("color", device.color ?? "") : undefined}
        >
          {editingField === "color" ? (
            <div className="details-inline-color">
              <input
                autoFocus
                type="color"
                value={fieldDraft || "#3276b1"}
                onChange={(e) => setFieldDraft(e.target.value)}
                onBlur={() => { if (!committingRef.current) void commitField({ color: fieldDraft || null }); }}
              />
              <button type="button" className="details-inline-auto" onClick={() => void commitField({ color: null })}>Auto</button>
            </div>
          ) : (
            <>
              <span className="color-readout" style={{ background: device.color ?? statusColor(device.status) }} />
              {device.color || "Status color"}
            </>
          )}
        </dd>
        <dt>VLAN / Group</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("topology_group_id", String(device.topology_group_id ?? "")) : undefined}
        >
          {editingField === "topology_group_id" ? (
            <select
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => {
                const value = e.target.value;
                void commitField({ topology_group_id: value ? Number(value) : null, topology_group: null });
              }}
              onBlur={cancelEdit}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            >
              <option value="">— None —</option>
              {groups.map((group) => (
                <option key={group.id} value={String(group.id)}>{group.display_name || group.name}</option>
              ))}
            </select>
          ) : deviceVlanDisplay(device)}
        </dd>
        <dt>Location</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("site_id", String(device.site_id ?? "")) : undefined}
        >
          {editingField === "site_id" ? (
            <select
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => {
                const value = e.target.value;
                void commitField({ site_id: value ? Number(value) : null });
              }}
              onBlur={cancelEdit}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            >
              <option value="">— None —</option>
              {sites.map((site) => (
                <option key={site.id} value={String(site.id)}>{site.display_name ?? site.name}</option>
              ))}
            </select>
          ) : (
            sites.find((s) => s.id === device.site_id)
              ? (sites.find((s) => s.id === device.site_id)!.display_name ?? sites.find((s) => s.id === device.site_id)!.name)
              : "—"
          )}
        </dd>
        <dt>Subnet</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("subnet", device.subnet ?? "") : undefined}
        >
          {editingField === "subnet" ? (
            <input
              autoFocus
              className="details-inline-input"
              placeholder="192.168.10.0/24"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ subnet: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ subnet: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.subnet || "—")}
        </dd>
        <dt>Tags</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("tags", device.tags.join(", ")) : undefined}
        >
          {editingField === "tags" ? (
            <input
              autoFocus
              className="details-inline-input"
              placeholder="tag1, tag2"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => {
                if (!committingRef.current) void commitField({ tags: fieldDraft.split(",").map((t) => t.trim()).filter(Boolean) });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ tags: fieldDraft.split(",").map((t) => t.trim()).filter(Boolean) });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.tags.length ? device.tags.join(", ") : "None")}
        </dd>
        <dt>Notes</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("notes", device.notes ?? "") : undefined}
        >
          {editingField === "notes" ? (
            <textarea
              autoFocus
              className="details-inline-input"
              rows={3}
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ notes: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            />
          ) : (device.notes || "None")}
        </dd>
      </dl>
      {canWrite && (onClone || onDelete) && (
        <div className="detail-actions">
          {onClone && <button type="button" disabled={disabled} onClick={onClone}>Clone</button>}
          {onDelete && <button className="danger-button" type="button" disabled={disabled} onClick={onDelete}>Delete</button>}
        </div>
      )}
      {editHint && <p className="details-edit-hint">Double-click any field to edit</p>}
      {canViewSecurity && (
        <div className="device-security-panel">
          <div className="details-heading security-heading">
            <AlertTriangle size={16} aria-hidden="true" />
            <h4>Recent security activity</h4>
          </div>
          {securityLoading ? (
            <p>Loading security activity...</p>
          ) : securitySummary ? (
            <>
              <dl className="security-summary-list">
                <dt>Blocked</dt>
                <dd>{securitySummary.blocked_count}</dd>
                <dt>Passed</dt>
                <dd>{securitySummary.passed_count}</dd>
                <dt>Total</dt>
                <dd>{securitySummary.total_count}</dd>
                <dt>Last seen</dt>
                <dd>
                  {securitySummary.last_seen_event_time
                    ? formatEventTime(securitySummary.last_seen_event_time)
                    : "No recent events"}
                </dd>
              </dl>
              {securitySummary.events.length === 0 ? (
                <p>No correlated events in the last {securitySummary.window_hours} hours.</p>
              ) : (
                <div className="device-event-list">
                  {securitySummary.events.map((event) => (
                    <div className="device-event-row" key={`device-event-${event.id}`}>
                      <span>{formatEventTime(event.received_at)}</span>
                      <span>{event.action || "-"}</span>
                      <span>{event.src_ip || "-"} → {event.dst_ip || "-"}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p>No security summary is available for this device.</p>
          )}
        </div>
      )}
    </div>
  );
}

function RelationshipDetails({
  canWrite,
  devices,
  disabled,
  relationship,
  onDelete,
  onEdit,
}: {
  canWrite: boolean;
  devices: Device[];
  disabled: boolean;
  relationship: Relationship;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const source = devices.find((device) => device.id === relationship.source_device_id);
  const target = devices.find((device) => device.id === relationship.target_device_id);
  return (
    <div>
      <div className="details-heading">
        <h3>Link details</h3>
      </div>
      <dl>
        <dt>Name</dt>
        <dd>{relationship.relationship_type}</dd>
        <dt>Source</dt>
        <dd>{source ? deviceLabel(source) : `Device ${relationship.source_device_id}`}</dd>
        <dt>Target</dt>
        <dd>{target ? deviceLabel(target) : `Device ${relationship.target_device_id}`}</dd>
        <dt>Source → Target traffic</dt>
        <dd>{relationship.allow_outbound !== false ? "Allowed" : "Blocked"}</dd>
        <dt>Target → Source traffic</dt>
        <dd>{relationship.allow_inbound !== false ? "Allowed" : "Blocked"}</dd>
        <dt>Notes</dt>
        <dd>{stripRelationshipMetadata(relationship.notes) || "None"}</dd>
      </dl>
      {canWrite && (
        <div className="detail-actions">
          <button type="button" disabled={disabled} onClick={onEdit}>
            Edit link
          </button>
          <button className="danger-button" type="button" disabled={disabled} onClick={onDelete}>
            Delete link
          </button>
        </div>
      )}
    </div>
  );
}

function DeviceForm({
  busy,
  cloneSource,
  device,
  groups,
  sites,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  cloneSource: Device | null;
  device: Device | null;
  groups: TopologyGroup[];
  sites: Site[];
  onCancel: () => void;
  onSubmit: (payload: DevicePayload) => Promise<void>;
}) {
  const formId = "device-form";
  const [form, setForm] = useState({
    display_name: device?.display_name ?? cloneSource?.display_name ?? "",
    hostname: initialDeviceName(device, cloneSource),
    ip_address: cloneSource ? "" : device?.ip_address ?? "",
    mac_address: cloneSource ? "" : device?.mac_address ?? "",
    vendor: device?.vendor ?? cloneSource?.vendor ?? "",
    device_type: device?.device_type ?? cloneSource?.device_type ?? "",
    status: device?.status ?? cloneSource?.status ?? "unknown",
    icon: device?.icon ?? cloneSource?.icon ?? deviceTypeIconMap[device?.device_type ?? cloneSource?.device_type ?? ""] ?? "device",
    color: device?.color ?? cloneSource?.color ?? "",
    vlan_id: device?.vlan_id ?? cloneSource?.vlan_id ?? "",
    subnet: device?.subnet ?? cloneSource?.subnet ?? "",
    topology_group_id: String(device?.topology_group_id ?? cloneSource?.topology_group_id ?? ""),
    site_id: String(device?.site_id ?? cloneSource?.site_id ?? ""),
    tags: (device?.tags ?? cloneSource?.tags ?? []).join(", "),
    notes: device?.notes ?? cloneSource?.notes ?? "",
  });

  function update(field: keyof typeof form, value: string) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === "device_type") {
        next.icon = deviceTypeIconMap[value] || "device";
      }
      return next;
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const selectedDeviceType = blankToNull(form.device_type);
    onSubmit({
      display_name: blankToNull(form.display_name),
      hostname: blankToNull(form.hostname),
      ip_address: form.ip_address.trim() || "",
      mac_address: blankToNull(form.mac_address),
      vendor: blankToNull(form.vendor),
      device_type: selectedDeviceType,
      status: form.status as DeviceStatus,
      icon: (form.icon || "device") as DeviceIcon,
      color: blankToNull(form.color),
      vlan_id: blankToNull(form.vlan_id),
      subnet: blankToNull(form.subnet),
      topology_group_id: form.topology_group_id ? Number(form.topology_group_id) : null,
      topology_group: null,
      site_id: form.site_id ? Number(form.site_id) : null,
      tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      notes: blankToNull(form.notes),
    });
  }

  return (
    <Modal
      title={device ? "Edit device" : cloneSource ? "Clone device" : "Add device"}
      onCancel={onCancel}
      headerSubmitLabel={device ? "Save" : undefined}
      headerSubmitFormId={device ? formId : undefined}
      headerSubmitDisabled={busy}
    >
      <form id={formId} className="modal-form" onSubmit={submit}>
        <label>
          Display name
          <input value={form.display_name} onChange={(event) => update("display_name", event.target.value)} />
        </label>
        <div className="modal-form-row">
          <label>
            Hostname
            <input value={form.hostname} onChange={(event) => update("hostname", event.target.value)} />
          </label>
          <label>
            IP address
            <input value={form.ip_address} onChange={(event) => update("ip_address", event.target.value)} />
          </label>
        </div>
        <div className="modal-form-row">
          <label>
            MAC address
            <input value={form.mac_address} onChange={(event) => update("mac_address", event.target.value)} />
          </label>
          <label>
            Vendor
            <input value={form.vendor} onChange={(event) => update("vendor", event.target.value)} />
          </label>
        </div>
        <div className="modal-form-row">
          <label>
            Device type
            <select value={form.device_type} onChange={(event) => update("device_type", event.target.value)}>
              {deviceTypeOptions.map((type) => (
                <option key={type} value={type}>
                  {formatDeviceTypeLabel(type)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={form.status} onChange={(event) => update("status", event.target.value)}>
              <option value="unknown">Unknown</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="warning">Warning</option>
            </select>
          </label>
        </div>
        <label>
          Color
          <div className="color-picker">
            {deviceColors.map((color) => (
              <button
                aria-label={color.label}
                className={form.color === color.value ? "selected" : ""}
                key={color.value}
                style={{ background: color.value }}
                title={color.label}
                type="button"
                onClick={() => update("color", color.value)}
              />
            ))}
            <button
              className={!form.color ? "selected clear-color" : "clear-color"}
              type="button"
              onClick={() => update("color", "")}
            >
              Auto
            </button>
            <label className="custom-color-picker" title="Custom color">
              <input
                type="color"
                value={form.color || "#3276b1"}
                onChange={(event) => update("color", event.target.value)}
              />
              Custom
            </label>
          </div>
        </label>
        <div className="modal-form-row">
          <label>
            Subnet
            <input
              placeholder="192.168.10.0/24"
              value={form.subnet}
              onChange={(event) => update("subnet", event.target.value)}
            />
          </label>
          <label>
            Group (VLAN/zone)
            <select value={form.topology_group_id} onChange={(event) => update("topology_group_id", event.target.value)}>
              <option value="">— None —</option>
              {groups.map((group) => (
                <option key={group.id} value={String(group.id)}>
                  {group.display_name || group.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Location
          <select value={form.site_id} onChange={(event) => update("site_id", event.target.value)}>
            <option value="">— None —</option>
            {sites.map((site) => (
              <option key={site.id} value={String(site.id)}>
                {site.display_name ?? site.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tags
          <input placeholder="comma-separated" value={form.tags} onChange={(event) => update("tags", event.target.value)} />
        </label>
        <label>
          Notes
          <textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

function RelationshipEditForm({
  busy,
  devices,
  relationship,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  devices: Device[];
  relationship: Relationship;
  onCancel: () => void;
  onSubmit: (payload: {
    source_device_id: number;
    target_device_id: number;
    relationship_type: string;
    allow_outbound: boolean;
    allow_inbound: boolean;
    notes: string | null;
  }) => Promise<void>;
}) {
  const formId = "relationship-edit-form";
  const groupNames = useMemo(
    () =>
      [...new Set(devices.map((device) => device.topology_group))]
        .filter(Boolean)
        .sort(compareGroupLabels),
    [devices],
  );
  const endpointOptions = useMemo(() => {
    const deviceOptions = devices.map((device) => ({
      value: `device:${device.id}`,
      label: deviceLabel(device),
    }));
    const groupOptions = groupNames.map((group) => ({
      value: `group:${group}`,
      label: group,
    }));
    return {
      deviceOptions,
      groupOptions,
      all: [...groupOptions, ...deviceOptions],
    };
  }, [devices, groupNames]);
  const visualEndpoints = parseRelationshipVisualEndpoints(relationship.notes);
  const [sourceEndpoint, setSourceEndpoint] = useState(visualEndpoints?.source ?? `device:${relationship.source_device_id}`);
  const [targetEndpoint, setTargetEndpoint] = useState(visualEndpoints?.target ?? `device:${relationship.target_device_id}`);
  const [relationshipType, setRelationshipType] = useState(relationship.relationship_type);
  const [allowOutbound, setAllowOutbound] = useState(relationship.allow_outbound !== false);
  const [allowInbound, setAllowInbound] = useState(relationship.allow_inbound !== false);
  const [notes, setNotes] = useState(stripRelationshipMetadata(relationship.notes));
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!endpointOptions.all.some((option) => option.value === sourceEndpoint)) {
      setSourceEndpoint(`device:${relationship.source_device_id}`);
    }
    if (!endpointOptions.all.some((option) => option.value === targetEndpoint)) {
      setTargetEndpoint(`device:${relationship.target_device_id}`);
    }
  }, [endpointOptions, relationship.source_device_id, relationship.target_device_id, sourceEndpoint, targetEndpoint]);

  function resolveEndpoint(endpoint: string): { deviceId: number; type: "device" | "group" } | null {
    if (endpoint.startsWith("device:")) {
      const deviceId = Number(endpoint.replace("device:", ""));
      const device = devices.find((row) => row.id === deviceId);
      if (!device) {
        return null;
      }
      return {
        deviceId,
        type: "device",
      };
    }
    if (endpoint.startsWith("group:")) {
      const groupName = endpoint.replace("group:", "");
      const representativeDeviceId = groupRepresentativeDeviceId(devices, groupName);
      if (representativeDeviceId === null) {
        return null;
      }
      return {
        deviceId: representativeDeviceId,
        type: "group",
      };
    }
    return null;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const normalizedType = relationshipType.trim();
    if (!normalizedType) {
      setFormError("Link name is required");
      return;
    }
    const source = resolveEndpoint(sourceEndpoint);
    const target = resolveEndpoint(targetEndpoint);
    if (!source || !target) {
      setFormError("Select valid source and target endpoints");
      return;
    }
    if (source.deviceId === target.deviceId) {
      setFormError("Source and target resolve to the same device");
      return;
    }
    void onSubmit({
      source_device_id: source.deviceId,
      target_device_id: target.deviceId,
      relationship_type: normalizedType,
      allow_outbound: allowOutbound,
      allow_inbound: allowInbound,
      notes: composeRelationshipNotes(sourceEndpoint, targetEndpoint, blankToNull(notes) ?? null),
    });
  }

  return (
    <Modal
      title="Edit link"
      onCancel={onCancel}
      headerSubmitLabel="Save"
      headerSubmitFormId={formId}
      headerSubmitDisabled={busy}
    >
      <form id={formId} className="modal-form" onSubmit={submit}>
        <label>
          Source
          <select value={sourceEndpoint} onChange={(event) => setSourceEndpoint(event.target.value)}>
            <optgroup label="Groups (VLAN / subnet zones)">
              {endpointOptions.groupOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Devices">
              {endpointOptions.deviceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label>
          Target
          <select value={targetEndpoint} onChange={(event) => setTargetEndpoint(event.target.value)}>
            <optgroup label="Groups (VLAN / subnet zones)">
              {endpointOptions.groupOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Devices">
              {endpointOptions.deviceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label>
          Link name
          <input required value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} />
        </label>
        <label>
          <span className="inline-toggle">
            <input
              type="checkbox"
              checked={allowOutbound}
              onChange={(event) => setAllowOutbound(event.target.checked)}
            />
            Allow traffic source → target
          </span>
        </label>
        <label>
          <span className="inline-toggle">
            <input
              type="checkbox"
              checked={allowInbound}
              onChange={(event) => setAllowInbound(event.target.checked)}
            />
            Allow traffic target → source
          </span>
        </label>
        <label>
          Notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        {formError && <div className="form-error">{formError}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            Save changes
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RelationshipForm({
  busy,
  devices,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  devices: Device[];
  onCancel: () => void;
  onSubmit: (payload: RelationshipPayload) => Promise<void>;
}) {
  const groupNames = useMemo(
    () =>
      [...new Set(devices.map((device) => device.topology_group))]
        .filter(Boolean)
        .sort(compareGroupLabels),
    [devices],
  );
  const endpointOptions = useMemo(() => {
    const deviceOptions = devices.map((device) => ({
      value: `device:${device.id}`,
      label: deviceLabel(device),
    }));
    const groupOptions = groupNames.map((group) => ({
      value: `group:${group}`,
      label: group,
    }));
    return {
      deviceOptions,
      groupOptions,
      all: [...groupOptions, ...deviceOptions],
    };
  }, [devices, groupNames]);
  const [sourceEndpoint, setSourceEndpoint] = useState(endpointOptions.all[0]?.value ?? "");
  const [targetEndpoint, setTargetEndpoint] = useState(
    endpointOptions.all[1]?.value ?? endpointOptions.all[0]?.value ?? "",
  );
  const [relationshipType, setRelationshipType] = useState("link");
  const [allowOutbound, setAllowOutbound] = useState(true);
  const [allowInbound, setAllowInbound] = useState(true);
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!endpointOptions.all.some((option) => option.value === sourceEndpoint)) {
      setSourceEndpoint(endpointOptions.all[0]?.value ?? "");
    }
    if (!endpointOptions.all.some((option) => option.value === targetEndpoint)) {
      setTargetEndpoint(endpointOptions.all[1]?.value ?? endpointOptions.all[0]?.value ?? "");
    }
  }, [endpointOptions, sourceEndpoint, targetEndpoint]);

  function resolveEndpoint(endpoint: string): { deviceId: number; description: string; type: "device" | "group" } | null {
    if (endpoint.startsWith("device:")) {
      const deviceId = Number(endpoint.replace("device:", ""));
      const device = devices.find((row) => row.id === deviceId);
      if (!device) {
        return null;
      }
      return {
        deviceId,
        description: deviceLabel(device),
        type: "device",
      };
    }
    if (endpoint.startsWith("group:")) {
      const groupName = endpoint.replace("group:", "");
      const representativeDeviceId = groupRepresentativeDeviceId(devices, groupName);
      if (representativeDeviceId === null) {
        return null;
      }
      return {
        deviceId: representativeDeviceId,
        description: groupName,
        type: "group",
      };
    }
    return null;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const source = resolveEndpoint(sourceEndpoint);
    const target = resolveEndpoint(targetEndpoint);
    if (!source || !target) {
      setFormError("Select valid source and target endpoints");
      return;
    }
    if (source.deviceId === target.deviceId) {
      setFormError("Source and target resolve to the same device");
      return;
    }
    onSubmit({
      source_device_id: source.deviceId,
      target_device_id: target.deviceId,
      relationship_type: relationshipType,
      allow_outbound: allowOutbound,
      allow_inbound: allowInbound,
      notes: composeRelationshipNotes(sourceEndpoint, targetEndpoint, blankToNull(notes) ?? null),
    });
  }

  return (
    <Modal title="Add relationship" onCancel={onCancel}>
      <form className="modal-form" onSubmit={submit}>
        <label>
          Source
          <select value={sourceEndpoint} onChange={(event) => setSourceEndpoint(event.target.value)}>
            <optgroup label="Groups (VLAN / subnet zones)">
              {endpointOptions.groupOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Devices">
              {endpointOptions.deviceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label>
          Target
          <select value={targetEndpoint} onChange={(event) => setTargetEndpoint(event.target.value)}>
            <optgroup label="Groups (VLAN / subnet zones)">
              {endpointOptions.groupOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Devices">
              {endpointOptions.deviceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label>
          Type
          <input required value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} />
        </label>
        <label>
          <span className="inline-toggle">
            <input
              type="checkbox"
              checked={allowOutbound}
              onChange={(event) => setAllowOutbound(event.target.checked)}
            />
            Allow traffic source → target
          </span>
        </label>
        <label>
          <span className="inline-toggle">
            <input
              type="checkbox"
              checked={allowInbound}
              onChange={(event) => setAllowInbound(event.target.checked)}
            />
            Allow traffic target → source
          </span>
        </label>
        <label>
          Notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        {formError && <div className="form-error">{formError}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy || sourceEndpoint.length === 0 || targetEndpoint.length === 0}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function groupRepresentativeDeviceId(devices: Device[], groupName: string): number | null {
  const candidates = devices
    .filter((device) => device.topology_group === groupName)
    .sort((left, right) => {
      const levelDelta = deviceHierarchyLevel(left) - deviceHierarchyLevel(right);
      if (levelDelta !== 0) {
        return levelDelta;
      }
      return compareDevices(left, right);
    });
  return candidates[0]?.id ?? null;
}

function Modal({
  children,
  headerSubmitDisabled = false,
  headerSubmitFormId,
  headerSubmitLabel,
  onCancel,
  title,
}: {
  children: React.ReactNode;
  headerSubmitDisabled?: boolean;
  headerSubmitFormId?: string;
  headerSubmitLabel?: string;
  onCancel: () => void;
  title: string;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <div className="modal-header">
          <h3>{title}</h3>
          <div className="modal-header-actions">
            {headerSubmitLabel && headerSubmitFormId && (
              <button type="submit" form={headerSubmitFormId} disabled={headerSubmitDisabled}>
                {headerSubmitLabel}
              </button>
            )}
            <button type="button" onClick={onCancel} title="Close">
              Close
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function statusColor(status: DeviceStatus) {
  return {
    online: "#2d9d78",
    offline: "#8a96a3",
    warning: "#d99a22",
    unknown: "#5b7c91",
    disabled: "#9aabb6",
  }[status];
}

function iconLabel(icon: DeviceIcon) {
  const key = resolveDeviceIcon(icon);
  return runtimeIconDefs.get(key)?.label ?? runtimeIconDefs.get("device")?.label ?? "Device";
}

function deviceVlanDisplay(device: Device) {
  const group = (device.topology_group || "").trim();
  const vlan = (device.vlan_id || "").trim();
  if (group && vlan) {
    const normalizedGroup = group.toLowerCase();
    const normalizedVlan = vlan.toLowerCase();
    if (normalizedGroup === normalizedVlan || normalizedGroup.includes(normalizedVlan)) {
      return group;
    }
    return `${vlan} - ${group}`;
  }
  if (group) {
    return group;
  }
  if (vlan) {
    return vlan;
  }
  return "—";
}

function iconSymbol(icon: DeviceIcon) {
  const key = resolveDeviceIcon(icon);
  return runtimeIconDefs.get(key)?.symbol || runtimeIconDefs.get("device")?.symbol || "□";
}

function iconSelectLabel(icon: DeviceIcon) {
  return `${iconSymbol(icon)} ${iconLabel(icon)}`;
}

function initialDeviceName(device: Device | null, cloneSource: Device | null) {
  if (device) {
    return device.hostname ?? "";
  }
  if (cloneSource?.hostname) {
    return `${cloneSource.hostname} copy`;
  }
  if (cloneSource?.ip_address) {
    return `${cloneSource.ip_address} copy`;
  }
  return "";
}

function deviceIconUrl(icon: DeviceIcon, color = "#3b7cc9") {
  const def = runtimeIconDefs.get(resolveDeviceIcon(icon));
  if (def?.url) return def.url;
  const path = def?.path ?? runtimeIconDefs.get("device")?.path ?? "";
  const safeColor = color.replace(/[<>"'&]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${safeColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function deviceIconPath(icon: DeviceIcon) {
  const key = resolveDeviceIcon(icon);
  return runtimeIconDefs.get(key)?.path ?? runtimeIconDefs.get("device")?.path ?? runtimeIconDefs.get("unknown")?.path ?? "";
}

function resolveDeviceIcon(icon: DeviceIcon | string | null | undefined): DeviceIcon {
  const key = String(icon ?? "").trim();
  if (key.length === 0 || key === "unknown") {
    return "device";
  }
  return runtimeIconDefs.has(key) ? key : "device";
}

function estimateGroupCenter(
  devices: Device[],
  positions: Record<string, { x: number; y: number }>,
) {
  const points = devices
    .map((device) => positions[`device-${device.id}`])
    .filter((point): point is { x: number; y: number } => Boolean(point));
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  const total = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

type DiagramLayout = {
  groups: Array<{ id: string; label: string }>;
  positions: Record<string, { x: number; y: number }>;
};

type DiagramLayoutOptions = {
  maxDevicesPerRow?: number;
  spacingScale?: number;
  groupOptions?: Record<string, { spacingScale?: number; maxDevicesPerRow?: number }>;
};

function buildDiagramLayout(
  graph: TopologyGraph,
  savedPositions: Record<string, { x: number; y: number }> = {},
  options: DiagramLayoutOptions = {},
): DiagramLayout {
  const groups = [...new Set(graph.devices.map((device) => device.topology_group))].sort(
    compareGroupLabels,
  );
  const positions: DiagramLayout["positions"] = {};
  const spacingScale = Math.max(0.8, Math.min(2, options.spacingScale ?? 1));
  const baseZoneWidth = Math.round(360 * spacingScale);
  const baseZoneGapX = Math.round(90 * spacingScale);
  const baseZoneGapY = Math.round(130 * spacingScale);
  const baseNodeGapX = Math.round(126 * spacingScale);
  const baseNodeGapY = Math.round(112 * spacingScale);
  const groupColumns = resolveGroupColumns(groups.length);

  const layoutGroups = groups.map((group) => {
    const groupOption = options.groupOptions?.[group];
    const groupSpacingScale = Math.max(0.8, Math.min(2, groupOption?.spacingScale ?? spacingScale));
    const nodeGapX = Math.round(126 * groupSpacingScale);
    const nodeGapY = Math.round(112 * groupSpacingScale);
    const devices = graph.devices
      .filter((device) => device.topology_group === group)
      .sort(compareDevices);
    const lanes = devicesByHierarchy(devices);
    const visualRows = buildGroupVisualRows(lanes, groupOption?.maxDevicesPerRow ?? options.maxDevicesPerRow ?? 4);
    return {
      group,
      devices,
      visualRows,
      nodeGapX,
      nodeGapY,
      estimatedHeight: estimateGroupHeight(visualRows.length, nodeGapY),
    };
  });

  const rowHeights: number[] = [];
  layoutGroups.forEach((layoutGroup, index) => {
    const row = Math.floor(index / groupColumns);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, layoutGroup.estimatedHeight);
  });
  const rowOffsets: number[] = [];
  let cumulativeOffset = 0;
  rowHeights.forEach((height, row) => {
    rowOffsets[row] = cumulativeOffset;
    cumulativeOffset += height + baseZoneGapY;
  });

  layoutGroups.forEach((layoutGroup, groupIndex) => {
    const row = Math.floor(groupIndex / groupColumns);
    const column = groupIndex % groupColumns;
    const columnX = column * (baseZoneWidth + baseZoneGapX) + baseZoneWidth / 2;
    const rowBaseY = (rowOffsets[row] ?? 0) + 100;

    // Anchor new devices near where existing group members actually are,
    // so adding a device doesn't stretch the compound zone to the abstract layout origin.
    const savedInGroup = layoutGroup.devices
      .map((d) => savedPositions[`device-${d.id}`])
      .filter((p): p is { x: number; y: number } => Boolean(p));
    const newAnchorX = savedInGroup.length > 0
      ? savedInGroup.reduce((s, p) => s + p.x, 0) / savedInGroup.length
      : columnX;
    const newAnchorBaseY = savedInGroup.length > 0
      ? Math.max(...savedInGroup.map((p) => p.y))
      : rowBaseY - layoutGroup.nodeGapY;

    let newOnlyRowIndex = 0;

    layoutGroup.visualRows.forEach((rowDevices) => {
      const rowSaved = rowDevices
        .map((d) => savedPositions[`device-${d.id}`])
        .filter((p): p is { x: number; y: number } => Boolean(p));
      const allNewRow = rowSaved.length === 0;

      rowDevices.forEach((device, index) => {
        const deviceId = `device-${device.id}`;
        const savedPosition = savedPositions[deviceId];
        if (savedPosition) {
          positions[deviceId] = savedPosition;
          return;
        }
        // Mixed row: match the Y of existing sibling devices in this row.
        // All-new row: stack below the bottom-most existing device.
        const y = allNewRow
          ? newAnchorBaseY + (newOnlyRowIndex + 1) * layoutGroup.nodeGapY
          : rowSaved.reduce((s, p) => s + p.y, 0) / rowSaved.length;
        positions[deviceId] = {
          x: newAnchorX + centeredOffset(index, rowDevices.length, layoutGroup.nodeGapX),
          y,
        };
      });

      if (allNewRow && rowDevices.some((d) => !savedPositions[`device-${d.id}`])) {
        newOnlyRowIndex++;
      }
    });
  });

  return {
    groups: groups.map((group) => ({ id: groupId(group), label: group })),
    positions,
  };
}

function resolveGroupColumns(groupCount: number) {
  if (groupCount <= 1) {
    return 1;
  }
  if (groupCount <= 4) {
    return 2;
  }
  if (groupCount <= 9) {
    return 3;
  }
  return 4;
}

function buildGroupVisualRows(lanes: Device[][], maxDevicesPerRow: number) {
  const safeMaxDevicesPerRow = Math.max(1, maxDevicesPerRow);
  const rows: Device[][] = [];
  lanes.forEach((lane) => {
    if (lane.length <= safeMaxDevicesPerRow) {
      rows.push(lane);
      return;
    }

    // Split each hierarchy lane into balanced rows to avoid uneven long tails.
    const rowCount = Math.ceil(lane.length / safeMaxDevicesPerRow);
    const perRow = Math.ceil(lane.length / rowCount);
    for (let index = 0; index < lane.length; index += perRow) {
      rows.push(lane.slice(index, index + perRow));
    }
  });
  return rows;
}

function estimateGroupHeight(laneCount: number, nodeGapY: number) {
  if (laneCount <= 1) {
    return 260;
  }
  return Math.max(260, 180 + (laneCount - 1) * nodeGapY);
}

function devicesByHierarchy(devices: Device[]) {
  const lanes = new Map<number, Device[]>();
  devices
    .slice()
    .sort((left, right) => {
      const levelDiff = deviceHierarchyLevel(left) - deviceHierarchyLevel(right);
      if (levelDiff !== 0) {
        return levelDiff;
      }
      return compareDevices(left, right);
    })
    .forEach((device) => {
      const level = deviceHierarchyLevel(device);
      const lane = lanes.get(level) ?? [];
      lane.push(device);
      lanes.set(level, lane);
    });
  return [...lanes.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, lane]) => lane);
}

function deviceHierarchyLevel(device: Device) {
  const normalizedType = `${device.device_type ?? ""} ${device.icon}`.toLowerCase();
  if (normalizedType.includes("firewall") || normalizedType.includes("gateway")) {
    return 0;
  }
  if (normalizedType.includes("router")) {
    return 1;
  }
  if (normalizedType.includes("switch")) {
    return 2;
  }
  if (normalizedType.includes("server") || normalizedType.includes("nas") || normalizedType.includes("cloud")) {
    return 3;
  }
  if (normalizedType.includes("wireless") || normalizedType.includes("ap") || normalizedType.includes("wifi")) {
    return 4;
  }
  if (normalizedType.includes("workstation") || normalizedType.includes("printer") || normalizedType.includes("phone")) {
    return 5;
  }
  return 4;
}

function centeredOffset(index: number, count: number, gap: number) {
  if (count <= 1) {
    return 0;
  }
  return (index - (count - 1) / 2) * gap;
}

function savedTopologyLayoutKey(userId: number) {
  return `${topologyLayoutStoragePrefix}.v${topologyLayoutVersion}.${userId}`;
}

function topologyDisplayPrefsKey(userId: number) {
  return `${topologyDisplayPrefsStoragePrefix}.${userId}`;
}

function readTopologyDisplayPrefs(userId: number): {
  groups: Record<string, { nodeScalePercent: number; spacingScalePercent: number; maxDevicesPerRow: number }>;
} {
  const raw = window.localStorage.getItem(topologyDisplayPrefsKey(userId));
  if (!raw) return { groups: {} };
  try {
    const parsed = JSON.parse(raw) as {
      groups?: Record<string, { nodeScalePercent: number; spacingScalePercent: number; maxDevicesPerRow: number }>;
    };
    return { groups: parsed.groups ?? {} };
  } catch {
    window.localStorage.removeItem(topologyDisplayPrefsKey(userId));
    return { groups: {} };
  }
}

function writeTopologyDisplayPrefs(
  userId: number,
  prefs: { groups: Record<string, { nodeScalePercent: number; spacingScalePercent: number; maxDevicesPerRow: number }> },
) {
  window.localStorage.setItem(topologyDisplayPrefsKey(userId), JSON.stringify(prefs));
}

function readSavedTopologyLayout(userId: number) {
  const raw = window.localStorage.getItem(savedTopologyLayoutKey(userId));
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    return parsed ?? {};
  } catch {
    window.localStorage.removeItem(savedTopologyLayoutKey(userId));
    return {};
  }
}

function clearSavedTopologyLayout(userId: number) {
  window.localStorage.removeItem(savedTopologyLayoutKey(userId));
}

function persistCurrentTopologyLayout(
  cy: Core | null,
  userId: number,
  layoutPositionsRef: React.MutableRefObject<Record<string, { x: number; y: number }>>,
) {
  if (!cy) {
    return;
  }
  const visiblePositions = collectCurrentTopologyLayoutPositions(cy);
  if (Object.keys(visiblePositions).length === 0) {
    return;
  }
  layoutPositionsRef.current = {
    ...layoutPositionsRef.current,
    ...visiblePositions,
  };
  window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(layoutPositionsRef.current));
}

function collectCurrentTopologyLayoutPositions(cy: Core | null) {
  const visiblePositions: Record<string, { x: number; y: number }> = {};
  if (!cy) {
    return visiblePositions;
  }
  cy.$("node.device").forEach((node) => {
    visiblePositions[node.id()] = { ...node.position() };
  });
  return visiblePositions;
}

function triggerDownload(result: DownloadResult) {
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadTextFile(content: string, filename: string, mimeType: string) {
  triggerDownload({
    blob: new Blob([content], { type: mimeType }),
    filename,
  });
}

function buildTopologySvg(cy: Core) {
  const bounds = cy.elements().boundingBox();
  const width = Math.max(320, Math.ceil(bounds.w + 120));
  const height = Math.max(240, Math.ceil(bounds.h + 120));
  const offsetX = 60 - bounds.x1;
  const offsetY = 60 - bounds.y1;
  let zoneMarkup = "";
  cy.nodes(".zone").forEach((zone) => {
    const position = zone.position();
    const zoneWidth = zone.width();
    const zoneHeight = zone.height();
    zoneMarkup += `
        <g>
          <rect x="${position.x - zoneWidth / 2 + offsetX}" y="${position.y - zoneHeight / 2 + offsetY}" width="${zoneWidth}" height="${zoneHeight}" rx="20" ry="20" fill="#f4f8fa" stroke="#aebfcb" stroke-width="2" stroke-dasharray="8 6" />
          <text x="${position.x - zoneWidth / 2 + 18 + offsetX}" y="${position.y - zoneHeight / 2 + 26 + offsetY}" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#263b4b">${escapeXml(zone.data("label") ?? "")}</text>
        </g>
      `;
  });
  let edgeMarkup = "";
  cy.edges().forEach((edge) => {
    const source = edge.source().position();
    const target = edge.target().position();
    edgeMarkup += `<line x1="${source.x + offsetX}" y1="${source.y + offsetY}" x2="${target.x + offsetX}" y2="${target.y + offsetY}" stroke="#6f8798" stroke-width="2" />`;
  });
  let nodeMarkup = "";
  cy.nodes(".device").forEach((node) => {
    const position = node.position();
    const label = String(node.data("label") ?? "");
    const lines = label.split("\n");
    const color = String(node.data("color") ?? "#5b7c91");
    const icon = resolveDeviceIcon(String(node.data("icon") ?? "unknown"));
    const iconPath = deviceIconPath(icon);
    const nodeScale = Math.max(0.7, Math.min(2.2, Number(node.data("nodeScale") ?? 1)));
    const size = Math.max(30, Math.min(130, 44 * nodeScale));
    const scale = size / 24;
    nodeMarkup += `
        <g>
          <g transform="translate(${position.x + offsetX - 12 * scale} ${position.y + offsetY - 12 * scale}) scale(${scale})">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${escapeXml(color)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              ${iconPath}
            </svg>
          </g>
          ${lines
            .map(
              (line, index) =>
                `<text x="${position.x + offsetX}" y="${position.y + 44 + offsetY + index * 14}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#13212b">${escapeXml(line)}</text>`,
            )
            .join("")}
        </g>
      `;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#fbfdfe" />
  ${zoneMarkup}
  ${edgeMarkup}
  ${nodeMarkup}
</svg>`;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function compareDevices(left: Device, right: Device) {
  const typeDiff = deviceTypeSortRank(left) - deviceTypeSortRank(right);
  if (typeDiff !== 0) {
    return typeDiff;
  }
  const nameDiff = (left.hostname ?? "").toLowerCase().localeCompare((right.hostname ?? "").toLowerCase());
  if (nameDiff !== 0) {
    return nameDiff;
  }
  return ipSortKey(left.ip_address).localeCompare(ipSortKey(right.ip_address));
}

function deviceTypeSortRank(device: Device) {
  const normalized = `${device.device_type ?? ""} ${device.icon}`.toLowerCase();
  if (normalized.includes("firewall") || normalized.includes("gateway")) return 0;
  if (normalized.includes("router")) return 1;
  if (normalized.includes("switch")) return 2;
  if (normalized.includes("server") || normalized.includes("nas") || normalized.includes("cloud")) return 3;
  if (normalized.includes("wireless") || normalized.includes("ap") || normalized.includes("wifi")) return 4;
  if (normalized.includes("workstation") || normalized.includes("laptop") || normalized.includes("desktop")) return 5;
  return 6;
}

function compareGroupLabels(left: string, right: string) {
  return groupSortKey(left).localeCompare(groupSortKey(right));
}

function groupSortKey(group: string) {
  const normalized = group.trim();
  const categoryRank = groupCategoryRank(normalized);
  const vlanMatch = normalized.match(/^VLAN\s+(\d+)/i);
  if (vlanMatch) {
    return `${categoryRank}-vlan-${vlanMatch[1].padStart(6, "0")}-${normalized.toLowerCase()}`;
  }
  const cidrMatch = normalized.match(/(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})/);
  if (cidrMatch) {
    return `${categoryRank}-cidr-${ipSortKey(cidrMatch[1])}-${cidrMatch[2].padStart(2, "0")}-${normalized.toLowerCase()}`;
  }
  return `${categoryRank}-name-${ipSortKey(normalized.toLowerCase())}`;
}

function groupCategoryRank(group: string) {
  const value = group.toLowerCase();
  if (value === "ungrouped" || value.includes("default")) {
    return "900";
  }
  if (
    value.includes("wan") ||
    value.includes("internet") ||
    value.includes("edge") ||
    value.includes("perimeter") ||
    value.includes("dmz")
  ) {
    return "000";
  }
  if (
    value.includes("core") ||
    value.includes("infra") ||
    value.includes("mgmt") ||
    value.includes("management") ||
    value.includes("network")
  ) {
    return "100";
  }
  if (
    value.includes("server") ||
    value.includes("compute") ||
    value.includes("datacenter") ||
    value.includes("dc") ||
    value.includes("storage") ||
    value.includes("nas")
  ) {
    return "200";
  }
  if (
    value.includes("user") ||
    value.includes("client") ||
    value.includes("workstation") ||
    value.includes("corp") ||
    value.includes("office") ||
    value.includes("lan")
  ) {
    return "300";
  }
  if (
    value.includes("wifi") ||
    value.includes("wireless") ||
    value.includes("wlan") ||
    value.includes("guest")
  ) {
    return "400";
  }
  if (value.includes("iot") || value.includes("ot") || value.includes("camera") || value.includes("voice")) {
    return "500";
  }
  if (value.includes("lab") || value.includes("test") || value.includes("dev")) {
    return "600";
  }
  return "700";
}

function ipSortKey(value: string) {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return value;
  }
  return match.slice(1).map((part) => part.padStart(3, "0")).join(".");
}

function groupId(group: string) {
  return `group-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default"}`;
}

function relationshipVisualSourceNodeId(relationship: Relationship) {
  const endpoints = parseRelationshipVisualEndpoints(relationship.notes);
  const source = endpoints?.source;
  if (source && source.startsWith("group:")) {
    return groupId(source.replace("group:", ""));
  }
  if (source && source.startsWith("device:")) {
    return `device-${Number(source.replace("device:", ""))}`;
  }
  return `device-${relationship.source_device_id}`;
}

function relationshipVisualTargetNodeId(relationship: Relationship) {
  const endpoints = parseRelationshipVisualEndpoints(relationship.notes);
  const target = endpoints?.target;
  if (target && target.startsWith("group:")) {
    return groupId(target.replace("group:", ""));
  }
  if (target && target.startsWith("device:")) {
    return `device-${Number(target.replace("device:", ""))}`;
  }
  return `device-${relationship.target_device_id}`;
}

function parseRelationshipVisualEndpoints(notes: string | null) {
  if (!notes || !notes.startsWith("__visual_endpoints__:")) {
    return null;
  }
  const [header] = notes.split("\n", 1);
  const payload = header.replace("__visual_endpoints__:", "");
  const [sourceRaw, targetRaw] = payload.split("|", 2);
  if (!sourceRaw || !targetRaw) {
    return null;
  }
  try {
    return {
      source: decodeURIComponent(sourceRaw),
      target: decodeURIComponent(targetRaw),
    };
  } catch {
    return null;
  }
}

function stripRelationshipMetadata(notes: string | null) {
  if (!notes) {
    return "";
  }
  if (!notes.startsWith("__visual_endpoints__:")) {
    return notes;
  }
  const [, ...rest] = notes.split("\n");
  return rest.join("\n").trim();
}

function composeRelationshipNotes(
  sourceEndpoint: string,
  targetEndpoint: string,
  notes: string | null,
) {
  const prefix = `__visual_endpoints__:${encodeURIComponent(sourceEndpoint)}|${encodeURIComponent(targetEndpoint)}`;
  const cleanNotes = blankToNull(notes ?? "");
  return cleanNotes ? `${prefix}\n${cleanNotes}` : prefix;
}

function preserveRelationshipMetadata(existingNotes: string | null, newNotes: string | null) {
  if (!existingNotes || !existingNotes.startsWith("__visual_endpoints__:")) {
    return newNotes;
  }
  const [header] = existingNotes.split("\n", 1);
  const cleanNotes = blankToNull(newNotes ?? "");
  return cleanNotes ? `${header}\n${cleanNotes}` : header;
}

function estimateScanTarget(rawTarget: string) {
  const target = rawTarget.trim();
  if (!target) {
    return {
      hostCount: 0,
      label: "Enter a private target",
      help: "Single IP, IP range, and CIDR notation are supported.",
    };
  }

  if (target.includes("/") && !target.includes(":")) {
    const [, prefixRaw] = target.split("/", 2);
    const prefix = Number(prefixRaw);
    if (Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
      const hostCount = 2 ** (32 - prefix);
      return {
        hostCount,
        label: `${hostCount} IPv4 addresses`,
        help:
          hostCount > 256
            ? "This is larger than a /24 and requires confirmation."
            : "Private /24-sized scans can start directly.",
      };
    }
  }

  if (target.includes("-")) {
    const [start, end] = target.split("-", 2).map((value) => value.trim());
    const startParts = parseIpv4Parts(start);
    const endParts = parseIpv4Parts(end);
    if (startParts && endParts) {
      const startValue = ipv4ToNumber(startParts);
      const endValue = ipv4ToNumber(endParts);
      const hostCount = Math.max(0, endValue - startValue + 1);
      return {
        hostCount,
        label: `${hostCount} IPv4 addresses`,
        help: hostCount > 256 ? "Large ranges require confirmation." : "Range is within the normal scan size.",
      };
    }
  }

  return {
    hostCount: 1,
    label: "1 target address",
    help: "Single-target scans can start directly.",
  };
}

function parseIpv4Parts(value: string) {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function ipv4ToNumber(parts: number[]) {
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function buildSearchParams(
  filters: SecurityFilters,
  offset: number,
  limit: number,
  sortBy: string,
  sortDir: "asc" | "desc",
): FirewallEventSearchParams {
  return {
    q: blankToUndefined(filters.q),
    src_ip: blankToUndefined(filters.src_ip),
    dst_ip: blankToUndefined(filters.dst_ip),
    src_port: toOptionalPort(filters.src_port),
    dst_port: toOptionalPort(filters.dst_port),
    action: blankToUndefined(filters.action.toLowerCase()),
    protocol: blankToUndefined(filters.protocol.toLowerCase()),
    interface: blankToUndefined(filters.interface),
    start_time: dateTimeLocalToIso(filters.start_time),
    end_time: dateTimeLocalToIso(filters.end_time),
    limit,
    offset,
    sort_by: sortBy,
    sort_dir: sortDir,
  };
}

function eventMatchesFilters(event: FirewallEvent, filters: SecurityFilters) {
  const comparisons: Array<[string, string | number | null]> = [
    [filters.src_ip, event.src_ip],
    [filters.dst_ip, event.dst_ip],
    [filters.src_port, event.src_port],
    [filters.dst_port, event.dst_port],
    [filters.action, event.action],
    [filters.protocol, event.protocol],
    [filters.interface, event.interface],
  ];
  if (comparisons.some(([filter, value]) => filter && String(value ?? "").toLowerCase() !== filter.toLowerCase())) {
    return false;
  }
  if (filters.q) {
    const haystack = [
      event.raw_log,
      event.src_ip,
      event.dst_ip,
      event.source_host,
      event.rule_id,
      event.reason,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(filters.q.toLowerCase())) {
      return false;
    }
  }
  const eventTime = new Date(event.received_at).getTime();
  const startTime = filters.start_time ? new Date(filters.start_time).getTime() : null;
  const endTime = filters.end_time ? new Date(filters.end_time).getTime() : null;
  return (!startTime || eventTime >= startTime) && (!endTime || eventTime <= endTime);
}

function relatedDevicesForEvent(
  event: FirewallEvent | CorrelatedFirewallEvent,
  devicesByIp: Map<string, Device[]>,
): Device[] {
  const results = new Map<number, Device>();
  if (event.src_ip) {
    (devicesByIp.get(event.src_ip.trim()) ?? []).forEach((device) => results.set(device.id, device));
  }
  if (event.dst_ip) {
    (devicesByIp.get(event.dst_ip.trim()) ?? []).forEach((device) => results.set(device.id, device));
  }
  return [...results.values()].sort(compareDevices);
}

function deviceLabel(device: Device) {
  return device.display_name || device.hostname || device.ip_address || `Device ${device.id}`;
}

function userInitials(username: string) {
  const parts = username.trim().split(/[\s._-]+/);
  if (parts.length >= 2 && parts[1].length > 0) return (parts[0][0] + parts[1][0]).toUpperCase();
  return username.slice(0, 2).toUpperCase();
}

function buildFirewallEventsWsUrl(token: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ token });
  return `${protocol}//${window.location.host}/api/v1/syslog/events/live?${params.toString()}`;
}

function toOptionalPort(value: string): number | "" {
  if (!value.trim()) {
    return "";
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : "";
}

function dateTimeLocalToIso(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

function toDateTimeLocal(value: Date) {
  const offsetMs = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offsetMs).toISOString().slice(0, 16);
}

function formatEventTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function blankToUndefined(value: string) {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function blankToNull(value: string) {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function cidrUsableHosts(cidr: string | null | undefined): number | null {
  if (!cidr) return null;
  const match = cidr.match(/\/(\d+)$/);
  if (!match) return null;
  const prefix = parseInt(match[1], 10);
  if (prefix < 0 || prefix > 32) return null;
  if (prefix === 32) return 1;
  if (prefix === 31) return 2;
  return Math.pow(2, 32 - prefix) - 2;
}

function formatUsableHosts(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function buildDevicePayload(device: Device, overrides: Partial<DevicePayload> = {}): DevicePayload {
  const base: DevicePayload = {
    display_name: device.display_name,
    hostname: device.hostname,
    ip_address: device.ip_address ?? "",
    mac_address: device.mac_address,
    vendor: device.vendor,
    device_type: device.device_type,
    status: device.status,
    icon: (deviceTypeIconMap[device.device_type ?? ""] || device.icon || "device") as DeviceIcon,
    color: device.color,
    vlan_id: device.vlan_id,
    subnet: device.subnet,
    topology_group_id: device.topology_group_id,
    topology_group: null,
    site_id: device.site_id,
    tags: device.tags,
    notes: device.notes,
  };
  return { ...base, ...overrides };
}

// ── IPAM ──────────────────────────────────────────────────────────────────────

function UtilizationBar({ value, size = "normal" }: { value: number; size?: "normal" | "thin" }) {
  const pct = Math.round(value * 100);
  const color = pct >= 90 ? "var(--dash-red)" : pct >= 70 ? "var(--dash-amber)" : "var(--dash-green)";
  return (
    <div className={`ipam-util-bar ipam-util-bar--${size}`}>
      <div className="ipam-util-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

const IP_KIND_COLOR: Record<string, string> = {
  network: "#94a3b8", broadcast: "#94a3b8", gateway: "#f59e0b",
  device: "#2dba7c", dhcp: "#3b80d0", free: "#e8edf3",
};
const IP_KIND_LABEL: Record<string, string> = {
  network: "Network", broadcast: "Broadcast", gateway: "Gateway",
  device: "Device", dhcp: "DHCP lease", free: "Free",
};
const IP_NO_TOOLTIP = new Set(["network", "broadcast"]);

function IpGrid({ entries }: { entries: IpAddressEntry[] }) {
  const [hovered, setHovered] = useState<IpAddressEntry | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  if (!entries.length) return <p className="dash-empty">Subnet too large to enumerate — showing summary only.</p>;

  return (
    <div
      className="ipam-grid"
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setHovered(null)}
    >
      {entries.map((e) => (
        <span
          key={e.ip}
          className={`ipam-grid-cell${!IP_NO_TOOLTIP.has(e.kind) ? " ipam-grid-cell--has-tip" : ""}`}
          style={{ background: IP_KIND_COLOR[e.kind] ?? "#e8edf3" }}
          onMouseEnter={() => { if (!IP_NO_TOOLTIP.has(e.kind)) setHovered(e); }}
          onMouseLeave={() => setHovered(null)}
        />
      ))}
      {hovered && (
        <IpTooltipCard entry={hovered} x={pos.x} y={pos.y} />
      )}
    </div>
  );
}

function IpTooltipCard({ entry, x, y }: { entry: IpAddressEntry; x: number; y: number }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = 220;
  const cardH = 130;
  const left = x + 14 + cardW > vw ? x - cardW - 8 : x + 14;
  const top  = y + 14 + cardH > vh ? y - cardH - 8 : y + 14;

  return (
    <div className="ipam-tooltip-card" style={{ left, top }}>
      <div className="ipam-tooltip-header">
        <span className="ipam-tooltip-kind-dot" style={{ background: IP_KIND_COLOR[entry.kind] ?? "#94a3b8" }} />
        <span className="ipam-tooltip-ip">{entry.ip}</span>
        <span className="ipam-tooltip-kind">{IP_KIND_LABEL[entry.kind] ?? entry.kind}</span>
      </div>
      {entry.kind === "free" ? (
        <div className="ipam-tooltip-row ipam-tooltip-row--available">
          <span>Status</span><span>Available — not assigned</span>
        </div>
      ) : (
        <>
          {entry.label && (
            <div className="ipam-tooltip-row">
              <span>Name</span><span>{entry.label}</span>
            </div>
          )}
          {entry.mac_address && (
            <div className="ipam-tooltip-row">
              <span>MAC</span><span className="ipam-tooltip-mono">{entry.mac_address}</span>
            </div>
          )}
          {entry.vendor && (
            <div className="ipam-tooltip-row">
              <span>Vendor</span><span>{entry.vendor}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SubnetForm({
  initial, onSave, onCancel, busy, error,
}: {
  initial?: Partial<SubnetPayload>;
  onSave: (p: SubnetPayload) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [cidr, setCidr] = useState(initial?.cidr ?? "");
  const [gateway, setGateway] = useState(initial?.gateway ?? "");
  const [vlan, setVlan] = useState(initial?.vlan_id ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave({ name: name.trim(), cidr: cidr.trim(), gateway: gateway.trim() || null, vlan_id: vlan.trim() || null, description: description.trim() || null });
  }

  return (
    <form className="ipam-subnet-form" onSubmit={submit}>
      <div className="ipam-form-row">
        <label className="ipam-form-label">Name *
          <input className="ipam-form-input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Office LAN" />
        </label>
        <label className="ipam-form-label">CIDR *
          <input className="ipam-form-input ipam-form-input--mono" value={cidr} onChange={(e) => setCidr(e.target.value)} required placeholder="e.g. 192.168.1.0/24" />
        </label>
        <label className="ipam-form-label">Gateway
          <input className="ipam-form-input ipam-form-input--mono" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="e.g. 192.168.1.1" />
        </label>
        <label className="ipam-form-label">VLAN ID
          <input className="ipam-form-input" value={vlan} onChange={(e) => setVlan(e.target.value)} placeholder="e.g. 10" />
        </label>
      </div>
      <label className="ipam-form-label">Description
        <input className="ipam-form-input ipam-form-input--wide" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="ipam-form-actions">
        <button type="submit" className="ipam-btn ipam-btn--primary" disabled={busy}>{busy ? "Saving…" : "Save subnet"}</button>
        <button type="button" className="ipam-btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function IpamWorkspace({ accessToken, canWrite }: { accessToken: string; canWrite: boolean }) {
  const [summary, setSummary] = useState<IpamSummary | null>(null);
  const [subnets, setSubnets] = useState<IpamSubnet[]>([]);
  const [conflicts, setConflicts] = useState<IpamConflict[]>([]);
  const [dhcpLeases, setDhcpLeases] = useState<DhcpLease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedSubnet, setSelectedSubnet] = useState<IpamSubnet | null>(null);
  const [addresses, setAddresses] = useState<IpAddressEntry[]>([]);
  const [addressesLoading, setAddressesLoading] = useState(false);

  const [showSubnetForm, setShowSubnetForm] = useState(false);
  const [editingSubnet, setEditingSubnet] = useState<IpamSubnet | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [showDhcp, setShowDhcp] = useState(false);
  const [dhcpText, setDhcpText] = useState("");
  const [dhcpBusy, setDhcpBusy] = useState(false);
  const [dhcpMsg, setDhcpMsg] = useState<string | null>(null);

  const [showConflicts, setShowConflicts] = useState(false);
  const [addrFilter, setAddrFilter] = useState<"all" | "device" | "dhcp" | "free">("all");

  const [showVlanImport, setShowVlanImport] = useState(false);
  const [vlanSuggestions, setVlanSuggestions] = useState<VlanSuggestion[]>([]);
  const [vlanSelected, setVlanSelected] = useState<Set<number>>(new Set());
  const [vlanBusy, setVlanBusy] = useState(false);
  const [vlanMsg, setVlanMsg] = useState<string | null>(null);
  const [ipamSortKey, setIpamSortKey] = useState<"name" | "cidr" | "util" | "devices" | "dhcp" | "free" | "gateway">("name");
  const [ipamSortDir, setIpamSortDir] = useState<"asc" | "desc">("asc");

  function toggleIpamSort(key: typeof ipamSortKey) {
    if (ipamSortKey === key) {
      setIpamSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setIpamSortKey(key);
      setIpamSortDir("asc");
    }
  }

  const sortedSubnets = useMemo(() => {
    const dir = ipamSortDir === "asc" ? 1 : -1;
    return [...subnets].sort((a, b) => {
      switch (ipamSortKey) {
        case "name": return dir * a.name.localeCompare(b.name);
        case "cidr": return dir * a.cidr.localeCompare(b.cidr);
        case "util": return dir * (a.utilization - b.utilization);
        case "devices": return dir * (a.device_count - b.device_count);
        case "dhcp": return dir * (a.dhcp_count - b.dhcp_count);
        case "free": return dir * (a.free - b.free);
        case "gateway": return dir * ((a.gateway ?? "").localeCompare(b.gateway ?? ""));
        default: return 0;
      }
    });
  }, [subnets, ipamSortKey, ipamSortDir]);

  const load = useCallback(async () => {
    try {
      const [s, sn, c, dl] = await Promise.all([
        api.getIpamSummary(accessToken),
        api.listSubnets(accessToken),
        api.getIpamConflicts(accessToken),
        api.listDhcpLeases(accessToken),
      ]);
      setSummary(s); setSubnets(sn); setConflicts(c); setDhcpLeases(dl);
      setError(null);
    } catch {
      setError("Failed to load IPAM data");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  const loadAddresses = useCallback(async (subnet: IpamSubnet) => {
    setAddressesLoading(true);
    try {
      setAddresses(await api.getSubnetAddresses(accessToken, subnet.id));
    } catch { setAddresses([]); }
    finally { setAddressesLoading(false); }
  }, [accessToken]);

  useEffect(() => {
    if (selectedSubnet) void loadAddresses(selectedSubnet);
    else setAddresses([]);
  }, [selectedSubnet, loadAddresses]);

  async function saveSubnet(payload: SubnetPayload) {
    setFormBusy(true); setFormError(null);
    try {
      if (editingSubnet) {
        await api.updateSubnet(accessToken, editingSubnet.id, payload);
      } else {
        await api.createSubnet(accessToken, payload);
      }
      setShowSubnetForm(false); setEditingSubnet(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save subnet");
    } finally { setFormBusy(false); }
  }

  async function deleteSubnet(subnet: IpamSubnet) {
    if (!confirm(`Delete subnet "${subnet.name}" (${subnet.cidr})?`)) return;
    try {
      await api.deleteSubnet(accessToken, subnet.id);
      if (selectedSubnet?.id === subnet.id) setSelectedSubnet(null);
      await load();
    } catch { /* ignore */ }
  }

  async function importDhcp(e: FormEvent) {
    e.preventDefault();
    setDhcpBusy(true); setDhcpMsg(null);
    try {
      const result = await api.importDhcpLeases(accessToken, dhcpText);
      setDhcpMsg(`Imported ${result.imported} new leases (${result.total} total parsed).`);
      setDhcpText(""); await load();
    } catch {
      setDhcpMsg("Failed to parse lease file. Check the format.");
    } finally { setDhcpBusy(false); }
  }

  async function clearDhcp() {
    if (!confirm("Clear all DHCP leases?")) return;
    await api.clearDhcpLeases(accessToken);
    await load();
  }

  async function openVlanImport() {
    setVlanMsg(null); setVlanSelected(new Set());
    const suggestions = await api.getVlanSuggestions(accessToken);
    setVlanSuggestions(suggestions);
    setShowVlanImport(true);
  }

  function toggleVlan(id: number) {
    setVlanSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function doVlanImport() {
    if (vlanSelected.size === 0) return;
    setVlanBusy(true); setVlanMsg(null);
    try {
      const result = await api.importSubnetsFromVlans(accessToken, [...vlanSelected]);
      setVlanMsg(`Imported ${result.imported} subnet${result.imported !== 1 ? "s" : ""}.`);
      setVlanSelected(new Set());
      await load();
      const updated = await api.getVlanSuggestions(accessToken);
      setVlanSuggestions(updated);
    } catch {
      setVlanMsg("Import failed.");
    } finally { setVlanBusy(false); }
  }

  const filteredAddresses = useMemo(() => {
    if (addrFilter === "all") return addresses;
    return addresses.filter((a) => a.kind === addrFilter);
  }, [addresses, addrFilter]);

  function fmtExpiry(iso: string | null) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  if (loading) return <div className="dash-layout"><p className="dash-empty">Loading IPAM data…</p></div>;
  if (error) return <div className="dash-layout"><p className="dash-empty" style={{ color: "var(--dash-red)" }}>{error}</p></div>;

  const errorConflicts = conflicts.filter((c) => c.severity === "error");
  const warnConflicts = conflicts.filter((c) => c.severity === "warning");

  return (
    <section className="dash-layout">

      {/* Header */}
      <div className="dash-header">
        <div>
          <h1 className="dash-title">IPAM</h1>
          <p className="dash-subtitle">IP address management — subnets, utilization and DHCP leases</p>
        </div>
        <div className="dash-header-meta">
          <RefreshCw size={13} style={{ cursor: "pointer" }} onClick={() => void load()} />
          <span>Auto-synced with device inventory</span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="dash-stats">
        <DashStat label="Subnets" value={summary?.subnet_count ?? 0} sub="defined" icon={<Network size={20} />} accent="teal" />
        <DashStat label="Total hosts" value={summary?.total_hosts ?? 0} sub="across all subnets" icon={<IconServer size={20} />} accent="blue" />
        <DashStat label="Used" value={summary?.used ?? 0} sub="addresses assigned" icon={<IconWifi size={20} />} accent="green" />
        <DashStat label="Free" value={summary?.free ?? 0} sub="addresses available" icon={<IconWifiOff size={20} />} accent="indigo" />
        <DashStat label="DHCP leases" value={summary?.dhcp_lease_count ?? 0} sub="imported" icon={<Activity size={20} />} accent="purple" />
        <DashStat
          label="Conflicts"
          value={conflicts.length}
          sub={conflicts.length === 0 ? "no issues" : `${errorConflicts.length} errors, ${warnConflicts.length} warnings`}
          icon={<IconAlertCircle size={20} />}
          accent={conflicts.length === 0 ? "green" : errorConflicts.length > 0 ? "red" : "purple"}
        />
      </div>

      {/* Conflicts banner */}
      {conflicts.length > 0 && (
        <div className={`dash-alert${errorConflicts.length === 0 ? " dash-alert--warn" : ""}`}>
          <IconAlertCircle size={15} />
          <span>
            <strong>{conflicts.length} conflict{conflicts.length !== 1 ? "s" : ""} detected</strong>
            {" — "}
            {errorConflicts.length > 0 && `${errorConflicts.length} error${errorConflicts.length !== 1 ? "s" : ""}, `}
            {warnConflicts.length > 0 && `${warnConflicts.length} warning${warnConflicts.length !== 1 ? "s" : ""}`}
          </span>
          <button type="button" className="dash-alert-link" onClick={() => setShowConflicts((v) => !v)}>
            {showConflicts ? "Hide" : "View"} <IconArrowRight size={13} />
          </button>
        </div>
      )}

      {/* Conflict list */}
      {showConflicts && conflicts.length > 0 && (
        <div className="dash-panel" style={{ marginBottom: 14 }}>
          <div className="dash-panel-header">
            <span className="dash-panel-title">Conflicts</span>
            <span className="dash-panel-meta">{conflicts.length} total</span>
          </div>
          <div className="dash-panel-body" style={{ padding: "10px 18px" }}>
            {conflicts.map((c, i) => (
              <div key={i} className={`ipam-conflict-row ipam-conflict-row--${c.severity}`}>
                <span className="ipam-conflict-icon">{c.severity === "error" ? "●" : "◆"}</span>
                <span className="ipam-conflict-desc">{c.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* VLAN import picker */}
      {showVlanImport && (
        <div className="dash-panel" style={{ marginBottom: 14 }}>
          <div className="dash-panel-header">
            <span className="dash-panel-title">Import subnets from VLANs</span>
            <button type="button" className="dash-panel-link" onClick={() => { setShowVlanImport(false); setVlanMsg(null); }}>
              <X size={14} />
            </button>
          </div>
          <div className="dash-panel-body" style={{ padding: "12px 18px" }}>
            {vlanSuggestions.length === 0 ? (
              <p className="dash-empty">No VLANs with an IP range configured. Set an IP range on a VLAN in the topology settings.</p>
            ) : (
              <>
                <table className="mon-table" style={{ marginBottom: 10 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }} />
                      <th>VLAN name</th>
                      <th>VLAN ID</th>
                      <th>IP range</th>
                      <th>Gateway</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vlanSuggestions.map((v) => (
                      <tr key={v.id} className="mon-row" style={{ opacity: v.already_imported ? 0.5 : 1 }}>
                        <td>
                          <input
                            type="checkbox"
                            checked={vlanSelected.has(v.id)}
                            disabled={v.already_imported}
                            onChange={() => toggleVlan(v.id)}
                          />
                        </td>
                        <td><span className="mon-device-name">{v.display_name || v.name}</span></td>
                        <td className="mon-cell-mono">{v.vlan_id ?? "—"}</td>
                        <td><code className="ipam-cidr">{v.ip_range}</code></td>
                        <td className="mon-cell-mono">{v.gateway ?? "—"}</td>
                        <td>
                          {v.already_imported
                            ? <span className="dash-status-pill dash-status-pill--unknown">Already imported</span>
                            : <span className="dash-status-pill dash-status-pill--online">Available</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {vlanMsg && <p style={{ fontSize: 13, marginBottom: 8, color: "var(--dash-green)" }}>{vlanMsg}</p>}
                <button
                  type="button"
                  className="ipam-btn ipam-btn--primary"
                  disabled={vlanSelected.size === 0 || vlanBusy}
                  onClick={() => void doVlanImport()}
                >
                  {vlanBusy ? "Importing…" : `Import ${vlanSelected.size > 0 ? vlanSelected.size : ""} selected`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Subnet form */}
      {(showSubnetForm || editingSubnet) && (
        <div className="dash-panel" style={{ marginBottom: 14 }}>
          <div className="dash-panel-header">
            <span className="dash-panel-title">{editingSubnet ? "Edit subnet" : "Add subnet"}</span>
          </div>
          <div className="dash-panel-body" style={{ padding: "14px 18px" }}>
            <SubnetForm
              initial={editingSubnet ?? undefined}
              onSave={(p) => void saveSubnet(p)}
              onCancel={() => { setShowSubnetForm(false); setEditingSubnet(null); setFormError(null); }}
              busy={formBusy}
              error={formError}
            />
          </div>
        </div>
      )}

      {/* Subnet list — always full width */}
      <div className="mon-content">
        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Subnets ({subnets.length})</span>
            {canWrite && !showSubnetForm && !editingSubnet && (
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" className="ipam-btn" onClick={() => void openVlanImport()}>
                  Import from VLANs
                </button>
                <button type="button" className="ipam-btn ipam-btn--primary" onClick={() => setShowSubnetForm(true)}>
                  + Add subnet
                </button>
              </span>
            )}
          </div>
          <div className="dash-panel-body">
            {subnets.length === 0 ? (
              <p className="dash-empty">No subnets defined yet. Add one to start tracking utilization.</p>
            ) : (
              <table className="mon-table">
                <thead>
                  <tr>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "name" ? " active" : ""}`} onClick={() => toggleIpamSort("name")}>Name{ipamSortKey === "name" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "cidr" ? " active" : ""}`} onClick={() => toggleIpamSort("cidr")}>CIDR{ipamSortKey === "cidr" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "util" ? " active" : ""}`} onClick={() => toggleIpamSort("util")}>Utilization{ipamSortKey === "util" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "devices" ? " active" : ""}`} onClick={() => toggleIpamSort("devices")}>Devices{ipamSortKey === "devices" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "dhcp" ? " active" : ""}`} onClick={() => toggleIpamSort("dhcp")}>DHCP{ipamSortKey === "dhcp" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "free" ? " active" : ""}`} onClick={() => toggleIpamSort("free")}>Free{ipamSortKey === "free" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "gateway" ? " active" : ""}`} onClick={() => toggleIpamSort("gateway")}>Gateway{ipamSortKey === "gateway" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    {canWrite && <th />}
                  </tr>
                </thead>
                <tbody>
                  {sortedSubnets.map((s) => (
                    <tr
                      key={s.id}
                      className={`mon-row ipam-subnet-row${selectedSubnet?.id === s.id ? " mon-row--active" : ""}`}
                      onClick={() => { setSelectedSubnet(s); setAddrFilter("all"); }}
                    >
                      <td>
                        <span className="mon-device-name">{s.name}</span>
                        {s.vlan_id && <span className="mon-device-ip">VLAN {s.vlan_id}</span>}
                      </td>
                      <td><code className="ipam-cidr">{s.cidr}</code></td>
                      <td>
                        <div className="ipam-util-wrap">
                          <UtilizationBar value={s.utilization} size="thin" />
                          <span className="ipam-util-pct">{Math.round(s.utilization * 100)}%</span>
                        </div>
                      </td>
                      <td className="mon-cell-mono">{s.device_count}</td>
                      <td className="mon-cell-mono">{s.dhcp_count}</td>
                      <td className="mon-cell-mono">{s.free}</td>
                      <td className="mon-cell-mono">{s.gateway ?? "—"}</td>
                      {canWrite && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <span className="ipam-row-actions">
                            <button type="button" className="dash-panel-link" onClick={() => { setEditingSubnet(s); setShowSubnetForm(false); }}>Edit</button>
                            <button type="button" className="dash-panel-link ipam-delete-btn" onClick={() => void deleteSubnet(s)}>Delete</button>
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Subnet detail modal */}
      {selectedSubnet && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setSelectedSubnet(null); }}>
          <div className="modal ipam-detail-modal">

            {/* Modal header */}
            <div className="modal-header ipam-modal-header">
              <div className="ipam-modal-title-wrap">
                <span className="ipam-modal-name">{selectedSubnet.name}</span>
                <code className="ipam-cidr ipam-modal-cidr">{selectedSubnet.cidr}</code>
                {selectedSubnet.vlan_id && <span className="mon-device-ip">VLAN {selectedSubnet.vlan_id}</span>}
              </div>
              <button type="button" className="ipam-modal-close" onClick={() => setSelectedSubnet(null)} aria-label="Close">✕</button>
            </div>

            {/* Stats row */}
            <div className="ipam-modal-stats">
              <div className="ipam-modal-stat">
                <span className="ipam-modal-stat-label">Used</span>
                <strong className="ipam-modal-stat-val">{selectedSubnet.used}<span className="ipam-modal-stat-of"> / {selectedSubnet.total_hosts}</span></strong>
              </div>
              <div className="ipam-modal-stat">
                <span className="ipam-modal-stat-label">Free</span>
                <strong className="ipam-modal-stat-val">{selectedSubnet.free}</strong>
              </div>
              <div className="ipam-modal-stat">
                <span className="ipam-modal-stat-label">Utilization</span>
                <strong className="ipam-modal-stat-val">{Math.round(selectedSubnet.utilization * 100)}%</strong>
              </div>
              {selectedSubnet.gateway && (
                <div className="ipam-modal-stat">
                  <span className="ipam-modal-stat-label">Gateway</span>
                  <strong className="ipam-modal-stat-val ipam-modal-stat-mono">{selectedSubnet.gateway}</strong>
                </div>
              )}
            </div>

            {/* Utilization bar */}
            <div className="ipam-modal-util">
              <UtilizationBar value={selectedSubnet.utilization} />
            </div>

            {/* Filter tabs */}
            <div className="ipam-addr-tabs">
              {(["all", "device", "dhcp", "free"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`ipam-addr-tab${addrFilter === f ? " active" : ""}`}
                  onClick={() => setAddrFilter(f)}
                >
                  {f === "all" ? "All addresses" : f === "device" ? `Devices (${addresses.filter(a => a.kind === "device").length})` : f === "dhcp" ? `DHCP (${addresses.filter(a => a.kind === "dhcp").length})` : `Free (${addresses.filter(a => a.kind === "free").length})`}
                </button>
              ))}
            </div>

            {/* Address content */}
            <div className="ipam-modal-body">
              {addressesLoading ? (
                <p className="dash-empty">Loading addresses…</p>
              ) : addresses.length === 0 ? (
                <p className="dash-empty">Subnet too large to enumerate individual IPs (max 1024 hosts).</p>
              ) : addrFilter === "all" && addresses.length <= 256 ? (
                <>
                  <IpGrid entries={addresses} />
                  <div className="ipam-grid-legend">
                    {[["device","#2dba7c","Device"], ["dhcp","#3b80d0","DHCP"], ["gateway","#f59e0b","Gateway"], ["free","#e8edf3","Free"], ["network","#94a3b8","Net/Bcast"]].map(([k, c, l]) => (
                      <span key={k} className="ipam-legend-item"><span className="ipam-legend-dot" style={{ background: c }} />{l}</span>
                    ))}
                  </div>
                </>
              ) : (
                <table className="mon-table">
                  <thead>
                    <tr><th>IP Address</th><th>Status</th><th>Label</th></tr>
                  </thead>
                  <tbody>
                    {filteredAddresses.filter((a) => a.kind !== "network" && a.kind !== "broadcast").map((a) => (
                      <tr key={a.ip} className="mon-row">
                        <td><code className="ipam-cidr">{a.ip}</code></td>
                        <td><span className={`ipam-kind-badge ipam-kind-badge--${a.kind}`}>{a.kind}</span></td>
                        <td className="mon-device-name">{a.label ?? <span className="dash-panel-meta">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

          </div>
        </div>
      )}

      {/* DHCP leases panel */}
      <div className="dash-panel">
        <div className="dash-panel-header">
          <span className="dash-panel-title">DHCP leases ({dhcpLeases.length})</span>
          <span className="dash-panel-meta">paste lease file to import</span>
          <button type="button" className="dash-panel-link" onClick={() => setShowDhcp((v) => !v)} style={{ marginLeft: 12 }}>
            {showDhcp ? "Hide importer" : "Import leases"}
          </button>
          {canWrite && dhcpLeases.length > 0 && (
            <button type="button" className="dash-panel-link ipam-delete-btn" onClick={() => void clearDhcp()} style={{ marginLeft: 8 }}>
              Clear all
            </button>
          )}
        </div>

        {showDhcp && (
          <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(209,220,230,0.6)" }}>
            <form onSubmit={(e) => void importDhcp(e)}>
              <textarea
                className="ipam-lease-textarea"
                rows={8}
                placeholder={"Paste ISC dhcpd.leases or dnsmasq.leases content here…\n\nISC example:\nlease 192.168.1.50 {\n  starts 1 2026/01/01 08:00:00;\n  ends 1 2026/01/01 20:00:00;\n  binding state active;\n  hardware ethernet aa:bb:cc:dd:ee:ff;\n  client-hostname \"mypc\";\n}"}
                value={dhcpText}
                onChange={(e) => setDhcpText(e.target.value)}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                <button type="submit" disabled={dhcpBusy || !dhcpText.trim()}>
                  {dhcpBusy ? "Importing…" : "Import"}
                </button>
                {dhcpMsg && <span className="dash-panel-meta">{dhcpMsg}</span>}
              </div>
            </form>
          </div>
        )}

        <div className="dash-panel-body" style={{ maxHeight: 280 }}>
          {dhcpLeases.length === 0 ? (
            <p className="dash-empty">No DHCP leases imported yet.</p>
          ) : (
            <table className="mon-table">
              <thead>
                <tr><th>IP Address</th><th>MAC</th><th>Hostname</th><th>Expires</th><th>Active</th></tr>
              </thead>
              <tbody>
                {dhcpLeases.map((l) => (
                  <tr key={l.id} className="mon-row">
                    <td><code className="ipam-cidr">{l.ip_address}</code></td>
                    <td className="mon-cell-mono">{l.mac_address ?? "—"}</td>
                    <td>{l.hostname ?? <span className="dash-panel-meta">—</span>}</td>
                    <td className="mon-cell-mono">{fmtExpiry(l.expires_at)}</td>
                    <td><MonStatusDot status={l.is_active ? "online" : "offline"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

    </section>
  );
}

// ── Monitoring ────────────────────────────────────────────────────────────────

function MonStatusDot({ status }: { status: string }) {
  return <span className={`mon-dot mon-dot-${status}`} title={status} />;
}

function UptimeBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="dash-panel-meta">—</span>;
  const pct = Math.round(value * 100);
  const cls = pct >= 99 ? "good" : pct >= 90 ? "warn" : "bad";
  return <span className={`mon-uptime mon-uptime-${cls}`}>{pct}%</span>;
}

function TrendBadge({ trend, pct }: { trend: string; pct: number | null }) {
  if (trend === "insufficient_data") return <span className="dash-panel-meta">Not enough data</span>;
  const arrow = trend === "rising" ? "↑" : trend === "falling" ? "↓" : "→";
  const cls = trend === "rising" ? "mon-trend--rising" : trend === "falling" ? "mon-trend--falling" : "mon-trend--stable";
  return (
    <span className={`mon-trend ${cls}`}>
      {arrow} {trend.charAt(0).toUpperCase() + trend.slice(1)}
      {pct !== null && <span className="mon-trend-pct"> ({pct > 0 ? "+" : ""}{pct.toFixed(1)}%)</span>}
    </span>
  );
}

function AnomalyBadge({ level, score }: { level: string; score: number | null }) {
  if (level === "insufficient_data") return <span className="dash-panel-meta">Not enough data</span>;
  const cls = level === "anomalous" ? "mon-anomaly--anomalous" : level === "elevated" ? "mon-anomaly--elevated" : "mon-anomaly--normal";
  const label = level.charAt(0).toUpperCase() + level.slice(1);
  return (
    <span className={`mon-anomaly ${cls}`}>
      {label}
      {score !== null && <span className="mon-anomaly-score"> (z={score.toFixed(1)})</span>}
    </span>
  );
}

function RttSparkline({ data }: { data: MonitorHistoryPoint[] }) {
  const valid = data.filter((d) => d.rtt_ms !== null);
  if (valid.length < 2) {
    return <p className="dash-empty" style={{ margin: "12px 0 0" }}>Not enough data yet.</p>;
  }
  const rtts = valid.map((d) => d.rtt_ms as number);
  const min = Math.min(...rtts);
  const max = Math.max(...rtts);
  const range = max - min || 1;
  const H = 56;
  const W = 100; // viewBox units — scales with container
  const step = W / (valid.length - 1);
  const points = valid
    .map((d, i) => `${i * step},${H - ((( d.rtt_ms as number) - min) / range) * (H - 6) - 3}`)
    .join(" ");
  const area = `${points} ${W},${H} 0,${H}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mon-sparkline" aria-label="RTT trend">
      <polygon points={area} fill="rgba(29,154,176,0.10)" />
      <polyline points={points} fill="none" stroke="#1d9ab0" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function MonStat({
  label, value, sub, icon, accent,
}: {
  label: string; value: string; sub: string;
  icon: React.ReactNode;
  accent: "teal" | "green" | "red" | "purple" | "blue" | "indigo";
}) {
  return (
    <div className={`dash-stat dash-stat--${accent}`}>
      <div className="dash-stat-icon">{icon}</div>
      <div className="dash-stat-body">
        <strong className="dash-stat-value mon-stat-value">{value}</strong>
        <span className="dash-stat-label">{label}</span>
        <span className="dash-stat-sub">{sub}</span>
      </div>
    </div>
  );
}

const BEAT_COLOR: Record<string, string> = {
  online: "#2dba7c",
  offline: "#e05050",
  unknown: "#7a8fa0",
};
function beatBg(status: string) { return BEAT_COLOR[status] ?? BEAT_COLOR.unknown; }

function HeartbeatBar({ beats, size = "sm" }: { beats: string[]; size?: "sm" | "lg" }) {
  if (beats.length === 0) return null;
  // Newest beat is always last in the array (oldest→newest); CSS right-anchors the bar
  const displayBeats = size === "sm" ? beats.slice(-30) : beats;
  return (
    <div className={`heartbeat-bar heartbeat-bar--${size}`}>
      {displayBeats.map((status, i) => (
        <span key={i} className="heartbeat-beat" style={{ background: beatBg(status) }} title={status} />
      ))}
    </div>
  );
}

function HeartbeatTooltip({ point, x, y }: { point: MonitorHistoryPoint; x: number; y: number }) {
  const d = new Date(point.checked_at);
  const dateStr = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const W = 230; const H = 160;
  const left = x + 16 + W > vw ? x - W - 8 : x + 16;
  const top  = y + 16 + H > vh ? y - H - 8 : y + 16;
  const statusColors: Record<string, string> = { online: "#2dba7c", offline: "#e05050", unknown: "#94a3b8" };

  return (
    <div className="hb-tooltip-card" style={{ left, top }}>
      <div className="hb-tooltip-header">
        <span className="hb-tooltip-date">{dateStr}</span>
        <span className="hb-tooltip-time">{timeStr}</span>
      </div>
      <div className="hb-tooltip-status-row">
        <span className={`mon-dot mon-dot-${point.status}`} />
        <span className="hb-tooltip-status-text" style={{ color: statusColors[point.status] ?? "#94a3b8" }}>
          {point.status.charAt(0).toUpperCase() + point.status.slice(1)}
        </span>
        {point.rtt_ms !== null && (
          <span className="hb-tooltip-rtt">{point.rtt_ms.toFixed(1)} ms</span>
        )}
      </div>
      {point.port_results.length > 0 && (
        <div className="hb-tooltip-ports">
          {point.port_results.map((r) => (
            <span key={r.port} className={`mon-port-badge mon-port-badge--${r.open ? "open" : "closed"}`}>
              {r.label}:{r.port}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Maximum beats rendered in the bar — keeps the bar a fixed visual size regardless of range.
// Stats (uptime %, incident log) always use the full history.
const HB_MAX_BEATS = 120;

function sampleHistory(full: MonitorHistoryPoint[]): MonitorHistoryPoint[] {
  if (full.length <= HB_MAX_BEATS) return full;
  // Evenly sample, always including the newest (last) point
  return Array.from({ length: HB_MAX_BEATS }, (_, i) =>
    full[Math.round(i * (full.length - 1) / (HB_MAX_BEATS - 1))],
  );
}

function HeartbeatTimeline({ history, hours }: { history: MonitorHistoryPoint[]; hours: number }) {
  const [hovered, setHovered] = useState<MonitorHistoryPoint | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  if (history.length === 0) return <p className="dash-empty">No poll data yet.</p>;

  const multiDay = hours > 24;
  const beats = sampleHistory(history);

  // Full-history stats so uptime % reflects the entire selected range
  const onlineCount = history.filter((h) => h.status === "online").length;
  const uptimePct = Math.round((onlineCount / history.length) * 100);

  // 5 axis labels spread across the sampled beats (oldest left → newest right)
  const axisCount = Math.min(5, beats.length);
  const axisIndices = Array.from({ length: axisCount }, (_, i) =>
    Math.round((i / Math.max(axisCount - 1, 1)) * (beats.length - 1)),
  );

  function fmtAxis(iso: string) {
    const d = new Date(iso);
    if (multiDay) {
      return d.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" })
        + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div
      className="heartbeat-timeline"
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setHovered(null)}
    >
      <div className="heartbeat-bar heartbeat-bar--lg">
        {beats.map((h) => (
          <span
            key={h.id}
            className="heartbeat-beat heartbeat-beat--clickable"
            style={{ background: beatBg(h.status) }}
            onMouseEnter={() => setHovered(h)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>

      {/* Time axis — oldest left, newest right */}
      <div
        className="heartbeat-time-axis"
        style={{ gridTemplateColumns: `repeat(${axisCount}, 1fr)` }}
      >
        {axisIndices.map((idx, pos_) => (
          <span
            key={idx}
            className="heartbeat-time-label"
            style={{ textAlign: pos_ === 0 ? "left" : pos_ === axisCount - 1 ? "right" : "center" }}
          >
            {fmtAxis(beats[idx].checked_at)}
          </span>
        ))}
      </div>

      {/* Summary row */}
      <div className="heartbeat-summary">
        <span className="dash-panel-meta">{history.length} polls</span>
        <span className="dash-panel-meta">·</span>
        <span className="dash-panel-meta">{uptimePct}% uptime in range</span>
        <span className="dash-panel-meta">·</span>
        <div className="heartbeat-legend" style={{ margin: 0 }}>
          <span className="heartbeat-legend-item"><span className="heartbeat-beat heartbeat-beat--online" /> Online</span>
          <span className="heartbeat-legend-item"><span className="heartbeat-beat heartbeat-beat--offline" /> Offline</span>
          <span className="heartbeat-legend-item"><span className="heartbeat-beat heartbeat-beat--unknown" /> Unknown</span>
        </div>
      </div>

      {hovered && <HeartbeatTooltip point={hovered} x={pos.x} y={pos.y} />}
    </div>
  );
}

interface Incident {
  start: string;
  end: string | null;
  durationMin: number | null;
}

function computeIncidents(history: MonitorHistoryPoint[]): Incident[] {
  const incidents: Incident[] = [];
  let incidentStart: string | null = null;
  for (const h of history) {
    const isDown = h.status === "offline";
    if (isDown && incidentStart === null) {
      incidentStart = h.checked_at;
    } else if (!isDown && incidentStart !== null) {
      const durationMin = Math.round((new Date(h.checked_at).getTime() - new Date(incidentStart).getTime()) / 60_000);
      incidents.push({ start: incidentStart, end: h.checked_at, durationMin });
      incidentStart = null;
    }
  }
  if (incidentStart !== null) incidents.push({ start: incidentStart, end: null, durationMin: null });
  return incidents.reverse();
}

function MonitoringWorkspace({
  accessToken,
  userRole,
}: {
  accessToken: string;
  canWrite: boolean;
  userRole: string;
}) {
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [devices, setDevices] = useState<DeviceMonitorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [history, setHistory] = useState<MonitorHistoryPoint[]>([]);
  const [historyHours, setHistoryHours] = useState(24);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [portTargets, setPortTargets] = useState<PortTarget[]>([]);
  const [showPortForm, setShowPortForm] = useState(false);
  const [portFormPort, setPortFormPort] = useState("");
  const [portFormLabel, setPortFormLabel] = useState("");
  const [portBusy, setPortBusy] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sortKey, setSortKey] = useState<"name" | "uptime24" | "uptime7" | "rtt" | "checked">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [deviceAlertEvents, setDeviceAlertEvents] = useState<AlertEvent[]>([]);
  const [allAlertRules, setAllAlertRules] = useState<AlertRule[]>([]);
  const [analysis, setAnalysis] = useState<DeviceAnalysis | null>(null);
  const [filterGroup, setFilterGroup] = useState("all");
  const [filterSite, setFilterSite] = useState("all");

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const [f, d, p] = await Promise.all([
        api.getMonitoringSummary(accessToken),
        api.listMonitoringDevices(accessToken),
        api.listPortTargets(accessToken),
      ]);
      setFleet(f);
      setDevices(d);
      setPortTargets(p);
      setError(null);
    } catch {
      setError("Failed to load monitoring data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const loadHistory = useCallback(async (deviceId: number, hours: number) => {
    setHistoryLoading(true);
    try {
      setHistory(await api.getDeviceHistory(accessToken, deviceId, hours));
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (selectedId !== null) void loadHistory(selectedId, historyHours);
  }, [selectedId, historyHours, loadHistory]);

  // Keep the heartbeat timeline live — refresh history at the same cadence as the monitor
  useEffect(() => {
    if (selectedId === null) return;
    const id = setInterval(() => void loadHistory(selectedId, historyHours), 30_000);
    return () => clearInterval(id);
  }, [selectedId, historyHours, loadHistory]);

  async function toggleFav(deviceId: number) {
    try {
      await api.toggleFavourite(accessToken, deviceId);
      setDevices((prev) => prev.map((d) => d.device_id === deviceId ? { ...d, is_favourite: !d.is_favourite } : d));
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (selectedId === null) { setDeviceAlertEvents([]); setAnalysis(null); return; }
    void api.listAlertEvents(accessToken, selectedId).then(setDeviceAlertEvents).catch(() => setDeviceAlertEvents([]));
    void api.listAlertRules(accessToken).then(setAllAlertRules).catch(() => setAllAlertRules([]));
    void api.getDeviceAnalysis(accessToken, selectedId).then(setAnalysis).catch(() => {
      // Still show the section with insufficient_data rather than hiding it
      setAnalysis({
        device_id: selectedId,
        baseline_rtt_ms: null, rtt_stddev: null, rtt_p50: null, rtt_p95: null,
        current_rtt_ms: null, anomaly_score: null,
        anomaly_level: "insufficient_data",
        trend: "insufficient_data", trend_pct: null,
        flap_count_24h: 0, longest_outage_minutes: null,
      });
    });
  }, [selectedId, accessToken]);

  const selectedDevice = devices.find((d) => d.device_id === selectedId) ?? null;

  const groupOptions = useMemo(
    () => [...new Set(devices.map((d) => d.topology_group).filter(Boolean))].sort() as string[],
    [devices],
  );
  const siteOptions = useMemo(
    () => [...new Map(devices.filter((d) => d.site_id).map((d) => [d.site_id, d.site_name])).entries()]
      .sort(([, a], [, b]) => (a ?? "").localeCompare(b ?? "")),
    [devices],
  );

  const filteredDevices = useMemo(() => {
    const q = searchQ.toLowerCase();
    let filtered = q
      ? devices.filter(
          (d) =>
            (d.display_name ?? "").toLowerCase().includes(q) ||
            (d.hostname ?? "").toLowerCase().includes(q) ||
            d.ip_address.toLowerCase().includes(q),
        )
      : [...devices];

    if (filterGroup !== "all") filtered = filtered.filter((d) => d.topology_group === filterGroup);
    if (filterSite !== "all") filtered = filtered.filter((d) => String(d.site_id) === filterSite);

    const dir = sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      switch (sortKey) {
        case "name": {
          const na = (a.display_name ?? a.hostname ?? a.ip_address).toLowerCase();
          const nb = (b.display_name ?? b.hostname ?? b.ip_address).toLowerCase();
          return na.localeCompare(nb) * dir;
        }
        case "uptime24":
          return ((a.uptime_24h ?? -1) - (b.uptime_24h ?? -1)) * dir;
        case "uptime7":
          return ((a.uptime_7d ?? -1) - (b.uptime_7d ?? -1)) * dir;
        case "rtt":
          return ((a.avg_rtt_24h ?? Infinity) - (b.avg_rtt_24h ?? Infinity)) * dir;
        case "checked": {
          const ta = a.last_checked ? new Date(a.last_checked).getTime() : 0;
          const tb = b.last_checked ? new Date(b.last_checked).getTime() : 0;
          return (ta - tb) * dir;
        }
        default: return 0;
      }
    });
    return filtered;
  }, [devices, searchQ, filterGroup, filterSite, sortKey, sortDir]);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const offlineDevices = useMemo(() => devices.filter((d) => d.status === "offline"), [devices]);

  async function addPortTarget(e: FormEvent) {
    e.preventDefault();
    const port = parseInt(portFormPort, 10);
    if (!port || port < 1 || port > 65535) { setPortError("Invalid port"); return; }
    if (!portFormLabel.trim()) { setPortError("Label required"); return; }
    setPortBusy(true);
    setPortError(null);
    try {
      await api.createPortTarget(accessToken, { device_id: null, port, label: portFormLabel.trim() });
      setPortFormPort(""); setPortFormLabel(""); setShowPortForm(false);
      setPortTargets(await api.listPortTargets(accessToken));
    } catch {
      setPortError("Failed to add port target");
    } finally {
      setPortBusy(false);
    }
  }

  async function removePortTarget(id: number) {
    try {
      await api.deletePortTarget(accessToken, id);
      setPortTargets((prev) => prev.filter((p) => p.id !== id));
    } catch { /* ignore */ }
  }

  function fmtTime(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function fmtRtt(ms: number | null) {
    return ms !== null ? `${ms.toFixed(1)} ms` : "—";
  }

  function fmtDateTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function fmtDuration(minutes: number) {
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }

  if (loading) return <div className="dash-layout"><p className="dash-empty">Loading monitoring data…</p></div>;
  if (error) return <div className="dash-layout"><p className="dash-empty" style={{ color: "var(--dash-red)" }}>{error}</p></div>;

  const canManagePorts = userRole === "SuperAdmin" || userRole === "NetworkAdmin";
  const globalPortTargets = portTargets.filter((p) => p.device_id === null);

  return (
    <section className="dash-layout">

      {/* Page header */}
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Monitoring</h1>
          <p className="dash-subtitle">Network device uptime, latency and service health</p>
        </div>
        <div className="dash-header-meta">
          <button
            type="button"
            className="dash-panel-link"
            onClick={() => void load(true)}
            disabled={refreshing}
            title="Refresh now"
            style={{ display: "flex", alignItems: "center", gap: 5 }}
          >
            <RefreshCw size={13} style={{ opacity: refreshing ? 0.4 : 1 }} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {fleet?.last_checked && (
            <span>· Last poll {fmtTime(fleet.last_checked)}</span>
          )}
        </div>
      </div>

      {/* Stat cards — same pattern as Overview */}
      <div className="dash-stats">
        <DashStat
          label="Monitored"
          value={fleet?.total ?? 0}
          sub={fleet?.total === 0 ? "no active devices" : "active devices"}
          icon={<IconServer size={20} />}
          accent="teal"
        />
        <DashStat
          label="Online"
          value={fleet?.online ?? 0}
          sub="reachable"
          icon={<IconWifi size={20} />}
          accent="green"
        />
        <DashStat
          label="Offline"
          value={fleet?.offline ?? 0}
          sub={(fleet?.offline ?? 0) > 0 ? "need attention" : "all clear"}
          icon={<IconWifiOff size={20} />}
          accent={(fleet?.offline ?? 0) > 0 ? "red" : "green"}
        />
        <DashStat
          label="Unknown"
          value={fleet?.unknown ?? 0}
          sub="no poll data"
          icon={<IconAlertCircle size={20} />}
          accent="purple"
        />
        <MonStat
          label="Avg RTT"
          value={fleet?.avg_rtt_ms != null ? `${fleet.avg_rtt_ms.toFixed(1)} ms` : "—"}
          sub="online devices"
          icon={<Activity size={20} />}
          accent="blue"
        />
        <MonStat
          label="Last poll"
          value={fleet?.last_checked ? fmtTime(fleet.last_checked) : "Never"}
          sub="auto-polls every 5 min"
          icon={<IconClock size={20} />}
          accent="indigo"
        />
      </div>

      {/* Offline alert */}
      {offlineDevices.length > 0 && (
        <div className="dash-alert">
          <IconAlertCircle size={15} />
          <span>
            <strong>{offlineDevices.length} device{offlineDevices.length !== 1 ? "s" : ""} offline</strong>
            {" — "}
            {offlineDevices.slice(0, 4).map((d) => d.display_name ?? d.hostname ?? d.ip_address).join(", ")}
            {offlineDevices.length > 4 && ` and ${offlineDevices.length - 4} more`}
          </span>
        </div>
      )}

      {/* Device list */}
      <div className="mon-content">
        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">
              Devices
              {filteredDevices.length !== devices.length
                ? ` (${filteredDevices.length} of ${devices.length})`
                : ` (${devices.length})`}
            </span>
            <div className="mon-panel-controls">
              {groupOptions.length > 0 && (
                <select className="toolbar-select" value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>
                  <option value="all">All groups</option>
                  {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              )}
              {siteOptions.length > 0 && (
                <select className="toolbar-select" value={filterSite} onChange={(e) => setFilterSite(e.target.value)}>
                  <option value="all">All sites</option>
                  {siteOptions.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
                </select>
              )}
              <div className="mon-search-wrap">
                <Search size={13} />
                <input
                  className="mon-search"
                  placeholder="Search devices…"
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="dash-panel-body mon-table-body">
            {filteredDevices.length === 0 ? (
              <p className="dash-empty">
                {devices.length === 0
                  ? "No data yet — the monitor polls every 5 minutes."
                  : "No devices match your filter."}
              </p>
            ) : (
              <table className="mon-table">
                <thead>
                  <tr>
                    <th style={{ width: 28 }} />
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "name" ? " active" : ""}`} onClick={() => toggleSort("name")}>
                        Device{sortKey === "name" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "uptime24" ? " active" : ""}`} onClick={() => toggleSort("uptime24")}>
                        24 h{sortKey === "uptime24" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "uptime7" ? " active" : ""}`} onClick={() => toggleSort("uptime7")}>
                        7 d{sortKey === "uptime7" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "rtt" ? " active" : ""}`} onClick={() => toggleSort("rtt")}>
                        Avg RTT{sortKey === "rtt" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                    </th>
                    <th>Ports</th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "checked" ? " active" : ""}`} onClick={() => toggleSort("checked")}>
                        Checked{sortKey === "checked" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                    </th>
                    <th style={{ width: 32 }} title="Favourite" />
                  </tr>
                </thead>
                <tbody>
                  {filteredDevices.map((d) => (
                    <tr
                      key={d.device_id}
                      className={`mon-row${selectedId === d.device_id ? " mon-row--active" : ""}`}
                      onClick={() => setSelectedId(selectedId === d.device_id ? null : d.device_id)}
                    >
                      <td><MonStatusDot status={d.status} /></td>
                      <td>
                        <span className="mon-device-name">{d.display_name ?? d.hostname ?? d.ip_address}</span>
                        <span className="mon-device-ip">{d.ip_address}</span>
                        {d.heartbeat.length > 0 && <HeartbeatBar beats={d.heartbeat} size="sm" />}
                      </td>
                      <td><UptimeBadge value={d.uptime_24h} /></td>
                      <td><UptimeBadge value={d.uptime_7d} /></td>
                      <td className="mon-cell-mono">{fmtRtt(d.avg_rtt_24h)}</td>
                      <td>
                        {d.latest_port_results.length === 0 ? (
                          <span className="dash-panel-meta">—</span>
                        ) : (
                          <span className="mon-port-badges">
                            {d.latest_port_results.map((r) => (
                              <span key={r.port} className={`mon-port-badge mon-port-badge--${r.open ? "open" : "closed"}`} title={`${r.label} :${r.port}`}>{r.label}</span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="mon-cell-mono">{fmtTime(d.last_checked)}</td>
                      <td>
                        <button
                          type="button"
                          className={`fav-btn${d.is_favourite ? " fav-btn--active" : ""}`}
                          title={d.is_favourite ? "Remove from favourites" : "Add to favourites"}
                          onClick={(e) => { e.stopPropagation(); void toggleFav(d.device_id); }}
                        >
                          <Star size={13} fill={d.is_favourite ? "currentColor" : "none"} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>{/* end mon-content */}

      {/* Device drilldown hero modal */}
      {selectedDevice && (
        <div
          className="mon-hero-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}
        >
          <div className="mon-hero">

            {/* Header */}
            <div className={`mon-hero-header mon-hero-header--${selectedDevice.status}`}>
              <div className="mon-hero-header-left">
                <MonStatusDot status={selectedDevice.status} />
                <div>
                  <div className="mon-hero-name">
                    {selectedDevice.display_name ?? selectedDevice.hostname ?? selectedDevice.ip_address}
                  </div>
                  <div className="mon-hero-sub">
                    {selectedDevice.hostname && selectedDevice.hostname !== selectedDevice.ip_address && (
                      <span>{selectedDevice.hostname} · </span>
                    )}
                    <span className="mon-cell-mono">{selectedDevice.ip_address}</span>
                  </div>
                </div>
              </div>
              <button type="button" className="mon-hero-close" onClick={() => setSelectedId(null)} title="Close">✕</button>
            </div>

            {/* Stat strip */}
            <div className="mon-hero-stats">
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">24 h uptime</span>
                <UptimeBadge value={selectedDevice.uptime_24h} />
              </div>
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">7 d uptime</span>
                <UptimeBadge value={selectedDevice.uptime_7d} />
              </div>
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">Avg RTT (24 h)</span>
                <strong className="mon-hero-stat-val">{fmtRtt(selectedDevice.avg_rtt_24h)}</strong>
              </div>
              {analysis?.current_rtt_ms != null && (
                <div className="mon-hero-stat">
                  <span className="mon-hero-stat-label">Current RTT</span>
                  <strong className="mon-hero-stat-val">{fmtRtt(analysis.current_rtt_ms)}</strong>
                </div>
              )}
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">Last checked</span>
                <strong className="mon-hero-stat-val">{fmtTime(selectedDevice.last_checked)}</strong>
              </div>
            </div>

            {/* Body — 2-col layout */}
            <div className="mon-hero-body">
              <div className="mon-hero-cols">

                {/* Left column: analysis, ports, alerts */}
                <div className="mon-hero-col">

                  {analysis && (
                    <div className="mon-hero-section">
                      <div className="mon-hero-section-title">
                        Analysis
                        <span className="dash-panel-meta">7-day baseline</span>
                      </div>
                      <div className="mon-analysis-body">
                        <div className="mon-analysis-row">
                          <span className="dash-panel-meta">Trend</span>
                          <TrendBadge trend={analysis.trend} pct={analysis.trend_pct} />
                        </div>
                        <div className="mon-analysis-row">
                          <span className="dash-panel-meta">Anomaly</span>
                          <AnomalyBadge level={analysis.anomaly_level} score={analysis.anomaly_score} />
                        </div>
                        {analysis.baseline_rtt_ms !== null && (
                          <div className="mon-analysis-row">
                            <span className="dash-panel-meta">Baseline RTT</span>
                            <span className="mon-analysis-val">
                              {analysis.baseline_rtt_ms.toFixed(1)} ms
                              {analysis.rtt_stddev !== null && (
                                <span className="dash-panel-meta"> ±{analysis.rtt_stddev.toFixed(1)}</span>
                              )}
                            </span>
                          </div>
                        )}
                        {analysis.rtt_p50 !== null && (
                          <div className="mon-analysis-row">
                            <span className="dash-panel-meta">p50 / p95</span>
                            <span className="mon-analysis-val">
                              {analysis.rtt_p50.toFixed(1)} ms
                              <span className="dash-panel-meta"> / </span>
                              {analysis.rtt_p95 !== null ? `${analysis.rtt_p95.toFixed(1)} ms` : "—"}
                            </span>
                          </div>
                        )}
                        <div className="mon-analysis-row">
                          <span className="dash-panel-meta">Flaps (24 h)</span>
                          <span className={`mon-analysis-val${analysis.flap_count_24h >= 4 ? " mon-analysis-val--warn" : ""}`}>
                            {analysis.flap_count_24h}
                          </span>
                        </div>
                        {analysis.longest_outage_minutes !== null && (
                          <div className="mon-analysis-row">
                            <span className="dash-panel-meta">Longest outage (7 d)</span>
                            <span className="mon-analysis-val">{fmtDuration(analysis.longest_outage_minutes)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {selectedDevice.latest_port_results.length > 0 && (
                    <div className="mon-hero-section">
                      <div className="mon-hero-section-title">
                        Port status
                        <span className="dash-panel-meta">latest check</span>
                      </div>
                      <div className="mon-port-rows">
                        {selectedDevice.latest_port_results.map((r) => (
                          <div key={r.port} className="mon-port-row">
                            <span className={`mon-dot mon-dot-${r.open ? "online" : "offline"}`} />
                            <span className="mon-port-label">{r.label}</span>
                            <span className="dash-panel-meta">:{r.port}</span>
                            <span className={`mon-port-status mon-port-status--${r.open ? "open" : "closed"}`}>
                              {r.open ? "Open" : "Closed"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(() => {
                    const relevantRules = allAlertRules.filter(
                      (r) => r.device_id === null || r.device_id === selectedDevice.device_id,
                    );
                    return (
                      <div className="mon-hero-section">
                        <div className="mon-hero-section-title">
                          Alert rules
                          <span className="dash-panel-meta">
                            {relevantRules.length === 0 ? "none configured" : `${relevantRules.length} active`}
                          </span>
                        </div>
                        <div className="incident-log">
                          {relevantRules.length === 0 ? (
                            <p className="dash-empty" style={{ margin: 0, padding: "8px 0" }}>
                              No alert rules cover this device.
                              {(userRole === "SuperAdmin" || userRole === "NetworkAdmin") && (
                                <> Configure them in <strong>Admin → Alerts</strong>.</>
                              )}
                            </p>
                          ) : (
                            relevantRules.map((rule) => (
                              <div key={rule.id} className="incident-row" style={{ alignItems: "flex-start" }}>
                                <span className={`mon-dot ${rule.enabled ? "mon-dot-online" : "mon-dot-unknown"}`} style={{ marginTop: 3 }} />
                                <div className="incident-row-body" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                                  <span style={{ fontWeight: 600, fontSize: 12.5, color: "inherit" }}>{rule.name}</span>
                                  <span className="dash-panel-meta" style={{ fontSize: 11 }}>
                                    {rule.event_type.replace(/_/g, " ")}
                                    {rule.device_id === null ? " · all devices" : " · this device"}
                                    {" · "}{rule.channels.join(", ") || "no channels"}
                                  </span>
                                </div>
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                                  {rule.last_triggered_at && (
                                    <span className="dash-panel-meta" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                                      last fired {fmtDateTime(rule.last_triggered_at)}
                                    </span>
                                  )}
                                  <span className={`incident-badge${rule.enabled ? "" : " incident-badge--active"}`} style={{ margin: 0 }}>
                                    {rule.enabled ? "enabled" : "disabled"}
                                  </span>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Right column: heartbeat, incident log, RTT chart */}
                <div className="mon-hero-col">

                  <div className="mon-hero-section">
                    <div className="mon-hero-section-title">
                      Heartbeat
                      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="dash-panel-meta">hover to inspect</span>
                        <select
                          className="mon-hours-select"
                          value={historyHours}
                          onChange={(e) => setHistoryHours(Number(e.target.value))}
                        >
                          <option value={6}>Last 6 h</option>
                          <option value={24}>Last 24 h</option>
                          <option value={72}>Last 3 days</option>
                          <option value={168}>Last 7 days</option>
                        </select>
                      </span>
                    </div>
                    <div className="mon-heartbeat-body">
                      {historyLoading
                        ? <p className="dash-empty">Loading…</p>
                        : <HeartbeatTimeline history={history} hours={historyHours} />
                      }
                    </div>
                  </div>

                  {history.length > 0 && (() => {
                    const incidents = computeIncidents(history);
                    if (incidents.length === 0) return null;
                    return (
                      <div className="mon-hero-section">
                        <div className="mon-hero-section-title">
                          Incident log
                          <span className="dash-panel-meta">{incidents.length} incident{incidents.length !== 1 ? "s" : ""}</span>
                        </div>
                        <div className="incident-log">
                          {incidents.map((inc, i) => {
                            const startTs = new Date(inc.start).getTime();
                            const endTs = inc.end ? new Date(inc.end).getTime() : Date.now();
                            const firedEvents = deviceAlertEvents.filter((ev) => {
                              const t = new Date(ev.fired_at).getTime();
                              return t >= startTs - 5 * 60_000 && t <= endTs + 5 * 60_000;
                            });
                            return (
                              <div key={i} className={`incident-row${inc.end === null ? " incident-row--active" : ""}`}>
                                <span className={`mon-dot mon-dot-${inc.end === null ? "offline" : "unknown"}`} />
                                <div className="incident-row-body">
                                  <span className="incident-time">{fmtDateTime(inc.start)}</span>
                                  <span className="dash-panel-meta">→</span>
                                  <span className="incident-time">{inc.end ? fmtDateTime(inc.end) : "now"}</span>
                                  {firedEvents.length > 0 && (
                                    <span className="incident-alert-tag" title={firedEvents.map((e) => e.alert_rule_name).join(", ")}>
                                      🔔 {firedEvents.length} alert{firedEvents.length !== 1 ? "s" : ""} fired
                                    </span>
                                  )}
                                </div>
                                {inc.end === null ? (
                                  <span className="incident-badge incident-badge--active">Ongoing</span>
                                ) : (
                                  <span className="incident-badge">{fmtDuration(inc.durationMin!)}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="mon-hero-section">
                    <div className="mon-hero-section-title">
                      Response time
                    </div>
                    <div className="mon-chart-body">
                      {historyLoading ? (
                        <p className="dash-empty">Loading…</p>
                      ) : (
                        <>
                          <RttSparkline data={history} />
                          {history.length > 0 && (
                            <p className="dash-panel-meta" style={{ margin: "6px 0 0" }}>
                              {history.length} data points · latest {fmtTime(history[history.length - 1].checked_at)}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                </div>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* Port targets panel */}
      <div className="dash-panel">
        <div className="dash-panel-header">
          <span className="dash-panel-title">Monitored ports</span>
          <span className="dash-panel-meta">checked against all devices on each poll</span>
          {canManagePorts && (
            <button
              type="button"
              className="dash-panel-link"
              onClick={() => setShowPortForm((v) => !v)}
              style={{ marginLeft: 12 }}
            >
              {showPortForm ? "Cancel" : "+ Add port"}
            </button>
          )}
        </div>
        <div className="dash-panel-body" style={{ padding: "14px 18px" }}>
          {showPortForm && (
            <form className="mon-port-form" onSubmit={(e) => void addPortTarget(e)}>
              <input
                className="mon-port-input"
                type="number"
                placeholder="Port (e.g. 3389)"
                value={portFormPort}
                onChange={(e) => setPortFormPort(e.target.value)}
                min={1} max={65535}
              />
              <input
                className="mon-port-input"
                type="text"
                placeholder="Label (e.g. RDP)"
                value={portFormLabel}
                onChange={(e) => setPortFormLabel(e.target.value)}
                maxLength={60}
              />
              <button type="submit" disabled={portBusy}>Add</button>
              {portError && <span className="form-error">{portError}</span>}
            </form>
          )}
          <div className="mon-port-chips">
            {globalPortTargets.length === 0 && !showPortForm && (
              <p className="dash-empty" style={{ margin: 0 }}>No global ports configured.</p>
            )}
            {globalPortTargets.map((p) => (
              <span key={p.id} className="mon-port-chip">
                {p.label}
                <span className="mon-port-chip-port">:{p.port}</span>
                {canManagePorts && (
                  <button
                    type="button"
                    className="mon-port-chip-del"
                    onClick={() => void removePortTarget(p.id)}
                    title={`Remove ${p.label}`}
                  >
                    <X size={11} />
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      </div>

    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import { Activity, Globe, Home, Network, Settings, MapPin, Wrench, Shield, Download, UserCircle } from "lucide-react";
import type { TokenPair } from "../api/client";
import { tokenStorageKey } from "../constants";

export type AppRoute = "/overview" | "/topology" | "/inventory" | "/vlans" | "/locations" | "/monitoring" | "/ipam" | "/tools" | "/security" | "/exports" | "/admin" | "/profile";

export type RouteDefinition = {
  href: AppRoute;
  icon: typeof Network;
  label: string;
  section?: string;
  requiresSecurityRole?: boolean;
  requiresSuperAdmin?: boolean;
};

export const appRoutes: RouteDefinition[] = [
  { href: "/overview",   icon: Home,        label: "Overview",   section: "Network" },
  { href: "/topology",   icon: Globe,       label: "Topology" },
  { href: "/inventory",  icon: Network,     label: "Inventory" },
  { href: "/vlans",      icon: Settings,    label: "VLANs" },
  { href: "/locations",  icon: MapPin,      label: "Locations" },
  { href: "/monitoring", icon: Activity,    label: "Monitoring" },
  { href: "/ipam",       icon: Network,     label: "IPAM" },
  { href: "/tools",      icon: Wrench,      label: "Tools",    section: "Tools" },
  { href: "/security",   icon: Shield,      label: "Security", requiresSecurityRole: true },
  { href: "/exports",    icon: Download,    label: "Exports" },
  { href: "/admin",      icon: Settings,    label: "Admin",    requiresSuperAdmin: true, section: "Account" },
  { href: "/profile",    icon: UserCircle,  label: "Profile" },
];

export const appRouteByHref = new Map<AppRoute, RouteDefinition>(appRoutes.map((route) => [route.href, route]));

export const appRouteCopy: Record<AppRoute, { title: string; subtitle: string }> = {
  "/overview":   { title: "Overview",       subtitle: "Live network health, inventory changes and device activity" },
  "/topology":   { title: "Topology",       subtitle: "Map devices, groups and relationships across your network" },
  "/inventory":  { title: "Inventory",      subtitle: "Search, filter and update discovered network devices" },
  "/vlans":      { title: "Groups & VLANs", subtitle: "Topology groups and VLANs visible in your network map" },
  "/locations":  { title: "Locations",      subtitle: "Network sites and physical locations for multi-site topology" },
  "/monitoring": { title: "Monitoring",     subtitle: "Network device uptime, latency and service health" },
  "/ipam":       { title: "IPAM",           subtitle: "IP address management, subnet utilization and DHCP leases" },
  "/tools":      { title: "Tools",          subtitle: "Run network checks and diagnostics from one workspace" },
  "/security":   { title: "Security",       subtitle: "Firewall events, syslog search and device correlation" },
  "/exports":    { title: "Exports",        subtitle: "Download inventory, firewall and report data" },
  "/admin":      { title: "Admin",          subtitle: "Manage users, settings, alerts and system data" },
  "/profile":    { title: "Profile",        subtitle: "Update your account details and password" },
};

export function readStoredTokens(): TokenPair | null {
  // Tokens are no longer stored in localStorage; clear any legacy values.
  window.localStorage.removeItem(tokenStorageKey);
  return null;
}

export function storeTokens(_tokens: TokenPair | null) {
  // Tokens are kept in React state only. The refresh token lives in an
  // HttpOnly cookie set by the server; the access token lives in memory.
  window.localStorage.removeItem(tokenStorageKey);
}

export function readRouteFromLocation(): AppRoute {
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

export function navigateToRoute(route: AppRoute, replace = false) {
  const method = replace ? "replaceState" : "pushState";
  window.history[method](null, "", route);
}

export function isMethodNotAllowedError(error: Error): boolean {
  const message = (error.message || "").toLowerCase();
  return message.includes("method not allowed") || message.includes("status 405") || message.includes("status: 405") || message.includes("405");
}

import { Settings, Shield } from "lucide-react";
import {
  IconAlertCircle,
  IconCalendarClock,
  IconCloud,
  IconPalette,
  IconServer,
  IconShieldCheck,
  IconUsers,
} from "@tabler/icons-react";

export type AdminTabId =
  | "system"
  | "devices-icons"
  | "users"
  | "groups"
  | "credentials"
  | "notifications"
  | "alerts"
  | "automation"
  | "security";

export const adminTabs = [
  { id: "system", label: "System", Icon: Settings },
  { id: "devices-icons", label: "Devices & Icons", Icon: IconPalette },
  { id: "users", label: "Users", Icon: IconUsers },
  { id: "groups", label: "Groups", Icon: IconShieldCheck },
  { id: "credentials", label: "SNMP Profiles", Icon: IconServer },
  { id: "notifications", label: "Notifications", Icon: IconCloud },
  { id: "alerts", label: "Alerts", Icon: IconAlertCircle },
  { id: "automation", label: "Automation", Icon: IconCalendarClock },
  { id: "security", label: "Security", Icon: Shield },
] as const;

export const ADMIN_TAB_CHANGE_EVENT = "netmap:admin-tab-change";

const adminTabIds = new Set<string>(adminTabs.map(({ id }) => id));

export function readAdminTabFromLocation(): AdminTabId {
  const candidate = window.location.hash.slice(1);
  return adminTabIds.has(candidate) ? candidate as AdminTabId : "system";
}

export function navigateToAdminTab(tab: AdminTabId, replace = false) {
  const nextUrl = `${window.location.pathname}${window.location.search}#${tab}`;
  window.history[replace ? "replaceState" : "pushState"](null, "", nextUrl);
  window.dispatchEvent(new CustomEvent<AdminTabId>(ADMIN_TAB_CHANGE_EVENT, { detail: tab }));
}

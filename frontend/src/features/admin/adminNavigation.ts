import { Settings, Shield } from "lucide-react";
import type { User } from "../../api/client";
import { userHasPermission } from "../../utils/permissions";
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
  | "cloud-providers"
  | "users"
  | "groups"
  | "credentials"
  | "notifications"
  | "alerts"
  | "automation"
  | "security";

export const adminTabs = [
  { id: "system", label: "System", Icon: Settings, permissions: ["diagnostics_view", "backup_manage"] },
  { id: "devices-icons", label: "Devices & Icons", Icon: IconPalette, permissions: ["device_catalog_manage"] },
  // Providers are shared by External IPAM allocations and Cloud assets, not by devices —
  // they only sat under Devices & Icons because that tab had spare column.
  { id: "cloud-providers", label: "Cloud providers", Icon: IconCloud, permissions: ["device_catalog_manage"] },
  { id: "users", label: "Users", Icon: IconUsers, permissions: ["user_manage"] },
  { id: "groups", label: "Groups", Icon: IconShieldCheck, superAdminOnly: true },
  { id: "credentials", label: "SNMP Profiles", Icon: IconServer, permissions: ["snmp_profile_manage"] },
  { id: "notifications", label: "Notifications", Icon: IconCloud, permissions: ["notification_manage"] },
  { id: "alerts", label: "Alerts", Icon: IconAlertCircle, permissions: ["alert_write"] },
  { id: "automation", label: "Automation", Icon: IconCalendarClock, permissions: ["automation_manage", "discovery_manage"] },
  { id: "security", label: "Security", Icon: Shield, permissions: ["audit_view"] },
] as const;

export function availableAdminTabs(user: User) {
  if (user.role === "SuperAdmin") return [...adminTabs];
  return adminTabs.filter((tab) => !(("superAdminOnly" in tab) && tab.superAdminOnly)
    && (("permissions" in tab) && tab.permissions.some((permission) => userHasPermission(user, permission))));
}

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

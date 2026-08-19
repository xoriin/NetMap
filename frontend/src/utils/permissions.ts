import type { User } from "../api/client";

const BUILT_IN_DEFAULTS: Record<string, readonly string[]> = {
  NetworkAdmin: [
    "topology_write", "security_view", "tools_passive", "tools_active",
    "inventory_export", "firewall_export", "report_export", "ipam_write",
    "ipam_reservation_claim", "monitoring_write", "alert_write",
    "user_manage", "notification_manage", "device_catalog_manage", "snmp_profile_manage",
    "audit_view", "diagnostics_view", "backup_manage", "automation_manage", "discovery_manage",
  ],
  SecurityAnalyst: ["security_view", "tools_passive", "firewall_export"],
  Viewer: ["tools_passive"],
};

export function userHasPermission(user: User | null | undefined, permission: string): boolean {
  if (!user) return false;
  if (user.role === "SuperAdmin") return true;
  // The fallback keeps older sessions and test fixtures compatible while the
  // API response containing effective permissions rolls out.
  const permissions = user.permissions ?? BUILT_IN_DEFAULTS[user.role] ?? [];
  return permissions.includes(permission);
}

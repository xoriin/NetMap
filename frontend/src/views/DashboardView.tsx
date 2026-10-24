import { lazy, Suspense, useState, useEffect, useCallback } from "react";
import {
  api, type User, type TopologyGraph, type DashboardSummary, type Device, type VersionInfo,
} from "../api/client";
import { type AppRoute, appRouteCopy } from "../routes";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { WorkspaceSkeleton } from "../components/Skeleton";
import { useTheme } from "../providers/ThemeProvider";
import { userHasPermission } from "../utils/permissions";
import { useIconPacks } from "../providers/IconPackProvider";
import { whenIdle } from "../utils/idle";

const pageLoaders = {
  OverviewWorkspace: () =>
    import("../features/overview/OverviewWorkspace").then((m) => ({ default: m.OverviewWorkspace })),
  SecurityWorkspace: () =>
    import("../features/security/SecurityWorkspace").then((m) => ({ default: m.SecurityWorkspace })),
  ToolsWorkspace: () =>
    import("../features/tools/ToolsWorkspace").then((m) => ({ default: m.ToolsWorkspace })),
  ExportsWorkspace: () =>
    import("../features/exports/ExportsWorkspace").then((m) => ({ default: m.ExportsWorkspace })),
  AdminWorkspace: () =>
    import("../features/admin/AdminWorkspace").then((m) => ({ default: m.AdminWorkspace })),
  TopologyWorkspace: () =>
    import("../features/topology/TopologyWorkspace").then((m) => ({ default: m.TopologyWorkspace })),
  InventoryWorkspace: () =>
    import("../features/inventory/InventoryWorkspace").then((m) => ({ default: m.InventoryWorkspace })),
  VlanWorkspace: () =>
    import("../features/vlans/VlanWorkspace").then((m) => ({ default: m.VlanWorkspace })),
  LocationsWorkspace: () =>
    import("../features/locations/LocationsWorkspace").then((m) => ({ default: m.LocationsWorkspace })),
  ProfileWorkspace: () =>
    import("../features/profile/ProfileWorkspace").then((m) => ({ default: m.ProfileWorkspace })),
  IpamWorkspace: () =>
    import("../features/ipam/IpamWorkspace").then((m) => ({ default: m.IpamWorkspace })),
  MonitoringWorkspace: () =>
    import("../features/monitoring/MonitoringWorkspace").then((m) => ({ default: m.MonitoringWorkspace })),
};
const OverviewWorkspace = lazy(pageLoaders.OverviewWorkspace);
const SecurityWorkspace = lazy(pageLoaders.SecurityWorkspace);
const ToolsWorkspace = lazy(pageLoaders.ToolsWorkspace);
const ExportsWorkspace = lazy(pageLoaders.ExportsWorkspace);
const AdminWorkspace = lazy(pageLoaders.AdminWorkspace);
const TopologyWorkspace = lazy(pageLoaders.TopologyWorkspace);
const InventoryWorkspace = lazy(pageLoaders.InventoryWorkspace);
const VlanWorkspace = lazy(pageLoaders.VlanWorkspace);
const LocationsWorkspace = lazy(pageLoaders.LocationsWorkspace);
const ProfileWorkspace = lazy(pageLoaders.ProfileWorkspace);
const IpamWorkspace = lazy(pageLoaders.IpamWorkspace);
const MonitoringWorkspace = lazy(pageLoaders.MonitoringWorkspace);
const ThemePreviewWorkspace = import.meta.env.DEV
  ? lazy(() => import("../features/theme-preview/ThemePreviewWorkspace").then((m) => ({ default: m.ThemePreviewWorkspace })))
  : null;
const AdminDesignPreviewWorkspace = import.meta.env.DEV
  ? lazy(() => import("../features/admin-preview/AdminDesignPreviewWorkspace").then((m) => ({ default: m.AdminDesignPreviewWorkspace })))
  : null;

export function DashboardView({
  accessToken,
  currentRoute,
  graph,
  livePingEnabled,
  monitorIntervalSeconds,
  onGraphChange,
  onDeviceChange,
  onDevicesRemove,
  onNavigate,
  onUserUpdate,
  onSettingsChange,
  onObservationActioned,
  openObservationCount,
  user,
  summary,
  onOpenWhatsNew,
  versionInfo,
}: {
  accessToken: string | null;
  currentRoute: AppRoute;
  graph: TopologyGraph;
  livePingEnabled: boolean;
  monitorIntervalSeconds: number;
  onGraphChange: () => Promise<void>;
  onDeviceChange: (device: Device) => void;
  onDevicesRemove: (deviceIds: number[]) => void;
  onNavigate: (route: AppRoute) => void;
  onUserUpdate: (user: User) => void;
  onSettingsChange: (settings: import("../api/client").SystemSettings) => void;
  onObservationActioned?: () => void;
  openObservationCount?: number;
  user: User;
  summary: DashboardSummary | null;
  onOpenWhatsNew: () => void;
  versionInfo: VersionInfo | null;
}) {
  const { theme } = useTheme();
  const canWrite = userHasPermission(user, "topology_write");
  const canViewSecurity = userHasPermission(user, "security_view");
  const canWriteIpam = userHasPermission(user, "ipam_write");
  const canClaimIpReservations = canWrite && userHasPermission(user, "ipam_reservation_claim");
  const canManageMonitoring = userHasPermission(user, "monitoring_write");
  const canManageAlerts = userHasPermission(user, "alert_write");
  const canManageStatusPages = userHasPermission(user, "status_page_manage");
  const canManageDiscovery = userHasPermission(user, "discovery_manage");
  const canRunActiveTools = userHasPermission(user, "tools_active");
  const canAccessExports = ["inventory_export", "firewall_export", "report_export"]
    .some((permission) => userHasPermission(user, permission));
  const [jumpTarget, setJumpTarget] = useState<{ deviceId: number; token: number } | null>(null);
  const [selectedTopologyDevice, setSelectedTopologyDevice] = useState<Device | null>(null);
  const [favouriteIds, setFavouriteIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!accessToken) return;
    void api.getFavourites(accessToken).then((ids) => setFavouriteIds(new Set(ids))).catch(() => {});
  }, [accessToken]);

  const { loadFullIconSet } = useIconPacks();
  useEffect(() => whenIdle(() => {
    loadFullIconSet();
    Object.values(pageLoaders).forEach((load) => void load().catch(() => undefined));
  }, { afterMs: 2000 }), [loadFullIconSet]);

  const onToggleFavourite = useCallback(async (deviceId: number) => {
    if (!accessToken) return;
    setFavouriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId); else next.add(deviceId);
      return next;
    });
    try {
      await api.toggleFavourite(accessToken, deviceId);
    } catch {
      setFavouriteIds((prev) => {
        const next = new Set(prev);
        if (next.has(deviceId)) next.delete(deviceId); else next.add(deviceId);
        return next;
      });
    }
  }, [accessToken]);

  function jumpToTopologyDevice(deviceId: number) {
    setJumpTarget({ deviceId, token: Date.now() });
    onNavigate("/topology");
  }

  return (
    <ErrorBoundary label={`The ${appRouteCopy[currentRoute]?.title ?? "current"} workspace`} resetKey={currentRoute}>
    <Suspense fallback={<WorkspaceSkeleton />}>
      {currentRoute === "/overview" && (
        <OverviewWorkspace
          accessToken={accessToken}
          canWrite={canWrite}
          canManageDiscovery={canManageDiscovery}
          favouriteIds={favouriteIds}
          graph={graph}
          onDeviceChange={onDeviceChange}
          onGraphChange={onGraphChange}
          onNavigate={onNavigate}
          onObservationActioned={onObservationActioned}
          onToggleFavourite={onToggleFavourite}
          openObservationCount={openObservationCount}
          summary={summary}
          user={user}
        />
      )}
      {currentRoute === "/topology" && (
        <TopologyWorkspace
          accessToken={accessToken}
          canViewSecurity={canViewSecurity}
          canWrite={canWrite}
          canManageDiscovery={canManageDiscovery}
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
        <InventoryWorkspace
          accessToken={accessToken}
          canViewSecurity={canViewSecurity}
          canWrite={canWrite}
          canWriteIpam={canWriteIpam}
          canManageDiscovery={canManageDiscovery}
          favouriteIds={favouriteIds}
          graph={graph}
          onDeviceChange={onDeviceChange}
          onDevicesRemove={onDevicesRemove}
          onGraphChange={onGraphChange}
          onNavigate={onNavigate}
          onObservationActioned={onObservationActioned}
          onToggleFavourite={onToggleFavourite}
          openObservationCount={openObservationCount}
          livePingEnabled={livePingEnabled}
        />
      )}
      {currentRoute === "/vlans" && accessToken && (
        <VlanWorkspace accessToken={accessToken} canWrite={canWrite} graph={graph} onGraphChange={onGraphChange} onNavigate={onNavigate} />
      )}
      {currentRoute === "/locations" && accessToken && (
        <LocationsWorkspace accessToken={accessToken} canWrite={canWrite} graph={graph} onGraphChange={onGraphChange} />
      )}
      {currentRoute === "/monitoring" && accessToken && (
        <MonitoringWorkspace accessToken={accessToken} canWrite={canWrite} canManageAlerts={canManageAlerts} canManageMonitoring={canManageMonitoring} canManageStatusPages={canManageStatusPages} favouriteIds={favouriteIds} inventoryDevices={graph.devices} livePingEnabled={livePingEnabled} monitorIntervalSeconds={monitorIntervalSeconds} onToggleFavourite={onToggleFavourite} />
      )}
      {currentRoute === "/ipam" && accessToken && (
        <IpamWorkspace canManageProviders={userHasPermission(user, "device_catalog_manage")} accessToken={accessToken} canWrite={canWriteIpam} canCreateDevice={canWrite} canClaimReservation={canClaimIpReservations} onDeviceChange={onDeviceChange} />
      )}
      {currentRoute === "/tools" && accessToken && (
        <ToolsWorkspace
          accessToken={accessToken}
          graph={graph}
          selectedDevice={selectedTopologyDevice}
          canRunActiveTools={canRunActiveTools}
        />
      )}
      {currentRoute === "/exports" && accessToken && canAccessExports && (
        <ExportsWorkspace accessToken={accessToken} user={user} />
      )}
      {currentRoute === "/security" && canViewSecurity && (
        <SecurityWorkspace
          accessToken={accessToken}
          graph={graph}
          onJumpToTopologyDevice={jumpToTopologyDevice}
        />
      )}
      {currentRoute === "/admin" && accessToken && (
        <AdminWorkspace
          accessToken={accessToken}
          graph={graph}
          onSettingsChange={onSettingsChange}
          onOpenWhatsNew={onOpenWhatsNew}
          versionInfo={versionInfo}
          user={user}
        />
      )}
      {currentRoute === "/profile" && accessToken && (
        <ProfileWorkspace accessToken={accessToken} user={user} onUserUpdate={onUserUpdate} />
      )}
      {ThemePreviewWorkspace && currentRoute === "/theme-preview" && user.role === "SuperAdmin" && (
        <ThemePreviewWorkspace />
      )}
      {AdminDesignPreviewWorkspace && currentRoute === "/admin-design-preview" && user.role === "SuperAdmin" && (
        <AdminDesignPreviewWorkspace />
      )}
    </Suspense>
    </ErrorBoundary>
  );
}

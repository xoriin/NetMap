import { lazy, Suspense, useState, useEffect, useCallback } from "react";
import {
  api, type User, type TopologyGraph, type DashboardSummary, type Device, type VersionInfo,
} from "../api/client";
import { type AppRoute, appRouteCopy } from "../routes";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { WorkspaceSkeleton } from "../components/Skeleton";
import { useTheme } from "../providers/ThemeProvider";
import { userHasPermission } from "../utils/permissions";

const OverviewWorkspace = lazy(() =>
  import("../features/overview/OverviewWorkspace").then((m) => ({ default: m.OverviewWorkspace }))
);
const SecurityWorkspace = lazy(() =>
  import("../features/security/SecurityWorkspace").then((m) => ({ default: m.SecurityWorkspace }))
);
const ToolsWorkspace = lazy(() =>
  import("../features/tools/ToolsWorkspace").then((m) => ({ default: m.ToolsWorkspace }))
);
const ExportsWorkspace = lazy(() =>
  import("../features/exports/ExportsWorkspace").then((m) => ({ default: m.ExportsWorkspace }))
);
const AdminWorkspace = lazy(() =>
  import("../features/admin/AdminWorkspace").then((m) => ({ default: m.AdminWorkspace }))
);
const TopologyWorkspace = lazy(() =>
  import("../features/topology/TopologyWorkspace").then((m) => ({ default: m.TopologyWorkspace }))
);
const InventoryWorkspace = lazy(() =>
  import("../features/inventory/InventoryWorkspace").then((m) => ({ default: m.InventoryWorkspace }))
);
const VlanWorkspace = lazy(() =>
  import("../features/vlans/VlanWorkspace").then((m) => ({ default: m.VlanWorkspace }))
);
const LocationsWorkspace = lazy(() =>
  import("../features/locations/LocationsWorkspace").then((m) => ({ default: m.LocationsWorkspace }))
);
const ProfileWorkspace = lazy(() =>
  import("../features/profile/ProfileWorkspace").then((m) => ({ default: m.ProfileWorkspace }))
);
const IpamWorkspace = lazy(() =>
  import("../features/ipam/IpamWorkspace").then((m) => ({ default: m.IpamWorkspace }))
);
const MonitoringWorkspace = lazy(() =>
  import("../features/monitoring/MonitoringWorkspace").then((m) => ({ default: m.MonitoringWorkspace }))
);
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
  const canManageMonitoring = userHasPermission(user, "monitoring_write");
  const canManageAlerts = userHasPermission(user, "alert_write");
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
        <VlanWorkspace accessToken={accessToken} canWrite={canWrite} graph={graph} onGraphChange={onGraphChange} />
      )}
      {currentRoute === "/locations" && accessToken && (
        <LocationsWorkspace accessToken={accessToken} canWrite={canWrite} graph={graph} onGraphChange={onGraphChange} />
      )}
      {currentRoute === "/monitoring" && accessToken && (
        <MonitoringWorkspace accessToken={accessToken} canWrite={canWrite} canManageAlerts={canManageAlerts} canManageMonitoring={canManageMonitoring} favouriteIds={favouriteIds} inventoryDevices={graph.devices} livePingEnabled={livePingEnabled} monitorIntervalSeconds={monitorIntervalSeconds} onToggleFavourite={onToggleFavourite} />
      )}
      {currentRoute === "/ipam" && accessToken && (
        <IpamWorkspace accessToken={accessToken} canWrite={canWriteIpam} />
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
      {currentRoute === "/admin" && user.role === "SuperAdmin" && accessToken && (
        <AdminWorkspace
          accessToken={accessToken}
          graph={graph}
          onSettingsChange={onSettingsChange}
          onOpenWhatsNew={onOpenWhatsNew}
          versionInfo={versionInfo}
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

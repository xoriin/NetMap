import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type DashboardSummary, type Device, type DeviceMonitorSummary,
  type DeviceStatus, type TopologyGraph,
} from "../api/client";
import { isMethodNotAllowedError } from "../routes";

/**
 * Owns the shared topology graph + dashboard summary and the background
 * monitor-status poll that patches device statuses into the graph.
 *
 * Extracted from App.tsx (Phase 3.4). Deliberately a hook rather than a
 * context provider: App is the single consumer and hands the data down as
 * props; a context would add indirection without removing any plumbing.
 *
 * - `loadInitial(token)` performs the first dashboard+topology fetch. The
 *   auth bootstrap awaits it so the loading screen covers the initial load,
 *   exactly as before the extraction. Non-405 failures surface via `onError`
 *   (405s are ignored: they mean a reverse proxy blocked an optional call).
 * - The monitor poll runs only while `active` (dashboard visible) and live
 *   ping is not disabled; it uses a delta cursor with periodic full refreshes.
 */
export function useGraphData({
  accessToken,
  active,
  livePingEnabled,
  monitorIntervalSeconds,
  onError,
}: {
  accessToken: string | null;
  active: boolean;
  livePingEnabled: boolean | undefined;
  monitorIntervalSeconds: number | undefined;
  onError: (message: string) => void;
}) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [graph, setGraph] = useState<TopologyGraph>({ devices: [], relationships: [] });
  const topologyRefreshRequestIdRef = useRef(0);
  const monitorCursorRef = useRef<string | null>(null);
  const monitorPollCountRef = useRef(0);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const loadInitial = useCallback(async (token: string) => {
    const [dashboardResult, topologyResult] = await Promise.allSettled([
      api.dashboardSummary(token),
      api.topologyGraph(token),
    ]);
    if (dashboardResult.status === "fulfilled") {
      setSummary(dashboardResult.value);
    } else if (dashboardResult.reason instanceof Error) {
      if (!isMethodNotAllowedError(dashboardResult.reason)) {
        onErrorRef.current(dashboardResult.reason.message);
      }
    }
    if (topologyResult.status === "fulfilled") {
      setGraph(topologyResult.value);
    } else if (topologyResult.reason instanceof Error) {
      if (!isMethodNotAllowedError(topologyResult.reason)) {
        onErrorRef.current(topologyResult.reason.message);
      }
    }
  }, []);

  const refreshTopology = useCallback(async (token?: string | null) => {
    const effectiveToken = token ?? accessTokenRef.current;
    if (!effectiveToken) {
      return;
    }
    const requestId = ++topologyRefreshRequestIdRef.current;
    const [dashboard, topology] = await Promise.all([
      api.dashboardSummary(effectiveToken),
      api.topologyGraph(effectiveToken),
    ]);
    if (requestId !== topologyRefreshRequestIdRef.current) {
      return;
    }
    setSummary(dashboard);
    setGraph(topology);
  }, []);

  const upsertGraphDevice = useCallback((device: Device) => {
    setGraph((current) => {
      const exists = current.devices.some((row) => row.id === device.id);
      return {
        ...current,
        devices: exists
          ? current.devices.map((row) => (row.id === device.id ? device : row))
          : [...current.devices, device],
      };
    });
  }, []);

  const removeGraphDevices = useCallback((deviceIds: number[]) => {
    const removeSet = new Set(deviceIds);
    setGraph((current) => ({
      devices: current.devices.filter((device) => !removeSet.has(device.id)),
      relationships: current.relationships.filter(
        (relationship) =>
          !removeSet.has(relationship.source_device_id) &&
          !removeSet.has(relationship.target_device_id),
      ),
    }));
  }, []);

  const clearSummary = useCallback(() => {
    setSummary(null);
  }, []);

  useEffect(() => {
    if (!active || !accessToken || livePingEnabled === false) {
      monitorCursorRef.current = null;
      monitorPollCountRef.current = 0;
      return;
    }

    const validStatuses = new Set<DeviceStatus>(["online", "offline", "warning", "unknown", "disabled"]);
    const boundedMonitorIntervalSeconds = Math.min(3600, Math.max(30, monitorIntervalSeconds ?? 300));
    const pollMs = Math.min(60_000, Math.max(30_000, boundedMonitorIntervalSeconds * 1000));
    const fullRefreshPolls = Math.max(1, Math.ceil(300_000 / pollMs));
    let cancelled = false;
    const token = accessToken;

    function applyMonitorRows(rows: DeviceMonitorSummary[]) {
      if (rows.length === 0) return;
      const byId = new Map(rows.map((row) => [row.device_id, row]));
      setGraph((current) => {
        let changed = false;
        const devices = current.devices.map((device) => {
          const row = byId.get(device.id);
          if (!row || !validStatuses.has(row.status as DeviceStatus)) {
            return device;
          }
          const nextStatus = row.status as DeviceStatus;
          const nextCheckedAt = row.last_checked ?? device.last_monitored_at;
          if (device.monitor_status === nextStatus && device.last_monitored_at === nextCheckedAt) {
            return device;
          }
          changed = true;
          return {
            ...device,
            monitor_status: nextStatus,
            last_monitored_at: nextCheckedAt,
          };
        });
        return changed ? { ...current, devices } : current;
      });
    }

    async function pollMonitoring(forceFull = false) {
      try {
        const previousCursor = monitorCursorRef.current;
        const shouldFullRefresh = forceFull || !previousCursor || monitorPollCountRef.current >= fullRefreshPolls;
        const [fleet, rows] = await Promise.all([
          api.getMonitoringSummary(token),
          api.listMonitoringDevices(token, shouldFullRefresh ? undefined : previousCursor),
        ]);
        if (cancelled) return;
        applyMonitorRows(rows);
        monitorCursorRef.current = fleet.last_checked ?? previousCursor;
        monitorPollCountRef.current = shouldFullRefresh ? 1 : monitorPollCountRef.current + 1;
      } catch {
        // Keep the current graph state; the next poll or route refresh will reconcile.
      }
    }

    if (monitorPollCountRef.current === 0) {
      void pollMonitoring(true);
    }
    const intervalId = window.setInterval(() => {
      void pollMonitoring(false);
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessToken, active, livePingEnabled, monitorIntervalSeconds]);

  return {
    graph,
    summary,
    loadInitial,
    refreshTopology,
    upsertGraphDevice,
    removeGraphDevices,
    clearSummary,
  };
}

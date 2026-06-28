import { useState, useEffect, useMemo } from "react";
import { Search, Star } from "lucide-react";
import {
  IconServer, IconWifi, IconWifiOff, IconMap, IconBolt,
  IconUsers, IconArrowRight, IconChartBar, IconDeviceDesktop, IconShieldCheck,
} from "@tabler/icons-react";
import {
  api,
  type AlertEvent,
  type DeviceAnalysis,
  type FleetSummary,
  type Device,
  type DeviceMonitorSummary,
  type DevicePayload,
  type DashboardSummary,
  type MonitorHistoryPoint,
  type TopologyGraph,
  type TopologyGroup,
  type Site,
  type SnmpProfile,
  type User,
} from "../../api/client";
import { type AppRoute } from "../../routes";
import { formatDeviceTypeLabel, deviceLabel } from "../../utils/format";
import { DashStat } from "../../components/DashStat";
import { HealthDonut } from "../../components/HealthDonut";
import { ObservationsAlert } from "../../components/ObservationsAlert";
import { AnomalyBadge, MonStatusDot, RttSparkline, TrendBadge, UptimeBadge } from "../../components/MonitorBadges";
import { HeartbeatBar, HeartbeatTimeline } from "../../components/HeartbeatBar";
import { DeviceForm } from "../devices/DeviceForm";
import { DiscoveryModal } from "../topology/DiscoveryModal";
import { computeIncidents } from "../../utils/monitoring";

export function OverviewWorkspace({
  accessToken,
  canWrite,
  favouriteIds,
  graph,
  onDeviceChange,
  onGraphChange,
  onNavigate,
  onObservationActioned,
  onToggleFavourite,
  openObservationCount,
  summary,
  user,
}: {
  accessToken: string | null;
  canWrite: boolean;
  favouriteIds: Set<number>;
  graph: TopologyGraph;
  onDeviceChange: (device: Device) => void;
  onGraphChange: () => Promise<void>;
  onNavigate: (route: AppRoute) => void;
  onObservationActioned?: () => void;
  onToggleFavourite: (deviceId: number) => void;
  openObservationCount?: number;
  summary: DashboardSummary | null;
  user: User;
}) {
  const [monFleet, setMonFleet] = useState<FleetSummary | null>(null);
  const [monDevices, setMonDevices] = useState<DeviceMonitorSummary[]>([]);
  const [monLoading, setMonLoading] = useState(true);
  const [alertDismissed, setAlertDismissed] = useState(false);
  const [favouriteSearch, setFavouriteSearch] = useState("");
  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [snmpProfiles, setSnmpProfiles] = useState<SnmpProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedFavouriteId, setSelectedFavouriteId] = useState<number | null>(null);
  const [favouriteHistory, setFavouriteHistory] = useState<MonitorHistoryPoint[]>([]);
  const [favouriteHistoryHours, setFavouriteHistoryHours] = useState(24);
  const [favouriteHistoryLoading, setFavouriteHistoryLoading] = useState(false);
  const [favouriteAnalysis, setFavouriteAnalysis] = useState<DeviceAnalysis | null>(null);
  const [favouriteAlertEvents, setFavouriteAlertEvents] = useState<AlertEvent[]>([]);

  useEffect(() => {
    if (!accessToken) return;
    setMonLoading(true);
    void Promise.all([
      api.getMonitoringSummary(accessToken),
      api.listMonitoringDevices(accessToken),
    ]).then(([f, d]) => { setMonFleet(f); setMonDevices(d); }).catch(() => {}).finally(() => setMonLoading(false));
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || !canWrite) return;
    let cancelled = false;
    void Promise.all([
      api.topologyGroups(accessToken),
      api.sites(accessToken),
      api.listSnmpProfiles(accessToken),
    ]).then(([groupRows, siteRows, profileRows]) => {
      if (cancelled) return;
      setGroups(groupRows);
      setSites(siteRows);
      setSnmpProfiles(profileRows);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [accessToken, canWrite]);

  async function submitNewDevice(payload: DevicePayload) {
    if (!accessToken) return;
    setBusy(true);
    setActionError(null);
    try {
      const created = await api.createDevice(accessToken, payload);
      onDeviceChange(created);
      setShowDeviceForm(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to create device");
    } finally {
      setBusy(false);
    }
  }

  const statusCounts = useMemo(() => {
    const c = { online: 0, offline: 0, warning: 0, unknown: 0 };
    for (const d of graph.devices) {
      const status = d.status === "disabled" ? "unknown" : (d.monitor_status ?? d.status);
      if (status === "online") c.online++;
      else if (status === "offline") c.offline++;
      else if (status === "warning") c.warning++;
      else c.unknown++;
    }
    return c;
  }, [graph.devices]);

  const total = graph.devices.filter((device) => device.status !== "disabled").length;

  const groupCount = useMemo(
    () => new Set(graph.devices.map((d) => d.topology_group).filter(Boolean)).size,
    [graph.devices],
  );

  const recentDevices = useMemo(
    () => [...graph.devices].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 8),
    [graph.devices],
  );

  const offlineDevices = useMemo(
    () => graph.devices.filter((d) => d.status !== "disabled" && (d.monitor_status ?? d.status) === "offline"),
    [graph.devices],
  );

  useEffect(() => { setAlertDismissed(false); }, [offlineDevices.length]);

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

  const onlinePct = total > 0 ? Math.round((statusCounts.online / total) * 100) : 0;

  const liveStatusByDeviceId = useMemo(() => {
    const m = new Map<number, string>();
    for (const d of graph.devices) {
      m.set(d.id, d.status === "disabled" ? "disabled" : (d.monitor_status ?? d.status));
    }
    return m;
  }, [graph.devices]);

  const favouriteDevices = useMemo(
    () => monDevices.filter((d) => favouriteIds.has(d.device_id)),
    [monDevices, favouriteIds],
  );

  const visibleFavouriteDevices = useMemo(() => {
    const q = favouriteSearch.trim().toLowerCase();
    if (!q) return favouriteDevices;
    return favouriteDevices.filter((d) => [
      d.display_name,
      d.hostname,
      d.ip_address,
      d.status,
    ].some((value) => (value ?? "").toLowerCase().includes(q)));
  }, [favouriteDevices, favouriteSearch]);

  const selectedFavouriteDevice = useMemo(
    () => monDevices.find((d) => d.device_id === selectedFavouriteId) ?? null,
    [monDevices, selectedFavouriteId],
  );

  useEffect(() => {
    if (!accessToken || selectedFavouriteId === null) {
      setFavouriteHistory([]);
      setFavouriteAnalysis(null);
      setFavouriteAlertEvents([]);
      return;
    }
    let cancelled = false;
    setFavouriteHistoryLoading(true);
    void Promise.all([
      api.getDeviceHistory(accessToken, selectedFavouriteId, favouriteHistoryHours).catch(() => []),
      api.listAlertEvents(accessToken, selectedFavouriteId).catch(() => []),
      api.getDeviceAnalysis(accessToken, selectedFavouriteId).catch((): DeviceAnalysis => ({
        device_id: selectedFavouriteId,
        baseline_rtt_ms: null, rtt_stddev: null, rtt_p50: null, rtt_p95: null,
        current_rtt_ms: null, anomaly_score: null,
        anomaly_level: "insufficient_data",
        trend: "insufficient_data", trend_pct: null,
        flap_count_24h: 0, longest_outage_minutes: null,
      })),
    ]).then(([history, events, analysis]) => {
      if (cancelled) return;
      setFavouriteHistory(history);
      setFavouriteAlertEvents(events);
      setFavouriteAnalysis(analysis);
    }).finally(() => {
      if (!cancelled) setFavouriteHistoryLoading(false);
    });
    return () => { cancelled = true; };
  }, [accessToken, selectedFavouriteId, favouriteHistoryHours]);

  function fmtTime(iso: string | null) {
    if (!iso) return "-";
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

  function fmtRtt(ms: number | null) {
    return ms !== null ? `${ms.toFixed(1)} ms` : "-";
  }

  return (
    <section className="dash-layout">
      {/* Stat row */}
      <div className="dash-stats">
        <DashStat label="Total devices" value={total} sub={total === 0 ? "none yet" : `${onlinePct}% reachable`} icon={<IconServer size={20} />} accent="teal" />
        <DashStat label="Online" value={statusCounts.online} sub="reachable" icon={<IconWifi size={20} />} accent="green" />
        <DashStat label="Offline" value={statusCounts.offline} sub={statusCounts.offline > 0 ? "need attention" : "all clear"} icon={<IconWifiOff size={20} />} accent={statusCounts.offline > 0 ? "red" : "green"} />
        <DashStat label="Groups / VLANs" value={groupCount} sub="topology segments" icon={<IconMap size={20} />} accent="purple" />
        <DashStat label="Links" value={graph.relationships.length} sub="connections" icon={<IconBolt size={20} />} accent="blue" />
        <DashStat label="Users" value={summary?.user_count ?? 0} sub="accounts" icon={<IconUsers size={20} />} accent="indigo" />
      </div>

      {offlineDevices.length > 0 && !alertDismissed && (
        <div className="dash-alert dash-alert--overview-bar">
          <span className="dash-alert-dot" aria-hidden="true" />
          <strong>{offlineDevices.length} device{offlineDevices.length !== 1 ? "s" : ""} offline</strong>
          {offlineDevices.slice(0, 6).map((d: Device) => (
            <span key={d.id} className="dash-alert-tag">{d.display_name || d.hostname || d.ip_address}</span>
          ))}
          {offlineDevices.length > 6 && (
            <span className="dash-alert-tag dash-alert-tag--more">+{offlineDevices.length - 6} more</span>
          )}
          <button type="button" className="dash-alert-link" onClick={() => onNavigate("/inventory")}>
            View inventory <IconArrowRight size={13} />
          </button>
          <button type="button" className="dash-alert-dismiss" aria-label="Dismiss alert" onClick={() => setAlertDismissed(true)}>
            &times;
          </button>
        </div>
      )}

      <ObservationsAlert
        accessToken={accessToken}
        openObservationCount={openObservationCount}
        onObservationActioned={onObservationActioned}
      />

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
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><IconServer size={22} /></div>
                <div className="dash-empty-title">No devices yet</div>
                <div className="dash-empty-desc">Add devices from the Inventory tab to see health here.</div>
                <button type="button" className="dash-empty-action" onClick={() => onNavigate("/inventory")}>Go to Inventory</button>
              </div>
            ) : (
              <div className="dash-health-with-donut">
                <HealthDonut statusCounts={statusCounts} total={total} pct={onlinePct} />
                <div className="dash-health-bars">
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
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><IconChartBar size={22} /></div>
                <div className="dash-empty-title">No device types yet</div>
                <div className="dash-empty-desc">Assign device types in inventory to see a breakdown here.</div>
              </div>
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
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><IconMap size={22} /></div>
                <div className="dash-empty-title">No groups yet</div>
                <div className="dash-empty-desc">Assign topology groups to devices to segment your network.</div>
                <button type="button" className="dash-empty-action" onClick={() => onNavigate("/vlans")}>Manage groups</button>
              </div>
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
            <div className="dash-panel-actions">
              {canWrite && (
                <>
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy} onClick={() => setShowDeviceForm(true)}>
                    + Device
                  </button>
                  <button type="button" className="nm-btn nm-btn--sm" disabled={busy} onClick={() => setShowScanModal(true)}>
                    Scan
                  </button>
                </>
              )}
              <button type="button" className="dash-panel-link" onClick={() => onNavigate("/inventory")}>
                View all <IconArrowRight size={12} />
              </button>
            </div>
          </div>
          <div className="dash-panel-body">
            {actionError && <div className="form-error" style={{ margin: "0 0 12px" }}>{actionError}</div>}
            {recentDevices.length === 0 ? (
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><IconDeviceDesktop size={22} /></div>
                <div className="dash-empty-title">No devices yet</div>
                <div className="dash-empty-desc">Add your first device to start mapping your network.</div>
                {canWrite ? (
                  <div className="dash-empty-actions">
                    <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy} onClick={() => setShowDeviceForm(true)}>+ Device</button>
                    <button type="button" className="nm-btn nm-btn--sm" disabled={busy} onClick={() => setShowScanModal(true)}>Scan</button>
                  </div>
                ) : (
                  <button type="button" className="dash-empty-action" onClick={() => onNavigate("/inventory")}>View inventory</button>
                )}
              </div>
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
                      <span className={`nm-status nm-status--${liveStatus}`}>{liveStatus}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Monitoring snapshot */}
        <div className="dash-panel">
          <div className="dash-panel-header dash-panel-header--favourites">
            <span className="dash-panel-title">Favourites</span>
            <div className="dash-panel-actions">
              <div className="overview-fav-search">
                <Search size={13} aria-hidden="true" />
                <input
                  type="search"
                  value={favouriteSearch}
                  onChange={(e) => setFavouriteSearch(e.target.value)}
                  placeholder="Search favourites"
                />
              </div>
              <button type="button" className="dash-panel-link" onClick={() => onNavigate("/monitoring")}>
                View all <IconArrowRight size={12} />
              </button>
            </div>
          </div>
          <div className="dash-panel-body">
            {monLoading ? (
              <div className="dash-device-list">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="dash-device-row" style={{ gap: 10 }}>
                    <span className="skeleton-circle" style={{ width: 10, height: 10, flexShrink: 0 }} />
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                      <span className="skeleton-line" style={{ height: 12, width: "55%" }} />
                      <span className="skeleton-line" style={{ height: 8, width: "35%" }} />
                    </div>
                    <span className="skeleton-line" style={{ height: 12, width: 48 }} />
                  </div>
                ))}
              </div>
            ) : monDevices.length === 0 ? (
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><IconWifi size={22} /></div>
                <div className="dash-empty-title">No monitoring data yet</div>
                <div className="dash-empty-desc">The background monitor polls on the configured live ping interval.</div>
              </div>
            ) : favouriteDevices.length === 0 ? (
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><IconShieldCheck size={22} /></div>
                <div className="dash-empty-title">No favourites yet</div>
                <div className="dash-empty-desc">Star devices in monitoring or inventory to pin them here.</div>
                <button type="button" className="dash-empty-action" onClick={() => onNavigate("/monitoring")}>Go to Monitoring</button>
              </div>
            ) : visibleFavouriteDevices.length === 0 ? (
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><Search size={22} /></div>
                <div className="dash-empty-title">No favourites found</div>
                <div className="dash-empty-desc">Try a different device name, host, IP, or status.</div>
              </div>
            ) : (
              <div className="dash-device-list">
                {visibleFavouriteDevices.map((d) => (
                  <div
                    key={d.device_id}
                    role="button"
                    tabIndex={0}
                    className="dash-device-row dash-device-row--favourite dash-device-row--action"
                    onClick={() => setSelectedFavouriteId(d.device_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedFavouriteId(d.device_id);
                      }
                    }}
                  >
                    <MonStatusDot status={liveStatusByDeviceId.get(d.device_id) ?? d.status} />
                    <div className="dash-device-info">
                      <span className="dash-device-name">{d.display_name ?? d.hostname ?? d.ip_address}</span>
                      {d.heartbeat.length > 0 && <HeartbeatBar beats={d.heartbeat} size="sm" />}
                    </div>
                    <UptimeBadge value={d.uptime_24h} />
                    <span className="dash-fav-rtt dash-panel-meta">
                      {d.avg_rtt_24h != null ? `${d.avg_rtt_24h.toFixed(1)} ms` : "—"}
                    </span>
                    <button
                      type="button"
                      className="fav-btn fav-btn--active"
                      aria-label="Remove from favourites"
                      title="Remove from favourites"
                      onClick={(e) => { e.stopPropagation(); onToggleFavourite(d.device_id); }}
                    >
                      <Star size={15} fill="currentColor" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>

      </div>{/* end dash-grids */}

      {showDeviceForm && (
        <DeviceForm
          busy={busy}
          device={null}
          cloneSource={null}
          groups={groups}
          snmpProfiles={snmpProfiles}
          sites={sites}
          onCancel={() => setShowDeviceForm(false)}
          onSubmit={submitNewDevice}
        />
      )}
      {showScanModal && accessToken && (
        <DiscoveryModal
          accessToken={accessToken}
          onCancel={() => setShowScanModal(false)}
          onImported={async () => {
            setShowScanModal(false);
            await onGraphChange();
          }}
        />
      )}
      {selectedFavouriteDevice && (
        <div
          className="mon-hero-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedFavouriteId(null); }}
        >
          <div className="mon-hero">
            <div className={`mon-hero-header mon-hero-header--${selectedFavouriteDevice.status}`}>
              <div className="mon-hero-header-left">
                <MonStatusDot status={selectedFavouriteDevice.status} />
                <div>
                  <div className="mon-hero-name">
                    {selectedFavouriteDevice.display_name ?? selectedFavouriteDevice.hostname ?? selectedFavouriteDevice.ip_address}
                  </div>
                  <div className="mon-hero-sub">
                    {selectedFavouriteDevice.hostname && selectedFavouriteDevice.hostname !== selectedFavouriteDevice.ip_address && (
                      <span>{selectedFavouriteDevice.hostname} - </span>
                    )}
                    <span className="mon-cell-mono">{selectedFavouriteDevice.ip_address}</span>
                  </div>
                </div>
              </div>
              <button type="button" className="mon-hero-close" onClick={() => setSelectedFavouriteId(null)} title="Close">x</button>
            </div>

            <div className="mon-hero-stats">
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">24 h uptime</span>
                <UptimeBadge value={selectedFavouriteDevice.uptime_24h} />
              </div>
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">7 d uptime</span>
                <UptimeBadge value={selectedFavouriteDevice.uptime_7d} />
              </div>
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">Avg RTT (24 h)</span>
                <strong className="mon-hero-stat-val">{fmtRtt(selectedFavouriteDevice.avg_rtt_24h)}</strong>
              </div>
              {favouriteAnalysis?.current_rtt_ms != null && (
                <div className="mon-hero-stat">
                  <span className="mon-hero-stat-label">Current RTT</span>
                  <strong className="mon-hero-stat-val">{fmtRtt(favouriteAnalysis.current_rtt_ms)}</strong>
                </div>
              )}
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">Last checked</span>
                <strong className="mon-hero-stat-val">{fmtTime(selectedFavouriteDevice.last_checked)}</strong>
              </div>
            </div>

            <div className="mon-hero-body">
              <div className="mon-hero-cols">
                <div className="mon-hero-col">
                  {favouriteAnalysis && (
                    <div className="mon-hero-section">
                      <div className="mon-hero-section-title">
                        Analysis
                        <span className="dash-panel-meta">7-day baseline</span>
                      </div>
                      <div className="mon-analysis-body">
                        <div className="mon-analysis-row">
                          <span className="dash-panel-meta">Trend</span>
                          <TrendBadge trend={favouriteAnalysis.trend} pct={favouriteAnalysis.trend_pct} />
                        </div>
                        <div className="mon-analysis-row">
                          <span className="dash-panel-meta">Anomaly</span>
                          <AnomalyBadge level={favouriteAnalysis.anomaly_level} score={favouriteAnalysis.anomaly_score} />
                        </div>
                        {favouriteAnalysis.baseline_rtt_ms !== null && (
                          <div className="mon-analysis-row">
                            <span className="dash-panel-meta">Baseline RTT</span>
                            <span className="mon-analysis-val">
                              {favouriteAnalysis.baseline_rtt_ms.toFixed(1)} ms
                              {favouriteAnalysis.rtt_stddev !== null && (
                                <span className="dash-panel-meta"> +/- {favouriteAnalysis.rtt_stddev.toFixed(1)}</span>
                              )}
                            </span>
                          </div>
                        )}
                        <div className="mon-analysis-row">
                          <span className="dash-panel-meta">Flaps (24 h)</span>
                          <span className={`mon-analysis-val${favouriteAnalysis.flap_count_24h >= 4 ? " mon-analysis-val--warn" : ""}`}>
                            {favouriteAnalysis.flap_count_24h}
                          </span>
                        </div>
                        {favouriteAnalysis.longest_outage_minutes !== null && (
                          <div className="mon-analysis-row">
                            <span className="dash-panel-meta">Longest outage (7 d)</span>
                            <span className="mon-analysis-val">{fmtDuration(favouriteAnalysis.longest_outage_minutes)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {selectedFavouriteDevice.latest_port_results.length > 0 && (
                    <div className="mon-hero-section">
                      <div className="mon-hero-section-title">
                        Service status
                        <span className="dash-panel-meta">latest check</span>
                      </div>
                      <div className="mon-port-rows">
                        {selectedFavouriteDevice.latest_port_results.map((r) => (
                          <div key={r.target_id ?? `${r.label}-${r.port}`} className="mon-port-row">
                            <span className={`mon-dot mon-dot-${r.open ? "online" : "offline"}`} />
                            <span className="mon-port-label">{r.label}</span>
                            <span className="dash-panel-meta">{r.check_type.toUpperCase()} :{r.port}</span>
                            <span className={`mon-port-status mon-port-status--${r.open ? "open" : "closed"}`}>
                              {r.open ? "Open" : "Closed"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {favouriteHistory.length > 0 && (() => {
                    const incidents = computeIncidents(favouriteHistory);
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
                            const firedEvents = favouriteAlertEvents.filter((ev) => {
                              const t = new Date(ev.fired_at).getTime();
                              return t >= startTs - 5 * 60_000 && t <= endTs + 5 * 60_000;
                            });
                            return (
                              <div key={i} className={`incident-row${inc.end === null ? " incident-row--active" : ""}`}>
                                <span className={`mon-dot mon-dot-${inc.end === null ? "offline" : "unknown"}`} />
                                <div className="incident-row-body">
                                  <span className="incident-time">{fmtDateTime(inc.start)}</span>
                                  <span className="dash-panel-meta">to</span>
                                  <span className="incident-time">{inc.end ? fmtDateTime(inc.end) : "now"}</span>
                                  {firedEvents.length > 0 && (
                                    <span className="incident-alert-tag" title={firedEvents.map((event) => event.alert_rule_name).join(", ")}>
                                      {firedEvents.length} alert{firedEvents.length !== 1 ? "s" : ""} fired
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
                </div>

                <div className="mon-hero-col">
                  <div className="mon-hero-section">
                    <div className="mon-hero-section-title">
                      Heartbeat
                      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="dash-panel-meta">hover to inspect</span>
                        <select
                          className="mon-hours-select"
                          value={favouriteHistoryHours}
                          onChange={(e) => setFavouriteHistoryHours(Number(e.target.value))}
                        >
                          <option value={6}>Last 6 h</option>
                          <option value={24}>Last 24 h</option>
                          <option value={72}>Last 3 days</option>
                          <option value={168}>Last 7 days</option>
                        </select>
                      </span>
                    </div>
                    <div className="mon-heartbeat-body">
                      {favouriteHistoryLoading
                        ? <p className="dash-empty">Loading...</p>
                        : <HeartbeatTimeline history={favouriteHistory} hours={favouriteHistoryHours} />
                      }
                    </div>
                  </div>

                  <div className="mon-hero-section">
                    <div className="mon-hero-section-title">Response time</div>
                    <div className="mon-chart-body">
                      {favouriteHistoryLoading ? (
                        <p className="dash-empty">Loading...</p>
                      ) : (
                        <>
                          <RttSparkline data={favouriteHistory} />
                          {favouriteHistory.length > 0 && (
                            <p className="dash-panel-meta" style={{ margin: "6px 0 0" }}>
                              {favouriteHistory.length} data points - latest {fmtTime(favouriteHistory[favouriteHistory.length - 1].checked_at)}
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

    </section>
  );
}

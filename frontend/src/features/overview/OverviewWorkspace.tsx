import { useState, useEffect, useMemo } from "react";
import { Search, Star } from "lucide-react";
import {
  IconServer, IconWifi, IconWifiOff, IconMap, IconBolt,
  IconUsers, IconArrowRight, IconChartBar, IconDeviceDesktop, IconShieldCheck,
} from "@tabler/icons-react";
import { api, type FleetSummary, type DeviceMonitorSummary, type DashboardSummary, type TopologyGraph, type User } from "../../api/client";
import { type AppRoute } from "../../routes";
import { formatDeviceTypeLabel, deviceLabel } from "../../utils/format";
import { DashStat } from "../../components/DashStat";
import { HealthDonut } from "../../components/HealthDonut";
import { MonStatusDot, UptimeBadge } from "../../components/MonitorBadges";
import { HeartbeatBar } from "../../components/HeartbeatBar";

export function OverviewWorkspace({
  accessToken,
  favouriteIds,
  graph,
  onNavigate,
  onToggleFavourite,
  summary,
  user,
}: {
  accessToken: string | null;
  favouriteIds: Set<number>;
  graph: TopologyGraph;
  onNavigate: (route: AppRoute) => void;
  onToggleFavourite: (deviceId: number) => void;
  summary: DashboardSummary | null;
  user: User;
}) {
  const [monFleet, setMonFleet] = useState<FleetSummary | null>(null);
  const [monDevices, setMonDevices] = useState<DeviceMonitorSummary[]>([]);
  const [monLoading, setMonLoading] = useState(true);
  const [alertDismissed, setAlertDismissed] = useState(false);
  const [favouriteSearch, setFavouriteSearch] = useState("");

  useEffect(() => {
    if (!accessToken) return;
    setMonLoading(true);
    void Promise.all([
      api.getMonitoringSummary(accessToken),
      api.listMonitoringDevices(accessToken),
    ]).then(([f, d]) => { setMonFleet(f); setMonDevices(d); }).catch(() => {}).finally(() => setMonLoading(false));
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
          {offlineDevices.slice(0, 6).map((d) => (
            <span key={d.device_id} className="dash-alert-tag">{d.display_name || d.hostname || d.ip_address}</span>
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

      {/* Main grids */}
      <div className="dash-grids">

      {/* Top row: Network health | Device types | Top groups */}
      <div className="dash-grid-3">

        {/* Network health */}
        <div className="dash-panel dash-panel--favourites">
          <div className="dash-panel-header dash-panel-header--favourites">
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
            <button type="button" className="dash-panel-link" onClick={() => onNavigate("/inventory")}>
              View all <IconArrowRight size={12} />
            </button>
          </div>
          <div className="dash-panel-body">
            {recentDevices.length === 0 ? (
              <div className="dash-empty-state">
                <div className="dash-empty-icon"><IconDeviceDesktop size={22} /></div>
                <div className="dash-empty-title">No devices yet</div>
                <div className="dash-empty-desc">Add your first device to start mapping your network.</div>
                <button type="button" className="dash-empty-action" onClick={() => onNavigate("/inventory")}>Add a device</button>
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
                <div className="dash-empty-desc">The background monitor polls every 5 minutes.</div>
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
                  <div key={d.device_id} className="dash-device-row dash-device-row--favourite">
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
                      aria-label="Remove from favourites"
                      title="Remove from favourites"
                      onClick={() => onToggleFavourite(d.device_id)}
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
    </section>
  );
}

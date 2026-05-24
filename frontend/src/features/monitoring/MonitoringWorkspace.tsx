import { useState, useEffect, useRef, useMemo, useCallback, useContext, type FormEvent } from "react";
import { Search, Star, ChevronUp, ChevronDown, Activity, X } from "lucide-react";
import { IconServer, IconWifi, IconWifiOff, IconAlertCircle } from "@tabler/icons-react";
import {
  api,
  type FleetSummary, type DeviceMonitorSummary, type MonitorHistoryPoint,
  type PortTarget, type AlertEvent, type AlertRule, type DeviceAnalysis,
} from "../../api/client";
import { TopbarNoteCtx } from "../../context";
import { type Incident } from "../../types";
import { MON_COL_WIDTHS_KEY, MON_COL_COUNT, computeIncidents, loadMonColWidths } from "../../utils/monitoring";
import { DashStat } from "../../components/DashStat";
import {
  AnomalyBadge, MonStat, MonStatusDot, RttSparkline, TrendBadge, UptimeBadge,
} from "../../components/MonitorBadges";
import { HeartbeatBar, HeartbeatTimeline } from "../../components/HeartbeatBar";

export function MonitoringWorkspace({
  accessToken,
  userRole,
}: {
  accessToken: string;
  canWrite: boolean;
  userRole: string;
}) {
  const [colWidths, setColWidths] = useState<number[] | null>(loadMonColWidths);
  const resizingRef = useRef<{ colIdx: number; startX: number; startWidth: number } | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const monitorCursorRef = useRef<string | null>(null);
  const deltaPollsRef = useRef(0);
  const FULL_REFRESH_POLLS = 5; // full reload every 5 × 60s to reconcile deletes/disabled devices

  function startColResize(colIdx: number, e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;

    // Snapshot all 6 resizable column widths from the DOM (th[1]..th[6], skipping Status)
    const table = tableRef.current;
    const initialWidths: number[] = table
      ? Array.from(table.querySelectorAll<HTMLElement>("thead tr th"))
          .slice(1, 1 + MON_COL_COUNT)
          .map((th) => th.getBoundingClientRect().width)
      : (colWidths ?? Array(MON_COL_COUNT).fill(150));

    const startWidth = initialWidths[colIdx];
    resizingRef.current = { colIdx, startX, startWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      if (!resizingRef.current) return;
      const { colIdx: ci, startX: sx, startWidth: sw } = resizingRef.current;
      const next = Math.max(50, sw + (ev.clientX - sx));
      const updated = [...initialWidths];
      updated[ci] = next;
      setColWidths(updated);
    }

    function onUp() {
      resizingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setColWidths((prev) => {
        if (prev) window.localStorage.setItem(MON_COL_WIDTHS_KEY, JSON.stringify(prev));
        return prev;
      });
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function resetColWidths() {
    setColWidths(null);
    window.localStorage.removeItem(MON_COL_WIDTHS_KEY);
  }

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

  const loadAll = useCallback(async (showSpinner = false) => {
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
      monitorCursorRef.current = f.last_checked;
      deltaPollsRef.current = 0;
      setError(null);
    } catch {
      setError("Failed to load monitoring data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accessToken]);

  const loadDelta = useCallback(async () => {
    const since = monitorCursorRef.current;
    if (!since) return;
    try {
      const [f, delta] = await Promise.all([
        api.getMonitoringSummary(accessToken),
        api.listMonitoringDevices(accessToken, since),
      ]);
      setFleet(f);
      if (delta.length > 0) {
        setDevices((prev) => {
          const map = new Map(prev.map((d) => [d.device_id, d]));
          for (const d of delta) map.set(d.device_id, d);
          return Array.from(map.values());
        });
      }
      monitorCursorRef.current = f.last_checked ?? since;
    } catch {
      // silently skip failed delta polls; next full refresh will reconcile
    }
  }, [accessToken]);

  const setTopbarNote = useContext(TopbarNoteCtx);
  useEffect(() => {
    setTopbarNote(fleet?.last_checked
      ? `Last poll ${new Date(fleet.last_checked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · every 5 min`
      : "");
  }, [fleet, setTopbarNote]);
  useEffect(() => () => setTopbarNote(""), [setTopbarNote]);

  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => {
    const id = setInterval(() => {
      deltaPollsRef.current += 1;
      if (deltaPollsRef.current >= FULL_REFRESH_POLLS) {
        void loadAll();
      } else {
        void loadDelta();
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [loadAll, loadDelta]);

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
      {/* Stat cards — same pattern as Overview */}
      <div className="dash-stats dash-stats--monitoring">
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
              <button type="button" className="toolbar-btn toolbar-btn--sm" onClick={resetColWidths} title="Reset column widths to default">
                Reset columns
              </button>
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
              <table
                className="mon-table"
                ref={tableRef}
                style={{ tableLayout: "fixed" }}
              >
                <colgroup>
                  <col style={{ width: 28 }} />
                  {colWidths
                    ? colWidths.map((w, i) => <col key={i} style={{ width: w }} />)
                    : <>
                        <col style={{ width: 360 }} />{/* Device: wide enough to show 30-beat heartbeat */}
                        <col /><col /><col /><col />{/* 24H, 7D, RTT, Ports: equal share */}
                        <col style={{ width: 80 }} />{/* Checked: compact */}
                      </>
                  }
                  <col style={{ width: 52 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ width: 28 }} />
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "name" ? " active" : ""}`} onClick={() => toggleSort("name")}>
                        Device{sortKey === "name" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(0, e)} />
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "uptime24" ? " active" : ""}`} onClick={() => toggleSort("uptime24")}>
                        24 h{sortKey === "uptime24" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(1, e)} />
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "uptime7" ? " active" : ""}`} onClick={() => toggleSort("uptime7")}>
                        7 d{sortKey === "uptime7" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(2, e)} />
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "rtt" ? " active" : ""}`} onClick={() => toggleSort("rtt")}>
                        Avg RTT{sortKey === "rtt" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(3, e)} />
                    </th>
                    <th>
                      Ports
                      <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(4, e)} />
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "checked" ? " active" : ""}`} onClick={() => toggleSort("checked")}>
                        Checked{sortKey === "checked" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(5, e)} />
                    </th>
                    <th style={{ width: 52 }} title="Favourite" />
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
                        <div className="mon-device-cell">
                          <div className="mon-device-meta">
                            <span className="mon-device-name">{d.display_name ?? d.hostname ?? d.ip_address}</span>
                            <span className="mon-device-ip">{d.ip_address}</span>
                          </div>
                          {d.heartbeat.length > 0 && <HeartbeatBar beats={d.heartbeat.slice(-48)} size="sm" />}
                        </div>
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

        {/* Monitored ports sidebar */}
        <div className="dash-panel mon-ports-sidebar">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Monitored ports</span>
            {canManagePorts && (
              <button
                type="button"
                className="dash-panel-link"
                onClick={() => setShowPortForm((v) => !v)}
              >
                {showPortForm ? "Cancel" : "+ Add"}
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
                <p className="dash-empty" style={{ margin: 0 }}>No ports configured.</p>
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

    </section>
  );
}

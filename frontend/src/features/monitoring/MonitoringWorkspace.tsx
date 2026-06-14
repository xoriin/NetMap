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
  AnomalyBadge, MonStatusDot, RttSparkline, TrendBadge, UptimeBadge,
} from "../../components/MonitorBadges";
import { HeartbeatBar, HeartbeatTimeline } from "../../components/HeartbeatBar";
import { Modal } from "../../components/Modal";

export function MonitoringWorkspace({
  accessToken,
  favouriteIds,
  livePingEnabled,
  monitorIntervalSeconds,
  onToggleFavourite,
  userRole,
}: {
  accessToken: string;
  canWrite: boolean;
  favouriteIds: Set<number>;
  livePingEnabled: boolean;
  monitorIntervalSeconds: number;
  onToggleFavourite: (deviceId: number) => void;
  userRole: string;
}) {
  const [colWidths, setColWidths] = useState<number[] | null>(loadMonColWidths);
  const resizingRef = useRef<{ colIdx: number; startX: number; startWidth: number } | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const monitorCursorRef = useRef<string | null>(null);
  const deltaPollsRef = useRef(0);
  const portDeviceRef = useRef<HTMLDivElement>(null);
  const [nowTick, setNowTick] = useState(0);
  const boundedMonitorIntervalSeconds = Math.min(3600, Math.max(30, monitorIntervalSeconds || 300));
  const monitoringPollMs = Math.min(60_000, Math.max(30_000, boundedMonitorIntervalSeconds * 1000));
  const fullRefreshPolls = Math.max(1, Math.ceil(300_000 / monitoringPollMs));
  const monitorIntervalLabel = boundedMonitorIntervalSeconds >= 60 && boundedMonitorIntervalSeconds % 60 === 0
    ? `${boundedMonitorIntervalSeconds / 60} min`
    : `${boundedMonitorIntervalSeconds} sec`;

  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  function relativeTime(iso: string): string {
    const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (diffMin < 1) return "just now";
    return `${diffMin} min ago`;
  }

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
  const [portFormScope, setPortFormScope] = useState<"global" | "device">("global");
  const [portFormDeviceId, setPortFormDeviceId] = useState<number | null>(null);
  const [portDeviceSearch, setPortDeviceSearch] = useState("");
  const [portDeviceDropOpen, setPortDeviceDropOpen] = useState(false);
  const [portBusy, setPortBusy] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sortKey, setSortKey] = useState<"status" | "name" | "uptime24" | "uptime7" | "rtt" | "checked">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [deviceAlertEvents, setDeviceAlertEvents] = useState<AlertEvent[]>([]);
  const [allAlertRules, setAllAlertRules] = useState<AlertRule[]>([]);
  const [analysis, setAnalysis] = useState<DeviceAnalysis | null>(null);
  const [filterGroup, setFilterGroup] = useState("all");
  const [filterSite, setFilterSite] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

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
    if (!livePingEnabled) {
      setTopbarNote(<span className="app-topbar-status app-topbar-status--paused"><span aria-hidden="true" />Paused</span>);
    } else if (fleet?.last_checked) {
      setTopbarNote(
        <div className="app-topbar-mon-status">
          <span className="app-topbar-status"><span aria-hidden="true" />Live</span>
          <span className="app-topbar-note">Last poll {new Date(fleet.last_checked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ({relativeTime(fleet.last_checked)}) · every {monitorIntervalLabel}</span>
        </div>
      );
    } else {
      setTopbarNote(<span className="app-topbar-status"><span aria-hidden="true" />Live</span>);
    }
  }, [fleet, livePingEnabled, monitorIntervalLabel, nowTick, relativeTime, setTopbarNote]);
  useEffect(() => () => setTopbarNote(""), [setTopbarNote]);

  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => {
    const id = setInterval(() => {
      deltaPollsRef.current += 1;
      if (deltaPollsRef.current >= fullRefreshPolls) {
        void loadAll();
      } else {
        void loadDelta();
      }
    }, monitoringPollMs);
    return () => clearInterval(id);
  }, [fullRefreshPolls, loadAll, loadDelta, monitoringPollMs]);

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
    const id = setInterval(() => void loadHistory(selectedId, historyHours), monitoringPollMs);
    return () => clearInterval(id);
  }, [selectedId, historyHours, loadHistory, monitoringPollMs]);


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

  useEffect(() => {
    if (!portDeviceDropOpen) return;
    function handleOutside(e: MouseEvent) {
      if (portDeviceRef.current && !portDeviceRef.current.contains(e.target as Node))
        setPortDeviceDropOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [portDeviceDropOpen]);

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
    if (filterStatus !== "all") filtered = filtered.filter((d) => d.status === filterStatus);

    const dir = sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      switch (sortKey) {
        case "status": {
          const order: Record<string, number> = { online: 0, warning: 1, unknown: 2, offline: 3 };
          return ((order[a.status] ?? 4) - (order[b.status] ?? 4)) * dir;
        }
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
  }, [devices, searchQ, filterGroup, filterSite, filterStatus, sortKey, sortDir]);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const offlineDevices = useMemo(() => devices.filter((d) => d.status === "offline"), [devices]);

  function parsePorts(raw: string): number[] | null {
    const ports: number[] = [];
    for (const token of raw.split(",").map((t) => t.trim()).filter(Boolean)) {
      const range = token.match(/^(\d+)-(\d+)$/);
      if (range) {
        const start = parseInt(range[1], 10);
        const end = parseInt(range[2], 10);
        if (start < 1 || end > 65535 || start > end || end - start > 100) return null;
        for (let p = start; p <= end; p++) ports.push(p);
      } else {
        const p = parseInt(token, 10);
        if (isNaN(p) || p < 1 || p > 65535) return null;
        ports.push(p);
      }
    }
    return ports.length > 0 ? ports : null;
  }

  async function addPortTarget(e: FormEvent) {
    e.preventDefault();
    const ports = parsePorts(portFormPort);
    if (!ports) { setPortError("Invalid port — use a number, range (e.g. 60-65), or comma-separated list (e.g. 9001, 9040, 8054)"); return; }
    if (!portFormLabel.trim()) { setPortError("Label required"); return; }
    const targetDeviceId = portFormScope === "device" ? portFormDeviceId : null;
    if (portFormScope === "device" && targetDeviceId === null) { setPortError("Select a device"); return; }
    setPortBusy(true);
    setPortError(null);
    try {
      await Promise.all(ports.map((port) =>
        api.createPortTarget(accessToken, {
          device_id: targetDeviceId,
          port,
          label: portFormLabel.trim(),
          check_type: "tcp",
          enabled: true,
        })
      ));
      setPortFormPort(""); setPortFormLabel(""); setPortFormScope("global"); setPortFormDeviceId(null); setPortDeviceSearch(""); setPortDeviceDropOpen(false); setShowPortForm(false);
      setPortTargets(await api.listPortTargets(accessToken));
    } catch {
      setPortError("Failed to add service check");
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
  const selectedPortTargets = selectedId === null ? [] : portTargets.filter((p) => p.device_id === selectedId);

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
          label="Live ping"
          value={livePingEnabled ? "On" : "Off"}
          sub={livePingEnabled ? "polling enabled" : "polling disabled"}
          icon={<Activity size={20} />}
          accent={livePingEnabled ? "green" : "red"}
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
              <select className="toolbar-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="warning">Warning</option>
                <option value="unknown">Unknown</option>
              </select>
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
              <button type="button" className="toolbar-btn toolbar-btn--sm" onClick={resetColWidths} title="Reset column widths to default">
                Reset columns
              </button>
              {canManagePorts && (
                <button type="button" className="toolbar-btn toolbar-btn--sm toolbar-btn--primary" onClick={() => setShowPortForm(true)}>
                  + Add service check
                </button>
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
            </div>
          </div>
          <div className="dash-panel-body mon-table-body">
            {filteredDevices.length === 0 ? (
              <p className="dash-empty">
                {devices.length === 0
                  ? `No data yet — the monitor polls every ${monitorIntervalLabel}.`
                  : "No devices match your filter."}
              </p>
            ) : (
              <table
                className="mon-table"
                ref={tableRef}
                style={{ tableLayout: "fixed" }}
              >
                <colgroup>
                  <col style={{ width: 40 }} />
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
                    <th style={{ width: 40 }}>
                      <button type="button" className={`inventory-sort-btn${sortKey === "status" ? " active" : ""}`} onClick={() => toggleSort("status")} title="Sort by status">
                        {sortKey === "status" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                    </th>
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
                      Services
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
                              <span key={r.target_id ?? `${r.label}-${r.port}`} className={`mon-port-badge mon-port-badge--${r.open ? "open" : "closed"}`} title={`${r.label} :${r.port}`}>{r.label}</span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="mon-cell-mono">{fmtTime(d.last_checked)}</td>
                      <td>
                        <button
                          type="button"
                          className={`fav-btn${favouriteIds.has(d.device_id) ? " fav-btn--active" : ""}`}
                          title={favouriteIds.has(d.device_id) ? "Remove from favourites" : "Add to favourites"}
                          onClick={(e) => { e.stopPropagation(); onToggleFavourite(d.device_id); }}
                        >
                          <Star size={13} fill={favouriteIds.has(d.device_id) ? "currentColor" : "none"} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Service checks sidebar */}
        <div className="dash-panel mon-ports-sidebar">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Service checks</span>
          </div>
          <div className="dash-panel-body" style={{ padding: "14px 18px" }}>
            <div className="mon-port-chips">
              {globalPortTargets.length === 0 && (
                <p className="dash-empty" style={{ margin: 0 }}>No service checks configured.</p>
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
            {selectedDevice && (
              <div className="mon-port-chips" style={{ marginTop: 10 }}>
                <span className="dash-panel-meta" style={{ width: "100%" }}>
                  {selectedDevice.display_name ?? selectedDevice.hostname ?? selectedDevice.ip_address}
                </span>
                {selectedPortTargets.length === 0 ? (
                  <p className="dash-empty" style={{ margin: 0 }}>No device-specific checks.</p>
                ) : selectedPortTargets.map((p) => (
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
            )}
          </div>
        </div>

      </div>{/* end mon-content */}

      {/* Add service check modal */}
      {showPortForm && (
        <Modal
          title="Add service check"
          onCancel={() => {
            setPortFormPort(""); setPortFormLabel(""); setPortFormScope("global");
            setPortFormDeviceId(null); setPortDeviceSearch(""); setPortDeviceDropOpen(false);
            setShowPortForm(false);
          }}
          headerSubmitFormId="service-check-form"
          headerSubmitLabel="Add"
          headerSubmitDisabled={portBusy}
        >
          <form id="service-check-form" className="modal-form" onSubmit={(e) => void addPortTarget(e)}>
            <div className="modal-form-row">
              <label>
                Port(s)
                <input
                  type="text"
                  placeholder="443 or 67,68 or 8080-8090"
                  value={portFormPort}
                  onChange={(e) => setPortFormPort(e.target.value)}
                  autoFocus
                />
              </label>
              <label>
                Service name
                <input
                  type="text"
                  placeholder="e.g. HTTPS, RDP, DNS"
                  value={portFormLabel}
                  onChange={(e) => setPortFormLabel(e.target.value)}
                  maxLength={60}
                />
              </label>
            </div>
            <label>
              Scope
              <select
                value={portFormScope}
                onChange={(e) => {
                  const scope = e.target.value as "global" | "device";
                  setPortFormScope(scope);
                  if (scope === "device" && selectedId !== null) setPortFormDeviceId(selectedId);
                }}
              >
                <option value="global">All devices</option>
                <option value="device">Specific device</option>
              </select>
            </label>
            {portFormScope === "device" && (
              <label>
                Device
                <div className="ep-picker" ref={portDeviceRef}>
                <button
                  type="button"
                  className={`ep-trigger${portDeviceDropOpen ? " ep-trigger--open" : ""}`}
                  onClick={() => { setPortDeviceDropOpen((o) => !o); setPortDeviceSearch(""); }}
                >
                  <span className="ep-trigger-label">
                    {portFormDeviceId !== null ? (() => {
                      const d = devices.find((x) => x.device_id === portFormDeviceId);
                      return d ? (
                        <>
                          <span className="ep-trigger-name">{d.display_name ?? d.hostname ?? d.ip_address}</span>
                          <span className="ep-trigger-sub">{d.ip_address}</span>
                        </>
                      ) : <span className="ep-trigger-placeholder">— select device —</span>;
                    })() : <span className="ep-trigger-placeholder">— select device —</span>}
                  </span>
                  <ChevronDown size={13} className={`ep-chevron${portDeviceDropOpen ? " ep-chevron--open" : ""}`} />
                </button>
                {portDeviceDropOpen && (() => {
                  const q = portDeviceSearch.toLowerCase();
                  const filtered = devices.filter((d) =>
                    !portDeviceSearch ||
                    (d.display_name ?? "").toLowerCase().includes(q) ||
                    (d.hostname ?? "").toLowerCase().includes(q) ||
                    d.ip_address.toLowerCase().includes(q)
                  );
                  return (
                    <div className="ep-dropdown" role="listbox">
                      <div className="ep-search-row">
                        <Search size={12} className="ep-search-icon" />
                        <input
                          className="ep-search"
                          placeholder="Search devices…"
                          autoFocus
                          value={portDeviceSearch}
                          onChange={(e) => setPortDeviceSearch(e.target.value)}
                        />
                      </div>
                      <div className="ep-list">
                        {filtered.map((d) => (
                          <div
                            key={d.device_id}
                            role="option"
                            aria-selected={portFormDeviceId === d.device_id}
                            className={`ep-option${portFormDeviceId === d.device_id ? " ep-option--selected" : ""}`}
                            onMouseDown={() => {
                              setPortFormDeviceId(d.device_id);
                              setPortDeviceDropOpen(false);
                              setPortDeviceSearch("");
                            }}
                          >
                            <span className="ep-option-name">{d.display_name ?? d.hostname ?? d.ip_address}</span>
                            <span className="ep-option-ip">{d.ip_address}</span>
                          </div>
                        ))}
                        {filtered.length === 0 && (
                          <div className="ep-empty">No results for "{portDeviceSearch}"</div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
              </label>
            )}
            {portError && <span className="form-error">{portError}</span>}
          </form>
        </Modal>
      )}

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
                        Service status
                        <span className="dash-panel-meta">latest check</span>
                      </div>
                      <div className="mon-port-rows">
                        {selectedDevice.latest_port_results.map((r) => (
                          <div key={r.target_id ?? `${r.label}-${r.port}`} className="mon-port-row">
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

import { useState, useEffect, useRef, useMemo, useCallback, useContext, type FormEvent } from "react";
import { useSortableData } from "../../hooks/useSortableData";
import { Search, Star, ChevronUp, ChevronDown, Activity, X } from "lucide-react";
import { IconServer, IconWifi, IconWifiOff, IconAlertCircle, IconPlugConnected, IconGauge } from "@tabler/icons-react";
import {
  api,
  type FleetSummary, type DeviceMonitorSummary, type MonitorHistoryPoint,
  type PortTarget, type AlertEvent, type AlertRule, type DeviceAnalysis, type ServiceCheckType, type HttpMethod,
  type Device,
} from "../../api/client";
import { TopbarNoteCtx } from "../../context";
import { type Incident } from "../../types";
import {
  MON_COL_WIDTHS_KEY, MON_COL_COUNT, MON_DEFAULT_COL_WIDTHS, computeIncidents, loadMonColWidths,
  MON_DEVICES_PAGE_SIZE_KEY, PAGE_SIZE_OPTIONS, loadPageSize,
  MON_STATUS_COL_WIDTH, MON_FAVOURITE_COL_WIDTH, MON_MIN_COL_WIDTH,
} from "../../utils/monitoring";
import { DashStat } from "../../components/DashStat";
import {
  AnomalyBadge, MonStatusDot, RttSparkline, TrendBadge, UptimeBadge,
} from "../../components/MonitorBadges";
import { HeartbeatBar, HeartbeatTimeline } from "../../components/HeartbeatBar";
import { Modal } from "../../components/Modal";
import { DeviceTypeIcon } from "../../components/DeviceTypeIcon";
import { EntityChip } from "../../components/EntityChip";
import { SwatchSelect, type SwatchOption } from "../../components/SwatchSelect";
import { useDeviceTypes } from "../../hooks/useDeviceTypes";
import { deviceTypeChipFor, resolveEntityColor } from "../../utils/entityColor";
import { formatDeviceTypeLabel } from "../../utils/format";
import { iconLabel } from "../../icons";
import { MonitorsPanel, type MonitorStats } from "./MonitorsPanel";
import {
  MONITORING_VIEW_CHANGE_EVENT,
  readMonitoringViewFromLocation,
  type MonitoringViewId,
} from "./monitoringNavigation";

type MonitoringSnapshot = {
  fleet: FleetSummary | null;
  devices: DeviceMonitorSummary[];
  portTargets: PortTarget[];
  cursor: string | null;
  cachedAt: number;
};

const MONITORING_SNAPSHOT_MAX_AGE_MS = 15 * 60_000;
const MONITORING_SNAPSHOT_FRESH_MS = 60_000;
let monitoringSnapshot: MonitoringSnapshot | null = null;

const STATUS_FILTER_OPTIONS: SwatchOption[] = [
  { value: "all", label: "All statuses" },
  { value: "online", label: "Online", color: "#2d9d78" },
  { value: "offline", label: "Offline", color: "#d94b4b" },
  { value: "warning", label: "Warning", color: "#d4912c" },
  { value: "unknown", label: "Unknown", color: "#7a8fa0" },
  { value: "paused", label: "Paused", color: "#7a8fa0" },
];

const HEALTH_FILTER_OPTIONS: SwatchOption[] = [
  { value: "all", label: "All health" },
  { value: "healthy", label: "Expected", color: "#2d9d78" },
  { value: "unhealthy", label: "Unexpected", color: "#d94b4b" },
  { value: "unknown", label: "Unknown", color: "#7a8fa0" },
  { value: "paused", label: "Paused", color: "#7a8fa0" },
];

function getMonitoringSnapshot(): MonitoringSnapshot | null {
  if (!monitoringSnapshot) return null;
  if (Date.now() - monitoringSnapshot.cachedAt > MONITORING_SNAPSHOT_MAX_AGE_MS) {
    monitoringSnapshot = null;
    return null;
  }
  return monitoringSnapshot;
}

function saveMonitoringSnapshot(snapshot: Omit<MonitoringSnapshot, "cachedAt">) {
  monitoringSnapshot = { ...snapshot, cachedAt: Date.now() };
}

export function MonitoringWorkspace({
  accessToken,
  canWrite,
  favouriteIds,
  inventoryDevices,
  livePingEnabled,
  monitorIntervalSeconds,
  onToggleFavourite,
  userRole,
}: {
  accessToken: string;
  canWrite: boolean;
  favouriteIds: Set<number>;
  inventoryDevices: Device[];
  livePingEnabled: boolean;
  monitorIntervalSeconds: number;
  onToggleFavourite: (deviceId: number) => void;
  userRole: string;
}) {
  const [viewTab, setViewTab] = useState<MonitoringViewId>(() => readMonitoringViewFromLocation());
  const [monitorStats, setMonitorStats] = useState<MonitorStats>({ total: 0, online: 0, offline: 0, avgRtt: null });
  const [colWidths, setColWidths] = useState<number[] | null>(loadMonColWidths);
  const resizingRef = useRef<{ colIdx: number; startX: number; startWidth: number } | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const monitorCursorRef = useRef<string | null>(null);
  const deltaPollsRef = useRef(0);
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

  // A handle sits at the right edge of column colIdx and resizes that column and
  // nothing else. Widths come from the DOM on the first drag so the flexible
  // columns freeze at exactly the width they were already rendering at.
  function startColResize(colIdx: number, e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;

    // Snapshot the resizable widths, skipping the fixed Favourite and Status columns.
    const table = tableRef.current;
    const initialWidths: number[] = table
      ? Array.from(table.querySelectorAll<HTMLElement>("thead tr th"))
          .slice(2, 2 + MON_COL_COUNT)
          .map((th) => th.getBoundingClientRect().width)
      : (colWidths ?? MON_DEFAULT_COL_WIDTHS);

    const startWidth = initialWidths[colIdx];
    resizingRef.current = { colIdx, startX, startWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      if (!resizingRef.current) return;
      const { colIdx: ci, startX: sx, startWidth: sw } = resizingRef.current;
      const next = Math.max(MON_MIN_COL_WIDTH, sw + (ev.clientX - sx));
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

  // Double-clicking any divider drops the saved widths entirely, which puts the
  // table back on the stylesheet's flexible default layout rather than on a
  // frozen copy of it.
  function resetColWidths() {
    window.localStorage.removeItem(MON_COL_WIDTHS_KEY);
    setColWidths(null);
  }

  // null while the columns are still flexible (no user-set widths yet) — the
  // stylesheet's width rule governs until the first drag freezes them.
  const fleetTableWidth = colWidths
    ? MON_STATUS_COL_WIDTH + colWidths.reduce((sum, w) => sum + w, 0) + MON_FAVOURITE_COL_WIDTH
    : null;

  const cachedSnapshot = useMemo(getMonitoringSnapshot, []);
  const [fleet, setFleet] = useState<FleetSummary | null>(() => cachedSnapshot?.fleet ?? null);
  const [devices, setDevices] = useState<DeviceMonitorSummary[]>(() => cachedSnapshot?.devices ?? []);
  const [loading, setLoading] = useState(() => cachedSnapshot === null);
  // Tracked apart from `loading` so the device table can show its own placeholder
  // while the stat cards are already up.
  const [devicesLoading, setDevicesLoading] = useState(() => cachedSnapshot === null);
  const devicesRef = useRef<DeviceMonitorSummary[]>(cachedSnapshot?.devices ?? []);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [history, setHistory] = useState<MonitorHistoryPoint[]>([]);
  const [historyHours, setHistoryHours] = useState(24);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [portTargets, setPortTargets] = useState<PortTarget[]>(() => cachedSnapshot?.portTargets ?? []);
  const portTargetsRef = useRef<PortTarget[]>(cachedSnapshot?.portTargets ?? []);
  const [showPortsModal, setShowPortsModal] = useState(false);
  const [portFormPort, setPortFormPort] = useState("");
  const [portFormLabel, setPortFormLabel] = useState("");
  const [portFormProtocol, setPortFormProtocol] = useState<ServiceCheckType>("tcp");
  const [portFormPath, setPortFormPath] = useState("");
  const [portFormMethod, setPortFormMethod] = useState<HttpMethod>("GET");
  const [portFormStatusMin, setPortFormStatusMin] = useState("200");
  const [portFormStatusMax, setPortFormStatusMax] = useState("399");
  const [portFormTimeout, setPortFormTimeout] = useState("");
  const [portFormVerifyTls, setPortFormVerifyTls] = useState(false);
  const [portFormFollowRedirects, setPortFormFollowRedirects] = useState(true);
  const [portFormScope, setPortFormScope] = useState<"global" | "device">("global");
  const [portFormDeviceIds, setPortFormDeviceIds] = useState<Set<number>>(new Set());
  const [portDeviceSearch, setPortDeviceSearch] = useState("");
  const [portBusy, setPortBusy] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const [pauseBusyId, setPauseBusyId] = useState<number | null>(null);
  const [expectationBusyId, setExpectationBusyId] = useState<number | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const { sortKey, sortDir, toggleSort } = useSortableData<"status" | "name" | "type" | "uptime24" | "uptime7" | "rtt" | "checked">("name");
  const [deviceAlertEvents, setDeviceAlertEvents] = useState<AlertEvent[]>([]);
  const [allAlertRules, setAllAlertRules] = useState<AlertRule[]>([]);
  const [analysis, setAnalysis] = useState<DeviceAnalysis | null>(null);
  const [filterGroup, setFilterGroup] = useState("all");
  const [filterSite, setFilterSite] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterHealth, setFilterHealth] = useState("all");
  const [filterDeviceType, setFilterDeviceType] = useState("all");
  const [filterVlan, setFilterVlan] = useState("all");
  const [favouriteFilter, setFavouriteFilter] = useState(false);
  const [devicesPage, setDevicesPage] = useState(1);
  const [devicesPageSize, setDevicesPageSize] = useState(() => loadPageSize(MON_DEVICES_PAGE_SIZE_KEY));
  const deviceTypeOptions = useDeviceTypes(accessToken).options;

  useEffect(() => {
    const syncMonitoringView = () => setViewTab(readMonitoringViewFromLocation());
    window.addEventListener("popstate", syncMonitoringView);
    window.addEventListener("hashchange", syncMonitoringView);
    window.addEventListener(MONITORING_VIEW_CHANGE_EVENT, syncMonitoringView);
    return () => {
      window.removeEventListener("popstate", syncMonitoringView);
      window.removeEventListener("hashchange", syncMonitoringView);
      window.removeEventListener(MONITORING_VIEW_CHANGE_EVENT, syncMonitoringView);
    };
  }, []);

  useEffect(() => {
    if (cachedSnapshot) {
      monitorCursorRef.current = cachedSnapshot.cursor;
      deltaPollsRef.current = 0;
    }
  }, [cachedSnapshot]);

  useEffect(() => {
    devicesRef.current = devices;
  }, [devices]);

  useEffect(() => {
    portTargetsRef.current = portTargets;
  }, [portTargets]);

  useEffect(() => {
    // `devicesLoading` matters as well as `loading`: the summary now lands (and
    // clears `loading`) before the device rows do, and caching that in-between
    // state would leave the next visit painting an empty table.
    if (loading || devicesLoading || fleet === null) return;
    saveMonitoringSnapshot({
      fleet,
      devices,
      portTargets,
      cursor: monitorCursorRef.current,
    });
  }, [devices, devicesLoading, fleet, loading, portTargets]);

  const loadAll = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    setDevicesLoading(true);

    // All three requests go out together, but the workspace no longer waits on
    // the slowest of them. The fleet summary is a handful of aggregates and
    // comes back well before the per-device 24 h/7 d rollups, so the stat cards
    // and the toolbar paint while the table is still filling in. Settling each
    // side to a nullable value keeps a rejection from the slow pair from
    // surfacing as an unhandled rejection while we await the fast one.
    const summaryPromise = api.getMonitoringSummary(accessToken).then(
      (value) => value,
      () => null,
    );
    const restPromise = Promise.all([
      api.listMonitoringDevices(accessToken),
      api.listPortTargets(accessToken),
    ]).then((value) => value, () => null);

    const f = await summaryPromise;
    if (f) setFleet(f);
    setLoading(false);

    const rest = await restPromise;
    if (rest) {
      const [d, p] = rest;
      setDevices(d);
      setPortTargets(p);
      devicesRef.current = d;
      portTargetsRef.current = p;
    }
    if (f) {
      monitorCursorRef.current = f.last_checked;
      deltaPollsRef.current = 0;
      saveMonitoringSnapshot({
        fleet: f,
        devices: rest ? rest[0] : devicesRef.current,
        portTargets: rest ? rest[1] : portTargetsRef.current,
        cursor: f.last_checked,
      });
    }
    if (f === null && rest === null) {
      if (devicesRef.current.length === 0) setError("Failed to load monitoring data");
    } else {
      setError(null);
    }
    setDevicesLoading(false);
    setRefreshing(false);
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
          const next = Array.from(map.values());
          devicesRef.current = next;
          saveMonitoringSnapshot({
            fleet: f,
            devices: next,
            portTargets: portTargetsRef.current,
            cursor: f.last_checked ?? since,
          });
          return next;
        });
      } else {
        saveMonitoringSnapshot({
          fleet: f,
          devices: devicesRef.current,
          portTargets: portTargetsRef.current,
          cursor: f.last_checked ?? since,
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

  useEffect(() => {
    const cached = getMonitoringSnapshot();
    if (!cached) {
      void loadAll();
      return;
    }
    setRefreshing(true);
    const cacheAge = Date.now() - cached.cachedAt;
    const refresh = cacheAge < MONITORING_SNAPSHOT_FRESH_MS && cached.cursor
      ? loadDelta()
      : loadAll();
    void refresh.finally(() => setRefreshing(false));
  }, [loadAll, loadDelta]);
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

  // The monitoring endpoint carries these fields on current backends, while
  // the already-loaded inventory graph is the compatibility source during a
  // rolling frontend/backend update. Both pages therefore render from the
  // same canonical device metadata instead of falling back to generic Device.
  const inventoryMetadataById = useMemo(
    () => new Map(inventoryDevices.map((device) => [device.id, device])),
    [inventoryDevices],
  );
  const displayDevices = useMemo(
    () => devices.map((device) => {
      const inventoryDevice = inventoryMetadataById.get(device.device_id);
      return {
        ...device,
        device_type: device.device_type ?? inventoryDevice?.device_type ?? null,
        icon: device.icon ?? inventoryDevice?.icon ?? null,
      };
    }),
    [devices, inventoryMetadataById],
  );

  const selectedDevice = displayDevices.find((d) => d.device_id === selectedId) ?? null;

  const groupOptions = useMemo(
    () => [...new Set(displayDevices.map((d) => d.topology_group).filter(Boolean))].sort() as string[],
    [displayDevices],
  );
  const siteOptions = useMemo(
    () => [...new Map(displayDevices.filter((d) => d.site_id).map((d) => [d.site_id, d.site_name])).entries()]
      .sort(([, a], [, b]) => (a ?? "").localeCompare(b ?? "")),
    [displayDevices],
  );
  const vlanOptions = useMemo(
    () => [...new Set(displayDevices.map((d) => d.vlan_id).filter(Boolean))].sort() as string[],
    [displayDevices],
  );
  const deviceTypeFilterOptions = useMemo(() => {
    const inUse = [...new Set(displayDevices.map((device) => device.device_type).filter(Boolean) as string[])].sort();
    const hasUntyped = displayDevices.some((device) => !device.device_type);
    return [
      { value: "all", label: "All types" },
      ...(hasUntyped ? [{ value: "none", label: "No type" }] : []),
      ...inUse.map((value) => {
        const configured = deviceTypeOptions.find((option) => option.value === value);
        return {
          value,
          label: configured?.label && configured.label !== value
            ? configured.label
            : formatDeviceTypeLabel(value),
          color: resolveEntityColor(configured?.color, value),
          icon: <DeviceTypeIcon type={value} size={13} />,
        };
      }),
    ];
  }, [displayDevices, deviceTypeOptions]);

  const groupFilterOptions = useMemo<SwatchOption[]>(() => [
    { value: "all", label: "All groups" },
    ...groupOptions.map((group) => ({
      value: group,
      label: group,
      color: resolveEntityColor(null, group),
    })),
  ], [groupOptions]);

  const siteFilterOptions = useMemo<SwatchOption[]>(() => [
    { value: "all", label: "All sites" },
    ...siteOptions.map(([id, name]) => ({
      value: String(id),
      label: name ?? `Site ${id}`,
      color: resolveEntityColor(null, name ?? String(id)),
    })),
  ], [siteOptions]);

  const vlanFilterOptions = useMemo<SwatchOption[]>(() => [
    { value: "all", label: "All VLANs" },
    ...vlanOptions.map((vlan) => ({
      value: vlan,
      label: `VLAN ${vlan}`,
      color: resolveEntityColor(null, `vlan-${vlan}`),
    })),
  ], [vlanOptions]);

  useEffect(() => {
    if (filterDeviceType === "all") return;
    if (!deviceTypeFilterOptions.some((option) => option.value === filterDeviceType)) {
      setFilterDeviceType("all");
    }
  }, [deviceTypeFilterOptions, filterDeviceType]);

  const filteredDevices = useMemo(() => {
    const q = searchQ.toLowerCase();
    let filtered = q
      ? displayDevices.filter(
          (d) =>
            (d.display_name ?? "").toLowerCase().includes(q) ||
            (d.hostname ?? "").toLowerCase().includes(q) ||
            d.ip_address.toLowerCase().includes(q) ||
            (d.device_type ?? "").toLowerCase().includes(q),
        )
      : [...displayDevices];

    if (filterGroup !== "all") filtered = filtered.filter((d) => d.topology_group === filterGroup);
    if (filterSite !== "all") filtered = filtered.filter((d) => String(d.site_id) === filterSite);
    if (filterStatus !== "all") filtered = filtered.filter((d) => d.status === filterStatus);
    if (filterHealth !== "all") filtered = filtered.filter((d) => d.health_status === filterHealth);
    if (filterDeviceType !== "all") {
      filtered = filtered.filter((d) => filterDeviceType === "none" ? !d.device_type : d.device_type === filterDeviceType);
    }
    if (filterVlan !== "all") filtered = filtered.filter((d) => d.vlan_id === filterVlan);
    if (favouriteFilter) filtered = filtered.filter((d) => favouriteIds.has(d.device_id));

    const dir = sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      switch (sortKey) {
        case "status": {
          const order: Record<string, number> = { healthy: 0, paused: 1, unknown: 2, unhealthy: 3 };
          return ((order[a.health_status] ?? 3) - (order[b.health_status] ?? 3)) * dir;
        }
        case "name": {
          const na = (a.display_name ?? a.hostname ?? a.ip_address).toLowerCase();
          const nb = (b.display_name ?? b.hostname ?? b.ip_address).toLowerCase();
          return na.localeCompare(nb) * dir;
        }
        case "type":
          return (a.device_type ?? "").localeCompare(b.device_type ?? "") * dir;
        case "uptime24":
          return ((a.compliance_24h ?? -1) - (b.compliance_24h ?? -1)) * dir;
        case "uptime7":
          return ((a.compliance_7d ?? -1) - (b.compliance_7d ?? -1)) * dir;
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
  }, [displayDevices, searchQ, filterGroup, filterSite, filterStatus, filterHealth, filterDeviceType, filterVlan, favouriteFilter, favouriteIds, sortKey, sortDir]);

  const paginatedDevices = useMemo(() => {
    const start = (devicesPage - 1) * devicesPageSize;
    return filteredDevices.slice(start, start + devicesPageSize);
  }, [filteredDevices, devicesPage, devicesPageSize]);

  useEffect(() => {
    setDevicesPage(1);
  }, [filteredDevices.length, devicesPageSize]);

  useEffect(() => {
    window.localStorage.setItem(MON_DEVICES_PAGE_SIZE_KEY, String(devicesPageSize));
  }, [devicesPageSize]);

  const unexpectedDevices = useMemo(() => devices.filter((d) => d.health_status === "unhealthy"), [devices]);

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
    const isDhcp = portFormProtocol === "dhcp";
    const ports = isDhcp ? [67] : parsePorts(portFormPort);
    if (!ports) { setPortError("Invalid port — use a number, range (e.g. 60-65), or comma-separated list (e.g. 9001, 9040, 8054)"); return; }
    if (!portFormLabel.trim()) { setPortError("Label required"); return; }
    if ((portFormScope === "device" || isDhcp) && portFormDeviceIds.size === 0) {
      setPortError(isDhcp ? "Select at least one DHCP server device" : "Select at least one device");
      return;
    }
    const isHttp = portFormProtocol === "http" || portFormProtocol === "https";
    const statusMin = parseInt(portFormStatusMin, 10);
    const statusMax = parseInt(portFormStatusMax, 10);
    if (isHttp && (isNaN(statusMin) || isNaN(statusMax) || statusMin < 100 || statusMax > 599 || statusMin > statusMax)) {
      setPortError("Expected status range must be a valid 100-599 range (min ≤ max)");
      return;
    }
    const timeoutSeconds = portFormTimeout.trim() ? parseFloat(portFormTimeout) : null;
    if (isHttp && timeoutSeconds !== null && (isNaN(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30)) {
      setPortError("Timeout must be between 1 and 30 seconds");
      return;
    }
    setPortBusy(true);
    setPortError(null);
    try {
      const deviceIds = portFormScope === "device" || isDhcp ? Array.from(portFormDeviceIds) : [null];
      await Promise.all(
        deviceIds.flatMap((deviceId) =>
          ports.map((port) =>
            api.createPortTarget(accessToken, {
              device_id: deviceId,
              port,
              label: portFormLabel.trim(),
              check_type: portFormProtocol,
              http_path: isHttp && portFormPath.trim() ? portFormPath.trim() : null,
              http_method: isHttp ? portFormMethod : undefined,
              expected_status_min: isHttp ? statusMin : undefined,
              expected_status_max: isHttp ? statusMax : undefined,
              timeout_seconds: isHttp ? timeoutSeconds : undefined,
              verify_tls: isHttp ? portFormVerifyTls : undefined,
              follow_redirects: isHttp ? portFormFollowRedirects : undefined,
              enabled: true,
            })
          )
        )
      );
      setPortFormPort(""); setPortFormLabel(""); setPortFormScope("global"); setPortFormDeviceIds(new Set()); setPortDeviceSearch("");
      setPortFormMethod("GET"); setPortFormStatusMin("200"); setPortFormStatusMax("399");
      setPortFormTimeout(""); setPortFormVerifyTls(false); setPortFormFollowRedirects(true);
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

  async function toggleDevicePause(device: DeviceMonitorSummary) {
    const shouldPause = !device.monitoring_paused;
    setPauseBusyId(device.device_id);
    try {
      await api.updateDevice(accessToken, device.device_id, { monitoring_paused: shouldPause });
      setDevices((current) =>
        current.map((row) =>
          row.device_id === device.device_id
            ? {
                ...row,
                status: shouldPause || row.lifecycle !== "active" ? "paused" : "unknown",
                monitoring_paused: shouldPause,
                flapping: shouldPause ? false : row.flapping,
              }
            : row,
        ),
      );
      setFleet((current) =>
        current
          ? {
              ...current,
              paused: Math.max(0, current.paused + (shouldPause ? 1 : -1)),
            }
          : current,
      );
      if (!shouldPause) {
        void loadAll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update monitoring pause");
    } finally {
      setPauseBusyId(null);
    }
  }

  async function toggleExpectedState(device: DeviceMonitorSummary) {
    const expectedStatus = device.expected_status === "offline" ? "online" : "offline";
    setExpectationBusyId(device.device_id);
    try {
      await api.updateDevice(accessToken, device.device_id, { expected_status: expectedStatus });
      const nextHealth: DeviceMonitorSummary["health_status"] = device.monitoring_paused || device.lifecycle !== "active"
        ? "paused"
        : device.status === "online" || device.status === "offline"
        ? device.status === expectedStatus ? "healthy" : "unhealthy"
        : "unknown";
      setDevices((current) => current.map((row) => row.device_id === device.device_id
        ? { ...row, expected_status: expectedStatus, health_status: nextHealth }
        : row));
      setFleet((current) => {
        if (!current || device.health_status === nextHealth) return current;
        return {
          ...current,
          healthy: Math.max(0, current.healthy + (nextHealth === "healthy" ? 1 : 0) - (device.health_status === "healthy" ? 1 : 0)),
          unhealthy: Math.max(0, current.unhealthy + (nextHealth === "unhealthy" ? 1 : 0) - (device.health_status === "unhealthy" ? 1 : 0)),
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update expected state");
    } finally {
      setExpectationBusyId(null);
    }
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
      {viewTab === "endpoints" ? (
        <div className="dash-stats dash-stats--monitoring nm-summary-band">
          <DashStat label="Endpoints" value={monitorStats.total} sub={monitorStats.total === 0 ? "none yet" : "HTTP/HTTPS targets"} icon={<IconPlugConnected size={20} />} accent="teal" />
          <DashStat label="Up" value={monitorStats.online} sub="responding" icon={<IconWifi size={20} />} accent="green" />
          <DashStat label="Down" value={monitorStats.offline} sub={monitorStats.offline > 0 ? "need attention" : "all clear"} icon={<IconWifiOff size={20} />} accent={monitorStats.offline > 0 ? "red" : "green"} />
          <DashStat label="Avg response" value={monitorStats.avgRtt !== null ? `${monitorStats.avgRtt.toFixed(0)} ms` : "—"} sub="last 24h" icon={<IconGauge size={20} />} accent="indigo" />
        </div>
      ) : (
      <div className="dash-stats dash-stats--monitoring nm-summary-band">
        <DashStat
          label="Monitored"
          value={fleet?.total ?? 0}
          sub={(fleet?.paused ?? 0) > 0 ? `${fleet?.paused} paused` : fleet?.total === 0 ? "no active devices" : "active devices"}
          icon={<IconServer size={20} />}
          accent="teal"
          onClick={() => { setFilterStatus("all"); setFilterHealth("all"); }}
        />
        <DashStat
          label="Live ping"
          value={livePingEnabled ? "On" : "Off"}
          sub={livePingEnabled ? "polling enabled" : "polling disabled"}
          icon={<Activity size={20} />}
          accent={livePingEnabled ? "green" : "red"}
        />
        <DashStat
          label="Healthy"
          value={fleet?.healthy ?? 0}
          sub="in expected state"
          icon={<IconWifi size={20} />}
          accent="green"
          onClick={() => setFilterHealth((current) => current === "healthy" ? "all" : "healthy")}
          active={filterHealth === "healthy"}
        />
        <DashStat
          label="Unexpected"
          value={fleet?.unhealthy ?? 0}
          sub={(fleet?.unhealthy ?? 0) > 0 ? "need attention" : "all clear"}
          icon={<IconWifiOff size={20} />}
          accent={(fleet?.unhealthy ?? 0) > 0 ? "red" : "green"}
          onClick={() => setFilterHealth((current) => current === "unhealthy" ? "all" : "unhealthy")}
          active={filterHealth === "unhealthy"}
        />
        {(() => {
          const labels = [...new Set(portTargets.map((p) => p.label))].sort();
          const shown = labels.slice(0, 3);
          const extra = labels.length - shown.length;
          return (
            <button
              type="button"
              className="dash-stat dash-stat--blue dash-stat--clickable"
              onClick={() => setShowPortsModal(true)}
              title="Manage service checks"
            >
              <div className="dash-stat-icon"><IconPlugConnected size={20} /></div>
              <div className="dash-stat-body">
                <strong className="dash-stat-value">{labels.length}</strong>
                <span className="dash-stat-label">Monitored ports</span>
                <span className="dash-stat-sub">
                  {labels.length === 0
                    ? "click to add checks"
                    : shown.join(" · ") + (extra > 0 ? ` +${extra} more` : "")}
                </span>
              </div>
            </button>
          );
        })()}
      </div>
      )}

      {/* Unexpected-state alert */}
      {viewTab === "devices" && unexpectedDevices.length > 0 && (
        <div className="dash-alert">
          <IconAlertCircle size={15} />
          <span>
            <strong>{unexpectedDevices.length} device{unexpectedDevices.length !== 1 ? "s" : ""} in an unexpected state</strong>
            {" — "}
            {unexpectedDevices.slice(0, 4).map((d) => d.display_name ?? d.hostname ?? d.ip_address).join(", ")}
            {unexpectedDevices.length > 4 && ` and ${unexpectedDevices.length - 4} more`}
          </span>
        </div>
      )}

      {/* Device / endpoint list */}
      <div className="mon-content">
        <div key={viewTab} className={`dash-panel mon-view-window mon-view-window--${viewTab}`}>
          {viewTab === "devices" && <div className="dash-panel-header mon-device-window-header">
              <div className="mon-table-toolbar-meta">
                <strong>Devices</strong>
                <span>
                  {filteredDevices.length === devices.length
                    ? `${devices.length} device${devices.length === 1 ? "" : "s"}`
                    : `${filteredDevices.length} of ${devices.length}`}
                </span>
              </div>
              <div className="mon-panel-controls">
                {refreshing && <span className="mon-refresh-status">Updating...</span>}
                <SwatchSelect
                  ariaLabel="Filter by status"
                  className="mon-filter-picker"
                  value={filterStatus}
                  options={STATUS_FILTER_OPTIONS}
                  onChange={setFilterStatus}
                />
                <SwatchSelect
                  ariaLabel="Filter by expected-state health"
                  className="mon-filter-picker"
                  value={filterHealth}
                  options={HEALTH_FILTER_OPTIONS}
                  onChange={setFilterHealth}
                />
                <SwatchSelect
                  ariaLabel="Filter by device type"
                  className="mon-filter-picker"
                  value={filterDeviceType}
                  options={deviceTypeFilterOptions}
                  onChange={setFilterDeviceType}
                />
                {groupOptions.length > 0 && (
                  <SwatchSelect ariaLabel="Filter by group" className="mon-filter-picker" value={filterGroup} options={groupFilterOptions} onChange={setFilterGroup} />
                )}
                {siteOptions.length > 0 && (
                  <SwatchSelect ariaLabel="Filter by site" className="mon-filter-picker" value={filterSite} options={siteFilterOptions} onChange={setFilterSite} />
                )}
                {vlanOptions.length > 0 && (
                  <SwatchSelect ariaLabel="Filter by VLAN" className="mon-filter-picker" value={filterVlan} options={vlanFilterOptions} onChange={setFilterVlan} />
                )}
                <button
                  type="button"
                  className={`inv-status-tab inv-fav-filter${favouriteFilter ? " active" : ""}`}
                  onClick={() => setFavouriteFilter((current) => !current)}
                  title={favouriteFilter ? "Show all devices" : "Show favourites only"}
                >
                  <Star size={13} fill={favouriteFilter ? "currentColor" : "none"} />
                  Favs
                </button>
                {canManagePorts && (
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" onClick={() => setShowPortsModal(true)}>
                    Ports
                  </button>
                )}
                <div className="mon-search-wrap nm-search">
                  <Search size={13} className="nm-search-icon" />
                  <input
                    className="mon-search nm-input"
                    placeholder="Search devices…"
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                  />
                </div>
              </div>
          </div>}
          <div className={`dash-panel-body mon-table-body${viewTab === "devices" ? " mon-table-body--fleet" : ""}`}>
            {viewTab === "endpoints" && <div className="mon-tab-panel">
              <MonitorsPanel
                accessToken={accessToken}
                canWrite={canManagePorts}
                embedded
                onStatsChange={setMonitorStats}
              />
            </div>}
            {viewTab === "devices" && (filteredDevices.length === 0 ? (
              <p className="dash-empty">
                {devicesLoading && devices.length === 0
                  ? "Loading devices…"
                  : devices.length === 0
                    ? `No data yet — the monitor polls every ${monitorIntervalLabel}.`
                    : "No devices match your filter."}
              </p>
            ) : (
              <table
                className="mon-table mon-table--fleet"
                ref={tableRef}
                // Once the user has set widths the table must be exactly as wide
                // as its columns add up to. Leaving it at the stylesheet's
                // max(100%, 1580px) makes table-layout: fixed spread the
                // difference over every column, so dragging one handle would
                // visibly resize the others too.
                style={{
                  tableLayout: "fixed",
                  ...(fleetTableWidth !== null ? { width: `max(100%, ${fleetTableWidth}px)` } : null),
                }}
              >
                <colgroup>
                  <col style={{ width: MON_FAVOURITE_COL_WIDTH }} />
                  <col style={{ width: MON_STATUS_COL_WIDTH }} />
                  {colWidths
                    ? colWidths.map((w, i) => <col key={i} style={{ width: w }} />)
                    : <>
                        <col style={{ width: MON_DEFAULT_COL_WIDTHS[0] }} />{/* Device */}
                        <col style={{ width: MON_DEFAULT_COL_WIDTHS[1] }} />{/* Type */}
                        <col />{/* 24H: equal share */}
                        <col />{/* 7D: equal share */}
                        <col />{/* Avg RTT: equal share */}
                        <col />{/* Services: equal share */}
                        <col />{/* Checked: equal share */}
                      </>
                  }
                  {colWidths && <col className="mon-table-filler-col" />}
                </colgroup>
                <thead>
                  <tr>
                    <th title="Favourite" />
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "status" ? " active" : ""}`} onClick={() => toggleSort("status")} title="Sort by status">
                        {sortKey === "status" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "name" ? " active" : ""}`} onClick={() => toggleSort("name")}>
                        Device{sortKey === "name" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div
                        className="mon-col-resize-handle"
                        onMouseDown={(e) => startColResize(0, e)}
                        onDoubleClick={resetColWidths}
                        title="Drag to resize · double-click to reset all columns"
                      />
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "type" ? " active" : ""}`} onClick={() => toggleSort("type")}>
                        Type{sortKey === "type" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div
                        className="mon-col-resize-handle"
                        onMouseDown={(e) => startColResize(1, e)}
                        onDoubleClick={resetColWidths}
                        title="Drag to resize · double-click to reset all columns"
                      />
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "uptime24" ? " active" : ""}`} onClick={() => toggleSort("uptime24")}>
                        24 h health{sortKey === "uptime24" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div
                        className="mon-col-resize-handle"
                        onMouseDown={(e) => startColResize(2, e)}
                        onDoubleClick={resetColWidths}
                        title="Drag to resize · double-click to reset all columns"
                      />
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "uptime7" ? " active" : ""}`} onClick={() => toggleSort("uptime7")}>
                        7 d health{sortKey === "uptime7" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div
                        className="mon-col-resize-handle"
                        onMouseDown={(e) => startColResize(3, e)}
                        onDoubleClick={resetColWidths}
                        title="Drag to resize · double-click to reset all columns"
                      />
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "rtt" ? " active" : ""}`} onClick={() => toggleSort("rtt")}>
                        Avg RTT{sortKey === "rtt" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div
                        className="mon-col-resize-handle"
                        onMouseDown={(e) => startColResize(4, e)}
                        onDoubleClick={resetColWidths}
                        title="Drag to resize · double-click to reset all columns"
                      />
                    </th>
                    <th>
                      Services
                      <div
                        className="mon-col-resize-handle"
                        onMouseDown={(e) => startColResize(5, e)}
                        onDoubleClick={resetColWidths}
                        title="Drag to resize · double-click to reset all columns"
                      />
                    </th>
                    <th>
                      <button type="button" className={`inventory-sort-btn${sortKey === "checked" ? " active" : ""}`} onClick={() => toggleSort("checked")}>
                        Checked{sortKey === "checked" && (sortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                      </button>
                      <div
                        className="mon-col-resize-handle"
                        onMouseDown={(e) => startColResize(6, e)}
                        onDoubleClick={resetColWidths}
                        title="Drag to resize · double-click to reset all columns"
                      />
                    </th>
                    {colWidths && <th className="mon-table-filler" aria-hidden="true" />}
                  </tr>
                </thead>
                <tbody>
                  {paginatedDevices.map((d) => (
                    <tr
                      key={d.device_id}
                      className={`mon-row${selectedId === d.device_id ? " mon-row--active" : ""}`}
                      onClick={() => setSelectedId(selectedId === d.device_id ? null : d.device_id)}
                    >
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
                      <td><MonStatusDot status={d.health_status} /></td>
                      <td>
                        <div className="mon-device-cell">
                          <div className="mon-device-meta">
                            <span className="mon-device-name">
                              {d.display_name ?? d.hostname ?? d.ip_address}
                              {d.flapping && <span className="mon-flap-badge" title="Status changed 4+ times in the last hour">flapping</span>}
                              {d.expected_status === "offline" && <span className="mon-expected-badge" title="This device is healthy while offline">expected offline</span>}
                            </span>
                            <span className="mon-device-ip">{d.ip_address}</span>
                          </div>
                          {d.heartbeat.length > 0 && <HeartbeatBar beats={d.heartbeat.slice(-48)} health={d.heartbeat_health.slice(-48)} size="sm" />}
                        </div>
                      </td>
                      <td>
                        {(() => {
                          const chip = deviceTypeChipFor(d.device_type, deviceTypeOptions);
                          return (
                            <EntityChip
                              label={d.device_type ? formatDeviceTypeLabel(d.device_type) : iconLabel(d.icon ?? "device")}
                              color={chip?.color}
                              colorKey={chip?.key ?? d.device_type ?? d.icon ?? "device"}
                              icon={<DeviceTypeIcon type={d.device_type} size={13} />}
                            />
                          );
                        })()}
                      </td>
                      <td><UptimeBadge value={d.compliance_24h} /></td>
                      <td><UptimeBadge value={d.compliance_7d} /></td>
                      <td className="mon-cell-mono">{fmtRtt(d.avg_rtt_24h)}</td>
                      <td>
                        {d.latest_port_results.length === 0 ? (
                          <span className="dash-panel-meta">—</span>
                        ) : (
                          <span className="mon-port-badges">
                            {d.latest_port_results.map((r) => (
                              <span
                              key={r.target_id ?? `${r.label}-${r.port}`}
                              className={`mon-port-badge mon-port-badge--${r.open ? "open" : "closed"}`}
                              title={`${r.label} ${r.check_type.toUpperCase()}:${r.port}${r.status_code !== null ? ` · HTTP ${r.status_code}` : ""}${r.response_time_ms !== null ? ` · ${Math.round(r.response_time_ms)} ms` : ""}${r.error ? ` · ${r.error}` : ""}`}
                            >{r.label}</span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="mon-cell-mono">{fmtTime(d.last_checked)}</td>
                      {colWidths && <td className="mon-table-filler" aria-hidden="true" />}
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
          {viewTab === "devices" && filteredDevices.length > 0 && (
            <div className="inv-pagination">
              <span className="inv-pagination-info">
                Showing {Math.min((devicesPage - 1) * devicesPageSize + 1, filteredDevices.length)}–{Math.min(devicesPage * devicesPageSize, filteredDevices.length)} of {filteredDevices.length} device{filteredDevices.length !== 1 ? "s" : ""}
              </span>
              <div className="inv-pagination-controls">
                <span style={{ fontSize: 11, opacity: 0.7 }}>Per page:</span>
                <select
                  className="inv-pagination-select"
                  value={devicesPageSize}
                  onChange={(e) => setDevicesPageSize(Number(e.target.value))}
                >
                  {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button
                  type="button"
                  className="inv-pagination-btn"
                  disabled={devicesPage <= 1}
                  onClick={() => setDevicesPage((p) => p - 1)}
                >
                  ‹ Prev
                </button>
                <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                  {devicesPage} / {Math.max(1, Math.ceil(filteredDevices.length / devicesPageSize))}
                </span>
                <button
                  type="button"
                  className="inv-pagination-btn"
                  disabled={devicesPage >= Math.ceil(filteredDevices.length / devicesPageSize)}
                  onClick={() => setDevicesPage((p) => p + 1)}
                >
                  Next ›
                </button>
              </div>
            </div>
          )}
        </div>

      </div>{/* end mon-content */}

      {/* Service checks modal — form on left, existing list on right */}
      {showPortsModal && (
        <Modal
          title="Port Monitoring"
          wide
          onCancel={() => {
            setPortFormPort(""); setPortFormLabel(""); setPortFormScope("global");
            setPortFormDeviceIds(new Set()); setPortDeviceSearch(""); setShowPortsModal(false);
          }}
          headerSubmitFormId={canManagePorts ? "service-check-form" : undefined}
          headerSubmitLabel={canManagePorts ? "Add" : undefined}
          headerSubmitDisabled={portBusy}
        >
          <div className="mon-ports-modal-body">

            {/* Left column: add form */}
            {canManagePorts && (
              <div className="mon-ports-form-col">
                <form id="service-check-form" onSubmit={(e) => void addPortTarget(e)}>
                  <label className="mon-ports-field-label">
                    Service name
                    <input
                      type="text"
                      className="mon-ports-input"
                      placeholder="e.g. HTTPS, RDP, DNS"
                      value={portFormLabel}
                      onChange={(e) => setPortFormLabel(e.target.value)}
                      maxLength={60}
                      autoFocus
                    />
                  </label>
                  <label className="mon-ports-field-label">
                    Port(s)
                    <input
                      type="text"
                      className="mon-ports-input"
                      placeholder="443 or 67,68 or 8080-8090"
                      value={portFormProtocol === "dhcp" ? "67" : portFormPort}
                      onChange={(e) => setPortFormPort(e.target.value)}
                      disabled={portFormProtocol === "dhcp"}
                    />
                  </label>
                  <label className="mon-ports-field-label">
                    Protocol
                    <select
                      className="mon-ports-input"
                      value={portFormProtocol}
                      onChange={(e) => {
                        const protocol = e.target.value as ServiceCheckType;
                        setPortFormProtocol(protocol);
                        if (protocol === "dhcp") {
                          setPortFormScope("device");
                          if (selectedId !== null) setPortFormDeviceIds(new Set([selectedId]));
                        }
                      }}
                    >
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                      <option value="dhcp">DHCP</option>
                      <option value="http">HTTP</option>
                      <option value="https">HTTPS</option>
                    </select>
                  </label>
                  {portFormProtocol === "dhcp" && (
                    <div className="nm-alert nm-alert--info" role="note">
                      Sends a DHCPINFORM request to UDP/67 and requires a matching DHCPACK. It never requests or reserves a lease and must target a specific IPv4 device.
                    </div>
                  )}
                  {(portFormProtocol === "http" || portFormProtocol === "https") && (
                    <>
                      <label className="mon-ports-field-label">
                        Path (optional)
                        <input
                          type="text"
                          className="mon-ports-input"
                          placeholder="/health"
                          value={portFormPath}
                          onChange={(e) => setPortFormPath(e.target.value)}
                          maxLength={200}
                        />
                      </label>
                      <label className="mon-ports-field-label">
                        Method
                        <select
                          className="mon-ports-input"
                          value={portFormMethod}
                          onChange={(e) => setPortFormMethod(e.target.value as HttpMethod)}
                        >
                          {["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"].map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </label>
                      <label className="mon-ports-field-label">
                        Expected status range
                        <div className="mon-ports-range-row">
                          <input
                            type="number"
                            className="mon-ports-input"
                            min={100}
                            max={599}
                            value={portFormStatusMin}
                            onChange={(e) => setPortFormStatusMin(e.target.value)}
                          />
                          <span>–</span>
                          <input
                            type="number"
                            className="mon-ports-input"
                            min={100}
                            max={599}
                            value={portFormStatusMax}
                            onChange={(e) => setPortFormStatusMax(e.target.value)}
                          />
                        </div>
                      </label>
                      <label className="mon-ports-field-label">
                        Timeout (seconds, optional)
                        <input
                          type="number"
                          className="mon-ports-input"
                          placeholder="default"
                          min={1}
                          max={30}
                          value={portFormTimeout}
                          onChange={(e) => setPortFormTimeout(e.target.value)}
                        />
                      </label>
                      <label className="mon-ports-checkbox-label">
                        <input
                          type="checkbox"
                          checked={portFormVerifyTls}
                          onChange={(e) => setPortFormVerifyTls(e.target.checked)}
                        />
                        Verify TLS certificate
                      </label>
                      <label className="mon-ports-checkbox-label">
                        <input
                          type="checkbox"
                          checked={portFormFollowRedirects}
                          onChange={(e) => setPortFormFollowRedirects(e.target.checked)}
                        />
                        Follow redirects
                      </label>
                    </>
                  )}
                  <label className="mon-ports-field-label">
                    Scope
                    <select
                      className="mon-ports-input"
                      value={portFormScope}
                      onChange={(e) => {
                        const scope = e.target.value as "global" | "device";
                        setPortFormScope(scope);
                        if (scope === "device" && selectedId !== null) setPortFormDeviceIds(new Set([selectedId]));
                        else if (scope === "global") setPortFormDeviceIds(new Set());
                      }}
                    >
                      <option value="global" disabled={portFormProtocol === "dhcp"}>All devices</option>
                      <option value="device">Specific devices</option>
                    </select>
                  </label>
                  {portFormScope === "device" && (() => {
                    const q = portDeviceSearch.toLowerCase();
                    const filtered = devices.filter((d) =>
                      !portDeviceSearch ||
                      (d.display_name ?? "").toLowerCase().includes(q) ||
                      (d.hostname ?? "").toLowerCase().includes(q) ||
                      d.ip_address.toLowerCase().includes(q)
                    );
                    return (
                      <label className="mon-ports-field-label">
                        Devices{portFormDeviceIds.size > 0 && <span className="mon-ports-sel-count"> · {portFormDeviceIds.size} selected</span>}
                        <div className="mon-device-picker">
                          <div className="ep-search-row">
                            <Search size={12} className="ep-search-icon" />
                            <input
                              className="ep-search"
                              placeholder="Search devices…"
                              value={portDeviceSearch}
                              onChange={(e) => setPortDeviceSearch(e.target.value)}
                            />
                          </div>
                          <div className="ep-list">
                            {filtered.map((d) => {
                              const selected = portFormDeviceIds.has(d.device_id);
                              return (
                                <div
                                  key={d.device_id}
                                  role="option"
                                  aria-selected={selected}
                                  className={`ep-option ep-option--multi${selected ? " ep-option--selected" : ""}`}
                                  onMouseDown={() => setPortFormDeviceIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(d.device_id)) next.delete(d.device_id);
                                    else next.add(d.device_id);
                                    return next;
                                  })}
                                >
                                  <span className="ep-option-check">{selected ? "✓" : ""}</span>
                                  <span className="ep-option-name">{d.display_name ?? d.hostname ?? d.ip_address}</span>
                                  <span className="ep-option-ip">{d.ip_address}</span>
                                </div>
                              );
                            })}
                            {filtered.length === 0 && (
                              <div className="ep-empty">No results for "{portDeviceSearch}"</div>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })()}
                  {portError && <span className="form-error">{portError}</span>}
                </form>
              </div>
            )}

            {/* Right column: existing checks list */}
            {portTargets.length > 0 && (
              <div className="mon-ports-list-col">
                {portTargets.filter((p) => p.device_id === null).length > 0 && (
                  <div>
                    <p className="mon-checks-group-label">All devices</p>
                    <div className="incident-log">
                      {portTargets.filter((p) => p.device_id === null).map((p) => (
                        <div key={p.id} className="incident-row" style={{ alignItems: "center" }}>
                          <span className="mon-dot mon-dot-online" />
                          <div className="incident-row-body">
                            <span style={{ fontWeight: 600, fontSize: 12.5 }}>{p.label}</span>
                            <span className="dash-panel-meta">{p.check_type.toUpperCase()} port {p.port}</span>
                          </div>
                          {canManagePorts && (
                            <button type="button" className="mon-port-chip-del" onClick={() => void removePortTarget(p.id)} title={`Remove ${p.label}`}>
                              <X size={13} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(() => {
                  const deviceSpecific = portTargets.filter((p) => p.device_id !== null);
                  if (deviceSpecific.length === 0) return null;
                  const grouped = deviceSpecific.reduce<Record<number, PortTarget[]>>((acc, p) => {
                    const key = p.device_id!;
                    if (!acc[key]) acc[key] = [];
                    acc[key].push(p);
                    return acc;
                  }, {});
                  return (
                    <div>
                      <p className="mon-checks-group-label">Device-specific</p>
                      <div className="incident-log">
                        {Object.entries(grouped).map(([deviceIdStr, checks]) => {
                          const devId = Number(deviceIdStr);
                          const dev = devices.find((d) => d.device_id === devId);
                          const devName = dev ? (dev.display_name ?? dev.hostname ?? dev.ip_address) : `Device #${devId}`;
                          return checks.map((p) => (
                            <div key={p.id} className="incident-row" style={{ alignItems: "center" }}>
                              <span className="mon-dot mon-dot-online" />
                              <div className="incident-row-body" style={{ flexDirection: "column", alignItems: "flex-start", gap: 1 }}>
                                <span style={{ fontWeight: 600, fontSize: 12.5 }}>{p.label}</span>
                                <span className="dash-panel-meta">{devName} · {p.check_type.toUpperCase()} port {p.port}</span>
                              </div>
                              {canManagePorts && (
                                <button type="button" className="mon-port-chip-del" onClick={() => void removePortTarget(p.id)} title={`Remove ${p.label}`}>
                                  <X size={13} />
                                </button>
                              )}
                            </div>
                          ));
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

          </div>
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
            <div className={`mon-hero-header mon-hero-header--${selectedDevice.health_status}`}>
              <div className="mon-hero-header-left">
                <MonStatusDot status={selectedDevice.health_status} />
                <div>
                  <div className="mon-hero-name">
                    {selectedDevice.display_name ?? selectedDevice.hostname ?? selectedDevice.ip_address}
                  </div>
                  <div className="mon-hero-sub">
                    {selectedDevice.hostname && selectedDevice.hostname !== selectedDevice.ip_address && (
                      <span>{selectedDevice.hostname} · </span>
                    )}
                    <span className="mon-cell-mono">{selectedDevice.ip_address}</span>
                    <span> · observed {selectedDevice.status}</span>
                    <span> · expected {selectedDevice.expected_status}</span>
                  </div>
                </div>
              </div>
              <div className="mon-hero-actions">
                {canWrite && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={selectedDevice.expected_status === "offline"}
                    aria-label="Upside down"
                    className={`nm-btn nm-btn--sm nm-btn--secondary mon-expectation-toggle${selectedDevice.expected_status === "offline" ? " is-offline" : ""}`}
                    disabled={expectationBusyId === selectedDevice.device_id}
                    onClick={() => void toggleExpectedState(selectedDevice)}
                    title={selectedDevice.expected_status === "offline"
                      ? "Offline is expected and healthy; online is treated as unexpected"
                      : "Online is expected and healthy; offline is treated as unexpected"}
                  >
                    <span className="mon-expectation-label">Upside down</span>
                    {expectationBusyId === selectedDevice.device_id
                      ? <span className="mon-expectation-saving">Saving…</span>
                      : <span className="mon-expectation-track" aria-hidden="true"><span /></span>}
                  </button>
                )}
                {canWrite && (
                  <button
                    type="button"
                    className="nm-btn nm-btn--sm nm-btn--secondary"
                    disabled={pauseBusyId === selectedDevice.device_id || (!selectedDevice.monitoring_paused && selectedDevice.lifecycle !== "active")}
                    onClick={() => void toggleDevicePause(selectedDevice)}
                    title={
                      selectedDevice.lifecycle !== "active" && !selectedDevice.monitoring_paused
                        ? `Lifecycle is ${selectedDevice.lifecycle}; set lifecycle to Active to monitor this device`
                        : selectedDevice.monitoring_paused
                        ? "Resume monitoring for this device"
                        : "Pause monitoring for this device"
                    }
                  >
                    {pauseBusyId === selectedDevice.device_id
                      ? "Saving..."
                      : selectedDevice.monitoring_paused
                      ? "Resume monitoring"
                      : selectedDevice.lifecycle !== "active"
                      ? `Lifecycle: ${selectedDevice.lifecycle}`
                      : "Pause monitoring"}
                  </button>
                )}
                <button type="button" className="mon-hero-close" onClick={() => setSelectedId(null)} title="Close">✕</button>
              </div>
            </div>

            {/* Stat strip */}
            <div className="mon-hero-stats">
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">24 h health</span>
                <UptimeBadge value={selectedDevice.compliance_24h} />
              </div>
              <div className="mon-hero-stat">
                <span className="mon-hero-stat-label">7 d health</span>
                <UptimeBadge value={selectedDevice.compliance_7d} />
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
                            <span className="dash-panel-meta">
                              {r.check_type.toUpperCase()} :{r.port}
                              {r.status_code !== null && ` · HTTP ${r.status_code}`}
                              {r.response_time_ms !== null && ` · ${Math.round(r.response_time_ms)} ms`}
                              {r.error && <span className="mon-port-error"> · {r.error}</span>}
                            </span>
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
                      (r) => r.device_id === selectedDevice.device_id,
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
                            <p className="dash-empty" style={{ margin: 0, padding: "8px 0", textAlign: "center" }}>
                              No alert rules for this device.
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
                                <span className={`mon-dot mon-dot-${inc.end === null ? "unhealthy" : "unknown"}`} />
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

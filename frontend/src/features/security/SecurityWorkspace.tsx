import { ChartPanel, ChartOptionsSlot } from "../../components/ChartPanel";
import { PersonalChart } from "../../components/PersonalChart";
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useContext, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import "./security.css";
import { Ban, Database, Radio, Search, Pause, Play, ChevronDown, ChevronRight, ShieldAlert, SlidersHorizontal, TableProperties, PieChart, Users } from "lucide-react";
import { api, type FirewallEvent, type FirewallEventList, type SavedSecuritySearch, type SyslogStatus, type Device, type TopologyGraph } from "../../api/client";
import { TopbarNoteCtx } from "../../context";
import { type SecurityFilters, emptySecurityFilters } from "../../types";
import { buildFirewallEventsWsUrl, buildSearchParams, eventMatchesFilters, relatedDevicesForEvent } from "../../utils/security";
import { deviceLabel, formatEventTime, toDateTimeLocal } from "../../utils/format";
import { SecurityFilterInput } from "../../components/SecurityFilterInput";
import { useConfirm } from "../../components/ConfirmDialog";
import { ClickableCell } from "../../components/ClickableCell";
import { Modal } from "../../components/Modal";
import { DashStat } from "../../components/DashStat";
import { UsageRing } from "../../components/UsageRing";

const SECURITY_COLUMN_WIDTHS_KEY = "netmap.securityEventColumnWidths.v1";
const SECURITY_COLUMN_COUNT = 11;
const SECURITY_MIN_COLUMN_WIDTH = 56;
const SECURITY_COLUMNS = [
  { label: "Time", sort: "received_at" },
  { label: "Interface", sort: "interface" },
  { label: "Source" },
  { label: "Destination" },
  { label: "Topology" },
  { label: "Protocol", sort: "protocol" },
  { label: "Source Port", sort: "src_port" },
  { label: "Destination Port", sort: "dst_port" },
  { label: "Action", sort: "action" },
  { label: "Rule" },
  { label: "Reason" },
] as const;

type LiveStreamState = "connecting" | "connected" | "reconnecting" | "paused";

function loadSecurityColumnWidths(): number[] | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SECURITY_COLUMN_WIDTHS_KEY) ?? "null");
    if (Array.isArray(parsed) && parsed.length === SECURITY_COLUMN_COUNT && parsed.every((width) => typeof width === "number" && Number.isFinite(width))) {
      return parsed.map((width) => Math.max(SECURITY_MIN_COLUMN_WIDTH, width));
    }
  } catch {
    // Ignore malformed browser preferences and use the responsive defaults.
  }
  return null;
}

function securityGridTemplate(widths: number[]) {
  return widths.map((width) => `${width}px`).join(" ");
}

export function SecurityWorkspace({
  accessToken,
  graph,
  onJumpToTopologyDevice,
}: {
  accessToken: string | null;
  graph: TopologyGraph;
  onJumpToTopologyDevice: (deviceId: number) => void;
}) {
  const confirmAction = useConfirm();
  const [filters, setFilters] = useState<SecurityFilters>(emptySecurityFilters);
  const [draftFilters, setDraftFilters] = useState<SecurityFilters>(emptySecurityFilters);
  const [events, setEvents] = useState<FirewallEvent[]>([]);
  const [status, setStatus] = useState<SyslogStatus | null>(null);
  const [resultMeta, setResultMeta] = useState<FirewallEventList | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState("received_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const [liveTail, setLiveTail] = useState(true);
  const [liveStreamState, setLiveStreamState] = useState<LiveStreamState>("connecting");
  const [autoScroll, setAutoScroll] = useState(true);
  const [eventsRefreshKey, setEventsRefreshKey] = useState(0);
  const [columnWidths, setColumnWidths] = useState<number[] | null>(loadSecurityColumnWidths);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedSearches, setSavedSearches] = useState<SavedSecuritySearch[]>([]);
  const [selectedSearchId, setSelectedSearchId] = useState<number | "">("");
  const [showSaveSearchModal, setShowSaveSearchModal] = useState(false);
  const [saveSearchName, setSaveSearchName] = useState("");
  const [saveSearchBusy, setSaveSearchBusy] = useState(false);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const tableHeaderRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(autoScroll);
  const pendingLiveScrollRef = useRef(false);
  const streamHasConnectedRef = useRef(false);
  const setTopbarNote = useContext(TopbarNoteCtx);
  const pageSize = 100;

  useEffect(() => {
    if (!accessToken) return;
    api.listSavedSecuritySearches(accessToken).then(setSavedSearches).catch(() => { /* non-critical */ });
  }, [accessToken]);

  async function saveCurrentSearch(name: string) {
    if (!accessToken || !name.trim()) return;
    setSaveSearchBusy(true);
    try {
      await api.createSavedSecuritySearch(accessToken, name.trim(), draftFilters as unknown as Record<string, unknown>);
      setSavedSearches(await api.listSavedSecuritySearches(accessToken));
      setShowSaveSearchModal(false);
      setSaveSearchName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save search");
    } finally {
      setSaveSearchBusy(false);
    }
  }

  function applySavedSearch(id: number) {
    const saved = savedSearches.find((s) => s.id === id);
    if (!saved) return;
    const next = { ...emptySecurityFilters, ...(saved.filters as Partial<SecurityFilters>) };
    setSelectedSearchId(id);
    setDraftFilters(next);
    setFilters(next);
    setOffset(0);
  }

  async function deleteSelectedSearch() {
    if (!accessToken || selectedSearchId === "") return;
    const confirmed = await confirmAction({
      title: "Delete saved search",
      message: "Delete this saved search?",
      confirmLabel: "Delete search",
    });
    if (!confirmed) return;
    await api.deleteSavedSecuritySearch(accessToken, selectedSearchId);
    setSelectedSearchId("");
    setSavedSearches(await api.listSavedSecuritySearches(accessToken));
  }

  const devicesByIp = useMemo(() => {
    const mapping = new Map<string, Device[]>();
    graph.devices.forEach((device) => {
      const key = device.ip_address.trim();
      if (!key) {
        return;
      }
      const current = mapping.get(key) ?? [];
      current.push(device);
      mapping.set(key, current);
    });
    return mapping;
  }, [graph.devices]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    const token = accessToken;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [nextStatus, nextEvents] = await Promise.all([
          api.syslogStatus(token),
          api.firewallEvents(token, buildSearchParams(filters, offset, pageSize, sortBy, sortDir)),
        ]);
        if (!cancelled) {
          setStatus(nextStatus);
          setResultMeta(nextEvents);
          setEvents(nextEvents.events);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load firewall events");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, eventsRefreshKey, filters, offset, sortBy, sortDir]);

  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  useLayoutEffect(() => {
    if (!pendingLiveScrollRef.current) {
      return;
    }
    pendingLiveScrollRef.current = false;
    if (tableRef.current) {
      tableRef.current.scrollTop = 0;
    }
  }, [events]);

  useEffect(() => {
    if (!accessToken || !liveTail) {
      setLiveStreamState("paused");
      return;
    }
    const token = accessToken;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let reconnectAttempt = 0;

    function clearHeartbeat() {
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    function scheduleReconnect() {
      if (disposed) return;
      setLiveStreamState("reconnecting");
      const delay = Math.min(1000 * (2 ** reconnectAttempt), 15_000);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    }

    function connect() {
      if (disposed) return;
      setLiveStreamState(reconnectAttempt === 0 ? "connecting" : "reconnecting");
      const nextSocket = new WebSocket(buildFirewallEventsWsUrl());
      socket = nextSocket;
      nextSocket.onopen = () => nextSocket.send(token);
      nextSocket.onmessage = (message) => {
        const payload = JSON.parse(message.data) as FirewallEvent | { type: "ready" | "heartbeat" };
        if ("type" in payload) {
          if (payload.type === "ready") {
            const shouldRefresh = streamHasConnectedRef.current;
            streamHasConnectedRef.current = true;
            reconnectAttempt = 0;
            setLiveStreamState("connected");
            clearHeartbeat();
            heartbeatTimer = window.setInterval(() => {
              if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send("ping");
            }, 30_000);
            if (shouldRefresh) setEventsRefreshKey((current) => current + 1);
          }
          return;
        }
        if (!eventMatchesFilters(payload, filters)) {
          return;
        }
        pendingLiveScrollRef.current = autoScrollRef.current;
        setEvents((current) => [payload, ...current.filter((existing) => existing.id !== payload.id)].slice(0, pageSize));
        setStatus((current) => (current ? { ...current, total_events: current.total_events + 1 } : current));
        setResultMeta((current) => (current ? { ...current, total: current.total + 1 } : current));
      };
      nextSocket.onerror = () => nextSocket.close();
      nextSocket.onclose = () => {
        if (socket !== nextSocket) return;
        socket = null;
        clearHeartbeat();
        scheduleReconnect();
      };
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      clearHeartbeat();
      socket?.close();
    };
  }, [accessToken, filters, liveTail]);

  function startColumnResize(columnIndex: number, event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const renderedWidths = columnWidths ?? (
      tableHeaderRef.current
        ? Array.from(tableHeaderRef.current.querySelectorAll<HTMLElement>(".security-table-heading"))
            .map((heading) => heading.getBoundingClientRect().width)
        : []
    );
    if (renderedWidths.length !== SECURITY_COLUMN_COUNT) return;
    const startX = event.clientX;
    const startWidth = renderedWidths[columnIndex];
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(moveEvent: MouseEvent) {
      const nextWidths = [...renderedWidths];
      nextWidths[columnIndex] = Math.max(SECURITY_MIN_COLUMN_WIDTH, startWidth + moveEvent.clientX - startX);
      setColumnWidths(nextWidths);
    }

    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setColumnWidths((current) => {
        if (current) window.localStorage.setItem(SECURITY_COLUMN_WIDTHS_KEY, JSON.stringify(current));
        return current;
      });
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function resetColumnWidths() {
    window.localStorage.removeItem(SECURITY_COLUMN_WIDTHS_KEY);
    setColumnWidths(null);
  }

  function updateDraftFilter(field: keyof SecurityFilters, value: string) {
    setDraftFilters((current) => ({ ...current, [field]: value }));
  }

  function applyDraftFilters() {
    setOffset(0);
    setFilters(draftFilters);
  }

  function applyFilter(field: keyof SecurityFilters, value: string | number | null) {
    if (value === null || value === "") {
      return;
    }
    const nextFilters = { ...draftFilters, [field]: String(value) };
    setOffset(0);
    setDraftFilters(nextFilters);
    setFilters(nextFilters);
  }

  function applyQuickFilter(kind: "blocked" | "passed" | "wan" | "hour" | "day") {
    const now = new Date();
    setOffset(0);
    setDraftFilters((current) => {
      let nextFilters: SecurityFilters;
      if (kind === "blocked") {
        nextFilters = { ...current, action: "block" };
      } else if (kind === "passed") {
        nextFilters = { ...current, action: "pass" };
      } else if (kind === "wan") {
        nextFilters = { ...current, interface: "wan" };
      } else {
        const start = new Date(now.getTime() - (kind === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000));
        nextFilters = { ...current, start_time: toDateTimeLocal(start), end_time: "" };
      }
      setFilters(nextFilters);
      return nextFilters;
    });
  }

  function changeSort(nextSortBy: string) {
    if (nextSortBy === sortBy) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(nextSortBy);
    setSortDir("desc");
  }

  const total = resultMeta?.total ?? 0;
  const canPrevious = offset > 0;
  const canNext = offset + pageSize < total;

  useEffect(() => {
    setTopbarNote(
      <div className="security-topbar-meta">
        <div className="security-topbar-copy">
          <span>
            {(status?.total_events ?? 0).toLocaleString()} retained events · {status?.retention_days ?? 7} day retention ·{" "}
            {liveTail ? `live stream ${liveStreamState}` : "live stream paused"}
          </span>
          {status && (
            <span>
              Last cleanup {status.retention_last_run_at ? formatEventTime(status.retention_last_run_at) : "not yet run"} ·
              deleted {status.retention_last_deleted} ·
              last event {status.last_event_received_at ? formatEventTime(status.last_event_received_at) : "none"}
              {status.retention_last_error ? ` · cleanup error: ${status.retention_last_error}` : ""}
            </span>
          )}
        </div>
        <div className="security-topbar-controls">
          <button className="nm-btn nm-btn--sm" type="button" onClick={() => setLiveTail((current) => !current)}>
            {liveTail ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            {liveTail ? "Pause" : "Resume"}
          </button>
          <label className="inline-toggle">
            <input defaultChecked={autoScroll} type="checkbox" onChange={(event) => setAutoScroll(event.target.checked)} />
            Auto-scroll
          </label>
        </div>
      </div>
    );
    return () => setTopbarNote("");
  }, [autoScroll, liveStreamState, liveTail, setTopbarNote, status]);

  const actionMix = useMemo(() => {
    const blocked = events.filter((event) => /block|reject|drop/i.test(event.action ?? "")).length;
    const passed = events.filter((event) => /pass|allow/i.test(event.action ?? "")).length;
    return { blocked, passed, other: events.length - blocked - passed, pct: events.length ? Math.round((blocked / events.length) * 100) : 0 };
  }, [events]);
  const topSources = useMemo(() => {
    const counts = new Map<string, { total: number; blocked: number }>();
    for (const event of events) {
      if (!event.src_ip) continue;
      const entry = counts.get(event.src_ip) ?? { total: 0, blocked: 0 };
      entry.total += 1;
      if (/block|reject|drop/i.test(event.action ?? "")) entry.blocked += 1;
      counts.set(event.src_ip, entry);
    }
    return [...counts.entries()].map(([ip, entry]) => ({ ip, ...entry })).sort((a, b) => b.total - a.total).slice(0, 5);
  }, [events]);
  const topSourceMax = topSources[0]?.total ?? 1;

  return (
    <section className="security-layout" id="security">
      {error && <div className="form-error">{error}</div>}
      <div className="security-bento">
        <ChartPanel><section className="security-insight security-mix-panel nm-app-panel nm-hero-visual" aria-label="Traffic Mix">
          <div className="security-panel-header nm-app-panel-header">
            <span className="security-panel-identity"><span className="security-panel-icon"><PieChart size={18} /></span><strong>Traffic Mix</strong><small>{events.length} loaded events</small></span>
            <ChartOptionsSlot />
          </div>
          <PersonalChart id="security.traffic-mix" label="Traffic Mix" base="ring" data={{ kind: "parts", noun: "events", rows: [{ label: "Blocked", value: actionMix.blocked, color: "--dash-red" }, { label: "Passed", value: actionMix.passed, color: "--dash-green" }, { label: "Other", value: actionMix.other, color: "--nm-text-faint" }], series: [{ key: "value", label: "Events", color: "--dash-blue" }] }}>
          <div className="security-mix-body">
            <UsageRing pct={actionMix.pct} label="blocked" tone="danger" />
            <ul className="security-mix-legend">
              <li><span className="security-mix-swatch security-mix-swatch--blocked" aria-hidden="true" /><span>Blocked</span><strong>{actionMix.blocked}</strong></li>
              <li><span className="security-mix-swatch security-mix-swatch--passed" aria-hidden="true" /><span>Passed</span><strong>{actionMix.passed}</strong></li>
              <li><span className="security-mix-swatch security-mix-swatch--other" aria-hidden="true" /><span>Other</span><strong>{actionMix.other}</strong></li>
            </ul>
          </div>
          </PersonalChart>
        </section></ChartPanel>
        <ChartPanel><section className="security-insight security-sources-panel nm-app-panel nm-hero-visual" aria-label="Top Sources">
          <div className="security-panel-header nm-app-panel-header">
            <span className="security-panel-identity"><span className="security-panel-icon"><Users size={18} /></span><strong>Top Sources</strong><small>{topSources.length ? `Top ${topSources.length}` : "No events"}</small></span>
            <ChartOptionsSlot />
          </div>
          <PersonalChart id="security.top-sources" label="Top Sources" base="bars" data={{ kind: "rank", rows: topSources.map(source => ({ label: source.ip, blocked: source.blocked, other: source.total - source.blocked })), series: [{ key: "blocked", label: "Blocked", color: "--dash-red" }, { key: "other", label: "Other events", color: "--dash-blue" }] }}>
          <div className="security-sources-body">
            {topSources.length === 0 ? <div className="dash-empty">No events loaded</div> : topSources.map((source) => (
              <div key={source.ip} className="security-source-row">
                <code>{source.ip}</code>
                <span className="security-source-bar" aria-hidden="true"><span style={{ width: `${(source.total / topSourceMax) * 100}%` }} /></span>
                <span className="security-source-count">{source.total}{source.blocked > 0 && <small>{source.blocked} blocked</small>}</span>
              </div>
            ))}
          </div>
          </PersonalChart>
        </section></ChartPanel>
      <div className="dash-stats dash-stats--four security-summary-grid nm-summary-band" aria-label="Security ingestion summary">
        <DashStat className="security-summary-card" label="Stored events" value={status?.stored_events ?? status?.total_events ?? 0} icon={<Database size={19} />} accent="teal" />
        <DashStat className="security-summary-card" label="Received packets" value={status?.received_packets ?? 0} icon={<Radio size={19} />} accent="green" />
        <DashStat className="security-summary-card" label="Unparsed packets" value={status?.dropped_unparsed ?? 0} icon={<ShieldAlert size={19} />} accent="amber" />
        <DashStat className="security-summary-card" label="Denied senders" value={status?.denied_senders ?? 0} icon={<Ban size={19} />} accent="red" />
      </div>
      </div>
      <div className="security-content">
        <form
          className="security-filters nm-app-panel"
          aria-label="Firewall event filters"
          onSubmit={(event) => {
            event.preventDefault();
            applyDraftFilters();
          }}
        >
          <div className="security-panel-header nm-app-panel-header">
            <span className="security-panel-identity"><span className="security-panel-icon"><SlidersHorizontal size={18} /></span><strong>Event Filters</strong></span>
            <small>{savedSearches.length} saved</small>
          </div>
          <label className="security-search">
            <Search size={16} aria-hidden="true" />
            <input
              placeholder="Search raw log, IP, rule, reason"
              value={draftFilters.q}
              onChange={(event) => updateDraftFilter("q", event.target.value)}
            />
          </label>
          <div className="quick-filters">
            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary quick-filter-block" onClick={() => applyQuickFilter("blocked")}>Blocked</button>
            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary quick-filter-pass" onClick={() => applyQuickFilter("passed")}>Passed</button>
            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => applyQuickFilter("wan")}>WAN</button>
            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => applyQuickFilter("hour")}>Last hour</button>
            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => applyQuickFilter("day")}>Last 24h</button>
          </div>
          <SecurityFilterInput label="Source IP" value={draftFilters.src_ip} onChange={(value) => updateDraftFilter("src_ip", value)} />
          <SecurityFilterInput label="Destination IP" value={draftFilters.dst_ip} onChange={(value) => updateDraftFilter("dst_ip", value)} />
          <SecurityFilterInput label="Source Port" value={draftFilters.src_port} onChange={(value) => updateDraftFilter("src_port", value)} />
          <SecurityFilterInput label="Destination Port" value={draftFilters.dst_port} onChange={(value) => updateDraftFilter("dst_port", value)} />
          <SecurityFilterInput label="Action" value={draftFilters.action} onChange={(value) => updateDraftFilter("action", value)} />
          <SecurityFilterInput label="Protocol" value={draftFilters.protocol} onChange={(value) => updateDraftFilter("protocol", value)} />
          <SecurityFilterInput label="Interface" value={draftFilters.interface} onChange={(value) => updateDraftFilter("interface", value)} />
          <label>
            Start time
            <input type="datetime-local" value={draftFilters.start_time} onChange={(event) => updateDraftFilter("start_time", event.target.value)} />
          </label>
          <label>
            End time
            <input type="datetime-local" value={draftFilters.end_time} onChange={(event) => updateDraftFilter("end_time", event.target.value)} />
          </label>
          <div className="security-filter-actions">
            <button className="security-search-btn nm-btn nm-btn--primary" type="submit">
              <Search size={15} aria-hidden="true" />
              Search
            </button>
            <button className="clear-filters nm-btn nm-btn--secondary" type="button" onClick={() => { setOffset(0); setSelectedSearchId(""); setDraftFilters(emptySecurityFilters); setFilters(emptySecurityFilters); }}>
              Clear filters
            </button>
          </div>
          <div className="security-saved-searches">
            <select
              className="toolbar-select nm-select"
              value={selectedSearchId === "" ? "" : String(selectedSearchId)}
              onChange={(event) => {
                if (!event.target.value) { setSelectedSearchId(""); return; }
                applySavedSearch(Number(event.target.value));
              }}
              title="Apply a saved search"
            >
              <option value="">Saved searches…</option>
              {savedSearches.map((s) => (
                <option key={s.id} value={String(s.id)}>{s.name}</option>
              ))}
            </select>
            <button type="button" className="clear-filters nm-btn nm-btn--secondary" onClick={() => { setSaveSearchName(""); setShowSaveSearchModal(true); }} title="Save the current filters as a named search">
              Save search
            </button>
            {selectedSearchId !== "" && (
              <button type="button" className="clear-filters nm-btn nm-btn--danger" onClick={() => void deleteSelectedSearch()} title="Delete the selected saved search">
                Delete
              </button>
            )}
          </div>
        </form>
        <div className="security-results nm-app-panel">
          <div className="security-results-meta">
            <span className="security-panel-identity"><span className="security-panel-icon"><TableProperties size={18} /></span><strong>Firewall events</strong><small>{loading ? "Searching…" : `${total.toLocaleString()} results`}</small></span>
            <span className="security-results-actions">
              {columnWidths && <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost" onClick={resetColumnWidths}>Reset columns</button>}
              <span className="security-results-range">Showing {total === 0 ? 0 : offset + 1}-{Math.min(offset + pageSize, total)}</span>
            </span>
          </div>
          <div
            className={`security-table${columnWidths ? " security-table--fixed" : ""}`}
            ref={tableRef}
            style={columnWidths ? ({
              "--security-grid-template": securityGridTemplate(columnWidths),
              "--security-table-width": `${columnWidths.reduce((totalWidth, width) => totalWidth + width, 0) + 100}px`,
            } as CSSProperties) : undefined}
          >
            <div className="security-table-header" ref={tableHeaderRef}>
              {SECURITY_COLUMNS.map((column, columnIndex) => (
                <span className="security-table-heading" key={column.label}>
                  {"sort" in column
                    ? <button type="button" onClick={() => changeSort(column.sort)}>{column.label}</button>
                    : <span>{column.label}</span>}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    className="security-col-resize-handle"
                    title="Drag to resize · double-click to reset all columns"
                    onMouseDown={(event) => startColumnResize(columnIndex, event)}
                    onDoubleClick={(event) => { event.stopPropagation(); resetColumnWidths(); }}
                  />
                </span>
              ))}
            </div>
            {events.length === 0 ? (
              <div className="security-empty">No firewall events match the current filters.</div>
            ) : (
              events.map((event) => {
                const relatedDevices = relatedDevicesForEvent(event, devicesByIp);
                const primaryDevice = relatedDevices[0] ?? null;
                return (
                  <div key={event.id} className="security-row-group">
                    <button
                      className="security-row"
                      type="button"
                      onClick={() => {
                        setExpandedId((current) => (current === event.id ? null : event.id));
                        if (primaryDevice) {
                          onJumpToTopologyDevice(primaryDevice.id);
                        }
                      }}
                    >
                      <span className="row-time">
                        {expandedId === event.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        {formatEventTime(event.received_at)}
                      </span>
                      <ClickableCell value={event.interface} onClick={() => applyFilter("interface", event.interface)} />
                      <ClickableCell value={event.src_ip} onClick={() => applyFilter("src_ip", event.src_ip)} />
                      <ClickableCell value={event.dst_ip} onClick={() => applyFilter("dst_ip", event.dst_ip)} />
                      {primaryDevice ? (
                        <ClickableCell
                          className="topology-link-cell"
                          value={deviceLabel(primaryDevice)}
                          onClick={() => onJumpToTopologyDevice(primaryDevice.id)}
                        />
                      ) : (
                        <span className="clickable-cell">-</span>
                      )}
                      <ClickableCell value={event.protocol} onClick={() => applyFilter("protocol", event.protocol)} />
                      <ClickableCell value={event.src_port} onClick={() => applyFilter("src_port", event.src_port)} />
                      <ClickableCell value={event.dst_port} onClick={() => applyFilter("dst_port", event.dst_port)} />
                      <ClickableCell value={event.action} className={`action-pill ${event.action ?? "unknown"}`} onClick={() => applyFilter("action", event.action)} />
                      <ClickableCell value={event.rule_id} onClick={() => applyFilter("q", event.rule_id)} />
                      <ClickableCell value={event.reason} onClick={() => applyFilter("q", event.reason)} />
                    </button>
                    {expandedId === event.id && (
                      <>
                        {relatedDevices.length > 0 && (
                          <div className="related-devices">
                            <span>Related devices:</span>
                            {relatedDevices.map((device) => (
                              <button
                                className="topology-jump-button"
                                key={`${event.id}-${device.id}`}
                                type="button"
                                onClick={() => onJumpToTopologyDevice(device.id)}
                              >
                                {deviceLabel(device)}
                              </button>
                            ))}
                          </div>
                        )}
                        <pre className="raw-log">{event.raw_log}</pre>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="security-pagination">
            <span>{total === 0 ? "No results" : `Page ${Math.floor(offset / pageSize) + 1} of ${Math.max(1, Math.ceil(total / pageSize))}`}</span>
            <div>
            <button className="nm-btn nm-btn--sm nm-btn--secondary" type="button" disabled={!canPrevious} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
              Previous
            </button>
            <button className="nm-btn nm-btn--sm nm-btn--secondary" type="button" disabled={!canNext} onClick={() => setOffset(offset + pageSize)}>
              Next
            </button>
            </div>
          </div>
        </div>
      </div>
      {showSaveSearchModal && (
        <Modal
          title="Save search"
          onCancel={() => { setShowSaveSearchModal(false); setSaveSearchName(""); }}
          headerSubmitLabel={saveSearchBusy ? "Saving…" : "Save"}
          headerSubmitFormId="save-search-form"
          headerSubmitDisabled={saveSearchBusy || !saveSearchName.trim()}
        >
          <form
            id="save-search-form"
            className="modal-form"
            onSubmit={(event) => { event.preventDefault(); void saveCurrentSearch(saveSearchName); }}
          >
            <label>
              Search name
              <input
                required
                maxLength={120}
                placeholder="e.g. Blocked WAN traffic"
                value={saveSearchName}
                onChange={(event) => setSaveSearchName(event.target.value)}
              />
            </label>
            <p className="tool-note">Saves the current filter set under this name. Saved searches are private to your account.</p>
          </form>
        </Modal>
      )}
    </section>
  );
}

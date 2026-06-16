import { useState, useEffect, useRef, useMemo, useContext } from "react";
import { Search, Pause, Play, ChevronDown, ChevronRight } from "lucide-react";
import { api, type FirewallEvent, type FirewallEventList, type SyslogStatus, type Device, type TopologyGraph } from "../../api/client";
import { TopbarNoteCtx } from "../../context";
import { type SecurityFilters, emptySecurityFilters } from "../../types";
import { buildFirewallEventsWsUrl, buildSearchParams, eventMatchesFilters, relatedDevicesForEvent } from "../../utils/security";
import { deviceLabel, formatEventTime, toDateTimeLocal } from "../../utils/format";
import { SecurityFilterInput } from "../../components/SecurityFilterInput";
import { ClickableCell } from "../../components/ClickableCell";

export function SecurityWorkspace({
  accessToken,
  graph,
  onJumpToTopologyDevice,
}: {
  accessToken: string | null;
  graph: TopologyGraph;
  onJumpToTopologyDevice: (deviceId: number) => void;
}) {
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
  const [autoScroll, setAutoScroll] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const setTopbarNote = useContext(TopbarNoteCtx);
  const pageSize = 100;
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
  }, [accessToken, filters, offset, sortBy, sortDir]);

  useEffect(() => {
    if (!accessToken || !liveTail) {
      return;
    }
    const socket = new WebSocket(buildFirewallEventsWsUrl());
    socket.onopen = () => socket.send(accessToken);
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as FirewallEvent;
      if (!eventMatchesFilters(event, filters)) {
        return;
      }
      setEvents((current) => [event, ...current.filter((existing) => existing.id !== event.id)].slice(0, pageSize));
      setStatus((current) => (current ? { ...current, total_events: current.total_events + 1 } : current));
      setResultMeta((current) => (current ? { ...current, total: current.total + 1 } : current));
      if (autoScroll) {
        requestAnimationFrame(() => {
          if (tableRef.current) {
            tableRef.current.scrollTop = 0;
          }
        });
      }
    };
    socket.onerror = () => setError("Live firewall event stream disconnected");
    return () => socket.close();
  }, [accessToken, autoScroll, filters, liveTail]);

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
            {liveTail ? "live tail active" : "live tail paused"}
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
            <input checked={autoScroll} type="checkbox" onChange={(event) => setAutoScroll(event.target.checked)} />
            Auto-scroll
          </label>
        </div>
      </div>
    );
    return () => setTopbarNote("");
  }, [autoScroll, liveTail, setTopbarNote, status]);

  return (
    <section className="security-layout" id="security">
      {error && <div className="form-error">{error}</div>}
      <div className="security-content">
        <form
          className="security-filters"
          aria-label="Firewall event filters"
          onSubmit={(event) => {
            event.preventDefault();
            applyDraftFilters();
          }}
        >
          <label className="security-search">
            <Search size={16} aria-hidden="true" />
            <input
              placeholder="Search raw log, IP, rule, reason"
              value={draftFilters.q}
              onChange={(event) => updateDraftFilter("q", event.target.value)}
            />
          </label>
          <div className="quick-filters">
            <button type="button" className="quick-filter-block" onClick={() => applyQuickFilter("blocked")}>Blocked</button>
            <button type="button" className="quick-filter-pass" onClick={() => applyQuickFilter("passed")}>Passed</button>
            <button type="button" onClick={() => applyQuickFilter("wan")}>WAN</button>
            <button type="button" onClick={() => applyQuickFilter("hour")}>Last Hour</button>
            <button type="button" onClick={() => applyQuickFilter("day")}>Last 24h</button>
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
            <button className="security-search-btn" type="submit">
              <Search size={15} aria-hidden="true" />
              Search
            </button>
            <button className="clear-filters" type="button" onClick={() => { setOffset(0); setDraftFilters(emptySecurityFilters); setFilters(emptySecurityFilters); }}>
              Clear filters
            </button>
          </div>
        </form>
        <div className="security-results">
          <div className="security-results-meta">
            <span>{loading ? "Searching..." : `${total} matching events`}</span>
            <span>
              Showing {total === 0 ? 0 : offset + 1}-{Math.min(offset + pageSize, total)}
            </span>
          </div>
          <div className="security-table" ref={tableRef}>
            <div className="security-table-header">
              <button type="button" onClick={() => changeSort("received_at")}>Time</button>
              <button type="button" onClick={() => changeSort("interface")}>Interface</button>
              <span>Source</span>
              <span>Destination</span>
              <span>Topology</span>
              <button type="button" onClick={() => changeSort("protocol")}>Protocol</button>
              <button type="button" onClick={() => changeSort("src_port")}>Source Port</button>
              <button type="button" onClick={() => changeSort("dst_port")}>Destination Port</button>
              <button type="button" onClick={() => changeSort("action")}>Action</button>
              <span>Rule</span>
              <span>Reason</span>
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
            <button type="button" disabled={!canPrevious} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
              Previous
            </button>
            <button type="button" disabled={!canNext} onClick={() => setOffset(offset + pageSize)}>
              Next
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

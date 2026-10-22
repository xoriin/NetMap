import { useEffect, useRef, useState, memo, type KeyboardEvent, type MouseEvent } from "react";
import type { MonitorHistoryPoint } from "../api/client";
import { beatBg, sampleHistory } from "../utils/monitoring";

function HeartbeatBarImpl({ beats, health, size = "sm" }: { beats: string[]; health?: string[]; size?: "sm" | "lg" }) {
  if (beats.length === 0) return null;
  // Newest beat is always last in the array (oldest -> newest); CSS right-anchors the bar.
  const displayBeats = size === "sm" ? beats.slice(-24) : beats;
  return (
    <div className={`heartbeat-bar heartbeat-bar--${size}`}>
      {displayBeats.map((status, i) => {
        const beatNum = beats.length - displayBeats.length + i + 1;
        const healthStatus = health?.[beats.length - displayBeats.length + i];
        return (
          <span
            key={i}
            className="heartbeat-beat"
            style={{ background: beatBg(healthStatus ?? status) }}
            title={`Poll ${beatNum} of ${beats.length}: ${status}${healthStatus ? ` · ${healthStatus}` : ""}`}
          />
        );
      })}
    </div>
  );
}

function HeartbeatTooltip({ point, anchor }: { point: MonitorHistoryPoint; anchor: DOMRect }) {
  const d = new Date(point.checked_at);
  const dateStr = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const W = 230;
  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - W / 2), window.innerWidth - W - 8);
  const above = anchor.top > 190;
  const statusColors: Record<string, string> = { online: "#2dba7c", offline: "#e05050", unknown: "#94a3b8" };

  return (
    <div className={`hb-tooltip-card hb-tooltip-card--${above ? "above" : "below"}`} role="status" style={{ left, top: above ? anchor.top - 10 : anchor.bottom + 10 }}>
      <div className="hb-tooltip-header">
        <span className="hb-tooltip-date">{dateStr}</span>
        <span className="hb-tooltip-time">{timeStr}</span>
      </div>
      <div className="hb-tooltip-status-row">
        <span className={`mon-dot mon-dot-${point.is_healthy === true ? "healthy" : point.is_healthy === false ? "unhealthy" : "unknown"}`} />
        <span className="hb-tooltip-status-text" style={{ color: statusColors[point.status] ?? "#94a3b8" }}>
          {point.status.charAt(0).toUpperCase() + point.status.slice(1)}
        </span>
        <span className="dash-panel-meta">
          {point.is_healthy === true ? "Expected" : point.is_healthy === false ? `Expected ${point.expected_status}` : "Unknown"}
        </span>
        {point.rtt_ms !== null && (
          <span className="hb-tooltip-rtt">{point.rtt_ms.toFixed(1)} ms</span>
        )}
      </div>
      {point.note && (
        <div className="hb-tooltip-ports"><span className="dash-panel-meta">{point.note}</span></div>
      )}
      {point.port_results.length > 0 && (
        <div className="hb-tooltip-ports">
          {point.port_results.map((r) => (
            <span key={r.port} className={`mon-port-badge mon-port-badge--${r.open ? "open" : "closed"}`}>
              {r.label}:{r.port}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function HeartbeatTimelineImpl({ history, hours }: { history: MonitorHistoryPoint[]; hours: number }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const [freshIds, setFreshIds] = useState<Set<number>>(() => new Set());
  const barRef = useRef<HTMLDivElement>(null);
  const seenRef = useRef<Set<number> | null>(null);

  useEffect(() => {
    const ids = sampleHistory(history).map((point) => point.id);
    const seen = seenRef.current;
    seenRef.current = new Set(ids);
    if (!seen) return undefined;
    const arrived: number[] = [];
    for (let index = ids.length - 1; index >= 0 && !seen.has(ids[index]); index -= 1) arrived.push(ids[index]);
    if (!arrived.length || arrived.length > 3) return undefined;
    setFreshIds(new Set(arrived));
    const timer = window.setTimeout(() => setFreshIds(new Set()), 900);
    return () => window.clearTimeout(timer);
  }, [history]);

  if (history.length === 0) return <p className="dash-empty">No poll data yet.</p>;

  const multiDay = hours > 24;
  const beats = sampleHistory(history);
  const healthyCount = history.filter((h) => h.is_healthy === true).length;
  const compliancePct = Math.round((healthyCount / history.length) * 100);
  const axisCount = Math.min(5, beats.length);
  const axisIndices = Array.from({ length: axisCount }, (_, i) =>
    Math.round((i / Math.max(axisCount - 1, 1)) * (beats.length - 1)),
  );
  const active = hoverIndex ?? pinnedIndex;
  const activeBeat = active !== null && active < beats.length ? beats[active] : null;
  const anchor = activeBeat ? barRef.current?.children[active as number]?.getBoundingClientRect() ?? null : null;

  function indexAt(clientX: number) {
    const children = Array.from(barRef.current?.children ?? []);
    let best = 0;
    let distance = Infinity;
    children.forEach((child, index) => {
      const rect = child.getBoundingClientRect();
      const gap = Math.abs(clientX - (rect.left + rect.width / 2));
      if (gap < distance) { distance = gap; best = index; }
    });
    return best;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const from = active ?? beats.length - 1;
      setHoverIndex(null);
      setPinnedIndex(Math.min(beats.length - 1, Math.max(0, from + (event.key === "ArrowLeft" ? -1 : 1))));
    } else if (event.key === "Escape" && active !== null) {
      event.stopPropagation();
      setHoverIndex(null);
      setPinnedIndex(null);
    }
  }

  function fmtAxis(iso: string) {
    const d = new Date(iso);
    if (multiDay) {
      return d.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" })
        + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div
      className="heartbeat-timeline"
      tabIndex={0}
      aria-label="Heartbeat timeline: hover or click a check for details, arrow keys to step"
      onKeyDown={onKeyDown}
    >
      <div
        ref={barRef}
        className={`heartbeat-bar heartbeat-bar--lg${active !== null ? " has-active" : ""}`}
        onMouseMove={(event: MouseEvent) => setHoverIndex(indexAt(event.clientX))}
        onMouseLeave={() => setHoverIndex(null)}
        onClick={(event: MouseEvent) => { const index = indexAt(event.clientX); setPinnedIndex((current) => (current === index ? null : index)); }}
      >
        {beats.map((h, index) => (
          <span
            key={h.id}
            className={`heartbeat-beat heartbeat-beat--clickable${index === active ? " is-active" : ""}${index === pinnedIndex ? " is-pinned" : ""}${freshIds.has(h.id) ? " is-new" : ""}`}
            style={{ background: beatBg(h.is_healthy === true ? "healthy" : h.is_healthy === false ? "unhealthy" : "unknown") }}
          />
        ))}
      </div>

      <div className="heartbeat-time-axis" style={{ gridTemplateColumns: `repeat(${axisCount}, 1fr)` }}>
        {axisIndices.map((idx, pos_) => (
          <span
            key={idx}
            className="heartbeat-time-label"
            style={{ textAlign: pos_ === 0 ? "left" : pos_ === axisCount - 1 ? "right" : "center" }}
          >
            {fmtAxis(beats[idx].checked_at)}
          </span>
        ))}
      </div>

      <div className="heartbeat-summary">
        <span className="dash-panel-meta">{history.length} polls</span>
        <span className="dash-panel-meta">·</span>
        <span className="dash-panel-meta">{compliancePct}% expected-state health</span>
        <span className="dash-panel-meta">·</span>
        <div className="heartbeat-legend" style={{ margin: 0 }}>
          <span className="heartbeat-legend-item"><span className="heartbeat-beat heartbeat-beat--online" /> Expected</span>
          <span className="heartbeat-legend-item"><span className="heartbeat-beat heartbeat-beat--offline" /> Unexpected</span>
          <span className="heartbeat-legend-item"><span className="heartbeat-beat heartbeat-beat--unknown" /> Unknown</span>
        </div>
      </div>

      {activeBeat && anchor && <HeartbeatTooltip point={activeBeat} anchor={anchor} />}
    </div>
  );
}

// Rendered once per monitoring/overview row on every poll cycle; memo skips
// re-render when the beats/history arrays are referentially unchanged.
export const HeartbeatBar = memo(HeartbeatBarImpl);
export const HeartbeatTimeline = memo(HeartbeatTimelineImpl);

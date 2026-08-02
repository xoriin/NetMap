import { useState , memo } from "react";
import type { MonitorHistoryPoint } from "../api/client";
import { beatBg, sampleHistory } from "../utils/monitoring";

function HeartbeatBarImpl({ beats, health, size = "sm" }: { beats: string[]; health?: string[]; size?: "sm" | "lg" }) {
  if (beats.length === 0) return null;
  // Newest beat is always last in the array (oldest -> newest); CSS right-anchors the bar.
  const displayBeats = size === "sm" ? beats.slice(-30) : beats;
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

function HeartbeatTooltip({ point, x, y }: { point: MonitorHistoryPoint; x: number; y: number }) {
  const d = new Date(point.checked_at);
  const dateStr = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const W = 230; const H = 160;
  const left = x + 16 + W > vw ? x - W - 8 : x + 16;
  const top = y + 16 + H > vh ? y - H - 8 : y + 16;
  const statusColors: Record<string, string> = { online: "#2dba7c", offline: "#e05050", unknown: "#94a3b8" };

  return (
    <div className="hb-tooltip-card" style={{ left, top }}>
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
  const [hovered, setHovered] = useState<MonitorHistoryPoint | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  if (history.length === 0) return <p className="dash-empty">No poll data yet.</p>;

  const multiDay = hours > 24;
  const beats = sampleHistory(history);
  const healthyCount = history.filter((h) => h.is_healthy === true).length;
  const compliancePct = Math.round((healthyCount / history.length) * 100);
  const axisCount = Math.min(5, beats.length);
  const axisIndices = Array.from({ length: axisCount }, (_, i) =>
    Math.round((i / Math.max(axisCount - 1, 1)) * (beats.length - 1)),
  );

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
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setHovered(null)}
    >
      <div className="heartbeat-bar heartbeat-bar--lg">
        {beats.map((h) => (
          <span
            key={h.id}
            className="heartbeat-beat heartbeat-beat--clickable"
            style={{ background: beatBg(h.is_healthy === true ? "healthy" : h.is_healthy === false ? "unhealthy" : "unknown") }}
            onMouseEnter={() => setHovered(h)}
            onMouseLeave={() => setHovered(null)}
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

      {hovered && <HeartbeatTooltip point={hovered} x={pos.x} y={pos.y} />}
    </div>
  );
}

// Rendered once per monitoring/overview row on every poll cycle; memo skips
// re-render when the beats/history arrays are referentially unchanged.
export const HeartbeatBar = memo(HeartbeatBarImpl);
export const HeartbeatTimeline = memo(HeartbeatTimelineImpl);

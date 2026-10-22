import React from "react";
import type { MonitorHistoryPoint } from "../api/client";

export function MonStatusDot({ status }: { status: string }) {
  return <span className={`mon-dot mon-dot-${status}`} title={status} />;
}

export function UptimeBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="dash-panel-meta">-</span>;
  const pct = Math.round(value * 100);
  const cls = pct >= 99 ? "good" : pct >= 90 ? "warn" : "bad";
  return <span className={`mon-uptime mon-uptime-${cls}`}>{pct}%</span>;
}

export function TrendBadge({ trend, pct }: { trend: string; pct: number | null }) {
  if (trend === "insufficient_data") return <span className="dash-panel-meta">Not enough data</span>;
  const arrow = trend === "rising" ? "↑" : trend === "falling" ? "↓" : "→";
  const cls = trend === "rising" ? "mon-trend--rising" : trend === "falling" ? "mon-trend--falling" : "mon-trend--stable";
  return (
    <span className={`mon-trend ${cls}`}>
      {arrow} {trend.charAt(0).toUpperCase() + trend.slice(1)}
      {pct !== null && <span className="mon-trend-pct"> ({pct > 0 ? "+" : ""}{pct.toFixed(1)}%)</span>}
    </span>
  );
}

export function AnomalyBadge({ level, score }: { level: string; score: number | null }) {
  if (level === "insufficient_data") return <span className="dash-panel-meta">Not enough data</span>;
  const cls = level === "anomalous" ? "mon-anomaly--anomalous" : level === "elevated" ? "mon-anomaly--elevated" : "mon-anomaly--normal";
  const label = level.charAt(0).toUpperCase() + level.slice(1);
  return (
    <span className={`mon-anomaly ${cls}`}>
      {label}
      {score !== null && <span className="mon-anomaly-score"> (z={score.toFixed(1)})</span>}
    </span>
  );
}

function RttSparklineImpl({ data }: { data: MonitorHistoryPoint[] }) {
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);
  const valid = data.filter((d) => d.rtt_ms !== null);
  if (valid.length < 2) {
    return <p className="dash-empty" style={{ margin: "12px 0 0" }}>Not enough data yet.</p>;
  }
  const rtts = valid.map((d) => d.rtt_ms as number);
  const minRtt = Math.min(...rtts);
  const maxRtt = Math.max(...rtts);
  const avgRtt = rtts.reduce((a, b) => a + b, 0) / rtts.length;
  const range = maxRtt - minRtt || 1;
  const H = 56, W = 100;
  const step = W / (valid.length - 1);
  const yOf = (ms: number) => H - ((ms - minRtt) / range) * (H - 10) - 5;
  const points = valid.map((d, i) => `${i * step},${yOf(d.rtt_ms as number)}`).join(" ");
  const avgY = yOf(avgRtt);
  const lastPoint = valid[valid.length - 1];
  const lastX = W;
  const lastY = yOf(lastPoint.rtt_ms as number);
  const fmt = (ms: number) => ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms % 1 === 0 ? ms.toFixed(0) : ms.toFixed(1)}ms`;
  const fmtTs = (iso: string) => { const d = new Date(iso); return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`; };
  const active = hoverIndex !== null && hoverIndex < valid.length ? hoverIndex : null;
  const activePoint = active !== null ? valid[active] : null;
  const fraction = active !== null ? active / (valid.length - 1) : 0;
  const indexAt = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return Math.round(ratio * (valid.length - 1));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const from = active ?? valid.length - 1;
    setHoverIndex(Math.min(valid.length - 1, Math.max(0, from + (event.key === "ArrowLeft" ? -1 : 1))));
  };

  return (
    <div className="mon-sparkline-wrap">
      <div className="mon-sparkline-yaxis">
        <span>{fmt(maxRtt)}</span>
        <span className="mon-sparkline-avg-label">avg {fmt(avgRtt)}</span>
        <span>{fmt(minRtt)}</span>
      </div>
      <div className="mon-sparkline-area">
        <div
          className="mon-sparkline-plot"
          tabIndex={0}
          aria-label="Response time graph: hover or use arrow keys to read values"
          onMouseMove={(event) => setHoverIndex(indexAt(event))}
          onMouseLeave={() => setHoverIndex(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setHoverIndex(null)}
        >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mon-sparkline" aria-label="RTT trend">
          <line className="mon-sparkline-grid" x1={0} y1={5} x2={W} y2={5} />
          <line className="mon-sparkline-grid" x1={0} y1={H / 2} x2={W} y2={H / 2} />
          <line className="mon-sparkline-grid" x1={0} y1={H - 5} x2={W} y2={H - 5} />
          <line className="mon-sparkline-avg" x1={0} y1={avgY} x2={W} y2={avgY} />
          <polyline className="mon-sparkline-line" points={points} />

        </svg>
        {activePoint && (
          <>
            <span className="mon-sparkline-guide" aria-hidden="true" style={{ left: `${fraction * 100}%` }} />
            <span className="mon-sparkline-dot" aria-hidden="true" style={{ left: `${fraction * 100}%`, top: `${(yOf(activePoint.rtt_ms as number) / H) * 100}%` }} />
            <span
              className={`mon-sparkline-readout${fraction < 0.15 ? " is-start" : fraction > 0.85 ? " is-end" : ""}`}
              role="status"
              style={{ left: `${fraction * 100}%` }}
            >
              {new Date(activePoint.checked_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · {fmt(activePoint.rtt_ms as number)}
            </span>
          </>
        )}
        </div>
        <div className="mon-sparkline-xaxis">
          <span>{fmtTs(valid[0].checked_at)}</span>
          <span>{fmtTs(valid[valid.length - 1].checked_at)}</span>
        </div>
      </div>
    </div>
  );
}

function MiniRttSparklineImpl({ data }: { data: (number | null)[] }) {
  const valid = data.filter((v): v is number => v !== null);
  if (valid.length < 2) return null;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  const H = 18, W = 100;
  const step = W / (valid.length - 1);
  const yOf = (v: number) => H - ((v - min) / range) * (H - 2) - 1;
  const points = valid.map((v, i) => `${(i * step).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  return (
    <svg
      className="mon-mini-sparkline"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline className="mon-mini-sparkline-line" points={points} />
    </svg>
  );
}

export function MonStat({
  label, value, sub, icon, accent,
}: {
  label: string; value: string; sub: string;
  icon: React.ReactNode;
  accent: "teal" | "green" | "red" | "purple" | "blue" | "indigo";
}) {
  return (
    <div className={`dash-stat dash-stat--${accent}`}>
      <div className="dash-stat-icon">{icon}</div>
      <div className="dash-stat-body">
        <strong className="dash-stat-value mon-stat-value">{value}</strong>
        <span className="dash-stat-label">{label}</span>
        <span className="dash-stat-sub">{sub}</span>
      </div>
    </div>
  );
}

export const RttSparkline = React.memo(RttSparklineImpl);
export const MiniRttSparkline = React.memo(MiniRttSparklineImpl);

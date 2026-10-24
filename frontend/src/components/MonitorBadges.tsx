import { AreaChart } from "./Charts";
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
  const valid = data.filter((d) => d.rtt_ms !== null);
  if (valid.length < 2) {
    return <p className="dash-empty" style={{ margin: "12px 0 0" }}>Not enough data yet.</p>;
  }
  const avg = valid.reduce((sum, d) => sum + (d.rtt_ms as number), 0) / valid.length;
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <AreaChart label="Response time" unit=" ms" height={220} zoomable
      reference={{ value: avg, label: `avg ${avg.toFixed(1)}` }}
      series={[{ key: "rtt", label: "Round-trip time", color: "--nm-accent" }]}
      rows={valid.map((d) => ({ label: time(d.checked_at), rtt: Number((d.rtt_ms as number).toFixed(2)) }))} />
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

export function HealthDonut({ statusCounts, total, pct, label = "online" }: {
  statusCounts: { online: number; offline: number; warning: number; unknown: number; paused?: number };
  total: number;
  pct: number;
  label?: string;
}) {
  const r = 40;
  const circ = 2 * Math.PI * r;
  const segments = [
    { key: "online" as const, color: "#2dba7c" },
    { key: "offline" as const, color: "#e05050" },
    { key: "warning" as const, color: "#f59e0b" },
    { key: "paused" as const, color: "var(--dash-paused)" },
    { key: "unknown" as const, color: "#94a3b8" },
  ];
  const counts = { paused: 0, ...statusCounts };
  let offset = 0;
  const arcs = segments.map(({ key, color }) => {
    const frac = total > 0 ? counts[key] / total : 0;
    const dash = frac * circ;
    const arc = { color, dash, gap: circ - dash, offset };
    offset += dash;
    return arc;
  });
  return (
    <div className="dash-donut-wrap">
      <svg className="dash-donut-svg" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#e8edf3" strokeWidth="10" />
        {total > 0 && arcs.map((arc, i) => arc.dash > 0 && (
          <circle
            key={i}
            cx="50" cy="50" r={r}
            fill="none"
            stroke={arc.color}
            strokeWidth="10"
            strokeDasharray={`${arc.dash} ${arc.gap}`}
            strokeDashoffset={-arc.offset}
          />
        ))}
      </svg>
      <div className="dash-donut-center">
        <span className="dash-donut-pct">{pct}%</span>
        <span className="dash-donut-label">{label}</span>
      </div>
    </div>
  );
}

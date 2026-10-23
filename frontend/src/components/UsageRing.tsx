export function UsageRing({ pct, label, tone = "ok" }: { pct: number; label: string; tone?: "ok" | "danger" }) {
  const r = 40;
  const circ = 2 * Math.PI * r;
  const dash = (Math.min(Math.max(pct, 0), 100) / 100) * circ;
  return (
    <div className={`dash-donut-wrap nm-usage-ring nm-usage-ring--${tone}`}>
      <svg className="dash-donut-svg" viewBox="0 0 100 100" aria-hidden="true">
        <circle className="nm-usage-ring-track" cx="50" cy="50" r={r} fill="none" strokeWidth="10" />
        {dash > 0 && (
          <circle className="nm-usage-ring-value" cx="50" cy="50" r={r} fill="none" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${dash} ${circ - dash}`} />
        )}
      </svg>
      <div className="dash-donut-center">
        <span className="dash-donut-pct">{pct}%</span>
        <span className="dash-donut-label">{label}</span>
      </div>
    </div>
  );
}

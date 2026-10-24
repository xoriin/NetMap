import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A chart colour is the name of an existing token, e.g. "--dash-blue". */
export type ChartColor = `--${string}`;
export type ChartItem = { label: string; value: number; color: ChartColor };

const fmt = (n: number) => n.toLocaleString();

type TipRow = { color: ChartColor; label: string; value: string };
type Tip = { anchor: DOMRect; title: string; rows: TipRow[] } | null;

function ChartTooltip({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const h = ref.current.offsetHeight;
    setTop(tip.anchor.top > h + 20 ? tip.anchor.top - h - 10 : tip.anchor.bottom + 10);
  }, [tip]);
  if (!tip) return null;
  const width = 230;
  const left = Math.min(Math.max(8, tip.anchor.left + tip.anchor.width / 2 - width / 2), window.innerWidth - width - 8);
  return createPortal(
    <div ref={ref} className="hb-tooltip-card nm-chart-tip" role="status" style={{ left, top: top ?? tip.anchor.top, visibility: top === null ? "hidden" : "visible" }}>
      <div className="hb-tooltip-header"><span className="hb-tooltip-date">{tip.title}</span></div>
      {tip.rows.map((row) => (
        <div key={row.label} className="nm-chart-tip-row">
          <span className="nm-chart-swatch" style={{ background: `var(${row.color})` }} aria-hidden="true" />
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>,
    document.body,
  );
}

function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const show = (el: Element, title: string, rows: TipRow[]) => setTip({ anchor: el.getBoundingClientRect(), title, rows });
  return { tip, show, hide: () => setTip(null) };
}

export function ChartLegend({ items, unit = "" }: { items: ChartItem[]; unit?: string }) {
  return (
    <ul className="nm-chart-legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className="nm-chart-swatch" style={{ background: `var(${item.color})` }} aria-hidden="true" />
          <span className="nm-chart-legend-label">{item.label}</span>
          <strong>{fmt(item.value)}{unit}</strong>
        </li>
      ))}
    </ul>
  );
}

/** Multi-segment ring on the UsageRing geometry, with a legend and per-segment tooltips. */
export function DonutChart({ items, centre, sub, unit = "", label, legend = true }: {
  items: ChartItem[];
  centre: ReactNode;
  sub: string;
  unit?: string;
  label: string;
  legend?: boolean;
}) {
  const { tip, show, hide } = useTip();
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const r = 40;
  const circ = 2 * Math.PI * r;
  const visible = items.filter((item) => item.value > 0);
  let offset = 0;
  return (
    <div className="nm-donut-chart">
      <div className="dash-donut-wrap nm-usage-ring nm-donut-ring">
        <svg className="dash-donut-svg" viewBox="0 0 100 100" role="img" aria-label={`${label}: ${items.map((i) => `${i.label} ${fmt(i.value)}${unit}`).join(", ")}`}>
          <circle className="nm-usage-ring-track" cx="50" cy="50" r={r} fill="none" strokeWidth="10" />
          {total > 0 && visible.map((item, index) => {
            const len = (item.value / total) * circ;
            const gap = visible.length > 1 ? Math.min(2, len / 2) : 0;
            const dashOffset = -offset;
            offset += len;
            const pct = Math.round((item.value / total) * 100);
            const onEnter = (event: { currentTarget: Element }) => show(event.currentTarget, item.label, [{ color: item.color, label: `${pct}% of total`, value: `${fmt(item.value)}${unit}` }]);
            return (
              <circle
                key={item.label}
                className="nm-chart-seg"
                cx="50" cy="50" r={r} fill="none" strokeWidth="10"
                strokeDasharray={`${Math.max(len - gap, 0.5)} ${circ}`}
                strokeDashoffset={dashOffset}
                tabIndex={0}
                aria-label={`${item.label} ${fmt(item.value)}${unit}`}
                style={{ stroke: `var(${item.color})`, "--nm-chart-i": index } as CSSProperties}
                onPointerEnter={onEnter} onFocus={onEnter} onPointerLeave={hide} onBlur={hide}
              />
            );
          })}
        </svg>
        <div className="dash-donut-center"><span className="dash-donut-pct">{centre}</span><span className="dash-donut-label">{sub}</span></div>
      </div>
      {legend && <ChartLegend items={items} unit={unit} />}
      <ChartTooltip tip={tip} />
    </div>
  );
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}

function roundTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return "";
  const rr = Math.min(r, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export type ColumnSeries = { key: string; label: string; color: ChartColor };

/** Stacked column chart: one axis, recessive grid, rounded data ends, per-column tooltip.
 * A row's `color` overrides the series colour (one category per column); `valueLabels` prints each total above its column. */
export function ColumnChart({ rows, series, label, height = 150, unit = "", valueLabels = false, barMax = 28 }: {
  rows: ({ label: string; color?: ChartColor } & Record<string, number | string>)[];
  series: ColumnSeries[];
  label: string;
  height?: number;
  unit?: string;
  valueLabels?: boolean;
  barMax?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const { tip, show, hide } = useTip();
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const padL = 34, padB = 22, padT = valueLabels ? 22 : 8;
  const value = (row: (typeof rows)[number], key: string) => Number(row[key]) || 0;
  const max = Math.max(1, ...rows.map((row) => series.reduce((sum, s) => sum + value(row, s.key), 0)));
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const plotW = Math.max(0, width - padL - 4);
  const plotH = height - padB - padT;
  const slot = rows.length ? plotW / rows.length : 0;
  const bw = Math.max(4, Math.min(barMax, slot * 0.6));
  const every = Math.max(1, Math.ceil(rows.length / 7));
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return (
    <div ref={host} className="nm-column-chart">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} className={active === null ? undefined : "has-active"}>
          {ticks.map((v) => {
            const y = padT + plotH - (v / top) * plotH;
            return (
              <g key={v}>
                <line className={v ? "nm-chart-grid" : "nm-chart-baseline"} x1={padL} x2={width - 4} y1={y} y2={y} />
                <text className="nm-chart-axis" x={padL - 6} y={y + 3} textAnchor="end">{fmt(Math.round(v * 10) / 10)}</text>
              </g>
            );
          })}
          {rows.map((row, i) => {
            const x = padL + slot * i + (slot - bw) / 2;
            let base = padT + plotH;
            const present = series.filter((s) => value(row, s.key) > 0);
            const onEnter = (event: { currentTarget: Element }) => {
              setActive(i);
              show(event.currentTarget, row.label, series.map((s) => ({ color: row.color ?? s.color, label: s.label, value: `${fmt(value(row, s.key))}${unit}` })));
            };
            const onLeave = () => { setActive(null); hide(); };
            return (
              <g key={row.label} className={`nm-chart-col${active === i ? " is-active" : ""}`} style={{ "--nm-chart-i": i } as CSSProperties}>
                <rect className="nm-chart-col-bg" x={padL + slot * i} y={padT} width={slot} height={plotH} aria-hidden="true" />
                {present.map((s, si) => {
                  const h = (value(row, s.key) / top) * plotH;
                  const y = base - h;
                  base = y;
                  return <path key={s.key} d={roundTop(x, y, bw, h - (si > 0 ? 2 : 0), si === present.length - 1 ? Math.min(4, bw / 2) : 0)} style={{ fill: `var(${row.color ?? s.color})` }} />;
                })}
                {valueLabels && (
                  <text className="nm-chart-value" x={x + bw / 2} y={base - 6} textAnchor="middle">
                    {fmt(series.reduce((sum, s) => sum + value(row, s.key), 0))}{unit}
                  </text>
                )}
                {(rows.length - 1 - i) % every === 0 && (
                  <text className="nm-chart-axis" x={x + bw / 2} y={height - 6} textAnchor="middle">{row.label}</text>
                )}
                <rect className="nm-chart-hit" x={padL + slot * i} y={padT} width={slot} height={plotH} tabIndex={0}
                  aria-label={`${row.label}: ${series.map((s) => `${s.label} ${fmt(value(row, s.key))}${unit}`).join(", ")}`}
                  onPointerEnter={onEnter} onFocus={onEnter} onPointerLeave={onLeave} onBlur={onLeave} />
              </g>
            );
          })}
        </svg>
      )}
      <ChartTooltip tip={tip} />
    </div>
  );
}

/** One horizontal bar split into parts of a whole, with a legend. */
export function StackBar({ items, label, of = "of total" }: { items: ChartItem[]; label: string; of?: string }) {
  const { tip, show, hide } = useTip();
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="nm-stackbar-chart">
      <div className="nm-stackbar" role="img" aria-label={`${label}: ${items.map((i) => `${i.label} ${fmt(i.value)}`).join(", ")}`}>
        {items.filter((item) => item.value > 0).map((item, index) => {
          const onEnter = (event: { currentTarget: Element }) => show(event.currentTarget, item.label, [{ color: item.color, label: `${((item.value / total) * 100).toFixed(1)}% ${of}`, value: fmt(item.value) }]);
          return (
            <span key={item.label} tabIndex={0} aria-label={`${item.label} ${fmt(item.value)}`}
              style={{ flex: `${item.value} 0 0`, background: `var(${item.color})`, "--nm-chart-i": index } as CSSProperties}
              onPointerEnter={onEnter} onFocus={onEnter} onPointerLeave={hide} onBlur={hide} />
          );
        })}
      </div>
      <ChartLegend items={items} />
      <ChartTooltip tip={tip} />
    </div>
  );
}

/** Tiny per-day activity bars for a list row. */
export function SparkBars({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  return (
    <span className="nm-sparkbars" role="img" aria-label={label}>
      {values.map((v, i) => (
        <i key={i} className={v ? undefined : "is-empty"} style={{ height: `${v ? Math.max(12, (v / max) * 100) : 6}%`, "--nm-chart-i": i } as CSSProperties} />
      ))}
    </span>
  );
}

/** Counts a number up once on mount; renders the final text under reduced motion. */
export function CountUp({ value, decimals = 0, prefix = "", suffix = "" }: { value: number; decimals?: number; prefix?: string; suffix?: string }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setShown(value); return; }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 900);
      setShown(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{prefix}{shown.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}</>;
}

export type BarItem = { label: string; value: number; color?: ChartColor | string; hint?: string };

/** Horizontal bars with a label and count per row; colours are tokens or runtime entity colours. */
export function BarList({ items, label, max, unit = "", empty = "Nothing to show yet." }: {
  items: BarItem[];
  label: string;
  max?: number;
  unit?: string;
  empty?: string;
}) {
  const { tip, show, hide } = useTip();
  if (items.length === 0) return <p className="tool-note nm-chart-empty">{empty}</p>;
  const top = max ?? Math.max(1, ...items.map((item) => item.value));
  const paint = (color?: string) => (color?.startsWith("--") ? `var(${color})` : color ?? "var(--dash-blue)");
  return (
    <ul className="nm-bar-list" aria-label={label}>
      {items.map((item, index) => {
        const value = `${item.value.toLocaleString()}${unit}`;
        const onEnter = (event: { currentTarget: Element }) => show(event.currentTarget, item.label, [{ color: (item.color?.startsWith("--") ? item.color : "--dash-blue") as ChartColor, label: item.hint ?? label, value }]);
        return (
          <li key={item.label} tabIndex={0} aria-label={`${item.label}: ${value}`} onPointerEnter={onEnter} onFocus={onEnter} onPointerLeave={hide} onBlur={hide}>
            <span className="nm-bar-list-label">{item.label}</span>
            <span className="nm-bar-list-track"><i style={{ width: `${Math.min(100, (item.value / top) * 100)}%`, background: paint(item.color), "--nm-chart-i": index } as CSSProperties} /></span>
            <strong>{value}</strong>
          </li>
        );
      })}
      <ChartTooltip tip={tip} />
    </ul>
  );
}

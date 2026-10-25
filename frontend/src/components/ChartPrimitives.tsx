import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A chart colour is the name of an existing token, e.g. "--dash-blue". */
export type ChartColor = `--${string}`;
/** A token name, or a runtime entity colour such as a site's hex colour. */
export type ChartPaint = ChartColor | (string & {});
export type ChartItem = { label: string; value: number; color: ChartPaint };

export const paint = (color?: ChartPaint) => (color?.startsWith("--") ? `var(${color})` : color ?? "var(--dash-blue)");

const fmt = (n: number) => n.toLocaleString();

type TipRow = { color: ChartPaint; label: string; value: string };
type Tip = { anchor: DOMRect; title: string; rows: TipRow[] } | null;

export function ChartTooltip({ tip }: { tip: Tip }) {
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
          <span className="nm-chart-swatch" style={{ background: paint(row.color) }} aria-hidden="true" />
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const show = (el: Element, title: string, rows: TipRow[]) => setTip({ anchor: el.getBoundingClientRect(), title, rows });
  return { tip, show, hide: () => setTip(null) };
}

export type LegendShow = "value" | "percent" | "both";

export function ChartLegend({ items, unit = "", show = "value", bars = false, hideValues = false }: { items: ChartItem[]; unit?: string; show?: LegendShow; bars?: boolean; hideValues?: boolean }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const pct = (value: number) => `${total ? Math.round((value / total) * 100) : 0}%`;
  return (
    <ul className={`nm-chart-legend${bars ? " nm-chart-legend--bars" : ""}${show === "both" ? " nm-chart-legend--both" : ""}`}>
      {items.map((item, index) => (
        <li key={item.label}>
          <span className="nm-chart-swatch" style={{ background: paint(item.color) }} aria-hidden="true" />
          <span className="nm-chart-legend-label">{item.label}</span>
          {bars && (
            <span className="nm-chart-legend-track" aria-hidden="true">
              <i style={{ width: `${total ? Math.sqrt(item.value / total) * 100 : 0}%`, background: paint(item.color), "--nm-chart-i": index } as CSSProperties} />
            </span>
          )}
          {!hideValues && <strong>{show === "percent" ? pct(item.value) : `${fmt(item.value)}${unit}`}</strong>}
          {!hideValues && show === "both" && <span className="nm-chart-legend-pct">{pct(item.value)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Multi-segment ring on the UsageRing geometry, with a legend and per-segment tooltips. */
export function DonutChart({ items, centre, sub, unit = "", label, legend = true, legendShow = "value", legendPosition = "side", legendBars = true }: {
  items: ChartItem[];
  centre: ReactNode;
  sub: string;
  unit?: string;
  label: string;
  legend?: boolean;
  legendShow?: LegendShow;
  legendPosition?: "side" | "below";
  legendBars?: boolean;
}) {
  const { tip, show, hide } = useTip();
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const r = 40;
  const circ = 2 * Math.PI * r;
  const visible = items.filter((item) => item.value > 0);
  let offset = 0;
  return (
    <div className={`nm-donut-chart${legendPosition === "below" ? " nm-donut-chart--below" : ""}`}>
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
                style={{ stroke: paint(item.color), "--nm-chart-i": index } as CSSProperties}
                onPointerEnter={onEnter} onFocus={onEnter} onPointerLeave={hide} onBlur={hide}
              />
            );
          })}
        </svg>
        <div className="dash-donut-center"><span className="dash-donut-pct">{centre}</span><span className="dash-donut-label">{sub}</span></div>
      </div>
      {legend && <ChartLegend items={items} unit={unit} show={legendShow} bars={legendBars} />}
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
 * A row's `color` overrides the series colour (one category per column); `valueLabels` prints each total above its column.
 * `scale="sqrt"` keeps small columns readable beside a dominant one and drops the y-axis numbers, so pair it with `valueLabels`.
 * `onSelect` makes each column a button (click, Enter or Space). */
export function ColumnChart({ rows, series, label, height = 150, unit = "", valueLabels = false, barMax = 28, scale = "linear", onSelect }: {
  rows: ({ label: string; color?: ChartPaint } & Record<string, number | string>)[];
  series: ColumnSeries[];
  label: string;
  height?: number;
  unit?: string;
  valueLabels?: boolean;
  barMax?: number;
  scale?: "linear" | "sqrt";
  onSelect?: (label: string) => void;
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
  const sqrt = scale === "sqrt";
  const padL = sqrt ? 4 : 34, padB = 22, padT = valueLabels ? 26 : 8;
  const value = (row: (typeof rows)[number], key: string) => Number(row[key]) || 0;
  const max = Math.max(1, ...rows.map((row) => series.reduce((sum, s) => sum + value(row, s.key), 0)));
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const plotW = Math.max(0, width - padL * 2);
  const plotH = height - padB - padT;
  const slot = rows.length ? plotW / rows.length : 0;
  const bw = Math.max(4, Math.min(barMax, slot * 0.6));
  const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(plotW / 70))));
  const labelLimit = Math.max(2, Math.min(16, Math.floor((slot - 8) / 7)));
  const ticks: number[] = [];
  for (let v = 0; v <= (sqrt ? 0 : top + 1e-9); v += step) ticks.push(v);
  const columnHeight = (total: number) => (sqrt ? Math.sqrt(total / max) : total / top) * plotH;
  return (
    <div ref={host} className="nm-column-chart">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} className={active === null ? undefined : "has-active"}>
          {ticks.map((v) => {
            const y = padT + plotH - (v / top) * plotH;
            return (
              <g key={v}>
                <line className={v ? "nm-chart-grid" : "nm-chart-baseline"} x1={padL} x2={width - padL} y1={y} y2={y} />
                {!sqrt && <text className="nm-chart-axis" x={padL - 6} y={y + 3} textAnchor="end">{fmt(Math.round(v * 10) / 10)}</text>}
              </g>
            );
          })}
          {rows.map((row, i) => {
            const x = padL + slot * i + (slot - bw) / 2;
            let base = padT + plotH;
            const present = series.filter((s) => value(row, s.key) > 0);
            const total = series.reduce((sum, s) => sum + value(row, s.key), 0);
            const totalText = `${fmt(total)}${unit}`;
            const colH = columnHeight(total);
            const onEnter = (event: { currentTarget: Element }) => {
              setActive(i);
              show(event.currentTarget, row.label, series.map((s) => ({ color: row.color ?? s.color, label: s.label, value: `${fmt(value(row, s.key))}${unit}` })));
            };
            const onLeave = () => { setActive(null); hide(); };
            return (
              <g key={row.label} className={`nm-chart-col${active === i ? " is-active" : ""}`} style={{ "--nm-chart-i": i } as CSSProperties}>
                <rect className="nm-chart-col-bg" x={padL + slot * i} y={padT} width={slot} height={plotH} aria-hidden="true" />
                {present.map((s, si) => {
                  const h = total ? (value(row, s.key) / total) * colH : 0;
                  const y = base - h;
                  base = y;
                  return <path key={s.key} d={roundTop(x, y, bw, h - (si > 0 ? 2 : 0), si === present.length - 1 ? Math.min(4, bw / 2) : 0)} style={{ fill: paint(row.color ?? s.color) }} />;
                })}
                {valueLabels && (
                  <>
                    <rect className="nm-chart-value-bg" x={x + bw / 2 - (totalText.length * 7 + 14) / 2} y={base - 23} width={totalText.length * 7 + 14} height={18} rx={9} aria-hidden="true" />
                    <text className="nm-chart-value" x={x + bw / 2} y={base - 10} textAnchor="middle">{totalText}</text>
                  </>
                )}
                {(rows.length - 1 - i) % every === 0 && (
                  <g><title>{row.label}</title><text className="nm-chart-axis" x={x + bw / 2} y={height - 6} textAnchor="middle" aria-label={row.label}>{row.label.length > labelLimit ? `${row.label.slice(0, labelLimit - 1)}…` : row.label}</text></g>
                )}
                <rect className="nm-chart-hit" x={padL + slot * i} y={padT} width={slot} height={plotH} tabIndex={0}
                  role={onSelect ? "button" : undefined}
                  aria-label={`${row.label}: ${series.map((s) => `${s.label} ${fmt(value(row, s.key))}${unit}`).join(", ")}`}
                  onPointerEnter={onEnter} onFocus={onEnter} onPointerLeave={onLeave} onBlur={onLeave}
                  onClick={onSelect ? () => { hide(); onSelect(row.label); } : undefined}
                  onKeyDown={onSelect ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); hide(); onSelect(row.label); } } : undefined} />
              </g>
            );
          })}
        </svg>
      )}
      <ChartTooltip tip={tip} />
    </div>
  );
}

/** Monotone cubic path through the points: smooth, never overshooting the data. */
export function smoothPath(points: [number, number][]) {
  if (points.length < 3) return points.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join("");
  const slopes = points.slice(1).map(([px, py], i) => (py - points[i][1]) / (px - points[i][0] || 1));
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === points.length - 1) return slopes[slopes.length - 1];
    return slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
  });
  return points.map(([px, py], i) => {
    if (i === 0) return `M${px},${py}`;
    const [x0, y0] = points[i - 1];
    const dx = (px - x0) / 3;
    return `C${x0 + dx},${y0 + tangents[i - 1] * dx} ${px - dx},${py - tangents[i] * dx} ${px},${py}`;
  }).join("");
}

/** Area chart: one axis, recessive grid, 2px lines over a soft fill, crosshair tooltip and markers per point.
 * `zoomable` adds wheel zoom and drag to scroll the zoomed timeline (double-click, Escape or Reset zoom to return); `reference` draws a dashed guide such as an average. */
export function AreaChart({ rows, series, label, height = 150, unit = "", zoomable = false, reference, filled = true }: {
  rows: ({ label: string } & Record<string, number | string>)[];
  series: ColumnSeries[];
  label: string;
  height?: number;
  unit?: string;
  zoomable?: boolean;
  filled?: boolean;
  reference?: { value: number; label: string };
}) {
  const host = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const { tip, show, hide } = useTip();
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setRange(null); }, [rows.length]);
  const zoomState = useRef({ range, total: rows.length, padL: 34, plotW: 0 });
  useEffect(() => {
    const svg = svgRef.current;
    if (!zoomable || !svg) return undefined;
    const onWheel = (event: WheelEvent) => {
      const { range: current, total, padL: left, plotW: plot } = zoomState.current;
      if (total < 5 || !plot) return;
      event.preventDefault();
      const [a, b] = current ?? [0, total - 1];
      const span = b - a;
      const ratio = Math.min(1, Math.max(0, (event.clientX - svg.getBoundingClientRect().left - left) / plot));
      const centre = a + ratio * span;
      const factor = Math.min(1.6, Math.max(0.6, Math.exp(event.deltaY * 0.0015)));
      const scaled = Math.round(span * factor);
      const next = scaled === span ? span + Math.sign(event.deltaY) : scaled;
      if (next >= total - 1) { setRange(null); return; }
      const width = Math.max(4, next);
      const start = Math.min(total - 1 - width, Math.max(0, Math.round(centre - ratio * width)));
      setRange([start, start + width]);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomable, width]);
  const visible = range ? rows.slice(range[0], range[1] + 1) : rows;
  const padL = 34, padB = 22, padT = 10, padR = reference ? 52 : 8;
  const value = (row: (typeof rows)[number], key: string) => Number(row[key]) || 0;
  const max = Math.max(1, reference?.value ?? 0, ...visible.flatMap((row) => series.map((s) => value(row, s.key))));
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = height - padB - padT;
  const base = padT + plotH;
  const n = visible.length;
  zoomState.current = { range, total: rows.length, padL, plotW };
  const x = (i: number) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v: number) => base - (v / top) * plotH;
  const slot = n > 1 ? plotW / (n - 1) : plotW;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const tipRows = (row: (typeof rows)[number]) => series.map((s) => ({ color: s.color, label: s.label, value: `${fmt(value(row, s.key))}${unit}` }));
  const showAt = (i: number) => {
    const svg = svgRef.current;
    if (!svg || !visible[i]) return;
    const box = svg.getBoundingClientRect();
    const anchor = { getBoundingClientRect: () => new DOMRect(box.left + x(i), box.top + padT, 1, plotH) } as unknown as Element;
    setActive(i);
    show(anchor, visible[i].label, tipRows(visible[i]));
  };
  const indexAt = (clientX: number) => {
    const box = svgRef.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - box.left - padL) / (plotW || 1)));
    return Math.round(ratio * (n - 1));
  };
  const reset = () => { setRange(null); drag.current = null; hide(); setActive(null); };
  const zoomed = range !== null;
  return (
    <div ref={host} className={`nm-area-chart${zoomable ? " nm-area-chart--zoomable" : ""}`}>
      {zoomable && (
        <div className="nm-area-chart-tools">
          <span className="dash-panel-meta">{zoomed ? `${visible[0]?.label} – ${visible[n - 1]?.label} · drag to move along the timeline` : "Scroll over the chart to zoom"}</span>
          {zoomed && <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost" onClick={reset}>Reset zoom</button>}
        </div>
      )}
      {width > 0 && (
        <svg ref={svgRef} width={width} height={height} role="img" aria-label={label}>
          {ticks.map((v) => (
            <g key={v}>
              <line className={v ? "nm-chart-grid" : "nm-chart-baseline"} x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} />
              <text className="nm-chart-axis" x={padL - 6} y={y(v) + 3} textAnchor="end">{fmt(Math.round(v * 10) / 10)}</text>
            </g>
          ))}
          {series.map((s) => {
            const line = smoothPath(visible.map((row, i) => [x(i), y(value(row, s.key))]));
            return (
              <g key={s.key}>
                {filled && <path className="nm-chart-area" d={`${line}L${x(n - 1)},${base}L${x(0)},${base}Z`} style={{ fill: paint(s.color) }} />}
                <path className="nm-chart-line" d={line} style={{ stroke: paint(s.color) }} />
              </g>
            );
          })}
          {reference && (
            <g className="nm-chart-reference">
              <line x1={padL} x2={width - padR} y1={y(reference.value)} y2={y(reference.value)} />
              <text x={width - padR + 6} y={y(reference.value) + 3}>{reference.label}</text>
            </g>
          )}
          {visible.map((row, i) => (
            <g key={`${row.label}-${i}`} className={`nm-chart-pt${active === i ? " is-active" : ""}`}>
              {active === i && <line className="nm-chart-crosshair" x1={x(i)} x2={x(i)} y1={padT} y2={base} />}
              {active === i && series.map((s) => (
                <circle key={s.key} className="nm-chart-marker" cx={x(i)} cy={y(value(row, s.key))} r={4.5} style={{ fill: paint(s.color) }} />
              ))}
              {(n - 1 - i) % every === 0 && (
                <text className="nm-chart-axis nm-chart-axis-x" x={x(i)} y={height - 6} textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"}>{row.label}</text>
              )}
              {!zoomable && (
                <rect className="nm-chart-hit" x={Math.max(padL, x(i) - slot / 2)} y={padT} width={Math.min(slot, plotW)} height={plotH} tabIndex={0}
                  aria-label={`${row.label}: ${series.map((s) => `${s.label} ${fmt(value(row, s.key))}${unit}`).join(", ")}`}
                  onPointerEnter={() => showAt(i)} onFocus={() => showAt(i)} onPointerLeave={() => { setActive(null); hide(); }} onBlur={() => { setActive(null); hide(); }} />
              )}
            </g>
          ))}
          {zoomable && (
            <rect className={`nm-chart-zoom-hit${zoomed ? " is-zoomed" : ""}`} x={padL} y={padT} width={plotW} height={plotH} tabIndex={0}
              aria-label={`${label}: scroll to zoom, drag to move along the timeline, arrow keys to read values, Escape to reset`}
              onPointerMove={(event) => {
                if (drag.current && range) {
                  const span = range[1] - range[0];
                  const shift = Math.round(((drag.current.x - event.clientX) / (plotW || 1)) * span);
                  const start = Math.min(rows.length - 1 - span, Math.max(0, drag.current.start + shift));
                  if (start !== range[0]) setRange([start, start + span]);
                  hide();
                  return;
                }
                showAt(indexAt(event.clientX));
              }}
              onPointerDown={(event) => {
                if (!range) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { x: event.clientX, start: range[0] };
              }}
              onPointerUp={() => { drag.current = null; }}
              onPointerLeave={() => { if (!drag.current) { setActive(null); hide(); } }}
              onDoubleClick={reset}
              onKeyDown={(event) => {
                if (event.key === "Escape") { reset(); return; }
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const from = active ?? n - 1;
                showAt(Math.min(n - 1, Math.max(0, from + (event.key === "ArrowLeft" ? -1 : 1))));
              }}
              onBlur={() => { setActive(null); hide(); }} />
          )}
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
              style={{ flex: `${item.value} 0 0`, background: paint(item.color), "--nm-chart-i": index } as CSSProperties}
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

export type BarItem = { label: string; value: number; color?: ChartPaint; hint?: string };

/** Horizontal bars with a label and count per row; colours are tokens or runtime entity colours. */
export function BarList({ items, label, max, unit = "", empty = "Nothing to show yet.", showValues = true, formatValue, onSelect }: {
  items: BarItem[];
  label: string;
  max?: number;
  unit?: string;
  empty?: string;
  showValues?: boolean;
  formatValue?: (value: number) => string;
  onSelect?: (label: string) => void;
}) {
  const { tip, show, hide } = useTip();
  if (items.length === 0) return <p className="tool-note nm-chart-empty">{empty}</p>;
  const top = max ?? (Math.max(0, ...items.map((item) => item.value)) || 1);
  return (
    <ul className="nm-bar-list" aria-label={label}>
      {items.map((item, index) => {
        const value = formatValue ? formatValue(item.value) : `${item.value.toLocaleString()}${unit}`;
        const onEnter = (event: { currentTarget: Element }) => show(event.currentTarget, item.label, [{ color: item.color ?? "--dash-blue", label: item.hint ?? label, value }]);
        return (
          <li key={item.label} tabIndex={0} role={onSelect ? "button" : undefined} aria-label={`${item.label}: ${value}`} onPointerEnter={onEnter} onFocus={onEnter} onPointerLeave={hide} onBlur={hide} onClick={onSelect ? () => { hide(); onSelect(item.label); } : onEnter} onKeyDown={event => { if (onSelect && ["Enter", " "].includes(event.key)) { event.preventDefault(); hide(); onSelect(item.label); } }}>
            <span className="nm-bar-list-label">{item.label}</span>
            <span className="nm-bar-list-track"><i style={{ width: `${Math.min(100, (item.value / top) * 100)}%`, background: paint(item.color), "--nm-chart-i": index } as CSSProperties} /></span>
            <strong>{showValues ? value : null}</strong>
          </li>
        );
      })}
      <ChartTooltip tip={tip} />
    </ul>
  );
}

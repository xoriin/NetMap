import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AreaChart, BarList, ChartLegend, ChartValueLabel, ChartTooltip, useTip, paint, smoothPath } from './ChartPrimitives';
import type { ChartData } from './PersonalChart';
import { chartLegendPosition, composeChartView, type ChartViewOptions } from '../utils/chartViews';

const number = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function PersonalChartRenderer({ data, options: requested, label }: { data: ChartData; options: ChartViewOptions; label: string }) {
  const options = composeChartView(requested, requested.type === 'default' ? 'ring' : requested.type);
  const host = useRef<HTMLDivElement>(null);
  const visualHost = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { tip, show, hide } = useTip();
  useEffect(() => {
    const measured = visualHost.current ?? host.current;
    if (!measured) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(measured);
    return () => observer.disconnect();
  }, [options.type, options.position, options.legend, options.chart, options.bars, options.bar_position, data.rows.length, data.series.length]);
  const rows = [...data.rows];
  const totalOf = (row: typeof rows[number]) => data.series.reduce((n, s) => n + number(row[s.key]), 0);
  if (data.kind !== 'time') {
    if (options.order === 'largest') rows.sort((a, b) => totalOf(b) - totalOf(a));
    if (options.order === 'smallest') rows.sort((a, b) => totalOf(a) - totalOf(b));
    if (options.order === 'name') rows.sort((a, b) => a.label.localeCompare(b.label));
  }
  const parts = data.kind === 'parts' && data.series.length === 1;
  const total = rows.reduce((n, d) => n + totalOf(d), 0);
  const unit = data.unit ?? '';
  const pct = (v: number) => total ? v / total * 100 : 0;
  const display = (v: number) => parts && options.values === 'percent' ? `${fmt(pct(v))}%` : `${fmt(v)}${unit}${parts && options.values === 'both' ? ` · ${fmt(pct(v))}%` : ''}`;
  const colour = (row: typeof rows[number], si = 0) => data.series.length === 1 ? row.color ?? data.series[si].color : data.series[si].color;
  const items = rows.map(d => ({ label: d.label, value: totalOf(d), color: colour(d) }));
  const category = rows.find(row => row.label === options.category);
  const categoryValue = category ? totalOf(category) : total;
  const categoryLabel = category?.label ?? (data.noun ? `Total ${data.noun}` : 'Total');
  const readout = (value: number, caption: string) => <><strong>{parts && options.values === 'percent' ? `${fmt(pct(value))}%` : `${fmt(value)}${unit}`}</strong>{parts && options.values === 'both' && <small>{fmt(pct(value))}%</small>}<span title={caption}>{caption}</span></>;
  const partLegend = options.legend && <ChartLegend items={items} unit={unit} show={parts ? options.values : 'value'} hideValues={!options.labels} />;
  const seriesLegend = options.legend && <ChartLegend items={data.series.map(s => ({ label: s.label, value: 0, color: s.color }))} hideValues />;
  const paired = (visual: ReactNode, companion: ReactNode, position: string, kind: 'bars' | 'legend', round = false) => {
    if (!visual) return companion;
    if (!companion) return visual;
    const before = ['top', 'left'].includes(position);
    return <div className={`nm-chart-pair${round ? ' nm-personal-ring-layout' : ''}${['number', 'gauge'].includes(options.type) ? ' nm-chart-pair--metric' : ''}${round && options.type === 'pie' ? ' nm-personal-ring-layout--pie' : ''}${round && position === 'bottom' ? ' nm-personal-ring-layout--below' : ''}`} data-legend-position={position} data-chart-pair={kind}>
      {before ? companion : null}<div className="nm-chart-pair-visual">{visual}</div>{!before ? companion : null}
    </div>;
  };
  const onEnter = (el: Element, row: typeof rows[number]) => show(el, row.label, data.series.map((s, si) => ({ color: colour(row, si), label: s.label, value: display(number(row[s.key])) })));
  const markEvents = (row: typeof rows[number]) => ({
    tabIndex: 0, role: data.onSelect ? 'button' as const : undefined,
    'aria-label': `${row.label}: ${data.series.map(s => `${s.label} ${display(number(row[s.key]))}`).join(', ')}`,
    onPointerEnter: (e: { currentTarget: Element }) => onEnter(e.currentTarget, row), onFocus: (e: { currentTarget: Element }) => onEnter(e.currentTarget, row),
    onPointerLeave: hide, onBlur: hide,
    onClick: (e: { currentTarget: Element }) => { if (data.onSelect) { hide(); data.onSelect(row.label); } else onEnter(e.currentTarget, row); },
    onKeyDown: (e: { key: string; preventDefault: () => void }) => { if (data.onSelect && ['Enter', ' '].includes(e.key)) { e.preventDefault(); hide(); data.onSelect(row.label); } },
  });
  const bars = <BarList label={label} max={data.maximum} showValues={options.labels} unit={unit} formatValue={parts && options.values !== 'value' ? display : undefined} onSelect={data.onSelect ? value => data.onSelect?.(rows.find(row => data.series.some(s => `${row.label} · ${s.label}` === value))?.label ?? value) : undefined} items={rows.flatMap(row => data.series.map((s, si) => ({ label: data.series.length > 1 ? `${row.label} · ${s.label}` : row.label, value: number(row[s.key]), color: colour(row, si), hint: s.label })))} />;
  let content: ReactNode;
  if (!rows.length || !data.series.length) content = <p className="tool-note nm-chart-empty">No data to display.</p>;
  else if (parts && total <= 0 && ['ring', 'pie', 'stacked', 'treemap', 'gauge'].includes(options.type)) content = <p className="tool-note nm-chart-empty">No data to display.</p>;
  else if (data.zoomable && ['area', 'line'].includes(options.type)) content = <AreaChart label={label} rows={rows.map(row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as { label: string } & Record<string, number | string>)} series={data.series} unit={unit} zoomable reference={data.reference} filled={options.type === 'area'} height={220} />;
  else if ((options.type === 'ring' || options.type === 'pie') && total > 0) {
    const radius = 40, circumference = 2 * Math.PI * radius;
    let offset = 0;
    const segments = rows.filter(d => totalOf(d) > 0);
    let angle = -Math.PI / 2;
    const pieLabels: { label: string; value: number; x: number; y: number }[] = [];
    const visual = <div className={`nm-personal-ring${options.type === 'pie' ? ' nm-personal-pie' : ''}`}><svg viewBox="0 0 100 100" role="img" aria-label={label}>
      {segments.map(row => {
        const value = totalOf(row), arc = value / total * 2 * Math.PI;
        if (options.type === 'pie') {
          const start = angle; angle += arc;
          if (options.labels && value / total >= .14) {
            const mid = start + arc / 2;
            pieLabels.push({ label: row.label, value, x: segments.length === 1 ? 50 : 50 + 28 * Math.cos(mid), y: segments.length === 1 ? 50 : 50 + 28 * Math.sin(mid) });
          }
          return segments.length === 1 ? <circle key={row.label} cx={50} cy={50} r={46} fill={paint(colour(row))} {...markEvents(row)} /> : <path key={row.label} d={`M50,50 L${50 + 46 * Math.cos(start)},${50 + 46 * Math.sin(start)} A46,46 0 ${arc > Math.PI ? 1 : 0},1 ${50 + 46 * Math.cos(angle)},${50 + 46 * Math.sin(angle)} Z`} fill={paint(colour(row))} {...markEvents(row)} />;
        }
        const length = value / total * circumference, start = offset; offset += length;
        return <circle key={row.label} cx={50} cy={50} r={radius} fill="none" stroke={paint(colour(row))} strokeWidth={10} strokeDasharray={`${Math.max(.5, length - (segments.length > 1 ? 1.5 : 0))} ${circumference}`} strokeDashoffset={-start} transform="rotate(-90 50 50)" {...markEvents(row)} />;
      })}
      {pieLabels.map(item => <g key={item.label} className="nm-personal-pie-label" transform={`translate(${item.x} ${item.y})`} aria-hidden="true"><rect x={-19} y={-10} width={38} height={20} rx={3} /><text textAnchor="middle"><tspan x={0} y={-1}>{item.label.length > 9 ? `${item.label.slice(0, 8)}…` : item.label}</tspan><tspan x={0} y={7}>{display(item.value).length > 11 ? `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(item.value)}${unit}${options.values === 'both' ? ` · ${Math.round(pct(item.value))}%` : ''}` : display(item.value)}</tspan></text></g>)}
    </svg>{options.type === 'ring' && options.labels && <div className="nm-personal-ring-centre">{readout(categoryValue, categoryLabel)}</div>}</div>;
    content = visual;
  } else if (options.type === 'bars') {
    content = bars;
  } else if (options.type === 'stacked') {
    content = <div className="nm-stackbar" role="img" aria-label={label}>{rows.filter(d => totalOf(d) > 0).map(row => <span key={row.label} style={{ flex: `${totalOf(row)} 0 0`, background: paint(colour(row)) }} {...markEvents(row)} />)}</div>;
  } else if (options.type === 'treemap') {
    const tiles: { row: typeof rows[number]; x: number; y: number; w: number; h: number }[] = [];
    const tile = (list: typeof rows, x: number, y: number, w: number, h: number) => {
      if (!list.length) return;
      if (list.length === 1) { tiles.push({ row: list[0], x, y, w, h }); return; }
      const sum = list.reduce((n, row) => n + totalOf(row), 0);
      let split = 1, head = totalOf(list[0]);
      while (split < list.length - 1 && Math.abs(head + totalOf(list[split]) - sum / 2) < Math.abs(head - sum / 2)) head += totalOf(list[split++]);
      const ratio = head / sum;
      if (w >= h) { tile(list.slice(0, split), x, y, w * ratio, h); tile(list.slice(split), x + w * ratio, y, w * (1 - ratio), h); }
      else { tile(list.slice(0, split), x, y, w, h * ratio); tile(list.slice(split), x, y + h * ratio, w, h * (1 - ratio)); }
    };
    tile(rows.filter(row => totalOf(row) > 0), 0, 0, width, 180);
    content = <div className="nm-personal-treemap" role="img" aria-label={label}>{tiles.map(({ row, x, y, w, h }) => <div key={row.label} style={{ left: x, top: y, width: Math.max(0, w - 2), height: Math.max(0, h - 2), '--nm-chart-paint': paint(colour(row)) } as CSSProperties} {...markEvents(row)}>{w > 55 && h > 35 && <><span>{row.label}</span>{options.labels && <strong>{display(totalOf(row))}</strong>}</>}</div>)}</div>;
  } else if (options.type === 'gauge') {
    // A named share of the original dataset; never infer a target or uptime from counts.
    const first = category ?? data.rows[0], share = pct(totalOf(first));
    content = <div className="nm-personal-gauge"><svg viewBox="0 0 240 140" role="img" aria-label={`${first.label}: ${fmt(share)}%`}><path d="M20,115 A100,100 0 0,1 220,115" pathLength={100} fill="none" stroke="var(--nm-track-bg)" strokeWidth={14} /><path d="M20,115 A100,100 0 0,1 220,115" pathLength={100} fill="none" stroke={paint(colour(first))} strokeWidth={14} strokeDasharray={`${share} 100`} /><text x={120} y={105} textAnchor="middle">{fmt(share)}%</text></svg><span>{first.label} · {fmt(totalOf(first))} of {fmt(total)}{unit}</span></div>;
  } else if (options.type === 'number') {
    const value = parts ? categoryValue : data.kind === 'time' ? totalOf(data.rows[data.rows.length - 1]) : Math.max(...rows.map(totalOf));
    content = <div className="nm-personal-number">{readout(value, parts ? categoryLabel : data.kind === 'time' ? 'Latest reading' : 'Highest value')}</div>;
  } else if (options.type === 'table') {
    content = <div className="nm-table-wrap nm-personal-table"><table className="nm-table"><thead><tr><th>{data.kind === 'time' ? 'Time' : 'Category'}</th>{data.series.map(s => <th key={s.key} className="nm-table-num">{s.label}{unit && ` (${unit.trim()})`}</th>)}{parts && <th className="nm-table-num">Share</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.label}-${index}`}><td>{data.onSelect ? <button className="nm-btn nm-btn--ghost nm-btn--sm" onClick={() => data.onSelect?.(row.label)}>{row.label}</button> : row.label}</td>{data.series.map(s => <td key={s.key} className="nm-table-num">{fmt(number(row[s.key]))}</td>)}{parts && <td className="nm-table-num">{fmt(pct(totalOf(row)))}%</td>}</tr>)}</tbody></table></div>;
  } else {
    const percent = parts && options.values === 'percent';
    const measure = (v: number) => percent ? pct(v) : v;
    const left = 44, right = 44, height = 214, top = 30, baseline = 176, plotW = Math.max(0, width - left - right), n = rows.length;
    const maximum = Math.max(0, measure(data.reference?.value ?? 0), ...rows.map(row => options.type === 'columns' ? measure(totalOf(row)) : Math.max(...data.series.map(s => measure(number(row[s.key])))))) || 1;
    const step = Math.pow(10, Math.floor(Math.log10(maximum)));
    const ceiling = Math.ceil(maximum / step) * step;
    const x = (i: number) => left + (i + .5) * plotW / n;
    const y = (v: number) => baseline - measure(v) / ceiling * (baseline - top);
    const slot = plotW / n, barWidth = Math.min(32, slot * .6);
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 80))));
    const limit = options.type === 'columns' ? Math.max(2, Math.min(14, Math.floor((slot - 8) / 7))) : 13;
    const ticks = [0, ceiling / 2, ceiling];
    content = <>{width > 0 && <svg className="nm-personal-plot" width={width} height={height} role="img" aria-label={`${label}${percent ? ' (%)' : unit ? ` (${unit.trim()})` : ''}`}>
      {ticks.map(v => <g key={v}><line className="nm-chart-grid" x1={left} x2={width - right} y1={baseline - v / ceiling * (baseline - top)} y2={baseline - v / ceiling * (baseline - top)} /><text className="nm-chart-axis" x={left - 6} y={baseline - v / ceiling * (baseline - top) + 4} textAnchor="end">{fmt(v)}{percent ? '%' : ''}</text></g>)}
      {['line', 'area'].includes(options.type) && data.series.map((s, si) => {
        const path = smoothPath(rows.map((row, i) => [x(i), y(number(row[s.key]))]));
        return <g key={s.key}>{options.type === 'area' && <path className="nm-chart-area" d={`${path}L${x(n - 1)},${baseline}L${x(0)},${baseline}Z`} fill={paint(s.color)} />}<path className="nm-chart-line" d={path} stroke={paint(s.color)} fill="none" /></g>;
      })}
      {data.reference && <g className="nm-chart-reference"><line x1={left} x2={width - right} y1={y(data.reference.value)} y2={y(data.reference.value)} /><text x={width - right} y={y(data.reference.value) - 5} textAnchor="end">{data.reference.label}</text></g>}
      {rows.map((row, i) => {
        let base = baseline;
        return <g key={`${row.label}-${i}`}>
          {data.series.map((s, si) => { const value = number(row[s.key]), yy = y(value), h = baseline - yy; base -= h; return options.type === 'columns' ? <rect key={s.key} className="nm-chart-column-bar" x={x(i) - barWidth / 2} y={base} width={barWidth} height={Math.max(0, h)} rx={Math.min(3, h / 2)} fill={paint(colour(row, si))} /> : <circle key={s.key} cx={x(i)} cy={yy} r={options.type === 'dots' ? 4.5 : 2.5} fill={paint(colour(row, si))} />; })}
          {options.labels && (options.type === 'columns'
            ? totalOf(row) !== 0 && <ChartValueLabel x={x(i)} y={Math.max(14, y(totalOf(row)) - 8)} text={display(totalOf(row))} />
            : i % every === 0 && <text className="nm-chart-axis nm-personal-value" x={x(i)} y={Math.max(12, y(number(row[data.series[0].key])) - 8)} textAnchor="middle">{display(number(row[data.series[0].key]))}</text>)}
          {(i % every === 0 || i === n - 1) && <text className="nm-chart-axis" x={x(i)} y={height - 12} textAnchor="middle"><title>{row.label}</title>{row.label.length > limit ? `${row.label.slice(0, limit - 1)}…` : row.label}</text>}
          <rect className="nm-chart-hit" x={left + i * slot} y={top} width={slot} height={baseline - top} {...markEvents(row)} />
        </g>;
      })}
    </svg>}{unit && <span className="dash-panel-meta">{unit.trim()}</span>}</>;
  }
  const round = ['ring', 'pie'].includes(options.type);
  const main = options.chart ? <div ref={visualHost} className={`nm-chart-element${round ? ' nm-chart-element--round' : ''}${options.type === 'pie' ? ' nm-chart-element--pie' : ''}`} data-chart-element="chart">{content}</div> : null;
  const extraBars = options.bars && options.type !== 'bars' ? <div className="nm-chart-element" data-chart-element="bars">{bars}</div> : null;
  const chartWithBars = paired(main, extraBars, options.bar_position, 'bars', round);
  const legend = options.legend ? <div className="nm-chart-element" data-chart-element="legend">{data.series.length > 1 ? seriesLegend : partLegend}</div> : null;
  const composed = paired(chartWithBars, legend, chartLegendPosition(options.position), 'legend', round && !extraBars);
  return <div ref={host} className="nm-personal-renderer" data-chart-layout={options.chart && options.type === 'bars' && !legend || !options.chart && extraBars && !legend ? 'bars' : undefined}><div className="nm-chart-composition">{!rows.length ? <p className="tool-note nm-chart-empty">No data to display.</p> : composed || <p className="tool-note nm-chart-empty">Choose a chart, bars or legend to display.</p>}</div><ChartTooltip tip={tip} /></div>;
}

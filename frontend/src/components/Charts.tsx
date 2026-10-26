import { DonutChart as Ring, ColumnChart as Columns, AreaChart as Area, StackBar as Stack, BarList as Bars } from './ChartPrimitives';
import { PersonalChart, type ChartData } from './PersonalChart';
export * from './ChartPrimitives';

type PersonalProps = { viewId?: string; viewNoun?: string; viewKind?: ChartData['kind'] };
/**
 * `breakdownBars` (default on) adds the bars beside the ring; `legend` only
 * controls the text legend, which bars replace while they are shown.
 */
export function DonutChart({ breakdownBars = true, ...props }: Parameters<typeof Ring>[0] & PersonalProps & { breakdownBars?: boolean }) {
  const position = props.legendPosition === 'below' ? 'bottom' : 'right';
  const native = breakdownBars ? <div className="nm-chart-composition"><div className="nm-chart-pair nm-personal-ring-layout" data-legend-position={position} data-chart-pair="bars">
    <div className="nm-chart-pair-visual"><Ring {...props} legend={false} /></div>
    <div className="nm-chart-element" data-chart-element="bars"><Bars label={props.label} items={props.items} unit={props.unit} formatValue={props.legendShow && props.legendShow !== 'value' ? value => {
      const total = props.items.reduce((sum, item) => sum + item.value, 0);
      const percent = `${total ? Math.round(value / total * 100) : 0}%`;
      return props.legendShow === 'percent' ? percent : `${value.toLocaleString()}${props.unit ?? ''} · ${percent}`;
    } : undefined} /></div>
  </div></div> : <Ring {...props} />;
  return <PersonalChart id={props.viewId} label={props.label} base="ring" data={{ kind: 'parts', defaultLegend: props.legend ?? true, defaultView: breakdownBars ? { bars: true, legend: false, bar_position: position } : undefined, unit: props.unit, noun: props.viewNoun ?? props.sub, rows: props.items.map(d => ({ label: d.label, value: d.value, color: d.color })), series: [{ key: 'value', label: props.sub, color: '--dash-blue' }] }}>{native}</PersonalChart>;
}
export function ColumnChart(props: Parameters<typeof Columns>[0] & PersonalProps) {
  return <PersonalChart id={props.viewId} label={props.label} base="columns" data={{ kind: props.viewKind ?? 'time', rows: props.rows, series: props.series, unit: props.unit, onSelect: props.onSelect }}><Columns {...props} /></PersonalChart>;
}
export function AreaChart(props: Parameters<typeof Area>[0] & PersonalProps) {
  return <PersonalChart id={props.viewId} label={props.label} base="area" data={{ kind: props.viewKind ?? 'time', rows: props.rows, series: props.series, unit: props.unit, reference: props.reference, zoomable: props.zoomable }}><Area {...props} /></PersonalChart>;
}
export function StackBar(props: Parameters<typeof Stack>[0] & PersonalProps) {
  return <PersonalChart id={props.viewId} label={props.label} base="stacked" data={{ kind: 'parts', rows: props.items.map(d => ({ ...d, value: d.value })), series: [{ key: 'value', label: props.label, color: '--dash-blue' }] }}><Stack {...props} /></PersonalChart>;
}
export function BarList(props: Parameters<typeof Bars>[0] & PersonalProps) {
  return <PersonalChart id={props.viewId} label={props.label} base="bars" data={{ kind: props.viewKind ?? 'parts', unit: props.unit, maximum: props.max, rows: props.items.map(d => ({ ...d, value: d.value })), series: [{ key: 'value', label: props.label, color: '--dash-blue' }] }}><Bars {...props} /></PersonalChart>;
}

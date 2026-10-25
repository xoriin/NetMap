import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChartArea, ChartBar, ChartBarStacked, ChartColumn, ChartLine, ChartPie, ChartScatter, Gauge, Hash, PanelsTopLeft, SlidersHorizontal, Table2, X } from 'lucide-react';
import type { ChartPaint, ColumnSeries } from './ChartPrimitives';
import { useChartPanelTarget } from './ChartPanel';
import { useChartViews } from '../providers/ChartViewsProvider';
import { chartLegendPosition, chartDefaults, resolveChartView, type ChartForm, type ChartViewOptions } from '../utils/chartViews';
import { PersonalChartRenderer } from './PersonalChartRenderer';

export type ChartData = {
  kind: 'parts' | 'rank' | 'time'; unit?: string; noun?: string; maximum?: number; defaultLegend?: boolean;
  rows: ({ label: string; color?: ChartPaint } & Record<string, number | string | undefined>)[];
  series: ColumnSeries[]; onSelect?: (label: string) => void;
  reference?: { value: number; label: string }; zoomable?: boolean;
};
const forms = [
  ['ring', 'Ring', ChartPie], ['pie', 'Pie', ChartPie], ['bars', 'Bars', ChartBar], ['columns', 'Columns', ChartColumn],
  ['stacked', 'Stacked bar', ChartBarStacked], ['line', 'Line', ChartLine], ['area', 'Area', ChartArea], ['dots', 'Dot plot', ChartScatter],
  ['treemap', 'Treemap', PanelsTopLeft], ['gauge', 'Gauge', Gauge], ['number', 'Number', Hash], ['table', 'Data table', Table2],
] as const;
export function supportsChart(form: ChartForm, data: ChartData) {
  if (['ring', 'pie', 'stacked', 'treemap', 'gauge'].includes(form)) return data.kind === 'parts' && data.series.length === 1;
  return form !== 'number' || data.series.length === 1;
}

export function PersonalChart({ id, label, base, data, children }: { id?: string; label: string; base: ChartForm; data: ChartData; children: ReactNode }) {
  const prefs = useChartViews();
  const target = useChartPanelTarget();
  const settingsId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const saved = id ? prefs?.views[id] : undefined;
  const [draft, setDraft] = useState<ChartViewOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { setDraft(null); }, [saved]);
  if (!id || !prefs) return <>{children}</>;
  const defaults = chartDefaults(base, data.defaultLegend);
  const options = { ...resolveChartView(saved, base, data.defaultLegend, data.series.length), ...draft };
  const selected = options.type === 'default' || !supportsChart(options.type, data) ? base : options.type;
  const changed = <K extends keyof ChartViewOptions>(key: K, value: ChartViewOptions[K]) => { setDraft({ ...options, [key]: value, ...(key === 'type' && value === 'bars' ? { chart: options.chart || options.bars, bars: false } : {}) }); setNotice('Unsaved changes'); setError(''); };
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const action = <button ref={trigger} type="button" className="nm-btn nm-btn--icon" aria-label={`Visual options: ${label}`} title="Visual options" aria-expanded={open} aria-controls={settingsId} disabled={prefs.loading || busy} onClick={() => { setOpen(v => !v); setError(''); }}><SlidersHorizontal size={16} aria-hidden="true" /></button>;
  const mutate = async (reset: boolean) => {
    setBusy(true); setError('');
    try { if (reset) await prefs.reset(id); else await prefs.save(id, options); setDraft(null); setNotice(reset ? 'Default view restored' : 'My view saved'); }
    catch { setError(reset ? 'Could not reset this chart. Try again.' : 'Could not save your view. Your changes are still here; try again.'); }
    finally { setBusy(false); }
  };
  const parts = data.kind === 'parts' && data.series.length === 1;
  const hasLegend = data.series.length > 0;
  const hasValueLabels = options.bars || options.legend || options.chart && ['ring', 'pie', 'bars', 'columns', 'line', 'area', 'dots', 'treemap'].includes(selected) && !(data.zoomable && ['line', 'area'].includes(selected));
  return <div className={`nm-personal-chart${open ? ' nm-personal-chart--editing' : ''}`} data-chart-id={id} data-chart-custom={draft || saved ? "true" : undefined}>
    {target ? createPortal(action, target) : <div className="nm-chart-local-action">{action}</div>}
    {!draft && Object.keys(defaults).every(key => options[key as keyof ChartViewOptions] === defaults[key as keyof ChartViewOptions]) ? children : <PersonalChartRenderer data={data} options={{ ...options, type: selected }} label={label} />}
    {open && <section id={settingsId} className="nm-chart-settings" aria-label={`Visual options: ${label}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close(); } }}>
      <div className="nm-chart-settings-heading"><strong>Visual options</strong><span className="dash-panel-meta">My view</span><button type="button" className="nm-btn nm-btn--icon" aria-label="Close visual options" disabled={busy} onClick={close}><X size={16} /></button></div>
      {prefs.error && <div className="nm-chart-save-error" role="alert">{prefs.error} <button type="button" className="nm-btn nm-btn--sm" onClick={prefs.reload}>Retry</button></div>}
      <div className="nm-chart-settings-body">
        <span className="nm-field-label">Visual type</span>
        <div className="nm-chart-gallery" role="group" aria-label="Visual type">{forms.map(([form, name, Icon]) => <button key={form} type="button" className={`nm-btn nm-chart-choice${selected === form ? ' nm-btn--active' : ''}`} aria-pressed={selected === form} disabled={busy || !supportsChart(form, data)} title={!supportsChart(form, data) ? 'Requires parts of a total or a single measure' : name} onClick={() => changed('type', form)}><Icon size={20} aria-hidden="true" /><span>{name}</span></button>)}</div>
        <span className="nm-field-label">Elements</span>
        <div className="nm-chart-switches">{([['chart', 'Show chart', options.chart && !options.bars && !options.legend], ['bars', 'Show bars', selected === 'bars' || options.bars && !options.chart && !options.legend], ['legend', 'Show legend', !hasLegend || options.legend && !options.chart && !options.bars]] as const).map(([key, text, disabled]) => <label key={key}><input type="checkbox" checked={options[key]} disabled={busy || disabled} onChange={e => changed(key, e.target.checked)} />{text}</label>)}</div>
        <div className="nm-chart-display-options">
          <label className="nm-field"><span className="nm-field-label">Values</span><select className="nm-select" aria-label="Values" value={options.values} disabled={busy || !parts || !options.bars && options.chart && ['gauge', 'number', 'table'].includes(selected)} onChange={e => changed('values', e.target.value as ChartViewOptions['values'])}><option value="value">Values</option><option value="percent">Percentages</option><option value="both">Values and percentages</option></select></label>
          <label className="nm-field"><span className="nm-field-label">Order</span><select className="nm-select" aria-label="Order" value={options.order} disabled={busy || data.kind === 'time' || ['gauge', 'number'].includes(selected)} onChange={e => changed('order', e.target.value as ChartViewOptions['order'])}><option value="original">Default order</option><option value="largest">Largest first</option><option value="smallest">Smallest first</option><option value="name">Name A–Z</option></select></label>
          <label className="nm-field"><span className="nm-field-label">Bars position</span><select className="nm-select" aria-label="Bars position" value={options.bar_position} disabled={busy || !options.bars || !options.chart || selected === 'bars'} onChange={e => changed('bar_position', e.target.value as ChartViewOptions['bar_position'])}><option value="top">Top</option><option value="bottom">Bottom</option><option value="left">Left</option><option value="right">Right</option></select></label>
          <label className="nm-field"><span className="nm-field-label">Legend position</span><select className="nm-select" aria-label="Legend position" value={chartLegendPosition(options.position)} disabled={busy || !hasLegend || !options.legend} onChange={e => changed('position', e.target.value as ChartViewOptions['position'])}><option value="top">Top</option><option value="bottom">Bottom</option><option value="left">Left</option><option value="right">Right</option></select></label>
        </div>
        <div className="nm-chart-switches"><label><input type="checkbox" checked={options.labels} disabled={busy || !hasValueLabels} onChange={e => changed('labels', e.target.checked)} />Show values</label></div>
      </div>
      {error && <p className="nm-chart-save-error" role="alert">{error}</p>}
      <div className="nm-chart-settings-footer"><button type="button" className="nm-btn nm-btn--ghost" disabled={busy || prefs.loading || !!prefs.error} onClick={() => void mutate(true)}>Reset this chart</button><span role="status" className="dash-panel-meta">{busy ? 'Saving…' : notice || (saved ? 'My saved view' : 'Default view')}</span><button type="button" className="nm-btn" disabled={busy} onClick={() => { setDraft(null); setError(''); setNotice(saved ? 'My saved view' : 'Default view'); close(); }}>Cancel</button><button type="button" className="nm-btn nm-btn--primary" disabled={busy || prefs.loading || !!prefs.error} onClick={() => void mutate(false)}>Save my view</button></div>
    </section>}
  </div>;
}

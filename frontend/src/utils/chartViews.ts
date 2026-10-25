/** Versioned presentation preferences, independent of data access and workspace modules. */
export type ChartForm = 'ring' | 'pie' | 'bars' | 'columns' | 'stacked' | 'line' | 'area' | 'dots' | 'treemap' | 'gauge' | 'number' | 'table';
export type ChartPosition = 'top' | 'bottom' | 'left' | 'right';
export type ChartViewOptions = {
  version: 1 | 2; type: ChartForm | 'default'; values: 'value' | 'percent' | 'both';
  order: 'original' | 'largest' | 'smallest' | 'name'; position: ChartPosition | 'side' | 'below';
  legend: boolean; labels: boolean; tracks: boolean;
  chart: boolean; bars: boolean; bar_position: ChartPosition;
};
export const defaultChartView: ChartViewOptions = { version: 2, type: 'default', values: 'value', order: 'original', position: 'side', legend: true, labels: true, tracks: false, chart: true, bars: false, bar_position: 'right' };
export const chartDefaults = (base: ChartForm, legend = ['ring', 'pie', 'stacked'].includes(base)): ChartViewOptions => ({ ...defaultChartView, legend });
/** Read old records without rewriting them. Legacy ring tracks become independent bars. */
export function resolveChartView(view: Partial<ChartViewOptions> | undefined, base: ChartForm, legend?: boolean, seriesCount = 1): ChartViewOptions {
  const defaults = chartDefaults(base, legend);
  if (!view) return defaults;
  const type = view.type === 'default' || !view.type ? base : view.type;
  const legacyBars = ['ring', 'pie'].includes(type) && view.tracks === true && view.legend !== false;
  const legacyLegend = ['ring', 'pie', 'stacked'].includes(type) || seriesCount > 1 && ['columns', 'line', 'area', 'dots'].includes(type);
  return { ...defaults, ...view, version: 2, tracks: false, ...(view.version !== 2 ? { chart: true, bars: legacyBars, legend: !legacyBars && legacyLegend && view.legend !== false, bar_position: chartLegendPosition(view.position ?? 'side') } : {}) };
}
/** Keep saved v1 positions compatible while exposing four explicit placements. */
export const chartLegendPosition = (position: ChartViewOptions['position']): ChartPosition => position === 'side' ? 'right' : position === 'below' ? 'bottom' : position;

/** Versioned presentation preferences, independent of data access and workspace modules. */
export type ChartForm = 'ring' | 'pie' | 'bars' | 'columns' | 'stacked' | 'line' | 'area' | 'dots' | 'treemap' | 'gauge' | 'number' | 'table';
export type ChartViewOptions = {
  version: 1; type: ChartForm | 'default'; values: 'value' | 'percent' | 'both';
  order: 'original' | 'largest' | 'smallest' | 'name'; position: 'side' | 'below';
  legend: boolean; labels: boolean; tracks: boolean;
};
export const defaultChartView: ChartViewOptions = { version: 1, type: 'default', values: 'value', order: 'original', position: 'side', legend: true, labels: true, tracks: true };

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useChartViews } from '../providers/ChartViewsProvider';
import { chartLegendPosition, defaultChartView, oppositeChartPosition, type ChartPosition } from '../utils/chartViews';

type Placement = {
  name: string; other: string; position: ChartPosition;
  change: (position: ChartPosition) => void;
  save: () => Promise<void>; reset: () => Promise<void>; cancel: () => void;
};
const Context = createContext<Placement | null>(null);
export const useChartPairPlacement = () => useContext(Context);

/** Layout preferences never replace either chart's own saved visual or native geometry. */
export function MovableChartPair({ id, className, names, children }: {
  id: string; className: string; names: readonly [string, string]; children: readonly [ReactNode, ReactNode];
}) {
  const prefs = useChartViews();
  const saved = prefs?.views[id];
  const [draft, setDraft] = useState<ChartPosition | null>(null);
  useEffect(() => { setDraft(null); }, [saved]);
  const position = draft ?? (saved ? chartLegendPosition(saved.position) : 'left');
  const cancel = () => setDraft(null);
  const save = async () => {
    if (draft && prefs) { await prefs.save(id, { ...defaultChartView, position: draft }); setDraft(null); }
  };
  const reset = async () => { if (prefs) await prefs.reset(id); setDraft(null); };
  return <div className={className} data-first-position={position}>
    {children.map((child, index) => <Context.Provider key={index} value={{
      name: names[index], other: names[1 - index],
      position: index === 0 ? position : oppositeChartPosition(position),
      change: next => setDraft(index === 0 ? next : oppositeChartPosition(next)), save, reset, cancel,
    }}><div className="nm-chart-pair-slot" data-pair-slot={index}>{child}</div></Context.Provider>)}
  </div>;
}

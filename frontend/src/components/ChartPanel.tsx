import { createContext, useContext, useState, type ReactNode } from 'react';

/** Explicit header slot: charts supply data declaratively; no DOM/data scraping. */
const Context = createContext<{ target: HTMLDivElement | null; setTarget: (el: HTMLDivElement | null) => void } | null>(null);
export function ChartPanel({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <Context.Provider value={{ target, setTarget }}>{children}</Context.Provider>;
}
export function ChartOptionsSlot({ children }: { children?: ReactNode }) {
  const host = useContext(Context);
  return <div className="nm-chart-actions">{children}<div className="nm-chart-actions" ref={host?.setTarget} /></div>;
}
export function useChartPanelTarget() { return useContext(Context)?.target; }

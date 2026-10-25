import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { ChartViewOptions } from '../utils/chartViews';

type ChartViews = {
  views: Record<string, ChartViewOptions>; loading: boolean; error: string;
  reload: () => void;
  save: (id: string, options: ChartViewOptions) => Promise<void>;
  reset: (id?: string) => Promise<void>;
};
const Context = createContext<ChartViews | null>(null);

/** Mount keyed by authenticated user ID; nothing survives sign-out or account switching. */
export function ChartViewsProvider({ token, children }: { token: string | null; children: ReactNode }) {
  const [views, setViews] = useState<Record<string, ChartViewOptions>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!token) { setViews({}); setLoading(false); return; }
    let current = true;
    setLoading(true); setError('');
    api.chartViews(token).then(value => { if (current) setViews(value); })
      .catch(() => { if (current) setError('Could not load your chart views.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [token, revision]);
  const save = useCallback(async (id: string, options: ChartViewOptions) => {
    if (!token) throw new Error("Sign in to save chart views.");
    const saved = await api.saveChartView(token, id, options);
    setViews(previous => ({ ...previous, [id]: saved }));
  }, [token]);
  const reset = useCallback(async (id?: string) => {
    if (!token) throw new Error("Sign in to reset chart views.");
    if (id) {
      await api.resetChartView(token, id);
      setViews(previous => { const next = { ...previous }; delete next[id]; return next; });
    } else { await api.resetChartViews(token); setViews({}); }
  }, [token]);
  return <Context.Provider value={{ views, loading, error, reload: () => setRevision(n => n + 1), save, reset }}>{children}</Context.Provider>;
}
export function useChartViews() { return useContext(Context); }

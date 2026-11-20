import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type AppLogEntry, type AppLogLevel, type AppLogPage, type AppLogQuery } from "../../api/client";

const POLL_MS = 3000;
const DEFAULT_LEVELS: AppLogLevel[] = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

type Filters = {
  level: string;
  source: string;
  q: string;
  since: string;
  until: string;
};

const emptyFilters: Filters = { level: "", source: "", q: "", since: "", until: "" };

function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function formatLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function queryFromFilters(filters: Filters): AppLogQuery {
  return {
    level: filters.level || undefined,
    source: filters.source ? [filters.source] : undefined,
    q: filters.q.trim() || undefined,
    since: localInputToIso(filters.since),
    until: localInputToIso(filters.until),
  };
}

function mergeEntries(current: AppLogEntry[], incoming: AppLogEntry[]): AppLogEntry[] {
  const byId = new Map<number, AppLogEntry>();
  for (const entry of current) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((left, right) => right.id - left.id);
}

function formError(err: unknown): string {
  if (err instanceof ApiError && typeof err.detail === "string" && err.detail.trim()) return err.detail;
  if (err instanceof Error && err.message) return err.message;
  return "Unable to load logs.";
}

export function ToolsLogsPanel({
  accessToken,
  onForbidden,
}: {
  accessToken: string;
  onForbidden: () => void;
}) {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [entries, setEntries] = useState<AppLogEntry[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [levels, setLevels] = useState<AppLogLevel[]>(DEFAULT_LEVELS);
  const [live, setLive] = useState(true);
  const [gap, setGap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pageHidden, setPageHidden] = useState(() => typeof document !== "undefined" && document.hidden);

  const sinceIdRef = useRef<number | null>(null);
  const beforeIdRef = useRef<number | null>(null);
  const liveRef = useRef(live);
  const filtersRef = useRef(filters);
  const generationRef = useRef(0);
  const [olderAvailable, setOlderAvailable] = useState(false);

  liveRef.current = live;
  filtersRef.current = filters;

  const applyMeta = useCallback((page: AppLogPage) => {
    if (page.sources.length) setSources((current) => [...new Set([...current, ...page.sources])].sort());
    if (page.levels.length) setLevels(page.levels);
    if (page.gap) setGap(true);
  }, []);

  const loadInitial = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setGap(false);
    setEntries([]);
    setOlderAvailable(false);
    sinceIdRef.current = null;
    beforeIdRef.current = null;
    try {
      const page = await api.listAppLogs(accessToken, queryFromFilters(filtersRef.current));
      if (generation !== generationRef.current) return;
      setEntries(page.entries);
      sinceIdRef.current = page.next_since_id;
      beforeIdRef.current = page.next_before_id;
      setOlderAvailable(page.next_before_id != null);
      applyMeta(page);
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (err instanceof ApiError && err.status === 403) {
        onForbidden();
        return;
      }
      setError(formError(err));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [accessToken, applyMeta, onForbidden]);

  const pollNewer = useCallback(async () => {
    if (!liveRef.current || document.hidden) return;
    const generation = generationRef.current;
    let sinceId = sinceIdRef.current;
    if (sinceId == null) return;
    try {
      let again = true;
      while (again) {
        if (generation !== generationRef.current || !liveRef.current || document.hidden) return;
        const page = await api.listAppLogs(accessToken, {
          ...queryFromFilters(filtersRef.current),
          since_id: sinceId,
        });
        if (generation !== generationRef.current) return;
        if (page.entries.length) setEntries((current) => mergeEntries(current, page.entries));
        sinceId = page.next_since_id;
        sinceIdRef.current = sinceId;
        applyMeta(page);
        again = page.has_more;
      }
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (err instanceof ApiError && err.status === 403) {
        onForbidden();
        return;
      }
      setError(formError(err));
    }
  }, [accessToken, applyMeta, onForbidden]);

  const loadOlder = useCallback(async () => {
    const beforeId = beforeIdRef.current;
    if (beforeId == null || loadingOlder) return;
    const generation = generationRef.current;
    setLoadingOlder(true);
    setError(null);
    try {
      const page = await api.listAppLogs(accessToken, {
        ...queryFromFilters(filtersRef.current),
        before_id: beforeId,
      });
      if (generation !== generationRef.current) return;
      if (page.entries.length) setEntries((current) => mergeEntries(current, page.entries));
      beforeIdRef.current = page.next_before_id;
      setOlderAvailable(page.next_before_id != null);
      applyMeta(page);
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (err instanceof ApiError && err.status === 403) {
        onForbidden();
        return;
      }
      setError(formError(err));
    } finally {
      if (generation === generationRef.current) setLoadingOlder(false);
    }
  }, [accessToken, applyMeta, loadingOlder, onForbidden]);

  useEffect(() => {
    void loadInitial();
  }, [filters, loadInitial]);

  useEffect(() => {
    const onVisibility = () => setPageHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!live || pageHidden) return;
    const timer = window.setInterval(() => { void pollNewer(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, pageHidden, pollNewer, filters]);

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  return (
    <>
      <form className="tool-form" onSubmit={(event) => event.preventDefault()}>
        <div className="tool-form-grid">
          <label>
            Level
            <select value={filters.level} onChange={(event) => updateFilter("level", event.target.value)}>
              <option value="">All levels</option>
              {levels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
          <label>
            Source
            <select value={filters.source} onChange={(event) => updateFilter("source", event.target.value)}>
              <option value="">All sources</option>
              {sources.map((source) => <option key={source} value={source}>{source}</option>)}
            </select>
          </label>
          <label>
            Text
            <input type="search" value={filters.q} onChange={(event) => updateFilter("q", event.target.value)} placeholder="Message, logger or exception" />
          </label>
          <label>
            Since
            <input type="datetime-local" value={filters.since} onChange={(event) => updateFilter("since", event.target.value)} />
          </label>
          <label>
            Until
            <input type="datetime-local" value={filters.until} onChange={(event) => updateFilter("until", event.target.value)} />
          </label>
        </div>
        <div className="tool-form-actions">
          <button
            type="button"
            className={`nm-btn nm-btn--sm${live ? " nm-btn--active" : " nm-btn--secondary"}`}
            aria-pressed={live}
            onClick={() => setLive((current) => !current)}
          >
            {live ? "Pause" : "Resume"}
          </button>
          {olderAvailable && (
            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "Loading…" : "Load older"}
            </button>
          )}
        </div>
      </form>
      {error && <div className="form-error">{error}</div>}
      {gap && <div className="nm-alert nm-alert--warning" role="status">Some entries were dropped</div>}
      {loading && entries.length === 0 && <p className="tool-note">Loading logs…</p>}
      {!loading && entries.length === 0 && !error && <p className="tool-note">No log entries match the current filters.</p>}
      {entries.length > 0 && (
        <div className="tool-result" aria-label="Application logs">
          {entries.map((entry) => {
            const heading = (
              <>
                <span>{formatLocal(entry.timestamp)} · {entry.level} · {entry.source} · {entry.message}</span>
                <span>{entry.logger}</span>
              </>
            );
            if (entry.exception) {
              return (
                <details key={entry.id} className="dns-detail-row">
                  <summary>{heading}</summary>
                  <pre>{entry.exception}</pre>
                </details>
              );
            }
            return (
              <div key={entry.id} className="dns-canonical-row">
                {heading}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

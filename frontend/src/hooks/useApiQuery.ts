import {
  useCallback, useEffect, useRef, useState,
  type Dispatch, type SetStateAction,
} from "react";
import { useToast } from "../components/Toast";

export type ApiQuery<T> = {
  /** Last successfully loaded value; kept during background refreshes (stale-while-revalidate). */
  data: T | null;
  /** Error message from the most recent attempt, or null. */
  error: string | null;
  /** True only while loading with no data yet — drive skeletons off this. */
  isLoading: boolean;
  /** True while refreshing in the background with stale data still shown. */
  isRefreshing: boolean;
  /** Re-run the fetcher. `silent` skips the isRefreshing flag (e.g. polling). */
  reload: (options?: { silent?: boolean }) => Promise<void>;
  /** Locally patch the cached value (optimistic updates, post-mutation sync). */
  setData: Dispatch<SetStateAction<T | null>>;
};

const rememberedResults = new Map<string, unknown>();

/** Forget every remembered result; called on sign-out so another session never sees them. */
export function clearRememberedQueries() {
  rememberedResults.clear();
}

/**
 * Declarative data fetching with race-guarding and unmount safety.
 *
 * - `fetcher` null disables the query (e.g. no token yet).
 * - While the first load is in flight `isLoading` is true; subsequent reloads
 *   keep `data` on screen and set `isRefreshing` instead.
 * - Out-of-order responses are dropped via a request id, so rapid dep changes
 *   can never paint stale data over fresh data.
 * - `rememberAs` keeps the last result under that key, so returning to a page
 *   shows it at once and refreshes it silently in the background.
 */
export function useApiQuery<T>(
  fetcher: (() => Promise<T>) | null,
  deps: readonly unknown[],
  options: { rememberAs?: string } = {},
): ApiQuery<T> {
  const rememberAs = fetcher ? options.rememberAs : undefined;
  const remembered = rememberAs !== undefined && rememberedResults.has(rememberAs)
    ? (rememberedResults.get(rememberAs) as T)
    : null;
  const [data, setData] = useState<T | null>(remembered);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(fetcher !== null && remembered === null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const hasDataRef = useRef(remembered !== null);
  const rememberAsRef = useRef(rememberAs);
  rememberAsRef.current = rememberAs;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runFetch = useCallback(async (options?: { silent?: boolean }) => {
    const fetch = fetcherRef.current;
    if (!fetch) return;
    const requestId = ++requestIdRef.current;
    const silent = options?.silent ?? false;
    if (!hasDataRef.current) {
      setIsLoading(true);
    } else if (!silent) {
      setIsRefreshing(true);
    }
    try {
      const result = await fetch();
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      hasDataRef.current = true;
      if (rememberAsRef.current !== undefined) rememberedResults.set(rememberAsRef.current, result);
      setData(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!fetcherRef.current) return;
    void runFetch({ silent: hasDataRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const patchData = useCallback<Dispatch<SetStateAction<T | null>>>((update) => {
    hasDataRef.current = true;
    setData((current) => {
      const next = typeof update === "function" ? (update as (value: T | null) => T | null)(current) : update;
      if (rememberAsRef.current !== undefined && next !== null) rememberedResults.set(rememberAsRef.current, next);
      return next;
    });
  }, []);

  return { data, error, isLoading, isRefreshing, reload: runFetch, setData: patchData };
}

export type ApiMutation<Args extends readonly unknown[], R> = {
  /** Runs the mutation. Resolves with the result, or null when it failed. */
  run: (...args: Args) => Promise<R | null>;
  /** True while the mutation is in flight — drive disabled/busy states off this. */
  isBusy: boolean;
  /** Error message from the last run, or null. Cleared on the next run. */
  error: string | null;
  clearError: () => void;
};

export type ApiMutationOptions<Args extends readonly unknown[], R> = {
  /** Toast headline on success. Omit for silent success. */
  successMessage?: string | ((result: R, ...args: Args) => string);
  /** Show an error toast on failure (default true — errors must never be silent). */
  errorToast?: boolean;
  /** Called with the result after a successful run. */
  onSuccess?: (result: R, ...args: Args) => void;
};

/**
 * Wraps a mutating API call with busy state, error capture, and toast feedback.
 */
export function useApiMutation<Args extends readonly unknown[], R>(
  mutation: (...args: Args) => Promise<R>,
  options?: ApiMutationOptions<Args, R>,
): ApiMutation<Args, R> {
  const toast = useToast();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (...args: Args): Promise<R | null> => {
    setIsBusy(true);
    setError(null);
    try {
      const result = await mutationRef.current(...args);
      const opts = optionsRef.current;
      if (opts?.successMessage) {
        toast.success(
          typeof opts.successMessage === "function"
            ? opts.successMessage(result, ...args)
            : opts.successMessage,
        );
      }
      opts?.onSuccess?.(result, ...args);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      if (mountedRef.current) setError(message);
      if (optionsRef.current?.errorToast !== false) {
        toast.error(message);
      }
      return null;
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }, [toast]);

  const clearError = useCallback(() => setError(null), []);

  return { run, isBusy, error, clearError };
}

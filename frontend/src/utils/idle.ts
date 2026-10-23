/** Run `callback` at the first idle moment after `afterMs` (and within `timeout` ms of that); returns a cancel function. */
export function whenIdle(callback: () => void, { afterMs = 0, timeout = 3000 }: { afterMs?: number; timeout?: number } = {}): () => void {
  let cancelIdle: (() => void) | null = null;
  const start = () => {
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(callback, { timeout });
      cancelIdle = () => window.cancelIdleCallback(handle);
    } else {
      const handle = globalThis.setTimeout(callback, Math.min(timeout, 1500));
      cancelIdle = () => globalThis.clearTimeout(handle);
    }
  };
  const delay = globalThis.setTimeout(start, afterMs);
  return () => {
    globalThis.clearTimeout(delay);
    cancelIdle?.();
  };
}

import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

/** Devices and Cloud assets share column drag, persistence and reset behaviour. */
export function useInventoryTableColumns({ count, storageKey, leadingColumns = 0, initialWidths, minWidth = 60 }: {
  count: number; storageKey: string; leadingColumns?: number; initialWidths?: () => number[] | null; minWidth?: number;
}) {
  const [widths, setWidths] = useState<number[] | null>(() => {
    if (initialWidths) return initialWidths();
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
      return Array.isArray(saved) && saved.length === count && saved.every(value => typeof value === "number" && value >= minWidth) ? saved : null;
    } catch { return null; }
  });
  const headerRef = useRef<HTMLDivElement | null>(null);
  function startResize(index: number, event: ReactMouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const initial = headerRef.current
      ? Array.from(headerRef.current.children).slice(leadingColumns, leadingColumns + count).map(cell => cell.getBoundingClientRect().width)
      : (widths ?? []);
    if (initial.length !== count) return;
    function move(event: MouseEvent) {
      const next = [...initial]; next[index] = Math.max(minWidth, initial[index] + event.clientX - startX); setWidths(next);
    }
    function up() {
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      setWidths(current => { if (current) window.localStorage.setItem(storageKey, JSON.stringify(current)); return current; });
    }
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }
  function reset() { window.localStorage.removeItem(storageKey); setWidths(null); }
  return { widths, headerRef, startResize, reset };
}

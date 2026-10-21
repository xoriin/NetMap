import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";

const EDITOR_SELECTOR = "input, textarea, select, button, form";
const FOCUSABLE_SELECTOR = "input, textarea, select, button";

/** Props for a sidebar `<dd>` that starts inline editing on double-click or Enter. */
export function editableField(enabled: boolean, start: () => void, field?: string) {
  if (!enabled) return {};
  return {
    className: "editable-dd",
    tabIndex: 0,
    "data-edit-field": field,
    onDoubleClick: (event: MouseEvent<HTMLElement>) => {
      if ((event.target as HTMLElement).closest(EDITOR_SELECTOR)) return;
      window.getSelection()?.removeAllRanges();
      start();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" || event.target !== event.currentTarget) return;
      event.preventDefault();
      start();
    },
  };
}

/** Moves focus into a field editor when it opens, and back to its `<dd>` when closing drops focus. */
export function useEditableFieldFocus(editing: string | null) {
  const listRef = useRef<HTMLDListElement>(null);
  const previous = useRef<string | null>(null);

  function fieldElement(field: string) {
    return listRef.current?.querySelector<HTMLElement>(`[data-edit-field="${CSS.escape(field)}"]`) ?? null;
  }

  function focusEditor() {
    if (editing) fieldElement(editing)?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
  }

  useEffect(() => {
    const closed = previous.current;
    previous.current = editing;
    const active = document.activeElement;
    if (editing) {
      const dd = fieldElement(editing);
      if (dd && (active === dd || !dd.contains(active))) focusEditor();
    } else if (closed && (!active || active === document.body)) {
      fieldElement(closed)?.focus();
    }
  }, [editing]);

  return { listRef, focusEditor };
}

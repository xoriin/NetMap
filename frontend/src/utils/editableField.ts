import type { KeyboardEvent, MouseEvent } from "react";

const EDITOR_SELECTOR = "input, textarea, select, button, form";

/** Props for a sidebar `<dd>` that starts inline editing on double-click or Enter. */
export function editableField(enabled: boolean, start: () => void) {
  if (!enabled) return {};
  return {
    className: "editable-dd",
    tabIndex: 0,
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

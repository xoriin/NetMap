import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { useEntityColorsEnabled } from "../providers/EntityColorProvider";

export type SwatchOption = {
  value: string;
  label: string;
  /** Omit for neutral entries such as "All groups". */
  color?: string | null;
  /**
   * Shown tinted in place of the swatch square, matching how device-type chips
   * render in the table. Icons stay visible when colour is turned off; only
   * the tint drops.
   */
  icon?: ReactNode;
};

/**
 * Select whose options can carry a colour swatch.
 *
 * A native `<select>` cannot render per-option colours consistently across
 * browsers, so the inventory filters use this listbox instead.
 */
export function SwatchSelect({
  value,
  options,
  onChange,
  className,
  ariaLabel,
}: {
  value: string;
  options: SwatchOption[];
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const colorsEnabled = useEntityColorsEnabled();

  /** The leading mark for an option: its icon if it has one, else a swatch. */
  function optionMark(option: SwatchOption | undefined, { placeholder }: { placeholder: boolean }) {
    if (!option) return null;
    const tint = colorsEnabled && option.color
      ? ({ "--nm-chip-color": option.color } as CSSProperties)
      : undefined;
    if (option.icon) {
      return <span className="nm-chip-icon" style={tint} aria-hidden>{option.icon}</span>;
    }
    if (tint) return <span className="nm-swatch-dot" style={tint} aria-hidden />;
    // Keeps labels aligned down the list when only some options have a mark.
    return placeholder ? <span className="nm-swatch-dot nm-swatch-dot--none" aria-hidden /> : null;
  }

  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? options[0],
    [options, value],
  );

  useEffect(() => {
    if (!open) return;
    setHighlighted(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(".nm-swatch-option--hl")?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted]);

  function commit(next: string) {
    onChange(next);
    setOpen(false);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open && (event.key === "Enter" || event.key === " " || event.key === "ArrowDown")) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => Math.min(current + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[highlighted];
      if (option) commit(option.value);
    }
  }

  return (
    <div className={`nm-swatch-select${className ? ` ${className}` : ""}`} ref={containerRef}>
      <button
        type="button"
        className="nm-swatch-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        {optionMark(selected, { placeholder: false })}
        <span className="nm-swatch-text">{selected?.label ?? ""}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="nm-swatch-list" role="listbox" ref={listRef} onKeyDown={onKeyDown}>
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={
                "nm-swatch-option"
                + (index === highlighted ? " nm-swatch-option--hl" : "")
                + (option.value === value ? " nm-swatch-option--selected" : "")
              }
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => commit(option.value)}
            >
              {optionMark(option, { placeholder: true })}
              <span className="nm-swatch-text">{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

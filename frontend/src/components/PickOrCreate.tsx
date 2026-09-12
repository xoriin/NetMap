import {
  Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, ChevronDown, Plus, Search } from "lucide-react";

export type PickOrCreateOption = { id: number; label: string; group?: string };

/**
 * Shared "pick an existing one or create a new one" combobox.
 *
 * Trigger reads as a sibling of `.nm-select`. The menu pins an empty option
 * first, filterable grouped options in the middle, and the create action
 * last. Modelled on the reviewed `.theme-lab-combobox` example in the live
 * theme-preview workspace (`/theme-preview` in the dev app —
 * `dev/docs/design-system-preview.html` has no combobox example),
 * reimplemented with `.nm-pick-*` classes and `--nm-*` tokens only — see `docs/UI_THEME_RULES.md` § Forms.
 *
 * Accessibility: the create action is rendered as a sibling of the
 * `role="listbox"`, not a child, so the listbox's DOM children are only
 * `role="option"` elements and `role="group"` wrappers (never an unroled
 * heading or an action button). The filter input's `aria-controls` names the
 * listbox itself (which carries its own id), and `aria-activedescendant` is
 * used only for genuine option rows (the empty row and real options) — never
 * for the create action, which has no listbox-child role. Up/Down/Enter/
 * Escape are handled by a shared handler on both the filter input and the
 * create button. Navigating onto the create row moves real DOM focus to that
 * button (clearing `aria-activedescendant`, since the input is no longer
 * focused); navigating back off it restores focus to the filter input and
 * re-establishes `aria-activedescendant`. Options are pre-clustered by
 * `group` internally, so callers do not need to pre-sort — interleaved
 * same-group entries still render one heading per group instead of one per
 * contiguous run.
 */
export function PickOrCreate({
  value,
  options,
  emptyLabel,
  createLabel,
  onChange,
  onCreateRequested,
  disabled = false,
  ariaLabel,
}: {
  value: number | null;
  options: PickOrCreateOption[];
  emptyLabel: string;
  createLabel: string;
  onChange: (id: number | null) => void;
  onCreateRequested: () => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlighted, setHighlighted] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);

  const uid = useId();
  const listboxId = `${uid}-listbox`;
  const emptyRowId = `${uid}-empty`;
  const createRowId = `${uid}-create`;
  const optionRowId = (id: number) => `${uid}-opt-${id}`;

  const selected = useMemo(
    () => (value == null ? null : options.find((option) => option.id === value) ?? null),
    [options, value],
  );

  const filteredOptions = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle));
  }, [options, filter]);

  // Cluster by group so interleaved same-group options (e.g. locations grouped
  // by provider/account, not pre-sorted by the caller) still render one
  // heading per group rather than one per contiguous run. Ordering follows
  // each group's first appearance in `filteredOptions`; order within a group
  // is preserved.
  const groupedOptions = useMemo(() => {
    const buckets = new Map<string, PickOrCreateOption[]>();
    const order: string[] = [];
    for (const option of filteredOptions) {
      const key = option.group ?? "";
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(option);
    }
    return order.flatMap((key) => buckets.get(key)!);
  }, [filteredOptions]);

  // Contiguous sections for rendering: each is either an unlabelled run of
  // ungrouped options, or a `role="group"` labelled by its heading.
  const sections = useMemo(() => {
    const list: { group?: string; options: PickOrCreateOption[] }[] = [];
    for (const option of groupedOptions) {
      const last = list[list.length - 1];
      if (last && last.group === option.group) {
        last.options.push(option);
      } else {
        list.push({ group: option.group, options: [option] });
      }
    }
    return list;
  }, [groupedOptions]);

  // Flattened row list in display order, addressed by one index so
  // Up/Down/Enter can move through the empty option, every real option, and
  // the create action uniformly. The create action is rendered outside the
  // listbox (see below) but still participates in this navigation model.
  type Row =
    | { kind: "empty"; id: string }
    | { kind: "option"; id: string; option: PickOrCreateOption }
    | { kind: "create"; id: string };
  const rows = useMemo<Row[]>(() => [
    { kind: "empty", id: emptyRowId },
    ...groupedOptions.map((option) => ({ kind: "option" as const, id: optionRowId(option.id), option })),
    { kind: "create", id: createRowId },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [groupedOptions, emptyRowId, createRowId]);

  const highlightedRow = rows[highlighted];
  // Only genuine listbox children (the empty row, real options) get
  // aria-activedescendant — the create action is a plain button outside the
  // listbox and is highlighted via real DOM focus instead (see moveHighlight).
  const activeId = highlightedRow && highlightedRow.kind !== "create" ? highlightedRow.id : undefined;

  // The menu is `position: fixed` so it escapes the enclosing modal's
  // `overflow: auto` clip (see components.css). That means its coordinates have
  // to come from the trigger rect, and have to be recomputed whenever anything
  // moves it — including a scroll inside the modal, which is why the scroll
  // listener is on the capture phase rather than bound to the window alone.
  // It opens downwards unless the space below is both too small for a usable
  // menu and smaller than the space above, in which case it flips up.
  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }
    const GAP = 5;
    const VIEWPORT_MARGIN = 12;
    const MIN_USABLE = 180;

    function place() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
      const above = rect.top - GAP - VIEWPORT_MARGIN;
      const flip = below < MIN_USABLE && above > below;
      setMenuStyle({
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        maxHeight: Math.max(MIN_USABLE, Math.floor(flip ? above : below)),
        ...(flip
          ? { bottom: Math.round(window.innerHeight - rect.top + GAP) }
          : { top: Math.round(rect.bottom + GAP) }),
      });
    }

    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    const selectedIndex = value == null ? 0 : Math.max(
      0,
      1 + filteredOptions.findIndex((option) => option.id === value),
    );
    setHighlighted(selectedIndex);
    // Focus (and keep focus on) the filter input once the menu has rendered;
    // highlighting is communicated via aria-activedescendant, not real focus
    // movement, so a screen reader keeps reading the input's context.
    const id = window.setTimeout(() => filterRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHighlighted((current) => Math.min(current, rows.length - 1));
  }, [open, rows.length]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    // Capture phase: the shared `Modal` stops mousedown propagation on the
    // dialog box, so a bubble-phase document listener never runs for clicks
    // inside a modal — which is the only place this component is used.
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || !activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [open, activeId]);

  function commitRow(row: Row) {
    if (row.kind === "empty") {
      onChange(null);
      setOpen(false);
    } else if (row.kind === "option") {
      onChange(row.option.id);
      setOpen(false);
    } else {
      setOpen(false);
      onCreateRequested();
    }
  }

  // Moves the highlight to `nextIndex` and, when that row is the create
  // action, moves real DOM focus onto its button (clearing
  // aria-activedescendant on the way, since the input is no longer focused);
  // moving off the create row restores focus to the filter input. Mouse
  // hover deliberately does NOT call this — hovering must not steal keyboard
  // focus, so hover handlers call setHighlighted directly instead.
  function moveHighlight(nextIndex: number) {
    const clamped = Math.max(0, Math.min(nextIndex, rows.length - 1));
    setHighlighted(clamped);
    const row = rows[clamped];
    if (row?.kind === "create") {
      createRef.current?.focus();
    } else {
      filterRef.current?.focus();
    }
  }

  function onNavKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      // Escape dismisses only the menu. This handler is mounted solely while
      // the menu is open, so stopping propagation here cannot swallow the
      // Escape that closes an enclosing dialog when the menu is shut. Without
      // it, the shared `Modal`'s window-level keydown listener also fires and
      // tears down the whole dialog along with the in-progress form.
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(highlighted + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(highlighted - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[highlighted];
      if (row) commitRow(row);
    }
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open && (event.key === "Enter" || event.key === " " || event.key === "ArrowDown")) {
      event.preventDefault();
      setOpen(true);
    }
  }

  return (
    <div className="nm-pick" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="nm-pick-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="nm-pick-trigger-text">{selected ? selected.label : emptyLabel}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && menuStyle && (
        <div className="nm-pick-menu" style={menuStyle}>
          <label className="nm-pick-filter">
            <Search size={13} aria-hidden />
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={onNavKeyDown}
              placeholder="Filter…"
              aria-label={`Filter ${ariaLabel}`}
              aria-controls={listboxId}
              aria-activedescendant={activeId}
              autoComplete="off"
            />
          </label>
          <div className="nm-pick-list" id={listboxId} role="listbox" aria-label={ariaLabel}>
            <div
              id={emptyRowId}
              role="option"
              aria-selected={value == null}
              className={
                "nm-pick-row nm-pick-row--empty"
                + (rows[highlighted]?.id === emptyRowId ? " nm-pick-row--hl" : "")
                + (value == null ? " nm-pick-row--selected" : "")
              }
              onMouseEnter={() => setHighlighted(0)}
              onClick={() => commitRow({ kind: "empty", id: emptyRowId })}
            >
              {emptyLabel}
              {value == null && <Check className="nm-pick-check" size={14} aria-hidden />}
            </div>
            {sections.map((section, sectionIndex) => {
              const headingId = section.group ? `${uid}-group-${sectionIndex}-heading` : undefined;
              const optionRows = section.options.map((option) => {
                const id = optionRowId(option.id);
                const rowIndex = rows.findIndex((row) => row.id === id);
                return (
                  <div
                    key={option.id}
                    id={id}
                    role="option"
                    aria-selected={option.id === value}
                    className={
                      "nm-pick-row"
                      + (rowIndex === highlighted ? " nm-pick-row--hl" : "")
                      + (option.id === value ? " nm-pick-row--selected" : "")
                    }
                    onMouseEnter={() => setHighlighted(rowIndex)}
                    onClick={() => commitRow({ kind: "option", id, option })}
                  >
                    {option.label}
                    {option.id === value && <Check className="nm-pick-check" size={14} aria-hidden />}
                  </div>
                );
              });
              if (section.group) {
                return (
                  <div key={`group-${sectionIndex}`} role="group" aria-labelledby={headingId}>
                    <div id={headingId} role="presentation" className="nm-pick-group-heading">
                      {section.group}
                    </div>
                    {optionRows}
                  </div>
                );
              }
              return <Fragment key={`group-${sectionIndex}`}>{optionRows}</Fragment>;
            })}
            {filteredOptions.length === 0 && (
              <div className="nm-pick-empty-state">No matches</div>
            )}
          </div>
          <button
            ref={createRef}
            type="button"
            id={createRowId}
            className={
              "nm-pick-row nm-pick-row--create"
              + (rows[highlighted]?.id === createRowId ? " nm-pick-row--hl" : "")
            }
            onMouseEnter={() => setHighlighted(rows.length - 1)}
            onClick={() => commitRow({ kind: "create", id: createRowId })}
            onKeyDown={onNavKeyDown}
          >
            <Plus size={13} aria-hidden />
            {createLabel}
          </button>
        </div>
      )}
    </div>
  );
}

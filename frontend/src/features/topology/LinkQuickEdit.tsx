import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import type { Relationship } from "../../api/client";
import { QUICK_LINK_SPEEDS } from "./linkMode";

const EDGE_GAP = 8;
const CURSOR_OFFSET = 14;

export function LinkQuickEdit({
  relationship,
  sourceLabel,
  targetLabel,
  point,
  onSpeed,
  onType,
  onUndo,
  onMore,
  onClose,
}: {
  relationship: Relationship;
  sourceLabel: string;
  targetLabel: string;
  point: { x: number; y: number };
  onSpeed: (mbps: number | null) => void;
  onType: (type: string) => void;
  onUndo: () => void;
  onMore: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: point.x + CURSOR_OFFSET, top: point.y + CURSOR_OFFSET });
  const [type, setType] = useState(relationship.relationship_type);
  const committedType = useRef(relationship.relationship_type);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const below = point.y + CURSOR_OFFSET;
    const top = below + height > window.innerHeight - EDGE_GAP ? point.y - CURSOR_OFFSET - height : below;
    setPosition({
      left: Math.max(EDGE_GAP, Math.min(point.x + CURSOR_OFFSET, window.innerWidth - width - EDGE_GAP)),
      top: Math.max(EDGE_GAP, Math.min(top, window.innerHeight - height - EDGE_GAP)),
    });
  }, [point.x, point.y]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!ref.current || ref.current.contains(event.target as Node)) return;
      commitTypeRef.current();
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  function commitType() {
    const next = type.trim() || "link";
    setType(next);
    if (next === committedType.current) return;
    committedType.current = next;
    onType(next);
  }
  const commitTypeRef = useRef(commitType);
  commitTypeRef.current = commitType;

  return createPortal(
    <div
      ref={ref}
      className="nm-pick-menu topo-linkquick"
      role="dialog"
      aria-label="Quick link settings"
      style={{ left: position.left, top: position.top }}
    >
      <div className="topo-linkquick__title">
        <Check size={14} aria-hidden="true" />
        <span>Linked <b>{sourceLabel}</b> → <b>{targetLabel}</b></span>
      </div>
      <div className="topo-linkquick__row">
        <span className="topo-linkquick__label">Speed</span>
        <div className="topo-linkquick__speeds">
          {QUICK_LINK_SPEEDS.map((option) => (
            <button
              key={option.label}
              type="button"
              className={`nm-btn nm-btn--sm${(relationship.link_speed_mbps ?? null) === option.value ? " nm-btn--active" : ""}`}
              onClick={() => onSpeed(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="topo-linkquick__row">
        <span className="topo-linkquick__label">Type</span>
        <input
          className="nm-input"
          aria-label="Link type"
          value={type}
          onChange={(event) => setType(event.target.value)}
          onBlur={commitType}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitType();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </div>
      <div className="topo-linkquick__actions">
        <button type="button" className="nm-btn nm-btn--sm" onClick={onUndo}>Undo</button>
        <span className="topo-linkquick__hint">Saved · keep clicking</span>
        <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost" onClick={onMore}>More…</button>
      </div>
    </div>,
    document.body,
  );
}

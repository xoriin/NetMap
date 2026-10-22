import { Fragment, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type ReactNode, type SetStateAction } from "react";
import { ArrowDown, ArrowUp, GripVertical, LayoutList, Plus, Rows3, Trash2 } from "lucide-react";
import { StatusSourcePicker, describeSource } from "./StatusSourcePicker";
import {
  NO_EXTRAS, sourceKey,
  type StatusItemExtras, type StatusItemSource, type StatusLayoutGroup, type StatusPageDetail, type StatusSources,
} from "./statusPagesEditorApi";

export type DraftItem = { uid: string; id: number | null; source: StatusItemSource; display_name: string; extras: StatusItemExtras };
export type DraftGroup = { uid: string; id: number | null; name: string; collapsed_by_default: boolean; items: DraftItem[] };

let uidCounter = 0;
const nextUid = (prefix: string) => `${prefix}-${++uidCounter}`;

export function draftFromDetail(detail: StatusPageDetail): DraftGroup[] {
  return detail.groups.map((group) => ({
    uid: nextUid("group"),
    id: group.id,
    name: group.name,
    collapsed_by_default: group.collapsed_by_default,
    items: group.items.map((item) => ({
      uid: nextUid("item"),
      id: item.id,
      source: item.source,
      display_name: item.display_name,
      extras: { ...NO_EXTRAS, ...item.extras },
    })),
  }));
}

export function layoutPayload(groups: DraftGroup[]): StatusLayoutGroup[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name.trim(),
    collapsed_by_default: group.collapsed_by_default,
    items: group.items.map((item) => ({ id: item.id, source: item.source, display_name: item.display_name.trim(), extras: item.extras })),
  }));
}

export function layoutProblems(groups: DraftGroup[]): string[] {
  const problems: string[] = [];
  if (groups.some((group) => !group.name.trim())) problems.push("Every group needs a name before you can save.");
  if (groups.some((group) => group.items.some((item) => !item.display_name.trim()))) problems.push("Every item needs a display name before you can save.");
  return problems;
}

export function StatusEditorPanelHeader({ icon: Icon, title, meta, children }: {
  icon: typeof LayoutList;
  title: string;
  meta?: string;
  children?: ReactNode;
}) {
  return (
    <div className="nm-app-panel-header status-editor-header">
      <div className="status-editor-title">
        <span className="status-editor-icon"><Icon size={18} /></span>
        <strong>{title}</strong>
        {meta && <span className="status-editor-count">{meta}</span>}
      </div>
      {children && <div className="status-editor-header-actions">{children}</div>}
    </div>
  );
}

type ExtraFlag = Exclude<keyof StatusItemExtras, "uptime_period">;

function extraLabels(rtt: boolean): [ExtraFlag, string][] {
  return [
    ["rtt_graph", rtt ? "RTT graph" : "Response-time graph"],
    ["avg_response", rtt ? "Average RTT" : "Average response time"],
    ["p95_response", rtt ? "p95 RTT" : "p95 response time"],
    ["failure_rate", "Failed-check rate"],
    ["last_check", "Time since last check"],
  ];
}

function extrasCount(extras: StatusItemExtras) {
  return (Object.keys(extras) as (keyof StatusItemExtras)[]).filter((key) => Boolean(extras[key])).length;
}

function moveItem(groups: DraftGroup[], draggedUid: string, targetGroupUid: string, targetUid: string | null, placeAfter: boolean): DraftGroup[] {
  let dragged: DraftItem | undefined;
  const without = groups.map((group) => {
    const found = group.items.find((item) => item.uid === draggedUid);
    if (!found) return group;
    dragged = found;
    return { ...group, items: group.items.filter((item) => item.uid !== draggedUid) };
  });
  if (!dragged) return groups;
  const moved = dragged;
  return without.map((group) => {
    if (group.uid !== targetGroupUid) return group;
    const items = [...group.items];
    const index = targetUid === null ? -1 : items.findIndex((item) => item.uid === targetUid);
    if (index < 0) items.push(moved);
    else items.splice(index + (placeAfter ? 1 : 0), 0, moved);
    return { ...group, items };
  });
}

function moveGroup(groups: DraftGroup[], draggedUid: string, targetUid: string, placeAfter: boolean): DraftGroup[] {
  const dragged = groups.find((group) => group.uid === draggedUid);
  if (!dragged) return groups;
  const rest = groups.filter((group) => group.uid !== draggedUid);
  const index = rest.findIndex((group) => group.uid === targetUid);
  if (index < 0) return groups;
  rest.splice(index + (placeAfter ? 1 : 0), 0, dragged);
  return rest;
}

function shiftItem(groups: DraftGroup[], uid: string, step: -1 | 1): DraftGroup[] {
  const gi = groups.findIndex((group) => group.items.some((item) => item.uid === uid));
  if (gi < 0) return groups;
  const items = groups[gi].items;
  const ii = items.findIndex((item) => item.uid === uid);
  const next = groups.map((group) => ({ ...group, items: [...group.items] }));
  const target = ii + step;
  if (target >= 0 && target < items.length) {
    [next[gi].items[ii], next[gi].items[target]] = [next[gi].items[target], next[gi].items[ii]];
    return next;
  }
  const neighbour = gi + step;
  if (neighbour < 0 || neighbour >= groups.length) return groups;
  const [moved] = next[gi].items.splice(ii, 1);
  if (step < 0) next[neighbour].items.push(moved);
  else next[neighbour].items.unshift(moved);
  return next;
}

function shiftGroup(groups: DraftGroup[], uid: string, step: -1 | 1): DraftGroup[] {
  const index = groups.findIndex((group) => group.uid === uid);
  const target = index + step;
  if (index < 0 || target < 0 || target >= groups.length) return groups;
  const next = [...groups];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

const sameOrder = (a: DraftGroup[], b: DraftGroup[]) =>
  a.length === b.length && a.every((group, gi) => group.uid === b[gi].uid
    && group.items.length === b[gi].items.length && group.items.every((item, ii) => item.uid === b[gi].items[ii].uid));

type DragState = { kind: "item" | "group"; uid: string };

export function StatusPageLayoutEditor({
  groups,
  setGroups,
  sources,
  sourcesError,
  dirty,
  saving,
  onSave,
}: {
  groups: DraftGroup[];
  setGroups: Dispatch<SetStateAction<DraftGroup[]>>;
  sources: StatusSources | null;
  sourcesError: string | null;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const [pickerGroupUid, setPickerGroupUid] = useState<string | null>(null);
  const [expandedUid, setExpandedUid] = useState<string | null>(null);
  const [focusUid, setFocusUid] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [dragOverUid, setDragOverUid] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const originalRef = useRef<DraftGroup[] | null>(null);
  const committedRef = useRef(false);
  const pendingMoveRef = useRef<{ groupUid: string; targetUid: string | null; placeAfter: boolean } | null>(null);
  const [pendingFocus, setPendingFocus] = useState<{ id: string; fallback: string } | null>(null);

  useEffect(() => {
    if (!pendingFocus) return;
    const button = document.getElementById(pendingFocus.id) as HTMLButtonElement | null;
    const target = button && !button.disabled ? button : document.getElementById(pendingFocus.fallback);
    target?.focus();
    setPendingFocus(null);
  }, [groups, pendingFocus]);

  function moveItemBy(uid: string, step: -1 | 1) {
    setGroups((current) => shiftItem(current, uid, step));
    setPendingFocus({ id: `${uid}-move-${step < 0 ? "up" : "down"}`, fallback: `${uid}-move-${step < 0 ? "down" : "up"}` });
  }

  function moveGroupBy(uid: string, step: -1 | 1) {
    setGroups((current) => shiftGroup(current, uid, step));
    setPendingFocus({ id: `${uid}-move-${step < 0 ? "up" : "down"}`, fallback: `${uid}-move-${step < 0 ? "down" : "up"}` });
  }

  const problems = layoutProblems(groups);
  const itemCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const usedKeys = useMemo(() => new Set(groups.flatMap((group) => group.items.map((item) => sourceKey(item.source)))), [groups]);
  const pickerGroup = groups.find((group) => group.uid === pickerGroupUid) ?? null;

  const updateGroup = (uid: string, patch: Partial<DraftGroup>) =>
    setGroups((current) => current.map((group) => (group.uid === uid ? { ...group, ...patch } : group)));
  const updateItem = (uid: string, patch: Partial<DraftItem>) =>
    setGroups((current) => current.map((group) => ({ ...group, items: group.items.map((item) => (item.uid === uid ? { ...item, ...patch } : item)) })));

  function addGroup() {
    const uid = nextUid("group");
    setGroups((current) => [...current, { uid, id: null, name: "", collapsed_by_default: false, items: [] }]);
    setFocusUid(uid);
  }

  function addItem(groupUid: string, source: StatusItemSource) {
    const uid = nextUid("item");
    setGroups((current) => current.map((group) => (
      group.uid === groupUid ? { ...group, items: [...group.items, { uid, id: null, source, display_name: "", extras: NO_EXTRAS }] } : group
    )));
    setPickerGroupUid(null);
    setFocusUid(uid);
  }

  function beginDrag(event: DragEvent<HTMLButtonElement>, state: DragState) {
    dragRef.current = state;
    originalRef.current = groups;
    committedRef.current = false;
    setDragging(state);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.uid);
    const surface = event.currentTarget.closest<HTMLElement>(state.kind === "item" ? ".status-layout-item" : ".status-layout-group");
    if (surface) event.dataTransfer.setDragImage(surface, 20, Math.min(22, Math.round(surface.getBoundingClientRect().height / 2)));
  }

  function previewItemDrop(event: DragEvent<HTMLElement>, groupUid: string, targetUid: string | null) {
    const state = dragRef.current;
    if (state?.kind !== "item") return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDragOverUid(targetUid ?? groupUid);
    if (state.uid === targetUid) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerAfterMidpoint = event.clientY >= rect.top + rect.height / 2;
    const sourceGroup = groups.find((g) => g.items.some((item) => item.uid === state.uid));
    // Moving a row into another tbody remounts it and detaches the drag source, so its dragend
    // would never fire; cross-group moves therefore wait for the drop.
    if (sourceGroup?.uid !== groupUid) {
      pendingMoveRef.current = { groupUid, targetUid, placeAfter: pointerAfterMidpoint };
      return;
    }
    pendingMoveRef.current = null;
    if (targetUid === null) return;
    setGroups((current) => {
      const group = current.find((g) => g.uid === groupUid);
      const sourceIndex = group ? group.items.findIndex((item) => item.uid === state.uid) : -1;
      const targetIndex = group ? group.items.findIndex((item) => item.uid === targetUid) : -1;
      const next = moveItem(current, state.uid, groupUid, targetUid, sourceIndex < targetIndex || pointerAfterMidpoint);
      return sameOrder(next, current) ? current : next;
    });
  }

  function previewGroupDrop(event: DragEvent<HTMLElement>, targetUid: string) {
    const state = dragRef.current;
    if (state?.kind !== "group") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverUid(targetUid);
    if (state.uid === targetUid) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerAfterMidpoint = event.clientY >= rect.top + rect.height / 2;
    setGroups((current) => {
      const sourceIndex = current.findIndex((g) => g.uid === state.uid);
      const targetIndex = current.findIndex((g) => g.uid === targetUid);
      const next = moveGroup(current, state.uid, targetUid, sourceIndex < targetIndex || pointerAfterMidpoint);
      return sameOrder(next, current) ? current : next;
    });
  }

  function commitDrop(event: DragEvent<HTMLElement>) {
    const state = dragRef.current;
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    const pending = pendingMoveRef.current;
    if (state.kind === "item" && pending) {
      setGroups((current) => moveItem(current, state.uid, pending.groupUid, pending.targetUid, pending.placeAfter));
    }
    pendingMoveRef.current = null;
    committedRef.current = true;
    dragRef.current = null;
    setDragging(null);
    setDragOverUid(null);
  }

  function endDrag() {
    if (!committedRef.current && originalRef.current) setGroups(originalRef.current);
    pendingMoveRef.current = null;
    dragRef.current = null;
    originalRef.current = null;
    setDragging(null);
    setDragOverUid(null);
  }

  return (
    <div className="status-editor-panels">
      <section className="nm-app-panel status-editor-panel">
        <StatusEditorPanelHeader
          icon={LayoutList}
          title="Groups and items"
          meta={`${groups.length} group${groups.length === 1 ? "" : "s"} · ${itemCount} item${itemCount === 1 ? "" : "s"}${dirty ? " · Unsaved changes" : ""}`}
        >
          <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={addGroup}>
            <Plus size={14} /> Add group
          </button>
          <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={!dirty || problems.length > 0 || saving} onClick={onSave}>
            {saving ? "Saving…" : "Save layout"}
          </button>
        </StatusEditorPanelHeader>
        <div className="status-layout-intro">
          {problems.map((problem) => <div key={problem} className="nm-alert nm-alert--warning" role="status">{problem}</div>)}
          <small className="status-editor-hint">Visitors see only group names and display names. Drag the handles or use the arrows to change the order.</small>
        </div>
      </section>

      {groups.length === 0 && (
        <section className="nm-app-panel status-editor-panel">
          <p className="dash-empty">No groups yet. Add a group, then add the devices, service checks and endpoints it should show.</p>
        </section>
      )}

      {groups.map((group, groupIndex) => {
        const groupLabel = group.name.trim() || "this group";
        const sortClass = [
          "mon-port-sort-row",
          dragging?.kind === "group" && dragging.uid === group.uid ? "is-dragging" : "",
          dragging?.kind === "group" && dragOverUid === group.uid && dragging.uid !== group.uid ? "is-drag-over" : "",
        ].filter(Boolean).join(" ");
        const lastGroup = groupIndex === groups.length - 1;
        return (
          <div
            key={group.uid}
            className={sortClass}
            onDragOver={(event) => previewGroupDrop(event, group.uid)}
            onDrop={commitDrop}
          >
          <section className="nm-app-panel status-editor-panel status-layout-group">
            <div className="nm-app-panel-header status-layout-group-header">
              <button
                type="button"
                draggable
                className="mon-port-drag-handle"
                aria-label={`Drag group ${groupLabel} to reorder`}
                title="Drag to reorder"
                onDragStart={(event) => beginDrag(event, { kind: "group", uid: group.uid })}
                onDragEnd={endDrag}
              >
                <GripVertical size={15} />
              </button>
              <span className="status-editor-icon"><Rows3 size={18} /></span>
              <input
                className="nm-input status-layout-group-name"
                aria-label="Group name"
                placeholder="Group name, e.g. Core network"
                value={group.name}
                maxLength={120}
                autoFocus={focusUid === group.uid}
                aria-invalid={!group.name.trim() || undefined}
                onChange={(event) => updateGroup(group.uid, { name: event.target.value })}
              />
              <label className="status-layout-check">
                <input
                  type="checkbox"
                  checked={group.collapsed_by_default}
                  onChange={(event) => updateGroup(group.uid, { collapsed_by_default: event.target.checked })}
                />
                Collapsed by default
              </label>
              <div className="status-editor-header-actions">
                <button
                  type="button"
                  id={`${group.uid}-move-up`}
                  className="nm-btn nm-btn--sm nm-btn--secondary"
                  aria-label={`Move group ${groupLabel} up`}
                  title="Move up"
                  disabled={groupIndex === 0}
                  onClick={() => moveGroupBy(group.uid, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  id={`${group.uid}-move-down`}
                  className="nm-btn nm-btn--sm nm-btn--secondary"
                  aria-label={`Move group ${groupLabel} down`}
                  title="Move down"
                  disabled={lastGroup}
                  onClick={() => moveGroupBy(group.uid, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" aria-label={`Add item to ${groupLabel}`} onClick={() => setPickerGroupUid(group.uid)}>
                  <Plus size={14} /> Add item
                </button>
                <button
                  type="button"
                  className="nm-btn nm-btn--sm nm-btn--ghost"
                  aria-label={`Remove group ${groupLabel}`}
                  onClick={() => setGroups((current) => current.filter((g) => g.uid !== group.uid))}
                >
                  <Trash2 size={14} /> Remove group
                </button>
              </div>
            </div>
            {group.items.length === 0 ? (
              <p
                className={`dash-empty status-layout-empty mon-port-sort-row${dragging?.kind === "item" && dragOverUid === group.uid ? " is-drag-over" : ""}`}
                onDragOver={(event) => previewItemDrop(event, group.uid, null)}
                onDrop={commitDrop}
              >
                No items in this group yet.
              </p>
            ) : (
              <div className="nm-table-wrap mon-embedded-table status-layout-table-wrap">
                <table className="nm-table status-layout-table">
                  <colgroup>
                    <col className="status-layout-col-handle" />
                    <col className="status-layout-col-name" />
                    <col />
                    <col className="status-layout-col-extras" />
                    <col className="status-layout-col-actions" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th aria-label="Reorder" />
                      <th>Display name</th>
                      <th>Source (internal)</th>
                      <th>Extras</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((item, itemIndex) => {
                      const description = describeSource(item.source, sources);
                      const label = item.display_name.trim() || description.internal;
                      const blank = !item.display_name.trim();
                      const count = extrasCount(item.extras);
                      const expanded = expandedUid === item.uid;
                      const errorId = `${item.uid}-name-error`;
                      const atStart = groupIndex === 0 && itemIndex === 0;
                      const atEnd = lastGroup && itemIndex === group.items.length - 1;
                      const rowClass = [
                        "status-layout-item mon-port-sort-row",
                        dragging?.kind === "item" && dragging.uid === item.uid ? "is-dragging" : "",
                        dragging?.kind === "item" && dragOverUid === item.uid && dragging.uid !== item.uid ? "is-drag-over" : "",
                      ].filter(Boolean).join(" ");
                      return (
                        <Fragment key={item.uid}>
                          <tr className={rowClass} onDragOver={(event) => previewItemDrop(event, group.uid, item.uid)} onDrop={commitDrop}>
                            <td className="status-layout-handle-cell">
                              <button
                                type="button"
                                draggable
                                className="mon-port-drag-handle"
                                aria-label={`Drag ${label} to reorder`}
                                title="Drag to reorder"
                                onDragStart={(event) => beginDrag(event, { kind: "item", uid: item.uid })}
                                onDragEnd={endDrag}
                              >
                                <GripVertical size={15} />
                              </button>
                            </td>
                            <td>
                              <input
                                className="nm-input"
                                aria-label={`Display name for ${description.internal}`}
                                aria-invalid={blank || undefined}
                                aria-describedby={blank ? errorId : undefined}
                                placeholder="Name visitors will see"
                                value={item.display_name}
                                maxLength={200}
                                autoFocus={focusUid === item.uid}
                                onChange={(event) => updateItem(item.uid, { display_name: event.target.value })}
                              />
                              {blank && <span className="status-editor-error" id={errorId}>Display name is required.</span>}
                            </td>
                            <td>
                              <strong>{description.internal}</strong>
                              <small className="status-editor-sub nm-table-mono">
                                {description.missing ? "Source no longer exists" : [description.reference, description.address].filter(Boolean).join(" · ")}
                              </small>
                            </td>
                            <td>
                              <button
                                type="button"
                                className={`nm-btn nm-btn--sm nm-btn--secondary${expanded ? " nm-btn--active" : ""}`}
                                aria-expanded={expanded}
                                aria-controls={`${item.uid}-extras`}
                                aria-label={`Extras for ${label}`}
                                onClick={() => setExpandedUid(expanded ? null : item.uid)}
                              >
                                {count > 0 ? `Extras · ${count}` : "Extras"}
                              </button>
                            </td>
                            <td className="status-layout-actions">
                              <div className="nm-table-actions">
                                <button
                                  type="button"
                                  id={`${item.uid}-move-up`}
                                  className="nm-btn nm-btn--sm nm-btn--secondary"
                                  aria-label={`Move ${label} up`}
                                  title="Move up"
                                  disabled={atStart}
                                  onClick={() => moveItemBy(item.uid, -1)}
                                >
                                  <ArrowUp size={14} />
                                </button>
                                <button
                                  type="button"
                                  id={`${item.uid}-move-down`}
                                  className="nm-btn nm-btn--sm nm-btn--secondary"
                                  aria-label={`Move ${label} down`}
                                  title="Move down"
                                  disabled={atEnd}
                                  onClick={() => moveItemBy(item.uid, 1)}
                                >
                                  <ArrowDown size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="nm-btn nm-btn--sm nm-btn--ghost"
                                  aria-label={`Remove ${label}`}
                                  onClick={() => setGroups((current) => current.map((g) => ({ ...g, items: g.items.filter((i) => i.uid !== item.uid) })))}
                                >
                                  Remove
                                </button>
                              </div>
                            </td>
                          </tr>
                          {expanded && (
                            <tr className="status-layout-extras-row" id={`${item.uid}-extras`}>
                              <td colSpan={5}>
                                <fieldset className="status-layout-extras">
                                  <legend className="nm-field-label">Extras shown when a visitor opens {label}</legend>
                                  {extraLabels(description.kind === "device").map(([key, text]) => (
                                    <label key={key} className="status-layout-check">
                                      <input
                                        type="checkbox"
                                        checked={item.extras[key]}
                                        onChange={(event) => updateItem(item.uid, { extras: { ...item.extras, [key]: event.target.checked } })}
                                      />
                                      {text}
                                    </label>
                                  ))}
                                  <label className="status-layout-check">
                                    Availability over
                                    <select
                                      className="nm-select"
                                      value={item.extras.uptime_period ?? ""}
                                      onChange={(event) => updateItem(item.uid, {
                                        extras: { ...item.extras, uptime_period: (event.target.value || null) as StatusItemExtras["uptime_period"] },
                                      })}
                                    >
                                      <option value="">Not shown</option>
                                      <option value="24h">24 hours</option>
                                      <option value="7d">7 days</option>
                                      <option value="30d">30 days</option>
                                    </select>
                                  </label>
                                </fieldset>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          </div>
        );
      })}

      {pickerGroup && (
        <StatusSourcePicker
          groupName={pickerGroup.name}
          sources={sources}
          sourcesError={sourcesError}
          usedKeys={usedKeys}
          onPick={(source) => addItem(pickerGroup.uid, source)}
          onCancel={() => setPickerGroupUid(null)}
        />
      )}
    </div>
  );
}

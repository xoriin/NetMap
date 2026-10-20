import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { TableSkeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { StatusEditorPanelHeader } from "./StatusPageLayoutEditor";
import { itemChoices, useStatusPageCatalog } from "./useStatusPageCatalog";
import {
  TEXT_LIMITS, apiErrorMessage, browserTimeZone, formatWhen, isoToLocalInput, localInputToIso, sourceKey, statusManageApi, toOffsetIso,
  type MaintenancePayload, type ManagedMaintenance, type StatusPageDetail,
} from "./statusPagesEditorApi";

const STATE_LABELS = { upcoming: "Upcoming", active: "In progress", finished: "Finished" } as const;
const STATE_TONES = { upcoming: "unknown", active: "warning", finished: "disabled" } as const;
const PAST_START_GRACE_MS = 5 * 60_000;
const SUPPRESS_NOTE = "Also silences monitoring alert notifications for these items throughout NetMap while the window is active, not only on the announced pages. Checks and history continue.";
const SUPPRESS_STARTED_NOTE = "Alert suppression can't be changed after a window starts. End the window early instead.";

type Draft = {
  title: string;
  description: string;
  starts: string;
  ends: string;
  itemKeys: string[];
  pageMode: "auto" | "chosen";
  pageIds: number[];
  suppress: boolean;
};

function draftFrom(window: ManagedMaintenance | null, pageId: number): Draft {
  if (!window) {
    return { title: "", description: "", starts: "", ends: "", itemKeys: [], pageMode: "auto", pageIds: [pageId], suppress: false };
  }
  return {
    title: window.title,
    description: window.description ?? "",
    starts: isoToLocalInput(window.starts_at),
    ends: isoToLocalInput(window.ends_at),
    itemKeys: window.items.map((item) => item.source_key),
    pageMode: "chosen",
    pageIds: [...window.page_ids],
    suppress: window.suppress_alerts,
  };
}

const sameSet = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((value) => b.includes(value));

function MaintenanceModal({
  accessToken, page, pages, window, canSuppress, onCancel, onSaved,
}: {
  accessToken: string;
  page: StatusPageDetail;
  pages: StatusPageDetail[];
  window: ManagedMaintenance | null;
  canSuppress: boolean;
  onCancel: () => void;
  onSaved: (window: ManagedMaintenance) => void;
}) {
  const [initial] = useState<Draft>(() => draftFrom(window, page.id));
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = window !== null && window.state !== "upcoming";
  const finished = window?.state === "finished";
  const choices = useMemo(() => {
    const known = itemChoices(pages, page.id);
    const extra = (window?.items ?? []).filter((item) => !known.some((c) => c.key === item.source_key))
      .map((item) => ({ key: item.source_key, source: item.source, label: item.source_key, aliases: [] }));
    return [...known, ...extra];
  }, [pages, page.id, window]);
  const startsAt = localInputToIso(draft.starts);
  const endsAt = localInputToIso(draft.ends);
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const problems: string[] = [];
  if (!draft.title.trim()) problems.push("Give the window a title.");
  if (!startsAt || !endsAt) problems.push("Choose a start and an end.");
  else if (new Date(endsAt) <= new Date(startsAt)) problems.push("The end must be after the start.");
  if (!window && startsAt && new Date(startsAt).getTime() < Date.now() - PAST_START_GRACE_MS) problems.push("The start can't be more than 5 minutes in the past.");
  if (draft.itemKeys.length === 0) problems.push("Choose at least one affected item.");
  if (draft.pageMode === "chosen" && draft.pageIds.length === 0) problems.push("Choose at least one page, or announce on every page showing an item.");

  function changes(): Partial<MaintenancePayload> {
    const base = window!;
    const next: Partial<MaintenancePayload> = {};
    if (draft.title.trim() !== base.title) next.title = draft.title.trim();
    if ((draft.description.trim() || null) !== base.description) next.description = draft.description.trim() || null;
    if (finished) return next;
    if (!started && startsAt && draft.starts !== initial.starts) next.starts_at = startsAt;
    if (endsAt && draft.ends !== initial.ends) next.ends_at = endsAt;
    if (!started && !sameSet(draft.itemKeys, base.items.map((item) => item.source_key))) {
      next.items = choices.filter((c) => draft.itemKeys.includes(c.key)).map((c) => c.source);
    }
    if (!started && !sameSet(draft.pageIds, base.page_ids)) next.page_ids = draft.pageIds;
    if (!started && canSuppress && draft.suppress !== base.suppress_alerts) next.suppress_alerts = draft.suppress;
    return next;
  }

  const pending = window ? changes() : null;
  const nothingChanged = pending !== null && Object.keys(pending).length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (problems.length > 0 || nothingChanged) return;
    setBusy(true);
    setError(null);
    try {
      if (window) {
        onSaved(await statusManageApi.updateMaintenance(accessToken, window.id, pending!));
      } else {
        onSaved(await statusManageApi.createMaintenance(accessToken, {
          title: draft.title.trim(),
          description: draft.description.trim() || null,
          starts_at: startsAt!,
          ends_at: endsAt!,
          items: choices.filter((c) => draft.itemKeys.includes(c.key)).map((c) => c.source),
          ...(draft.pageMode === "chosen" ? { page_ids: draft.pageIds } : {}),
          suppress_alerts: canSuppress && draft.suppress,
        }));
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to save the maintenance window"));
      setBusy(false);
    }
  }

  const scopeLocked = started;
  return (
    <Modal
      title={window ? "Edit maintenance" : "Schedule maintenance"}
      titleIcon={<CalendarClock size={18} />}
      size="lg"
      onCancel={onCancel}
      footer={
        <ModalFooterActions
          onCancel={onCancel}
          formId="status-maintenance-form"
          primaryLabel={busy ? "Saving…" : window ? "Save changes" : "Schedule"}
          primaryDisabled={busy || problems.length > 0 || nothingChanged}
        />
      }
    >
      <form id="status-maintenance-form" className="modal-form" onSubmit={(event) => void submit(event)} noValidate>
        {error && <div className="form-error" role="alert">{error}</div>}
        {finished && <div className="nm-alert nm-alert--info" role="note">This window has finished. Only its title and description can change.</div>}
        {started && !finished && <div className="nm-alert nm-alert--info" role="note">This window has started, so its start, items and pages are fixed. You can still move the end or end it now.</div>}
        <label>Title
          <input value={draft.title} maxLength={TEXT_LIMITS.maintenanceTitle} onChange={(event) => update("title", event.target.value)} />
          <small className="status-editor-hint">Plain text · {draft.title.length}/{TEXT_LIMITS.maintenanceTitle} characters</small>
        </label>
        <label>Description
          <textarea rows={3} value={draft.description} maxLength={TEXT_LIMITS.maintenanceDescription} onChange={(event) => update("description", event.target.value)} />
          <small className="status-editor-hint">Optional. Plain text · {draft.description.length}/{TEXT_LIMITS.maintenanceDescription} characters</small>
        </label>
        <label>Starts
          <input type="datetime-local" value={draft.starts} disabled={scopeLocked} onChange={(event) => update("starts", event.target.value)} />
        </label>
        <label>Ends
          <input type="datetime-local" value={draft.ends} disabled={finished} onChange={(event) => update("ends", event.target.value)} />
          <small className="status-editor-hint">Times are in your timezone ({browserTimeZone()}). Visitors see them in their own timezone.</small>
        </label>
        <fieldset className="status-manage-choices">
          <legend className="nm-field-label">Affected items</legend>
          {choices.length === 0 && <small className="status-editor-hint">No status page shows any items yet.</small>}
          {choices.map((choice) => (
            <label key={choice.key} className="tool-form-inline-check">
              <input
                type="checkbox"
                disabled={scopeLocked}
                checked={draft.itemKeys.includes(choice.key)}
                onChange={(event) => update("itemKeys", event.target.checked ? [...draft.itemKeys, choice.key] : draft.itemKeys.filter((k) => k !== choice.key))}
              />
              <span className="tool-form-check-copy">
                <span>{choice.label}</span>
                {choice.aliases.length > 0 && <span className="tool-note">Also shown as {choice.aliases.join(", ")}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="status-manage-choices">
          <legend className="nm-field-label">Announce on</legend>
          {!window && (
            <>
              <label className="tool-form-inline-check">
                <input type="radio" name="status-maintenance-pages" checked={draft.pageMode === "auto"} onChange={() => update("pageMode", "auto")} />
                Every page showing an affected item
              </label>
              <label className="tool-form-inline-check">
                <input type="radio" name="status-maintenance-pages" checked={draft.pageMode === "chosen"} onChange={() => update("pageMode", "chosen")} />
                Only the pages I choose
              </label>
            </>
          )}
          {draft.pageMode === "chosen" && pages.map((p) => (
            <label key={p.id} className="tool-form-inline-check">
              <input
                type="checkbox"
                disabled={scopeLocked}
                checked={draft.pageIds.includes(p.id)}
                onChange={(event) => update("pageIds", event.target.checked ? [...draft.pageIds, p.id] : draft.pageIds.filter((id) => id !== p.id))}
              />
              {p.name}
            </label>
          ))}
        </fieldset>
        {canSuppress && (
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={draft.suppress} disabled={started} onChange={(event) => update("suppress", event.target.checked)} />
            <span className="tool-form-check-copy">
              <span>Suppress monitoring alerts</span>
              <span className="tool-note">{started ? SUPPRESS_STARTED_NOTE : SUPPRESS_NOTE}</span>
            </span>
          </label>
        )}
        {problems.length > 0 && <small className="status-editor-hint">{problems[0]}</small>}
      </form>
    </Modal>
  );
}

export function StatusMaintenancePanel({ accessToken, page, canManageAlerts }: { accessToken: string; page: StatusPageDetail; canManageAlerts: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { pages, error: pagesError } = useStatusPageCatalog(accessToken);
  const [windows, setWindows] = useState<ManagedMaintenance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ManagedMaintenance | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setWindows(await statusManageApi.maintenance(accessToken));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to load maintenance windows"));
    }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  const pageKeys = useMemo(() => new Set(page.groups.flatMap((g) => g.items.map((item) => sourceKey(item.source)))), [page]);
  const shown = useMemo(
    () => (windows ?? []).filter((w) => w.page_ids.includes(page.id) || w.items.some((item) => pageKeys.has(item.source_key)))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    [windows, page.id, pageKeys],
  );
  const locked = (w: ManagedMaintenance) => w.suppress_alerts && !canManageAlerts;

  async function endNow(w: ManagedMaintenance) {
    const ok = await confirm({
      title: `End ${w.title} now?`,
      message: "The window ends immediately. Affected items return to normal reporting and alerting.",
      confirmLabel: "End now",
      danger: false,
    });
    if (!ok) return;
    try {
      await statusManageApi.updateMaintenance(accessToken, w.id, { ends_at: toOffsetIso(new Date()) });
      toast.success("Maintenance ended");
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Unable to end the maintenance window"));
    }
  }

  async function remove(w: ManagedMaintenance) {
    const ok = await confirm({
      title: `Delete ${w.title}?`,
      message: "The window is removed from every page, including its history under Past incidents.",
      confirmLabel: "Delete window",
    });
    if (!ok) return;
    try {
      await statusManageApi.deleteMaintenance(accessToken, w.id);
      toast.success("Maintenance deleted");
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Unable to delete the maintenance window"));
    }
  }

  return (
    <div className="status-editor-panels">
      <section className="nm-app-panel status-editor-panel status-maintenance-panel">
        <StatusEditorPanelHeader icon={CalendarClock} title="Scheduled maintenance" meta={windows ? `${shown.length} window${shown.length === 1 ? "" : "s"}` : undefined}>
          <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={!pages} onClick={() => setEditing("new")}>
            <Plus size={14} /> Schedule maintenance
          </button>
        </StatusEditorPanelHeader>
        <div className="status-layout-intro">
          {(error || pagesError) && <div className="nm-alert nm-alert--error" role="alert">{error ?? pagesError}</div>}
          <small className="status-editor-hint">Announced 7 days ahead. During the window affected items show Under maintenance and no automatic incidents open for them.</small>
        </div>
        {!windows ? (
          <TableSkeleton rows={2} columns={6} />
        ) : shown.length === 0 ? (
          <p className="dash-empty">No maintenance scheduled for this page.</p>
        ) : (
          <div className="nm-table-wrap mon-embedded-table">
            <table className="nm-table status-manage-table status-maintenance-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>When</th>
                  <th>State</th>
                  <th>Items</th>
                  <th>Alerts</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <strong>{w.title}</strong>
                      <small className="status-editor-sub">{w.created_by_token ? `Scheduled by token ${w.created_by_token}` : w.created_by ? `Scheduled by ${w.created_by}` : "Scheduled"}</small>
                    </td>
                    <td>{formatWhen(w.starts_at)} – {formatWhen(w.ends_at)}</td>
                    <td><span className={`nm-status nm-status--${STATE_TONES[w.state]}`}>{STATE_LABELS[w.state]}</span></td>
                    <td className="nm-table-num">{w.items.length}</td>
                    <td>{w.suppress_alerts ? "Suppressed" : "Normal"}</td>
                    <td className="status-pages-actions">
                      <div className="nm-table-actions">
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={!pages || locked(w)} title={locked(w) ? "Only someone who can manage alert rules can change a window that suppresses alerts." : undefined} onClick={() => setEditing(w)}>Edit</button>
                        {w.state === "active" && <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={locked(w)} onClick={() => void endNow(w)}>End now</button>}
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={locked(w)} onClick={() => void remove(w)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && pages && (
        <MaintenanceModal
          accessToken={accessToken}
          page={page}
          pages={pages}
          window={editing === "new" ? null : editing}
          canSuppress={canManageAlerts}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            toast.success(editing === "new" ? "Maintenance scheduled" : "Maintenance updated");
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

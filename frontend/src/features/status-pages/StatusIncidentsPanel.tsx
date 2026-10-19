import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus, Siren } from "lucide-react";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { TableSkeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { StatusEditorPanelHeader } from "./StatusPageLayoutEditor";
import { itemChoices, pageItems, useStatusPageCatalog } from "./useStatusPageCatalog";
import {
  TEXT_LIMITS, apiErrorMessage, formatWhen, isHttpUrl, statusManageApi,
  type IncidentSeverity, type IncidentStatus, type ManagedIncident, type ManagedIncidentUpdate, type StatusPageDetail,
} from "./statusPagesEditorApi";

const STATUS_LABELS: Record<IncidentStatus, string> = {
  investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved",
};
const STATUS_TONES: Record<IncidentStatus, string> = {
  investigating: "offline", identified: "warning", monitoring: "unknown", resolved: "online",
};
const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  performance: "Degraded performance", partial: "Partial outage", major: "Major outage",
};
const SOURCE_LABELS = { person: "Opened by a person", token: "Opened by an integration", netmap: "Opened by NetMap" } as const;
const EVENT_LABELS: Record<string, string> = {
  opened: "Opened automatically after consecutive failed checks.",
  source_added: "Another monitored item is affected.",
  rebreached: "Failing again.",
  source_removed: "Monitoring source removed.",
  recovered: "All affected systems have recovered. Monitoring.",
  resolved_manual: "Resolved.",
};
const AUTHOR_NOTE = "Visitors only ever see \"Status team\" as the author of people's updates. Names here are visible to page managers only.";

function limitHint(length: number, max: number) {
  return `Plain text · ${length}/${max} characters`;
}

function StatusPill({ status }: { status: IncidentStatus }) {
  return <span className={`nm-status nm-status--${STATUS_TONES[status]}`}>{STATUS_LABELS[status]}</span>;
}

function pageName(pages: StatusPageDetail[] | null, id: number) {
  return pages?.find((p) => p.id === id)?.name ?? `Page #${id}`;
}

function updateText(update: ManagedIncidentUpdate) {
  if (update.message) return update.message;
  return update.event_code ? EVENT_LABELS[update.event_code] ?? "Automatic update." : "";
}

function OpenIncidentModal({
  accessToken, page, pages, onCancel, onOpened,
}: {
  accessToken: string;
  page: StatusPageDetail;
  pages: StatusPageDetail[];
  onCancel: () => void;
  onOpened: (incident: ManagedIncident) => void;
}) {
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>("partial");
  const [message, setMessage] = useState("");
  const [internal, setInternal] = useState(false);
  const [pageIds, setPageIds] = useState<number[]>([page.id]);
  const [itemKeys, setItemKeys] = useState<string[]>([]);
  const [ticketUrl, setTicketUrl] = useState("");
  const [ticketLabel, setTicketLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPages = useMemo(() => pages.filter((p) => pageIds.includes(p.id)), [pages, pageIds]);
  const choices = useMemo(() => itemChoices(selectedPages, page.id), [selectedPages, page.id]);
  const ticketInvalid = ticketUrl.trim() !== "" && !isHttpUrl(ticketUrl.trim());
  const invalid = !title.trim() || !message.trim() || pageIds.length === 0 || ticketInvalid;

  function togglePage(id: number, checked: boolean) {
    const next = checked ? [...pageIds, id] : pageIds.filter((p) => p !== id);
    setPageIds(next);
    const available = new Set(itemChoices(pages.filter((p) => next.includes(p.id)), page.id).map((c) => c.key));
    setItemKeys((keys) => keys.filter((key) => available.has(key)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(await statusManageApi.openIncident(accessToken, {
        title: title.trim(),
        severity,
        message: message.trim(),
        is_public: !internal,
        page_ids: pages.filter((p) => pageIds.includes(p.id)).map((p) => p.id),
        items: choices.filter((c) => itemKeys.includes(c.key)).map((c) => c.source),
        ...(ticketUrl.trim() ? { ticket: { url: ticketUrl.trim(), label: ticketLabel.trim() || null } } : {}),
      }));
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to open the incident"));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Open incident"
      titleIcon={<Siren size={18} />}
      size="lg"
      onCancel={onCancel}
      footer={<ModalFooterActions onCancel={onCancel} formId="status-incident-form" primaryLabel={busy ? "Opening…" : "Open incident"} primaryDisabled={busy || invalid} />}
    >
      <form id="status-incident-form" className="modal-form" onSubmit={(event) => void submit(event)} noValidate>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label>Title
          <input value={title} maxLength={TEXT_LIMITS.incidentTitle} placeholder="e.g. Email delivery delayed" onChange={(event) => setTitle(event.target.value)} />
          <small className="status-editor-hint">{limitHint(title.length, TEXT_LIMITS.incidentTitle)}</small>
        </label>
        <label>Severity
          <select value={severity} onChange={(event) => setSeverity(event.target.value as IncidentSeverity)}>
            {(Object.keys(SEVERITY_LABELS) as IncidentSeverity[]).map((value) => <option key={value} value={value}>{SEVERITY_LABELS[value]}</option>)}
          </select>
        </label>
        <label>Message
          <textarea rows={4} value={message} maxLength={TEXT_LIMITS.incidentMessage} onChange={(event) => setMessage(event.target.value)} />
          <small className="status-editor-hint">{limitHint(message.length, TEXT_LIMITS.incidentMessage)}</small>
        </label>
        <label className="tool-form-inline-check">
          <input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} />
          <span className="tool-form-check-copy">
            <span>Internal first update</span>
            <span className="tool-note">Shown only on private pages, marked Internal.</span>
          </span>
        </label>
        <fieldset className="status-manage-choices">
          <legend className="nm-field-label">Publish to pages</legend>
          {pages.map((p) => (
            <label key={p.id} className="tool-form-inline-check">
              <input type="checkbox" checked={pageIds.includes(p.id)} onChange={(event) => togglePage(p.id, event.target.checked)} />
              {p.name}
            </label>
          ))}
        </fieldset>
        <fieldset className="status-manage-choices">
          <legend className="nm-field-label">Affected items</legend>
          {choices.length === 0
            ? <small className="status-editor-hint">The selected pages have no items. The incident is still shown on them.</small>
            : choices.map((choice) => (
              <label key={choice.key} className="tool-form-inline-check">
                <input
                  type="checkbox"
                  checked={itemKeys.includes(choice.key)}
                  onChange={(event) => setItemKeys((keys) => event.target.checked ? [...keys, choice.key] : keys.filter((k) => k !== choice.key))}
                />
                <span className="tool-form-check-copy">
                  <span>{choice.label}</span>
                  {choice.aliases.length > 0 && <span className="tool-note">Also shown as {choice.aliases.join(", ")}</span>}
                </span>
              </label>
            ))}
        </fieldset>
        <section className="mon-hero-section status-incident-audience">
          <div className="mon-hero-section-title">Audience before you save<span className="dash-panel-meta">{selectedPages.length} page{selectedPages.length === 1 ? "" : "s"}</span></div>
          <div className="mon-analysis-body">
            {selectedPages.length === 0 ? (
              <div className="mon-analysis-row"><span className="status-editor-error">Choose at least one page.</span></div>
            ) : selectedPages.map((p) => {
              const local = choices.filter((c) => itemKeys.includes(c.key))
                .map((c) => pageItems(p).find((item) => item.key === c.key)?.displayName)
                .filter((name): name is string => Boolean(name));
              return (
                <div key={p.id} className="mon-analysis-row">
                  <span><strong>{p.name}</strong> <span className="dash-panel-meta">{p.visibility === "public" ? "Public page" : "Private page"}</span></span>
                  <span className="dash-panel-meta">{local.length > 0 ? `Shows: ${local.join(", ")}` : "No affected items on this page"}</span>
                </div>
              );
            })}
          </div>
        </section>
        <label>Ticket link
          <input value={ticketUrl} maxLength={TEXT_LIMITS.ticketUrl} placeholder="https://tickets.example.com/INC-1042" aria-invalid={ticketInvalid || undefined} onChange={(event) => setTicketUrl(event.target.value)} />
          {ticketInvalid && <small className="status-editor-error">Use an http:// or https:// link.</small>}
        </label>
        <label>Ticket label
          <input value={ticketLabel} maxLength={TEXT_LIMITS.ticketLabel} placeholder="e.g. Ticket INC-1042" disabled={!ticketUrl.trim()} onChange={(event) => setTicketLabel(event.target.value)} />
          <small className="status-editor-hint">{limitHint(ticketLabel.length, TEXT_LIMITS.ticketLabel)}</small>
        </label>
      </form>
    </Modal>
  );
}

function IncidentDetailModal({
  accessToken, page, pages, incident, onChange, onClose,
}: {
  accessToken: string;
  page: StatusPageDetail;
  pages: StatusPageDetail[];
  incident: ManagedIncident;
  onChange: (incident: ManagedIncident) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [message, setMessage] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [statusChange, setStatusChange] = useState<"" | Exclude<IncidentStatus, "resolved">>("");
  const [audience, setAudience] = useState(incident.page_ids.includes(page.id) ? String(page.id) : "all");
  const [reason, setReason] = useState("");
  const [publishTo, setPublishTo] = useState("");
  const [busy, setBusy] = useState<null | "update" | "resolve" | "publish">(null);
  const [error, setError] = useState<string | null>(null);
  const resolved = incident.status === "resolved";
  const otherPages = pages.filter((p) => !incident.page_ids.includes(p.id));
  const reasonMissing = incident.breaching && !reason.trim();

  async function run(kind: "update" | "resolve" | "publish", action: () => Promise<ManagedIncident>, success: string) {
    setBusy(kind);
    setError(null);
    try {
      onChange(await action());
      toast.success(success);
      return true;
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to save"));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function postUpdate(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() && !statusChange) return;
    const ok = await run("update", () => statusManageApi.addUpdate(accessToken, incident.id, {
      message: message.trim() || null,
      is_public: isPublic,
      page_id: audience === "all" ? null : Number(audience),
      status_change: statusChange || null,
    }), "Update posted");
    if (ok) { setMessage(""); setStatusChange(""); }
  }

  return (
    <Modal title={incident.title} titleIcon={<Siren size={18} />} size="lg" onCancel={onClose} footer={<button type="button" className="nm-btn" onClick={onClose}>Close</button>}>
      <div className="modal-form status-incident-detail">
        <div className="status-incident-facts">
          <StatusPill status={incident.status} />
          <span>{SEVERITY_LABELS[incident.severity]}</span>
          <span className="status-editor-count">{SOURCE_LABELS[incident.source]} · {formatWhen(incident.opened_at)}</span>
          {incident.ticket && <a href={incident.ticket.url} target="_blank" rel="noopener noreferrer">{incident.ticket.label || incident.ticket.url}</a>}
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        {incident.breaching && !resolved && (
          <div className="nm-alert nm-alert--warning" role="status">An affected system hasn't recovered yet. Resolving now needs a reason, and NetMap won't reopen this incident until the system recovers and then fails again.</div>
        )}

        <section className="mon-hero-section">
          <div className="mon-hero-section-title">Shown on<span className="dash-panel-meta">{incident.page_ids.length} page{incident.page_ids.length === 1 ? "" : "s"}</span></div>
          <div className="mon-analysis-body">
            {incident.page_ids.map((id) => {
              const names = incident.items.filter((item) => item.page_id === id).map((item) => item.display_name);
              return (
                <div key={id} className="mon-analysis-row">
                  <strong>{pageName(pages, id)}</strong>
                  <span className="dash-panel-meta">{names.length > 0 ? `Shows: ${names.join(", ")}` : "No affected items on this page"}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mon-hero-section">
          <div className="mon-hero-section-title">Timeline<span className="dash-panel-meta">{incident.updates.length} update{incident.updates.length === 1 ? "" : "s"}</span></div>
          <div className="mon-analysis-body">
            <div className="mon-analysis-row"><small className="status-editor-hint">{AUTHOR_NOTE}</small></div>
            {[...incident.updates].reverse().map((update) => (
              <div key={update.id} className="mon-analysis-row status-incident-update">
                <div>
                  <div className="status-incident-update-meta">
                    <span>{formatWhen(update.at)}</span>
                    <strong>{update.author ?? "Unknown"}</strong>
                    <span className="dash-panel-meta">{update.page_id === null ? "Every page in the audience" : pageName(pages, update.page_id)}</span>
                  </div>
                  {updateText(update) && <p>{updateText(update)}</p>}
                </div>
                <div className="status-incident-update-meta">
                  {!update.is_public && <span className="nm-status nm-status--paused">Internal</span>}
                  {update.status && <StatusPill status={update.status} />}
                </div>
              </div>
            ))}
          </div>
        </section>

        {!resolved && (
          <section className="mon-hero-section">
            <div className="mon-hero-section-title">Post an update</div>
            <form className="status-incident-section-body" onSubmit={(event) => void postUpdate(event)}>
              <label>Update message
                <textarea rows={3} value={message} maxLength={TEXT_LIMITS.incidentMessage} onChange={(event) => setMessage(event.target.value)} />
                <small className="status-editor-hint">{limitHint(message.length, TEXT_LIMITS.incidentMessage)}</small>
              </label>
              <label className="tool-form-inline-check">
                <input type="checkbox" checked={!isPublic} onChange={(event) => setIsPublic(!event.target.checked)} />
                <span className="tool-form-check-copy">
                  <span>Internal update</span>
                  <span className="tool-note">{isPublic ? "Off: shown on public and private pages." : "Shown only on private pages, marked Internal."}</span>
                </span>
              </label>
              <label>Show on
                <select value={audience} onChange={(event) => setAudience(event.target.value)}>
                  {incident.page_ids.map((id) => <option key={id} value={id}>{pageName(pages, id)}{id === page.id ? " (this page)" : ""}</option>)}
                  <option value="all">Every page in the audience</option>
                </select>
              </label>
              <label>Status
                <select value={statusChange} onChange={(event) => setStatusChange(event.target.value as typeof statusChange)}>
                  <option value="">Keep {STATUS_LABELS[incident.status]}</option>
                  {(["investigating", "identified", "monitoring"] as const).filter((s) => s !== incident.status).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                </select>
              </label>
              <div className="nm-btn-row status-incident-actions">
                <button type="submit" className="nm-btn nm-btn--primary" disabled={busy !== null || (!message.trim() && !statusChange)}>
                  {busy === "update" ? "Posting…" : "Post update"}
                </button>
              </div>
            </form>
          </section>
        )}

        {!resolved && (
          <section className="mon-hero-section">
            <div className="mon-hero-section-title">Resolve</div>
            <div className="status-incident-section-body">
              <label>Reason for resolving
                <textarea
                  rows={2}
                  value={reason}
                  maxLength={TEXT_LIMITS.resolveReason}
                  aria-invalid={reasonMissing || undefined}
                  onChange={(event) => setReason(event.target.value)}
                />
                <small className="status-editor-hint">
                  {incident.breaching ? "Required while an affected system hasn't recovered. " : "Optional. "}Recorded as an internal update · {reason.length}/{TEXT_LIMITS.resolveReason} characters
                </small>
              </label>
              <div className="nm-btn-row status-incident-actions">
                <button
                  type="button"
                  className="nm-btn nm-btn--secondary"
                  disabled={busy !== null || reasonMissing}
                  onClick={() => void run("resolve", () => statusManageApi.resolve(accessToken, incident.id, reason.trim() || null), "Incident resolved")}
                >
                  {busy === "resolve" ? "Resolving…" : "Resolve incident"}
                </button>
              </div>
            </div>
          </section>
        )}

        {!resolved && otherPages.length > 0 && (
          <section className="mon-hero-section">
            <div className="mon-hero-section-title">Publish to another page</div>
            <div className="status-incident-section-body">
              <label>Page
                <select value={publishTo} onChange={(event) => setPublishTo(event.target.value)}>
                  <option value="">Choose a page</option>
                  {otherPages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              {publishTo && (
                <div className="nm-alert nm-alert--warning" role="status">
                  Earlier updates won't appear on {pageName(pages, Number(publishTo))}. Visitors there see this incident from the next update you post.
                </div>
              )}
              <div className="nm-btn-row status-incident-actions">
                <button
                  type="button"
                  className="nm-btn nm-btn--secondary"
                  disabled={busy !== null || !publishTo}
                  onClick={() => void run("publish", () => statusManageApi.publish(accessToken, incident.id, [Number(publishTo)]), "Incident published").then((ok) => { if (ok) setPublishTo(""); })}
                >
                  {busy === "publish" ? "Publishing…" : "Publish"}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

export function StatusIncidentsPanel({ accessToken, page }: { accessToken: string; page: StatusPageDetail }) {
  const toast = useToast();
  const { pages, error: pagesError } = useStatusPageCatalog(accessToken);
  const [incidents, setIncidents] = useState<ManagedIncident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [viewingId, setViewingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setIncidents(await statusManageApi.incidents(accessToken));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to load incidents"));
    }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(
    () => (incidents ?? []).filter((incident) => incident.page_ids.includes(page.id))
      .sort((a, b) => Number(a.status === "resolved") - Number(b.status === "resolved")),
    [incidents, page.id],
  );
  const activeCount = shown.filter((incident) => incident.status !== "resolved").length;
  const viewing = incidents?.find((incident) => incident.id === viewingId) ?? null;
  const replace = (next: ManagedIncident) => setIncidents((current) => current?.map((i) => (i.id === next.id ? next : i)) ?? [next]);

  return (
    <div className="status-editor-panels">
      <section className="nm-app-panel status-editor-panel status-incidents-panel">
        <StatusEditorPanelHeader icon={Siren} title="Incidents" meta={incidents ? `${activeCount} active on this page` : undefined}>
          <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={!pages} onClick={() => setOpening(true)}>
            <Plus size={14} /> Open incident
          </button>
        </StatusEditorPanelHeader>
        <div className="status-layout-intro">
          {(error || pagesError) && <div className="nm-alert nm-alert--error" role="alert">{error ?? pagesError}</div>}
          <small className="status-editor-hint">Incidents opened by NetMap's alert rules appear here automatically. {AUTHOR_NOTE}</small>
        </div>
        {!incidents ? (
          <TableSkeleton rows={3} columns={6} />
        ) : shown.length === 0 ? (
          <p className="dash-empty">No incidents on this page.</p>
        ) : (
          <div className="nm-table-wrap mon-embedded-table">
            <table className="nm-table status-manage-table status-incidents-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Severity</th>
                  <th>Pages</th>
                  <th>Opened</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((incident) => (
                  <tr key={incident.id}>
                    <td>
                      <strong>{incident.title}</strong>
                      <small className="status-editor-sub">{SOURCE_LABELS[incident.source]}</small>
                    </td>
                    <td><StatusPill status={incident.status} /></td>
                    <td>{SEVERITY_LABELS[incident.severity]}</td>
                    <td>{incident.page_ids.map((id) => pageName(pages, id)).join(", ")}</td>
                    <td>{formatWhen(incident.opened_at)}</td>
                    <td className="status-pages-actions">
                      <div className="nm-table-actions">
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={!pages} onClick={() => setViewingId(incident.id)}>View</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {opening && pages && (
        <OpenIncidentModal
          accessToken={accessToken}
          page={page}
          pages={pages}
          onCancel={() => setOpening(false)}
          onOpened={(incident) => {
            setOpening(false);
            setIncidents((current) => [incident, ...(current ?? [])]);
            toast.success("Incident opened");
          }}
        />
      )}
      {viewing && pages && (
        <IncidentDetailModal
          accessToken={accessToken}
          page={page}
          pages={pages}
          incident={viewing}
          onChange={replace}
          onClose={() => setViewingId(null)}
        />
      )}
    </div>
  );
}

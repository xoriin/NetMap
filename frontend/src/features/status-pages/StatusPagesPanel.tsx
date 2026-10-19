import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { IconBroadcast } from "@tabler/icons-react";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { TableSkeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { StatusPageEditor } from "./StatusPageEditor";
import { statusPagePath } from "./statusPagesApi";
import {
  SLUG_HINT, isValidSlug, slugFromName, statusPagesEditorApi, type StatusPageSummary, type StatusPageVisibility,
} from "./statusPagesEditorApi";
import "./statusPagesEditor.css";

const WINDOW_LABELS = { "1h": "Last hour", "24h": "Last 24 hours" } as const;

function formatUpdated(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : `${date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function CreatePageModal({
  accessToken,
  onCancel,
  onCreated,
}: {
  accessToken: string;
  onCancel: () => void;
  onCreated: (page: StatusPageSummary) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [visibility, setVisibility] = useState<StatusPageVisibility>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugInvalid = slug !== "" && !isValidSlug(slug);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !isValidSlug(slug)) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await statusPagesEditorApi.create(accessToken, { name: name.trim(), slug, visibility }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the status page");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New status page"
      titleIcon={<IconBroadcast size={18} />}
      onCancel={onCancel}
      footer={
        <ModalFooterActions
          onCancel={onCancel}
          formId="status-page-create-form"
          primaryLabel={busy ? "Creating…" : "Create page"}
          primaryDisabled={busy || !name.trim() || !isValidSlug(slug)}
        />
      }
    >
      <form id="status-page-create-form" className="modal-form" onSubmit={(event) => void submit(event)}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label>Name
          <input
            value={name}
            maxLength={120}
            required
            placeholder="e.g. Customer services"
            onChange={(event) => {
              setName(event.target.value);
              if (!slugEdited) setSlug(slugFromName(event.target.value));
            }}
          />
        </label>
        <label>Slug
          <input
            value={slug}
            maxLength={48}
            required
            aria-invalid={slugInvalid || undefined}
            onChange={(event) => { setSlugEdited(true); setSlug(event.target.value.toLowerCase()); }}
          />
          <small className="status-editor-hint">{slugInvalid ? SLUG_HINT : `Visitors open ${statusPagePath(slug || "your-slug")}.`}</small>
        </label>
        <label>Visibility
          <select value={visibility} onChange={(event) => setVisibility(event.target.value as StatusPageVisibility)}>
            <option value="public">Public — anyone with the link</option>
            <option value="private">Private — signed-in users only</option>
          </select>
        </label>
      </form>
    </Modal>
  );
}

export function StatusPagesPanel({ accessToken, canManageAlerts = false }: { accessToken: string; canManageAlerts?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [pages, setPages] = useState<StatusPageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setPages(await statusPagesEditorApi.list(accessToken));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load status pages");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  async function deletePage(page: StatusPageSummary) {
    const confirmed = await confirm({
      title: `Delete ${page.name}`,
      message: `This permanently deletes the status page and its layout. ${statusPagePath(page.slug)} stops working immediately.`,
      confirmLabel: "Delete page",
    });
    if (!confirmed) return;
    try {
      await statusPagesEditorApi.remove(accessToken, page.id);
      toast.success(`Deleted ${page.name}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to delete the status page");
    }
  }

  if (editingId !== null) {
    return (
      <StatusPageEditor
        accessToken={accessToken}
        pageId={editingId}
        canManageAlerts={canManageAlerts}
        onClose={() => { setEditingId(null); void load(); }}
      />
    );
  }

  return (
    <div className="dash-panel nm-app-panel mon-view-window status-pages-window">
      <div className="dash-panel-header nm-app-panel-header status-editor-header">
        <div className="status-editor-title">
          <span className="status-editor-icon"><IconBroadcast size={18} /></span>
          <span className="status-editor-title-separator" aria-hidden="true">-</span>
          <strong>Status pages</strong>
          {!loading && <span className="status-editor-count">{pages.length} page{pages.length === 1 ? "" : "s"}</span>}
        </div>
        <div className="mon-panel-controls">
          <button type="button" className="nm-btn nm-btn--primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New status page
          </button>
        </div>
      </div>
      <div className="dash-panel-body mon-table-body status-pages-body">
        {error && <div className="nm-alert nm-alert--error status-pages-alert" role="alert">{error}</div>}
        {loading ? (
          <TableSkeleton rows={4} columns={6} />
        ) : pages.length === 0 ? (
          <p className="dash-empty">No status pages yet. Create one to share the health of chosen devices and endpoints.</p>
        ) : (
          <div className="nm-table-wrap mon-embedded-table status-pages-table-wrap">
            <table className="nm-table status-pages-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Address</th>
                  <th>Visibility</th>
                  <th>Heartbeat window</th>
                  <th>Updated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {pages.map((page) => (
                  <tr key={page.id}>
                    <td>
                      <strong>{page.name}</strong>
                      {page.title && page.title !== page.name && <small className="status-editor-sub">{page.title}</small>}
                    </td>
                    <td className="nm-table-mono">
                      <a href={statusPagePath(page.slug)} target="_blank" rel="noopener noreferrer">{statusPagePath(page.slug)}</a>
                    </td>
                    <td>{page.visibility === "public" ? "Public" : "Private"}</td>
                    <td>{WINDOW_LABELS[page.heartbeat_window]}</td>
                    <td>{formatUpdated(page.updated_at)}</td>
                    <td className="status-pages-actions">
                      <div className="nm-table-actions">
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => setEditingId(page.id)}>Edit</button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void deletePage(page)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && (
        <CreatePageModal
          accessToken={accessToken}
          onCancel={() => setCreating(false)}
          onCreated={(page) => {
            setCreating(false);
            toast.success(`Created ${page.name}`);
            setEditingId(page.id);
          }}
        />
      )}
    </div>
  );
}

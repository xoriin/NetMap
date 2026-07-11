import { useState, type FormEvent } from "react";
import { api, type TopologyDisplayPrefs, type TopologyLayout } from "../../api/client";
import type { LayoutPosition } from "../../api/client";
import { Modal } from "../../components/Modal";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";

function LayoutDotPlot({ positions }: { positions: TopologyLayout["positions"] }) {
  const points = Object.values(positions);
  if (points.length === 0) return null;
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const W = 240;
  const H = 140;
  const PAD = 10;
  const scale = Math.min((W - PAD * 2) / width, (H - PAD * 2) / height);
  return (
    <svg className="layout-preview-plot" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="presentation">
      {points.map((point, index) => (
        <circle
          key={index}
          cx={(point.x - minX) * scale + (W - width * scale) / 2}
          cy={(point.y - minY) * scale + (H - height * scale) / 2}
          r={2.5}
        />
      ))}
    </svg>
  );
}

/**
 * Saved-layouts manager: save the current canvas as a named layout, load or
 * delete existing layouts, and share layouts between users via short share
 * codes. Loading is delegated to the orchestrator (which owns cytoscape).
 */
export function LayoutsModal({
  accessToken,
  layouts,
  getCurrentLayout,
  onClose,
  onLoad,
  onLayoutsChanged,
}: {
  accessToken: string;
  layouts: TopologyLayout[];
  getCurrentLayout: () => { positions: Record<string, LayoutPosition>; display_prefs: TopologyDisplayPrefs };
  onClose: () => void;
  onLoad: (layout: TopologyLayout) => void;
  onLayoutsChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const confirmAction = useConfirm();
  const [newName, setNewName] = useState("");
  const [importCode, setImportCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<TopologyLayout | null>(null);

  async function previewCode() {
    const code = importCode.trim();
    if (!code) return;
    setBusy(true);
    try {
      setPreview(await api.previewSharedTopologyLayout(accessToken, code));
    } catch (err) {
      setPreview(null);
      toast.error(err instanceof Error ? err.message : "No shared layout matches this code");
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrent(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (name === "__autosave__") {
      toast.error("That name is reserved");
      return;
    }
    setBusy(true);
    try {
      const current = getCurrentLayout();
      await api.saveTopologyLayout(accessToken, { name, ...current });
      setNewName("");
      await onLayoutsChanged();
      toast.success(`Layout "${name}" saved`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save layout");
    } finally {
      setBusy(false);
    }
  }

  async function importFromCode(event: FormEvent) {
    event.preventDefault();
    const code = importCode.trim();
    if (!code) return;
    setBusy(true);
    try {
      const imported = await api.importTopologyLayout(accessToken, code);
      setImportCode("");
      setPreview(null);
      await onLayoutsChanged();
      toast.success(`Layout "${imported.name}" imported`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import layout");
    } finally {
      setBusy(false);
    }
  }

  async function shareLayout(layout: TopologyLayout) {
    setBusy(true);
    try {
      await api.shareTopologyLayout(accessToken, layout.id);
      await onLayoutsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to share layout");
    } finally {
      setBusy(false);
    }
  }

  async function revokeShare(layout: TopologyLayout) {
    const confirmed = await confirmAction({
      title: "Stop sharing this layout?",
      message: `The share code for "${layout.name}" will stop working immediately.`,
      detail: "Layouts other users already imported are their own copies and are not affected.",
      confirmLabel: "Stop sharing",
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.revokeTopologyLayoutShare(accessToken, layout.id);
      await onLayoutsChanged();
      toast.success("Share code revoked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke share code");
    } finally {
      setBusy(false);
    }
  }

  async function copyShareCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Share code copied to clipboard");
    } catch {
      toast.error("Could not copy — select and copy the code manually");
    }
  }

  async function deleteLayout(layout: TopologyLayout) {
    const confirmed = await confirmAction({
      title: "Delete this layout?",
      message: `"${layout.name}" will be permanently removed.`,
      detail: layout.share_code ? "Its share code will stop working as well." : undefined,
      confirmLabel: "Delete layout",
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.deleteTopologyLayout(accessToken, layout.id);
      await onLayoutsChanged();
      toast.success("Layout deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete layout");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Saved layouts" onCancel={onClose} size="lg">
      <div className="modal-body layouts-modal-body">
        <form className="modal-form" onSubmit={(e) => void saveCurrent(e)}>
          <label>
            Save current layout as
            <input
              maxLength={80}
              placeholder="e.g. Rack overview"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <div className="modal-actions modal-actions--plain">
            <button type="submit" className="nm-btn nm-btn--primary" disabled={busy || !newName.trim()}>
              Save
            </button>
          </div>
        </form>

        <form className="modal-form" onSubmit={(e) => void importFromCode(e)}>
          <label>
            Import a shared layout
            <input
              maxLength={24}
              placeholder="Enter share code"
              value={importCode}
              onChange={(e) => setImportCode(e.target.value)}
            />
          </label>
          <div className="modal-actions modal-actions--plain">
            <button type="button" className="nm-btn nm-btn--secondary" disabled={busy || !importCode.trim()} onClick={() => void previewCode()}>
              Preview
            </button>
            <button type="submit" className="nm-btn nm-btn--secondary" disabled={busy || !importCode.trim()}>
              Import
            </button>
          </div>
        </form>
        {preview && (
          <div className="layout-preview">
            <div className="layout-preview-meta">
              <strong>{preview.name}</strong>
              <span>{Object.keys(preview.positions).length} placed nodes · updated {new Date(preview.updated_at).toLocaleDateString()}</span>
            </div>
            <LayoutDotPlot positions={preview.positions} />
          </div>
        )}

        {layouts.length === 0
          ? <p className="auth-field-hint">No saved layouts yet. Arrange the map, then save it under a name above.</p>
          : (
            <div className="nm-table-wrap">
              <table className="nm-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Updated</th>
                    <th>Share code</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {layouts.map((layout) => (
                    <tr key={layout.id}>
                      <td>{layout.name}</td>
                      <td>{new Date(layout.updated_at).toLocaleDateString()}</td>
                      <td>
                        {layout.share_code
                          ? (
                            <button
                              type="button"
                              className="nm-btn nm-btn--sm nm-btn--ghost nm-table-mono"
                              title="Copy share code"
                              onClick={() => void copyShareCode(layout.share_code as string)}
                            >
                              {layout.share_code}
                            </button>
                          )
                          : <span className="dash-dim">not shared</span>}
                      </td>
                      <td className="nm-table-actions">
                        <button type="button" className="nm-btn nm-btn--sm" disabled={busy} onClick={() => onLoad(layout)}>
                          Load
                        </button>
                        {layout.share_code
                          ? (
                            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={() => void revokeShare(layout)}>
                              Unshare
                            </button>
                          )
                          : (
                            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={() => void shareLayout(layout)}>
                              Share
                            </button>
                          )}
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={busy} onClick={() => void deleteLayout(layout)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        <p className="auth-field-hint">
          Sharing generates a code others can use to import a copy of your layout. Copies are independent —
          later changes to your layout are not synced to importers.
        </p>
      </div>
    </Modal>
  );
}

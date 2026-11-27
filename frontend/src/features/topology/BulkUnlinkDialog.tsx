import { useState, type FormEvent } from "react";
import { TriangleAlert } from "lucide-react";
import { Modal } from "../../components/Modal";
import type { UnlinkScope } from "./bulkUnlink";

const plural = (n: number) => `${n} link${n === 1 ? "" : "s"}`;

export function BulkUnlinkDialog({
  deviceCount,
  betweenCount,
  touchingCount,
  busy,
  onScopeChange,
  onConfirm,
  onCancel,
}: {
  deviceCount: number;
  betweenCount: number;
  touchingCount: number;
  busy: boolean;
  onScopeChange: (scope: UnlinkScope) => void;
  onConfirm: (scope: UnlinkScope) => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState<UnlinkScope>(betweenCount > 0 ? "between" : "touching");
  const count = scope === "between" ? betweenCount : touchingCount;

  function choose(next: UnlinkScope) {
    setScope(next);
    onScopeChange(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (count > 0 && !busy) onConfirm(scope);
  }

  return (
    <Modal
      size="sm"
      title="Remove links"
      onCancel={onCancel}
      modalClassName="nm-confirm-modal"
      titleIcon={<span className="nm-confirm-title-icon" aria-hidden="true"><TriangleAlert size={18} /></span>}
    >
      <form className="nm-confirm-body" onSubmit={submit}>
        <div className="nm-confirm-message-row">
          <div className="nm-confirm-copy">
            <p className="nm-confirm-message">Remove links from the {deviceCount} selected devices?</p>
            <p className="nm-confirm-detail">The devices themselves are not affected. You can undo this straight after.</p>
          </div>
        </div>
        <fieldset className="topo-unlink-scope" aria-label="Which links">
          <label className="tool-form-inline-check">
            <input type="radio" name="unlink-scope" checked={scope === "between"} disabled={betweenCount === 0} onChange={() => choose("between")} />
            <span>Only links between these devices <b>({betweenCount})</b></span>
          </label>
          <label className="tool-form-inline-check">
            <input type="radio" name="unlink-scope" checked={scope === "touching"} onChange={() => choose("touching")} />
            <span>Every link to or from these devices <b>({touchingCount})</b></span>
          </label>
        </fieldset>
        <div className="nm-confirm-actions">
          <button type="button" className="nm-btn" onClick={onCancel} autoFocus>Cancel</button>
          <button type="submit" className="nm-btn nm-btn--danger" disabled={count === 0 || busy}>
            {busy ? "Removing…" : `Remove ${plural(count)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

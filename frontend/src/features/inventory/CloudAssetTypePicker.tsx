import { useId, useState } from "react";
import { api, type CloudAssetType } from "../../api/client";
import { PickOrCreate } from "../../components/PickOrCreate";

export function CloudAssetTypePicker({ accessToken, value, types, disabled = false, onChange, onTypeCreated, onEditingChange, onBusyChange }: {
  accessToken: string; value: string | null; types: CloudAssetType[]; disabled?: boolean;
  onChange: (value: string | null) => void; onTypeCreated: (type: CloudAssetType) => void;
  onEditingChange: (editing: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = types.map((type, index) => ({ id: type.id ?? -(index + 1), label: type.label, value: type.value }));
  function close() { setAdding(false); setLabel(""); setError(null); onEditingChange(false); }
  async function create() {
    if (busy || !label.trim()) return;
    setBusy(true); onBusyChange(true); setError(null);
    try {
      const type = await api.createCloudAssetType(accessToken, label.trim());
      onTypeCreated(type); onChange(type.value); close();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to add type"); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <div className="inventory-cloud-type-picker">
    <PickOrCreate ariaLabel="Type" value={options.find(option => option.value === value)?.id ?? null}
      options={options} emptyLabel="Not set" createLabel="Add type…" disabled={disabled || busy || adding}
      onChange={id => onChange(options.find(option => option.id === id)?.value ?? null)}
      onCreateRequested={() => { setAdding(true); onEditingChange(true); }} />
    {adding && <div className="inventory-cloud-type-create" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) close(); }
    }}>
      <label htmlFor={id}>New type name</label>
      <input id={id} autoFocus className="nm-input" maxLength={80} value={label} disabled={busy}
        onChange={event => setLabel(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void create(); }
        }} />
      {error && <span className="form-error" role="alert">{error}</span>}
      <div className="inventory-cloud-type-actions">
        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={close}>Cancel type</button>
        <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy || !label.trim()} onClick={() => void create()}>{busy ? "Adding…" : "Add type"}</button>
      </div>
    </div>}
  </div>;
}

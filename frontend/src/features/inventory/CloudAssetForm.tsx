import { useId, useState, type FormEvent } from "react";
import { Cloud } from "lucide-react";
import { api, type CloudAssetType, type CloudProviderOption, type Device, type SavedCloudAsset } from "../../api/client";
import { Modal } from "../../components/Modal";
import { PickOrCreate } from "../../components/PickOrCreate";
import { deviceLabel } from "../../utils/format";
import { CloudAssetTypePicker } from "./CloudAssetTypePicker";

export function CloudAssetForm({ accessToken, providers, devices, types, onTypeCreated, onCreated, onCancel }: {
  types: CloudAssetType[]; onTypeCreated: (type: CloudAssetType) => void;
  accessToken: string; providers: CloudProviderOption[]; devices: Device[];
  onCreated: (asset: SavedCloudAsset) => void; onCancel: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [addingType, setAddingType] = useState(false);
  const [provider, setProvider] = useState("");
  const [account, setAccount] = useState("");
  const [region, setRegion] = useState("");
  const [description, setDescription] = useState("");
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || addingType) return;
    if (!name.trim()) { setError("Enter an asset name"); return; }
    setBusy(true);
    setError(null);
    try {
      const asset = await api.createSavedCloudAsset(accessToken, {
        name: name.trim(), kind: kind || null, provider_id: provider ? Number(provider) : null,
        account: account.trim() || null, region: region.trim() || null,
        description: description.trim() || null, device_id: deviceId,
      });
      onCreated(asset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add cloud asset");
      setBusy(false);
    }
  }
  return <Modal title="Add cloud asset" titleIcon={<Cloud size={18} />} onCancel={onCancel} dismissible={!busy}
    footer={<>
      <button type="button" className="nm-btn nm-btn--secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" form={formId} className="nm-btn nm-btn--primary" disabled={busy || addingType || !name.trim()}>{busy ? "Adding…" : "Add asset"}</button>
    </>}>
    <form id={formId} className="modal-form" onSubmit={event => void submit(event)}>
      <div className="nm-form-row">
        <label className="nm-field">Name<input className="nm-input" autoFocus required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <div className="inventory-cloud-device-field"><label>Type</label><CloudAssetTypePicker accessToken={accessToken} value={kind} types={types}
          disabled={busy} onChange={setKind} onTypeCreated={onTypeCreated} onEditingChange={setAddingType} onBusyChange={setBusy} /></div>
      </div>
      <label className="nm-field">Provider<select className="nm-select" aria-label="Provider" value={provider} disabled={busy} onChange={event => setProvider(event.target.value)}>
        <option value="">Unassigned</option>{providers.filter(item => item.id != null).map(item => <option key={item.id} value={item.id ?? ""}>{item.name}</option>)}
      </select></label>
      <div className="inventory-cloud-device-field"><label htmlFor={`${formId}-device`}>Inventory device</label><PickOrCreate id={`${formId}-device`} ariaLabel="Inventory device" value={deviceId} disabled={busy}
        emptyLabel="Not linked" createLabel="Create device…" onChange={setDeviceId}
        options={devices.map(device => ({ id: device.id, label: deviceLabel(device), group: device.ip_address }))} />
      </div>
      <div className="nm-form-row">
        <label className="nm-field">Account<input className="nm-input" maxLength={120} value={account} disabled={busy} onChange={event => setAccount(event.target.value)} /></label>
        <label className="nm-field">Region<input className="nm-input" maxLength={120} value={region} disabled={busy} onChange={event => setRegion(event.target.value)} /></label>
      </div>
      <label className="nm-field">Description<textarea className="nm-input" rows={3} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></label>
      {error && <div className="form-error" role="alert">{error}</div>}
    </form>
  </Modal>;
}

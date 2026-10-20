import { Fragment, useState, type ReactNode } from "react";
import { Activity, Cloud, FileText, Globe, Link2, MapPin, Network, Pencil, Server, Tag, UserRound, type LucideIcon } from "lucide-react";
import type { DeviceHealth } from "../../utils/deviceHealth";
import { api, type Device, type DevicePayload, type ExternalIpAddress, type ExternalIpAddressPayload, type ExternalLocation, type ExternalProviderAccount, type CloudProviderOption, type SavedCloudAsset, type Site, type SnmpProfile, type TopologyGroup } from "../../api/client";
import { deviceLabel } from "../../utils/format";
import { PickOrCreate } from "../../components/PickOrCreate";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { DeviceForm } from "../devices/DeviceForm";
import { createDeviceWithReservationConfirmation } from "../devices/createDevice";
import { InventoryDetailsPanel } from "./InventoryDetailsPanel";

export type CloudAssetRecord = { type: "address"; value: ExternalIpAddress } | { type: "resource"; value: SavedCloudAsset };
export type CloudDeviceFormOptions = { deviceTypes: Parameters<typeof DeviceForm>[0]["deviceTypes"]; groups: TopologyGroup[]; snmpProfiles: SnmpProfile[]; sites: Site[] };
type Choice = { value: string; label: string };
type Field = { label: string; value: string; node?: ReactNode; choices?: Choice[]; multiline?: boolean; required?: boolean; device?: boolean; save?: (value: string) => Promise<void> };
const fieldIcons: Record<string, LucideIcon> = {"Inventory device":Server,Monitoring:Activity,"IP address":Network,Purpose:FileText,"Address state":Tag,Location:MapPin,Provider:Globe,Account:UserRound,Owner:UserRound,Tags:Tag,Notes:FileText,URL:Link2,Name:Pencil,Kind:Server,Region:MapPin,Description:FileText};
function FieldIcon({label}:{label:string}) { const Icon=fieldIcons[label] || Pencil; return <Icon size={12} />; }
const nullable = (value: string) => value.trim() || null;
const kinds = ["ec2", "vm", "load_balancer", "nat_gateway", "k8s_ingress", "database", "storage", "cdn", "other"];
const splitTags = (tags: string | null) => (tags ?? "").split(",").map(tag => tag.trim()).filter(Boolean);

/** Cloud metadata stays editable even when the record is linked to a real device. */
export function CloudAssetDetails({ record, name, canWrite, canCreateDevice, accessToken, devices, providers, locations, accounts,
  deviceDetails, deviceFormOptions, externalIpAction, health, monitoring, onClose, onAddressChange, onResourceChange, onLinkChange, onDeviceCreated }: {
  health: DeviceHealth; monitoring: string; record: CloudAssetRecord; name: string; canWrite: boolean; canCreateDevice: boolean; accessToken: string;
  devices: Device[]; providers: CloudProviderOption[]; locations: ExternalLocation[]; accounts: ExternalProviderAccount[];
  deviceDetails: ReactNode; deviceFormOptions: CloudDeviceFormOptions; externalIpAction: ReactNode; onClose: () => void;
  onAddressChange: (value: ExternalIpAddress) => void; onResourceChange: (value: SavedCloudAsset) => void;
  onLinkChange: (id: number | null) => void; onDeviceCreated: (device: Device) => void;
}) {
  const confirmAction = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDevice, setShowDevice] = useState(false);
  const [deviceSeed, setDeviceSeed] = useState<Partial<Device> | null>(null);
  const [createdDevice, setCreatedDevice] = useState<Device | null>(null);
  const fields: Field[] = [];
  const deviceId = record.value.device_id;
  const device = devices.find(row => row.id === deviceId);
  const canCreate = canWrite && canCreateDevice;
  async function addressPatch(patch: Partial<ExternalIpAddressPayload>) {
    if (record.type !== "address") return;
    onAddressChange(await api.updateExternalAddress(accessToken, record.value.id, patch));
  }
  async function resourcePatch(patch: Partial<Omit<SavedCloudAsset, "id">>) {
    if (record.type !== "resource") return;
    onResourceChange(await api.updateSavedCloudAsset(accessToken, record.value.id, patch));
  }
  async function link(id: number | null) {
    if (record.type === "address") await addressPatch({device_id:id}); else await resourcePatch({device_id:id});
    onLinkChange(id);
  }
  if (record.type === "address") {
    const row = record.value;
    const location = locations.find(item => item.id === row.location_id);
    const account = accounts.find(item => item.id === location?.account_id);
    fields.push(
      { label: "IP address", value: row.ip_address, required: true, save: value => addressPatch({ip_address:value}) },
      { label: "Purpose", value: row.label || "", save: value => addressPatch({label:nullable(value)}) },
      { label: "Address state", value: row.status, choices:[{value:"in_use",label:"In use"},{value:"reserved",label:"Reserved"},{value:"available",label:"Available"}], save:value => addressPatch({status:value as ExternalIpAddress["status"]}) },
      { label: "Location", value: row.location_id?.toString() || "", choices:[{value:"",label:"Unassigned"},...locations.map(item => ({value:String(item.id),label:[item.name,item.region,accounts.find(account=>account.id===item.account_id)?.name].filter(Boolean).join(" · ")}))], save:value => addressPatch({location_id:value ? Number(value) : null}) },
      { label: "Provider", value: providers.find(item=>item.id===account?.provider_id)?.name || "" },
      { label: "Account", value: account?.name || "" },
      { label: "Owner", value: row.owner || "", save:value=>addressPatch({owner:nullable(value)}) },
      { label: "Tags", value: row.tags || "", save:value=>addressPatch({tags:nullable(value)}) },
      { label: "Notes", value: row.notes || "", multiline:true, save:value=>addressPatch({notes:nullable(value)}) },
      { label: "URL", value: row.url || "", save:value=>addressPatch({url:nullable(value)}) },
    );
  } else {
    const row = record.value;
    const kindChoices = [...new Set([...kinds,...(row.kind ? [row.kind] : [])])];
    fields.push(
      {label:"Name",value:row.name,required:true,save:value=>resourcePatch({name:value})},
      {label:"Kind",value:row.kind || "",choices:[{value:"",label:"Not set"},...kindChoices.map(value=>({value,label:value.replace(/_/g," ")}))],save:value=>resourcePatch({kind:nullable(value)})},
      {label:"Provider",value:row.provider_id?.toString() || "",choices:[{value:"",label:"Unassigned"},...providers.map(item=>({value:String(item.id),label:item.name}))],save:value=>resourcePatch({provider_id:value ? Number(value) : null})},
      {label:"Account",value:row.account || "",save:value=>resourcePatch({account:nullable(value)})},
      {label:"Region",value:row.region || "",save:value=>resourcePatch({region:nullable(value)})},
      {label:"Description",value:row.description || "",multiline:true,save:value=>resourcePatch({description:nullable(value)})},
    );
  }
  const deviceOptions = [...devices.map(row=>({id:row.id,label:`${deviceLabel(row)} · ${row.ip_address || "No address"}`})),...(deviceId !== null && !device ? [{id:deviceId,label:"Linked device unavailable"}] : [])];
  const context: Field[] = [
    {label:"Inventory device",value:deviceId?.toString() || "",device:true,save:value=>link(value ? Number(value) : null)},
    {label:"Monitoring",value:monitoring},
  ];
  fields.unshift(...context);
  const current = fields.find(field => field.label === editing);
  function start(field: Field) {
    if (!canWrite || busy || !field.save) return;
    setEditing(field.label); setDraft(field.value); setError(null);
  }
  async function save() {
    if (!current?.save || busy || !canWrite) return;
    if (current.required && !draft.trim()) { setError(`Enter ${current.label.toLowerCase()}`); return; }
    setBusy(true); setError(null);
    try { await current.save(draft.trim()); setEditing(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to save this field"); }
    finally { setBusy(false); }
  }
  async function unlink() {
    if (!canWrite || busy) return;
    setBusy(true);
    try { await link(null); }
    catch (err) { toast.error(err instanceof Error ? err.message : "Unable to unlink this device"); }
    finally { setBusy(false); }
  }
  function startCreate() {
    if (!canCreate || busy) return;
    setEditing(null); setError(null); setCreatedDevice(null);
    setDeviceSeed(record.type === "address"
      ? { display_name: record.value.label, hostname: null, ip_address: record.value.ip_address, tags: splitTags(record.value.tags), notes: record.value.notes, monitoring_paused: false }
      : { display_name: record.value.name, hostname: null, notes: record.value.description, monitoring_paused: false });
  }
  async function createAndLink(payload: DevicePayload) {
    if (!canCreate) return;
    setBusy(true);
    try {
      let target = createdDevice;
      if (!target) {
        const existing = devices.find(row => row.ip_address && row.ip_address.toLowerCase() === payload.ip_address?.trim().toLowerCase());
        if (existing && await confirmAction({ title: "Link existing Inventory device?", message: `${deviceLabel(existing)} already uses this address.`, confirmLabel: "Link device" })) target = existing;
        else if (existing) return;
      }
      if (!target) {
        const created = await createDeviceWithReservationConfirmation(accessToken, payload, confirmAction);
        if (!created) return;
        target = created;
        setCreatedDevice(created);
        onDeviceCreated(created);
      }
      await link(target.id);
      setDeviceSeed(null); setCreatedDevice(null);
      toast.success("Device linked in Inventory and Monitoring", { detail: deviceLabel(target) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to add this asset to Inventory");
    } finally { setBusy(false); }
  }
  function renderEditor(field: Field) {
    if (field.device) return <PickOrCreate ariaLabel="Inventory device" value={draft ? Number(draft) : null} options={deviceOptions} emptyLabel="Not linked"
      createLabel="Create device…" disabled={busy} onChange={id => setDraft(id === null ? "" : String(id))} onCreateRequested={canCreate ? startCreate : undefined} />;
    if (field.choices) return <select autoFocus className="details-inline-input" aria-label={`Edit ${field.label}`} disabled={busy} value={draft} onChange={event=>setDraft(event.target.value)}>{field.choices.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>;
    if (field.multiline) return <textarea autoFocus className="details-inline-input" rows={4} aria-label={`Edit ${field.label}`} disabled={busy} value={draft} onChange={event=>setDraft(event.target.value)} />;
    return <input autoFocus className="details-inline-input" aria-label={`Edit ${field.label}`} disabled={busy} value={draft} onChange={event=>setDraft(event.target.value)} />;
  }
  function display(field: Field) {
    if (field.node) return field.node;
    if (field.device) return deviceOptions.find(option => String(option.id) === field.value)?.label || "Not linked";
    return field.choices?.find(choice=>choice.value===field.value)?.label || field.value || "Not set";
  }
  return <><InventoryDetailsPanel title={showDevice ? "Device overview" : "Asset overview"} icon={<Cloud size={17} />} onClose={onClose}>
    {showDevice ? <>
      <div className="detail-actions detail-actions--device"><button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={()=>setShowDevice(false)}>Back to asset</button></div>
      {deviceDetails}
    </> : <>
      <div className="details-heading"><span className={`status-dot ${health}`} /><div className="details-heading-body"><div className="details-heading-title-row"><h3>{name}</h3></div></div></div>
      <div className="device-detail-tabs"><button type="button" className="device-detail-tab active">Details</button></div>
      <dl>{fields.map(field=><Fragment key={field.label}>
        <dt><span className="details-field-icon"><FieldIcon label={field.label} /></span>{field.label}</dt>
        <dd className={canWrite && field.save && editing !== field.label ? "editable-dd" : undefined} onDoubleClick={()=>start(field)}>{editing===field.label ? <form className="cloud-asset-field-edit" onSubmit={event=>{event.preventDefault(); void save();}} onKeyDown={event=>{if(event.key==="Escape" && !busy){event.stopPropagation(); setEditing(null); setError(null);}}}>
          {renderEditor(field)}
          {error && <span className="form-error" role="alert">{error}</span>}
          <div className="detail-actions detail-actions--device"><button type="submit" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy || draft===field.value}>{busy ? "Saving…" : "Save"}</button><button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={()=>{setEditing(null);setError(null);}}>Cancel</button></div>
        </form> : <span className="cloud-asset-field-value"><span>{display(field)}</span>{canWrite && field.save && <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost nm-btn--icon" aria-label={`Edit ${field.label}`} title={`Edit ${field.label}`} disabled={busy} onClick={()=>start(field)}><Pencil size={12} /></button>}</span>}</dd>
      </Fragment>)}</dl>
      <div className="detail-actions detail-actions--device">
        {device && deviceDetails && <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={()=>setShowDevice(true)}>Open linked device</button>}
        {canWrite && deviceId === null && canCreate && <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy} onClick={startCreate}>Add to Inventory</button>}
        {canWrite && deviceId === null && <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={()=>start(fields[0])}>Link device</button>}
      </div>
      {((canWrite && deviceId !== null) || record.type === "address") && <div className="detail-actions detail-actions--device">
        {canWrite && deviceId !== null && <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={()=>void unlink()}>Unlink device</button>}
        {record.type === "address" && externalIpAction}
      </div>}
    </>}
  </InventoryDetailsPanel>
    {deviceSeed && <DeviceForm busy={busy} title={createdDevice ? "Device created — link cloud asset" : "Add device"} submitLabel={createdDevice ? "Retry link" : undefined}
      device={null} cloneSource={null} initialValues={deviceSeed} deviceTypes={deviceFormOptions.deviceTypes} groups={deviceFormOptions.groups}
      snmpProfiles={deviceFormOptions.snmpProfiles} sites={deviceFormOptions.sites}
      onCancel={()=>{setDeviceSeed(null);setCreatedDevice(null);}} onSubmit={createAndLink} />}
  </>;
}

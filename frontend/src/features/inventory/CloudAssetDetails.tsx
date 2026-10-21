import { Fragment, useId, useState, type ReactNode } from "react";
import {
  Activity,
  Clock,
  Cloud,
  FileText,
  Gauge,
  Globe,
  Link2,
  MapPin,
  Network,
  Pencil,
  Server,
  Tag,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { DeviceHealth } from "../../utils/deviceHealth";
import {
  api,
  type CloudAssetType,
  type CloudProviderOption,
  type Device,
  type DevicePayload,
  type ExternalIpAddress,
  type ExternalIpAddressPayload,
  type ExternalLocation,
  type ExternalProviderAccount,
  type SavedCloudAsset,
  type Site,
  type SnmpProfile,
  type TopologyGroup,
} from "../../api/client";
import { deviceLabel, formatEventTime } from "../../utils/format";
import { Modal } from "../../components/Modal";
import { PickOrCreate } from "../../components/PickOrCreate";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { DeviceForm } from "../devices/DeviceForm";
import { createDeviceWithReservationConfirmation } from "../devices/createDevice";
import { editableField, useEditableFieldFocus } from "../../utils/editableField";
import { sameIp } from "../../utils/ipParse";
import { CloudAssetTypePicker } from "./CloudAssetTypePicker";
import { InventoryDetailsPanel } from "./InventoryDetailsPanel";

export type CloudAssetRecord =
  | { type: "address"; value: ExternalIpAddress }
  | { type: "resource"; value: SavedCloudAsset };

export type CloudDeviceFormOptions = {
  deviceTypes: Parameters<typeof DeviceForm>[0]["deviceTypes"];
  groups: TopologyGroup[];
  snmpProfiles: SnmpProfile[];
  sites: Site[];
};

type Choice = { value: string; label: string };

type Field = {
  label: string;
  value: string;
  node?: ReactNode;
  choices?: Choice[];
  multiline?: boolean;
  required?: boolean;
  device?: boolean;
  assetType?: boolean;
  save?: (value: string) => Promise<void>;
};

const fieldIcons: Record<string, LucideIcon> = {
  "Inventory device": Server,
  Monitoring: Activity,
  Latency: Gauge,
  "Last checked": Clock,
  "IP address": Network,
  Purpose: FileText,
  "Address state": Tag,
  Location: MapPin,
  Provider: Globe,
  Account: UserRound,
  Owner: UserRound,
  Tags: Tag,
  Notes: FileText,
  URL: Link2,
  Name: Pencil,
  Type: Server,
  Region: MapPin,
  Description: FileText,
};

const addressStates: Choice[] = [
  { value: "in_use", label: "In use" },
  { value: "reserved", label: "Reserved" },
  { value: "available", label: "Available" },
];

function FieldIcon({ label }: { label: string }) {
  const Icon = fieldIcons[label] || Pencil;
  return <Icon size={12} />;
}

const nullable = (value: string) => value.trim() || null;
const splitTags = (tags: string | null) => (tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);

/** Cloud metadata stays editable even when the record is linked to a real device. */
export function CloudAssetDetails({
  record,
  types,
  onTypeCreated,
  name,
  canWrite,
  canCreateDevice,
  accessToken,
  devices,
  providers,
  locations,
  accounts,
  deviceDetails,
  deviceFormOptions,
  externalIpAction,
  health,
  monitoring,
  latency,
  onClose,
  onAddressChange,
  onResourceChange,
  onLinkChange,
  onDeviceCreated,
  onShowInDevices,
}: {
  record: CloudAssetRecord;
  types: CloudAssetType[];
  onTypeCreated: (type: CloudAssetType) => void;
  name: string;
  canWrite: boolean;
  canCreateDevice: boolean;
  accessToken: string;
  devices: Device[];
  providers: CloudProviderOption[];
  locations: ExternalLocation[];
  accounts: ExternalProviderAccount[];
  deviceDetails: ReactNode;
  deviceFormOptions: CloudDeviceFormOptions;
  externalIpAction: ReactNode;
  health: DeviceHealth;
  monitoring: string;
  latency: string | null;
  onClose: () => void;
  onAddressChange: (value: ExternalIpAddress) => void;
  onResourceChange: (value: SavedCloudAsset) => void;
  onLinkChange: (id: number | null) => void;
  onDeviceCreated: (device: Device) => void;
  onShowInDevices: (id: number) => void;
}) {
  const confirmAction = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [addingType, setAddingType] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDevice, setShowDevice] = useState(false);
  const [deviceSeed, setDeviceSeed] = useState<Partial<Device> | null>(null);
  const [failedLink, setFailedLink] = useState<Device | null>(null);
  const { listRef, focusEditor } = useEditableFieldFocus(editing);
  const hintId = useId();

  const deviceId = record.value.device_id;
  const device = devices.find((row) => row.id === deviceId);
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
    if (record.type === "address") await addressPatch({ device_id: id });
    else await resourcePatch({ device_id: id });
    onLinkChange(id);
  }

  const deviceOptions = [
    ...devices.map((row) => ({ id: row.id, label: `${deviceLabel(row)} · ${row.ip_address || "No address"}` })),
    ...(deviceId !== null && !device ? [{ id: deviceId, label: "Linked device unavailable" }] : []),
  ];

  const fields: Field[] = [
    {
      label: "Inventory device",
      value: deviceId?.toString() || "",
      device: true,
      save: (value) => link(value ? Number(value) : null),
    },
    {
      label: "Monitoring",
      value: monitoring,
      node: deviceId !== null
        ? <span className={`status-pill ${health}`} title={monitoring}><span className="status-pill-text">{monitoring}</span></span>
        : undefined,
    },
  ];
  if (device) {
    fields.push(
      { label: "Latency", value: latency || "—" },
      { label: "Last checked", value: device.last_monitored_at ? formatEventTime(device.last_monitored_at) : "Never" },
    );
  }

  if (record.type === "address") {
    const row = record.value;
    const location = locations.find((item) => item.id === row.location_id);
    const account = accounts.find((item) => item.id === location?.account_id);
    const locationChoices: Choice[] = [
      { value: "", label: "Unassigned" },
      ...locations.map((item) => ({
        value: String(item.id),
        label: [item.name, item.region, accounts.find((candidate) => candidate.id === item.account_id)?.name].filter(Boolean).join(" · "),
      })),
    ];
    fields.push(
      { label: "IP address", value: row.ip_address, required: true, save: (value) => addressPatch({ ip_address: value }) },
      { label: "Purpose", value: row.label || "", save: (value) => addressPatch({ label: nullable(value) }) },
      {
        label: "Address state",
        value: row.status,
        choices: addressStates,
        save: (value) => addressPatch({ status: value as ExternalIpAddress["status"] }),
      },
      {
        label: "Location",
        value: row.location_id?.toString() || "",
        choices: locationChoices,
        save: (value) => addressPatch({ location_id: value ? Number(value) : null }),
      },
      { label: "Provider", value: providers.find((item) => item.id === account?.provider_id)?.name || "" },
      { label: "Account", value: account?.name || "" },
      { label: "Owner", value: row.owner || "", save: (value) => addressPatch({ owner: nullable(value) }) },
      { label: "Tags", value: row.tags || "", save: (value) => addressPatch({ tags: nullable(value) }) },
      { label: "Notes", value: row.notes || "", multiline: true, save: (value) => addressPatch({ notes: nullable(value) }) },
      { label: "URL", value: row.url || "", save: (value) => addressPatch({ url: nullable(value) }) },
    );
  } else {
    const row = record.value;
    fields.push(
      { label: "Name", value: row.name, required: true, save: (value) => resourcePatch({ name: value }) },
      {
        label: "Type",
        assetType: true,
        value: row.kind || "",
        choices: [{ value: "", label: "Not set" }, ...types.map(type => ({ value: type.value, label: type.label }))],
        save: (value) => resourcePatch({ kind: nullable(value) }),
      },
      {
        label: "Provider",
        value: row.provider_id?.toString() || "",
        choices: [{ value: "", label: "Unassigned" }, ...providers.map((item) => ({ value: String(item.id), label: item.name }))],
        save: (value) => resourcePatch({ provider_id: value ? Number(value) : null }),
      },
      { label: "Account", value: row.account || "", save: (value) => resourcePatch({ account: nullable(value) }) },
      { label: "Region", value: row.region || "", save: (value) => resourcePatch({ region: nullable(value) }) },
      {
        label: "Description",
        value: row.description || "",
        multiline: true,
        save: (value) => resourcePatch({ description: nullable(value) }),
      },
    );
  }

  const current = fields.find((field) => field.label === editing);

  function start(field: Field) {
    if (!canWrite || busy || !field.save) return;
    if (editing === field.label || hasDirtyDraft()) {
      focusEditor();
      return;
    }
    setEditing(field.label);
    setDraft(field.value);
    setError(null);
  }

  function hasDirtyDraft() {
    return Boolean(current && draft !== current.value);
  }

  function stopEditing() {
    setEditing(null);
    setAddingType(false);
    setError(null);
  }

  async function save() {
    if (!current?.save || busy || addingType || !canWrite) return;
    if (current.required && !draft.trim()) {
      setError(`Enter ${current.label.toLowerCase()}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await current.save(draft.trim());
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save this field");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!canWrite || busy) return;
    setBusy(true);
    try {
      await link(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to unlink this device");
    } finally {
      setBusy(false);
    }
  }

  function startCreate(fromEditor = false) {
    if (!canCreate || busy) return;
    if (!fromEditor && hasDirtyDraft()) {
      focusEditor();
      return;
    }
    stopEditing();
    setFailedLink(null);
    setDeviceSeed(record.type === "address"
      ? {
          display_name: record.value.label,
          hostname: null,
          ip_address: record.value.ip_address,
          tags: splitTags(record.value.tags),
          notes: record.value.notes,
          monitoring_paused: false,
        }
      : { display_name: record.value.name, hostname: null, notes: record.value.description, monitoring_paused: false });
  }

  async function createAndLink(payload: DevicePayload | null) {
    if (!canCreate) return;
    setBusy(true);
    let created: Device | null = null;
    try {
      let target = failedLink;
      if (!target && payload) {
        const existing = devices.find((row) => sameIp(row.ip_address, payload.ip_address));
        if (existing && await confirmAction({
          title: "Link existing Inventory device?",
          message: `${deviceLabel(existing)} already uses this address.`,
          confirmLabel: "Link device",
        })) {
          target = existing;
        } else if (existing) {
          return;
        }
      }
      if (!target && payload) {
        created = await createDeviceWithReservationConfirmation(accessToken, payload, confirmAction);
        if (!created) return;
        target = created;
        onDeviceCreated(created);
      }
      if (!target) return;
      await link(target.id);
      setDeviceSeed(null);
      setFailedLink(null);
      toast.success("Device linked in Inventory and Monitoring", { detail: deviceLabel(target) });
    } catch (err) {
      if (created) setFailedLink(created);
      toast.error(err instanceof Error ? err.message : "Unable to add this asset to Inventory");
    } finally {
      setBusy(false);
    }
  }

  function renderEditor(field: Field) {
    if (field.assetType) return <CloudAssetTypePicker accessToken={accessToken} value={draft || null} types={types} disabled={busy}
      onChange={value => setDraft(value || "")} onTypeCreated={onTypeCreated} onEditingChange={setAddingType} onBusyChange={setBusy} />;
    if (field.device) {
      return (
        <PickOrCreate
          ariaLabel="Inventory device"
          value={draft ? Number(draft) : null}
          options={deviceOptions}
          emptyLabel="Not linked"
          createLabel="Create device…"
          disabled={busy}
          onChange={(id) => setDraft(id === null ? "" : String(id))}
          onCreateRequested={canCreate ? () => startCreate(true) : undefined}
        />
      );
    }
    const common = {
      autoFocus: true,
      className: "details-inline-input",
      "aria-label": `Edit ${field.label}`,
      disabled: busy,
      value: draft,
    };
    if (field.choices) {
      return (
        <select {...common} onChange={(event) => setDraft(event.target.value)}>
          {field.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      );
    }
    if (field.multiline) return <textarea {...common} rows={4} onChange={(event) => setDraft(event.target.value)} />;
    return <input {...common} onChange={(event) => setDraft(event.target.value)} />;
  }

  function display(field: Field) {
    if (field.node) return field.node;
    if (field.device) return deviceOptions.find((option) => String(option.id) === field.value)?.label || "Not linked";
    return field.choices?.find((choice) => choice.value === field.value)?.label || field.value || "Not set";
  }

  return (
    <>
      <InventoryDetailsPanel title={showDevice ? "Device overview" : "Asset overview"} icon={<Cloud size={17} />} onClose={onClose}>
        {showDevice ? (
          <>
            <div className="detail-actions detail-actions--device">
              <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => setShowDevice(false)}>Back to asset</button>
            </div>
            {deviceDetails}
          </>
        ) : (
          <>
            <div className="details-heading">
              <span className={`status-dot ${health}`} />
              <div className="details-heading-body">
                <div className="details-heading-title-row"><h3>{name}</h3></div>
              </div>
            </div>
            <div className="device-detail-tabs">
              <button type="button" className="device-detail-tab active">Details</button>
            </div>
            <dl ref={listRef}>
              {fields.map((field) => (
                <Fragment key={field.label}>
                  <dt><span className="details-field-icon"><FieldIcon label={field.label} /></span>{field.label}</dt>
                  <dd {...editableField(canWrite && Boolean(field.save) && !busy, () => start(field), field.label, hintId)}>
                    {editing === field.label ? (
                      <form
                        className="cloud-asset-field-edit"
                        onSubmit={(event) => { event.preventDefault(); void save(); }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape" && !busy) {
                            event.stopPropagation();
                            stopEditing();
                          }
                        }}
                      >
                        {renderEditor(field)}
                        {error && <span className="form-error" role="alert">{error}</span>}
                        <div className="detail-actions detail-actions--device">
                          <button type="submit" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy || addingType || draft === field.value}>
                            {busy ? "Saving…" : "Save"}
                          </button>
                          <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={stopEditing}>Cancel</button>
                        </div>
                      </form>
                    ) : display(field)}
                  </dd>
                </Fragment>
              ))}
            </dl>
            {(device || canWrite || record.type === "address") && (
              <div className="detail-actions detail-actions--device detail-actions--inline">
                {canWrite && deviceId === null && (
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={() => start(fields[0])}>Link device</button>
                )}
                {device && deviceDetails && (
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={() => setShowDevice(true)}>Open device</button>
                )}
                {device && (
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={() => onShowInDevices(device.id)}>Show in Devices</button>
                )}
                {canWrite && deviceId !== null && (
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy} onClick={() => void unlink()}>Unlink</button>
                )}
                {record.type === "address" && externalIpAction}
                {canWrite && deviceId === null && canCreate && (
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy} onClick={() => startCreate()}>Add to Inventory</button>
                )}
              </div>
            )}
            {canWrite && <p id={hintId} className="details-edit-hint">Double-click any field to edit</p>}
          </>
        )}
      </InventoryDetailsPanel>
      {deviceSeed && !failedLink && (
        <DeviceForm
          busy={busy}
          title="Add device"
          device={null}
          cloneSource={null}
          initialValues={deviceSeed}
          deviceTypes={deviceFormOptions.deviceTypes}
          groups={deviceFormOptions.groups}
          snmpProfiles={deviceFormOptions.snmpProfiles}
          sites={deviceFormOptions.sites}
          onCancel={() => setDeviceSeed(null)}
          onSubmit={createAndLink}
        />
      )}
      {deviceSeed && failedLink && (
        <Modal
          title="Link the created device"
          onCancel={() => { if (!busy) { setDeviceSeed(null); setFailedLink(null); } }}
          footer={(
            <>
              <button type="button" className="nm-btn" disabled={busy} onClick={() => { setDeviceSeed(null); setFailedLink(null); }}>Cancel</button>
              <button type="button" className="nm-btn nm-btn--primary" disabled={busy} onClick={() => void createAndLink(null)}>
                {busy ? "Linking…" : "Retry link"}
              </button>
            </>
          )}
        >
          <p>
            {deviceLabel(failedLink)} was added to Inventory, but linking it to {name} failed.
            Retry the link, or cancel to keep the device without this link.
          </p>
        </Modal>
      )}
    </>
  );
}

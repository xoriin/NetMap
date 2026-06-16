import { useState, type FormEvent } from "react";
import {
  type Device,
  type DevicePayload,
  type DeviceStatus,
  type DeviceIcon,
  type SnmpProfile,
  type TopologyGroup,
  type Site,
} from "../../api/client";
import { formatDeviceTypeLabel, blankToNull, initialDeviceName } from "../../utils/format";
import { deviceTypeOptions } from "../../constants";
import { deviceTypeIconMap } from "../../icons";
import { Modal } from "../../components/Modal";

export function DeviceForm({
  busy,
  cloneSource,
  device,
  groups,
  snmpProfiles,
  sites,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  cloneSource: Device | null;
  device: Device | null;
  groups: TopologyGroup[];
  snmpProfiles: SnmpProfile[];
  sites: Site[];
  onCancel: () => void;
  onSubmit: (payload: DevicePayload) => Promise<void>;
}) {
  const formId = "device-form";
  const [form, setForm] = useState({
    display_name: device?.display_name ?? cloneSource?.display_name ?? "",
    hostname: initialDeviceName(device, cloneSource),
    ip_address: cloneSource ? "" : device?.ip_address ?? "",
    mac_address: cloneSource ? "" : device?.mac_address ?? "",
    vendor: device?.vendor ?? cloneSource?.vendor ?? "",
    os: device?.os ?? cloneSource?.os ?? "",
    device_type: device?.device_type ?? cloneSource?.device_type ?? "",
    status: device?.status ?? cloneSource?.status ?? "unknown",
    icon: device?.icon ?? cloneSource?.icon ?? deviceTypeIconMap[device?.device_type ?? cloneSource?.device_type ?? ""] ?? "device",
    color: device?.color ?? cloneSource?.color ?? "",
    vlan_id: device?.vlan_id ?? cloneSource?.vlan_id ?? "",
    subnet: device?.subnet ?? cloneSource?.subnet ?? "",
    topology_group_id: String(device?.topology_group_id ?? cloneSource?.topology_group_id ?? ""),
    site_id: String(device?.site_id ?? cloneSource?.site_id ?? ""),
    snmp_profile_id: String(device?.snmp_profile_id ?? cloneSource?.snmp_profile_id ?? ""),
    tags: (device?.tags ?? cloneSource?.tags ?? []).join(", "),
    notes: device?.notes ?? cloneSource?.notes ?? "",
  });

  function update(field: keyof typeof form, value: string) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === "device_type") {
        next.icon = deviceTypeIconMap[value] || "device";
      }
      return next;
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const selectedDeviceType = blankToNull(form.device_type);
    onSubmit({
      display_name: blankToNull(form.display_name),
      hostname: blankToNull(form.hostname),
      ip_address: form.ip_address.trim() || "",
      mac_address: blankToNull(form.mac_address),
      vendor: blankToNull(form.vendor),
      os: blankToNull(form.os),
      device_type: selectedDeviceType,
      status: form.status as DeviceStatus,
      icon: (form.icon || "device") as DeviceIcon,
      color: blankToNull(form.color),
      vlan_id: blankToNull(form.vlan_id),
      subnet: blankToNull(form.subnet),
      topology_group_id: form.topology_group_id ? Number(form.topology_group_id) : null,
      topology_group: null,
      site_id: form.site_id ? Number(form.site_id) : null,
      snmp_profile_id: form.snmp_profile_id ? Number(form.snmp_profile_id) : null,
      tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      notes: blankToNull(form.notes),
    });
  }

  return (
    <Modal
      title={device ? "Edit device" : cloneSource ? "Clone device" : "Add device"}
      onCancel={onCancel}
      headerSubmitLabel={device ? "Save" : undefined}
      headerSubmitFormId={device ? formId : undefined}
      headerSubmitDisabled={busy}
      wide
    >
      <form id={formId} className="modal-form device-form" onSubmit={submit}>
        <div className="device-form-body">
          <div className="device-form-col">
            <div className="device-form-section">
              <span className="device-form-section-title">Identity</span>
              <label>
                Display name
                <input value={form.display_name} onChange={(event) => update("display_name", event.target.value)} />
              </label>
              <div className="modal-form-row">
                <label>
                  Hostname
                  <input value={form.hostname} onChange={(event) => update("hostname", event.target.value)} />
                </label>
                <label>
                  IP address
                  <input placeholder="192.168.1.100" value={form.ip_address} onChange={(event) => update("ip_address", event.target.value)} />
                </label>
              </div>
              <div className="modal-form-row">
                <label>
                  MAC address
                  <input value={form.mac_address} onChange={(event) => update("mac_address", event.target.value)} />
                </label>
                <label>
                  Vendor
                  <input value={form.vendor} onChange={(event) => update("vendor", event.target.value)} />
                </label>
              </div>
              <label>
                OS
                <input placeholder="e.g. Ubuntu 24.04, Windows Server 2025, Cisco IOS" value={form.os} onChange={(event) => update("os", event.target.value)} />
              </label>
            </div>

            <div className="device-form-section">
              <span className="device-form-section-title">Classification</span>
              <div className="modal-form-row">
                <label>
                  Device type
                  <select value={form.device_type} onChange={(event) => update("device_type", event.target.value)}>
                    {deviceTypeOptions.map((type) => (
                      <option key={type} value={type}>
                        {formatDeviceTypeLabel(type)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Status
                  <select value={form.status} onChange={(event) => update("status", event.target.value)}>
                    <option value="unknown">Unknown</option>
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                    <option value="warning">Warning</option>
                  </select>
                </label>
              </div>
            </div>
          </div>

          <div className="device-form-col">
            <div className="device-form-section device-form-section--fill">
              <span className="device-form-section-title">Network &amp; Organisation</span>
              <div className="modal-form-row">
                <label>
                  Subnet
                  <input placeholder="192.168.1.0/24" value={form.subnet} onChange={(event) => update("subnet", event.target.value)} />
                </label>
                <label>
                  VLAN / Group
                  <select value={form.topology_group_id} onChange={(event) => update("topology_group_id", event.target.value)}>
                    <option value="">— None —</option>
                    {groups.map((group) => (
                      <option key={group.id} value={String(group.id)}>
                        {group.display_name || group.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Location
                <select value={form.site_id} onChange={(event) => update("site_id", event.target.value)}>
                  <option value="">— None —</option>
                  {sites.map((site) => (
                    <option key={site.id} value={String(site.id)}>
                      {site.display_name ?? site.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                SNMP profile
                <select value={form.snmp_profile_id} onChange={(event) => update("snmp_profile_id", event.target.value)}>
                  <option value="">— None —</option>
                  {snmpProfiles.map((profile) => (
                    <option key={profile.id} value={String(profile.id)}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tags
                <input placeholder="comma-separated" value={form.tags} onChange={(event) => update("tags", event.target.value)} />
              </label>
              <label className="device-form-notes-label">
                Notes
                <textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} />
              </label>
            </div>
          </div>
        </div>

        <div className="modal-actions device-form-actions">
          <button type="button" className="nm-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

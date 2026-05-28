import { useState, useEffect, useRef } from "react";
import { Network, Pencil, Activity, MapPin } from "lucide-react";
import {
  IconServer,
  IconFingerprint,
  IconBuildingStore,
  IconDeviceDesktop,
  IconPalette,
  IconMap,
  IconRoute,
  IconTag,
  IconNote,
} from "@tabler/icons-react";
import {
  type Device,
  type DeviceLiveStatus,
  type DevicePayload,
  type DeviceStatus,
  type DeviceIcon,
  type SnmpEnrichmentPreview,
  type SnmpProfile,
  type TopologyGroup,
  type Site,
  type DeviceSecurityEventSummary,
  api,
} from "../../api/client";
import { deviceLabel, statusColor, formatDeviceTypeLabel, deviceVlanDisplay, formatEventTime } from "../../utils/format";
import { buildDevicePayload } from "../../utils/device";
import { deviceTypeOptions } from "../../constants";
import { deviceTypeIconMap } from "../../icons";
import { DeviceTypeIcon } from "../../components/DeviceTypeIcon";

export function DeviceDetails({
  canViewSecurity,
  canWrite,
  device,
  disabled,
  groups,
  accessToken,
  hideHeading,
  snmpProfiles,
  sites,
  onGraphChange,
  liveStatus,
  onDelete,
  onClone,
  onSubmit,
  securityLoading,
  securitySummary,
}: {
  canViewSecurity: boolean;
  canWrite: boolean;
  device: Device;
  disabled: boolean;
  groups: TopologyGroup[];
  accessToken: string;
  hideHeading?: boolean;
  snmpProfiles: SnmpProfile[];
  sites: Site[];
  liveStatus: DeviceLiveStatus | null;
  onDelete?: () => void;
  onClone?: () => void;
  onSubmit: (payload: DevicePayload) => Promise<void>;
  onGraphChange: () => Promise<void>;
  securityLoading: boolean;
  securitySummary: DeviceSecurityEventSummary | null;
}) {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [fieldDraft, setFieldDraft] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"details" | "activity">("details");
  const [snmpPreview, setSnmpPreview] = useState<SnmpEnrichmentPreview | null>(null);
  const [snmpBusy, setSnmpBusy] = useState(false);
  const [snmpError, setSnmpError] = useState<string | null>(null);
  const committingRef = useRef(false);

  useEffect(() => {
    setEditingField(null);
    setFieldDraft("");
    setActiveTab("details");
    setSnmpPreview(null);
    setSnmpError(null);
    committingRef.current = false;
  }, [device.id]);

  function startEdit(field: string, currentValue: string) {
    if (!canWrite || disabled) return;
    setEditingField(field);
    setFieldDraft(currentValue);
  }

  async function commitField(overrides: Partial<DevicePayload>) {
    if (committingRef.current) return;
    committingRef.current = true;
    setEditingField(null);
    setFieldDraft("");
    try {
      await onSubmit(buildDevicePayload(device, overrides));
    } finally {
      committingRef.current = false;
    }
  }

  function cancelEdit() {
    setEditingField(null);
    setFieldDraft("");
  }

  const editHint = canWrite && !disabled;
  const dotStatus = liveStatus?.status ?? device.monitor_status ?? device.status;
  const assignedSnmpProfile = snmpProfiles.find((profile) => profile.id === device.snmp_profile_id) ?? null;

  async function previewSnmpEnrichment() {
    setSnmpBusy(true);
    setSnmpError(null);
    try {
      setSnmpPreview(await api.previewSnmpArpEnrichment(accessToken, device.id));
    } catch (err) {
      setSnmpError(err instanceof Error ? err.message : "SNMP enrichment failed");
    } finally {
      setSnmpBusy(false);
    }
  }

  async function applySnmpEnrichment() {
    setSnmpBusy(true);
    setSnmpError(null);
    try {
      const result = await api.applySnmpArpEnrichment(accessToken, device.id);
      setSnmpPreview(null);
      await onGraphChange();
      setSnmpError(`Applied SNMP updates to ${result.updated} device${result.updated === 1 ? "" : "s"}.`);
    } catch (err) {
      setSnmpError(err instanceof Error ? err.message : "SNMP enrichment failed");
    } finally {
      setSnmpBusy(false);
    }
  }

  return (
    <div>
      {!hideHeading && (
        <div className="details-heading">
          <span className={`status-dot ${dotStatus}`} />
          <div className="details-heading-body">
            <div className="details-heading-title-row">
              <h3>{deviceLabel(device)}</h3>
              {liveStatus && liveStatus.status !== "unknown" && (
                <span className={`details-live-badge details-live-badge--${liveStatus.status}`}>
                  <span className="details-live-dot" />
                  {liveStatus.status}
                  {liveStatus.latency_ms != null && (
                    <span className="details-live-rtt">{liveStatus.latency_ms.toFixed(1)} ms</span>
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="device-detail-tabs">
        <button type="button" className={`device-detail-tab${activeTab === "details" ? " active" : ""}`} onClick={() => setActiveTab("details")}>Details</button>
        {canViewSecurity && (
          <button type="button" className={`device-detail-tab device-detail-tab--right${activeTab === "activity" ? " active" : ""}`} onClick={() => setActiveTab("activity")}>Activity</button>
        )}
      </div>

      {activeTab === "details" && (<>
      <dl>
        <dt><span className="details-field-icon"><Pencil size={12} /></span>Display name</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("display_name", device.display_name ?? "") : undefined}
        >
          {editingField === "display_name" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ display_name: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ display_name: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.display_name || "Not set")}
        </dd>
        <dt><span className="details-field-icon"><IconServer size={12} /></span>Hostname</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("hostname", device.hostname ?? "") : undefined}
        >
          {editingField === "hostname" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ hostname: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ hostname: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.hostname || "Not set")}
        </dd>
        <dt><span className="details-field-icon"><Network size={12} /></span>IP address</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("ip_address", device.ip_address ?? "") : undefined}
        >
          {editingField === "ip_address" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ ip_address: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ ip_address: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.ip_address || "Not set")}
        </dd>
        <dt><span className="details-field-icon"><IconFingerprint size={12} /></span>MAC address</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("mac_address", device.mac_address ?? "") : undefined}
        >
          {editingField === "mac_address" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ mac_address: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ mac_address: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.mac_address || "Not set")}
        </dd>
        <dt><span className="details-field-icon"><IconBuildingStore size={12} /></span>Vendor</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("vendor", device.vendor ?? "") : undefined}
        >
          {editingField === "vendor" ? (
            <input
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ vendor: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ vendor: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.vendor || "Not set")}
        </dd>
        <dt><span className="details-field-icon"><IconDeviceDesktop size={12} /></span>Type</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("device_type", device.device_type ?? "") : undefined}
        >
          {editingField === "device_type" ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <DeviceTypeIcon type={fieldDraft || device.device_type} size={13} />
              <select
                autoFocus
                className="details-inline-input"
                value={fieldDraft}
                onChange={(e) => {
                  const value = e.target.value;
                  void commitField({ device_type: value || null, icon: (deviceTypeIconMap[value] || "device") as DeviceIcon });
                }}
                onBlur={cancelEdit}
                onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
              >
                {deviceTypeOptions.map((type) => (
                  <option key={type} value={type}>{formatDeviceTypeLabel(type)}</option>
                ))}
              </select>
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <DeviceTypeIcon type={device.device_type} size={13} />
              {device.device_type ? formatDeviceTypeLabel(device.device_type) : "Not set"}
            </span>
          )}
        </dd>
        <dt><span className="details-field-icon"><Activity size={12} /></span>Status</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("status", device.status) : undefined}
        >
          {editingField === "status" ? (
            <select
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => { void commitField({ status: e.target.value as DeviceStatus }); }}
              onBlur={cancelEdit}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            >
              <option value="unknown">unknown</option>
              <option value="online">online</option>
              <option value="offline">offline</option>
              <option value="warning">warning</option>
            </select>
          ) : device.status}
        </dd>
        <dt><span className="details-field-icon"><IconPalette size={12} /></span>Color</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("color", device.color ?? "") : undefined}
        >
          {editingField === "color" ? (
            <div className="details-inline-color">
              <input
                autoFocus
                type="color"
                value={fieldDraft || "#3276b1"}
                onChange={(e) => setFieldDraft(e.target.value)}
                onBlur={() => { if (!committingRef.current) void commitField({ color: fieldDraft || null }); }}
              />
              <button type="button" className="details-inline-auto" onClick={() => void commitField({ color: null })}>Auto</button>
            </div>
          ) : (
            <>
              <span className="color-readout" style={{ background: device.color ?? statusColor(device.status) }} />
              {device.color || "Status color"}
            </>
          )}
        </dd>
        <dt><span className="details-field-icon"><IconMap size={12} /></span>VLAN / Group</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("topology_group_id", String(device.topology_group_id ?? "")) : undefined}
        >
          {editingField === "topology_group_id" ? (
            <select
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => {
                const value = e.target.value;
                void commitField({ topology_group_id: value ? Number(value) : null, topology_group: null });
              }}
              onBlur={cancelEdit}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            >
              <option value="">— None —</option>
              {groups.map((group) => (
                <option key={group.id} value={String(group.id)}>{group.display_name || group.name}</option>
              ))}
            </select>
          ) : deviceVlanDisplay(device)}
        </dd>
        <dt><span className="details-field-icon"><MapPin size={12} /></span>Location</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("site_id", String(device.site_id ?? "")) : undefined}
        >
          {editingField === "site_id" ? (
            <select
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => {
                const value = e.target.value;
                void commitField({ site_id: value ? Number(value) : null });
              }}
              onBlur={cancelEdit}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            >
              <option value="">— None —</option>
              {sites.map((site) => (
                <option key={site.id} value={String(site.id)}>{site.display_name ?? site.name}</option>
              ))}
            </select>
          ) : (
            sites.find((s) => s.id === device.site_id)
              ? (sites.find((s) => s.id === device.site_id)!.display_name ?? sites.find((s) => s.id === device.site_id)!.name)
              : "—"
          )}
        </dd>
        <dt><span className="details-field-icon"><IconRoute size={12} /></span>SNMP profile</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("snmp_profile_id", String(device.snmp_profile_id ?? "")) : undefined}
        >
          {editingField === "snmp_profile_id" ? (
            <select
              autoFocus
              className="details-inline-input"
              value={fieldDraft}
              onChange={(e) => {
                const value = e.target.value;
                void commitField({ snmp_profile_id: value ? Number(value) : null });
              }}
              onBlur={cancelEdit}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            >
              <option value="">— None —</option>
              {snmpProfiles.map((profile) => (
                <option key={profile.id} value={String(profile.id)}>{profile.name}</option>
              ))}
            </select>
          ) : (assignedSnmpProfile?.name || "—")}
        </dd>
        <dt><span className="details-field-icon"><IconRoute size={12} /></span>Subnet</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("subnet", device.subnet ?? "") : undefined}
        >
          {editingField === "subnet" ? (
            <input
              autoFocus
              className="details-inline-input"
              placeholder="192.168.10.0/24"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ subnet: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ subnet: fieldDraft.trim() || null });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.subnet || "—")}
        </dd>
        <dt><span className="details-field-icon"><IconTag size={12} /></span>Tags</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("tags", device.tags.join(", ")) : undefined}
        >
          {editingField === "tags" ? (
            <input
              autoFocus
              className="details-inline-input"
              placeholder="tag1, tag2"
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => {
                if (!committingRef.current) void commitField({ tags: fieldDraft.split(",").map((t) => t.trim()).filter(Boolean) });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitField({ tags: fieldDraft.split(",").map((t) => t.trim()).filter(Boolean) });
                if (e.key === "Escape") cancelEdit();
              }}
            />
          ) : (device.tags.length ? device.tags.join(", ") : "None")}
        </dd>
        <dt><span className="details-field-icon"><IconNote size={12} /></span>Notes</dt>
        <dd
          className={editHint ? "editable-dd" : undefined}
          onDoubleClick={editHint ? () => startEdit("notes", device.notes ?? "") : undefined}
        >
          {editingField === "notes" ? (
            <textarea
              autoFocus
              className="details-inline-input"
              rows={3}
              value={fieldDraft}
              onChange={(e) => setFieldDraft(e.target.value)}
              onBlur={() => { if (!committingRef.current) void commitField({ notes: fieldDraft.trim() || null }); }}
              onKeyDown={(e) => { if (e.key === "Escape") cancelEdit(); }}
            />
          ) : (device.notes || "None")}
        </dd>
      </dl>
      {canWrite && (assignedSnmpProfile || onClone || onDelete) && (
        <div className="detail-actions detail-actions--device">
          {assignedSnmpProfile && (
            <button type="button" className="vlan-action-btn" disabled={disabled || snmpBusy} onClick={() => void previewSnmpEnrichment()}>
              {snmpBusy ? "Checking..." : "SNMP ARP preview"}
            </button>
          )}
          {onClone && <button type="button" className="vlan-action-btn" disabled={disabled} onClick={onClone}>Clone</button>}
          {onDelete && <button type="button" className="vlan-action-btn vlan-action-btn--danger" disabled={disabled} onClick={onDelete}>Delete</button>}
        </div>
      )}
      {snmpError && <p className="details-edit-hint">{snmpError}</p>}
      {snmpPreview && (
        <div className="device-security-panel">
          <p className="dash-empty">{snmpPreview.changes.length} SNMP ARP change{snmpPreview.changes.length === 1 ? "" : "s"} found.</p>
          {snmpPreview.changes.slice(0, 12).map((change) => (
            <div className="device-event-row" key={`${change.device_id}-${change.field}`}>
              <span>{change.ip_address}</span>
              <span>{change.field}</span>
              <span>{change.current || "empty"} → {change.suggested}</span>
            </div>
          ))}
          {snmpPreview.changes.length > 0 && (
            <div className="detail-actions detail-actions--device">
              <button type="button" className="vlan-action-btn vlan-action-btn--primary" disabled={snmpBusy} onClick={() => void applySnmpEnrichment()}>
                Apply updates
              </button>
            </div>
          )}
        </div>
      )}
      {editHint && <p className="details-edit-hint">Double-click any field to edit</p>}
      </>)}

      {activeTab === "activity" && canViewSecurity && (
        <div className="device-security-panel">
          {securityLoading ? (
            <p className="dash-empty">Loading security activity…</p>
          ) : securitySummary ? (
            <>
              <dl className="security-summary-list">
                <dt>Blocked</dt><dd>{securitySummary.blocked_count}</dd>
                <dt>Passed</dt><dd>{securitySummary.passed_count}</dd>
                <dt>Total</dt><dd>{securitySummary.total_count}</dd>
                <dt>Last seen</dt>
                <dd>{securitySummary.last_seen_event_time ? formatEventTime(securitySummary.last_seen_event_time) : "No recent events"}</dd>
              </dl>
              {securitySummary.events.length === 0 ? (
                <p className="dash-empty">No events in the last {securitySummary.window_hours} hours.</p>
              ) : (
                <div className="device-event-list">
                  {securitySummary.events.map((event) => (
                    <div className="device-event-row" key={`device-event-${event.id}`}>
                      <span>{formatEventTime(event.received_at)}</span>
                      <span>{event.action || "-"}</span>
                      <span>{event.src_ip || "-"} → {event.dst_ip || "-"}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="dash-empty">No security data for this device.</p>
          )}
        </div>
      )}
    </div>
  );
}

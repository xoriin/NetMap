import { AdminTaskPanel } from "../AdminTaskPanel";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { IconDeviceDesktop, IconPalette, IconTrash } from "@tabler/icons-react";
import { BarChart3, Boxes, Package, Palette, Sparkles } from "lucide-react";

import { api, type DeviceTypeOption } from "../../../api/client";
import { DeviceTypeIconPicker } from "../../../components/IconPicker";
import { IconManagerModal } from "../../../components/IconManagerModal";
import { useConfirm } from "../../../components/ConfirmDialog";
import { useDeviceTypes } from "../../../hooks/useDeviceTypes";
import { useIconPacks } from "../../../providers/IconPackProvider";
import {
  applyDeviceTypeIconMap,
  builtInIconPack,
  defaultDeviceTypeIconMap,
  fullTablerIconPack,
  loadFullTablerIconPack,
  readDeviceTypeIconMap,
} from "../../../icons";
import { formatDeviceTypeLabel } from "../../../utils/format";
import { autoEntityColor, isValidHexColor, resolveEntityColor } from "../../../utils/entityColor";
import { EntityColorsPanel } from "./EntityColorsPanel";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { DashStat } from "../../../components/DashStat";
import { BarList, CountUp } from "../../../components/Charts";
import { AdminCard } from "../AdminCard";

function deviceTypeValueFromLabel(label: string) {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

type EditDraft = {
  originalValue: string;
  label: string;
  value: string;
  icon: string;
};

export function DeviceIconsTab({
  accessToken,
  onError,
  onSuccess,
}: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const confirm = useConfirm();
  const {
    iconPacks, localIconPacks, activeIconPackId, iconPackLoading, iconPackError,
    selectIconPack: onSelectIconPack,
    addLocalIconPack: onAddLocalIconPack,
    removeLocalIconPack: onRemoveLocalIconPack,
  } = useIconPacks();
  const deviceTypesQuery = useDeviceTypes(accessToken);
  const devicesQuery = useApiQuery(() => api.topologyGraph(accessToken).then((graph) => graph.devices), [accessToken]);

  const [iconModalOpen, setIconModalOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [newDeviceTypeLabel, setNewDeviceTypeLabel] = useState("");
  const [newDeviceTypeIcon, setNewDeviceTypeIcon] = useState("device");
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [typeIconMap, setTypeIconMap] = useState<Record<string, string>>(() => readDeviceTypeIconMap());
  const [typeIconSaved, setTypeIconSaved] = useState(false);

  const [tablerPack, setTablerPack] = useState(fullTablerIconPack);
  useEffect(() => {
    let live = true;
    void loadFullTablerIconPack().then((pack) => { if (live) setTablerPack(pack); });
    return () => { live = false; };
  }, []);

  const allPacks = useMemo(
    () => [builtInIconPack, tablerPack, ...iconPacks, ...localIconPacks],
    [tablerPack, iconPacks, localIconPacks],
  );
  const activePack = allPacks.find((pack) => pack.id === activeIconPackId) ?? builtInIconPack;
  const newDeviceTypeValue = deviceTypeValueFromLabel(newDeviceTypeLabel);

  function saveTypeIconMap(next: Record<string, string>) {
    setTypeIconMap(next);
    applyDeviceTypeIconMap(next);
    setTypeIconSaved(true);
    window.setTimeout(() => setTypeIconSaved(false), 2000);
  }

  // The endpoint replaces the whole map, so send every currently-set colour with
  // the one being changed (or dropped) applied on top.
  async function saveTypeColor(value: string, color: string | null) {
    setBusy(`color:${value}`);
    onError(null);
    onSuccess(null);
    try {
      const colors: Record<string, string> = {};
      for (const type of deviceTypesQuery.options) {
        if (type.value !== value && isValidHexColor(type.color)) colors[type.value] = type.color as string;
      }
      if (color) colors[value] = color;
      await api.updateDeviceTypeColors(accessToken, colors);
      await deviceTypesQuery.reload();
      onSuccess(color ? "Device type colour updated" : "Device type reset to automatic colour");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to save device type colour");
    } finally {
      setBusy(null);
    }
  }

  async function createDeviceType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = newDeviceTypeLabel.trim();
    if (!label) return;
    setBusy("create");
    onError(null);
    onSuccess(null);
    try {
      const created = await api.createDeviceType(accessToken, { label, icon: newDeviceTypeIcon });
      await deviceTypesQuery.reload();
      saveTypeIconMap({ ...typeIconMap, [created.value]: created.icon || "device" });
      setNewDeviceTypeLabel("");
      setNewDeviceTypeIcon("device");
      onSuccess(`Added device type ${created.label}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to add device type");
    } finally {
      setBusy(null);
    }
  }

  function startEdit(type: DeviceTypeOption) {
    setEditDraft({
      originalValue: type.value,
      label: type.label || formatDeviceTypeLabel(type.value),
      value: type.value,
      icon: typeIconMap[type.value] || type.icon || "device",
    });
  }

  async function saveEdit() {
    if (!editDraft) return;
    setBusy(`edit:${editDraft.originalValue}`);
    onError(null);
    onSuccess(null);
    try {
      const updated = await api.updateDeviceType(accessToken, editDraft.originalValue, {
        label: editDraft.label,
        value: editDraft.value,
        icon: editDraft.icon,
      });
      await deviceTypesQuery.reload();
      const nextMap = { ...typeIconMap };
      delete nextMap[editDraft.originalValue];
      nextMap[updated.value] = updated.icon || editDraft.icon || "device";
      saveTypeIconMap(nextMap);
      setEditDraft(null);
      onSuccess(`Updated device type ${updated.label}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to update device type");
    } finally {
      setBusy(null);
    }
  }

  async function deleteDeviceType(type: DeviceTypeOption) {
    const ok = await confirm({
      title: "Delete Device Type",
      message: `Delete the custom device type "${type.label || type.value}"?`,
      detail: "NetMap will only delete unused custom types. Device types currently used by devices are blocked by the server.",
      confirmLabel: "Delete type",
    });
    if (!ok) return;

    setBusy(`delete:${type.value}`);
    onError(null);
    onSuccess(null);
    try {
      await api.deleteDeviceType(accessToken, type.value);
      await deviceTypesQuery.reload();
      const nextMap = { ...typeIconMap };
      delete nextMap[type.value];
      saveTypeIconMap(nextMap);
      onSuccess("Device type removed");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to remove device type");
    } finally {
      setBusy(null);
    }
  }

  const types = deviceTypesQuery.options;
  const devices = devicesQuery.data ?? [];
  const builtIn = types.filter((t) => t.is_builtin);
  const custom = types.filter((t) => !t.is_builtin);
  const typeName = (t: DeviceTypeOption) => t.label || formatDeviceTypeLabel(t.value);
  const listNames = (list: DeviceTypeOption[]) => list.length > 3 ? `${list.slice(0, 3).map(typeName).join(", ")}…` : list.map(typeName).join(", ");
  const perType = new Map<string, number>();
  for (const d of devices) if (d.device_type) perType.set(d.device_type, (perType.get(d.device_type) ?? 0) + 1);
  const typeBars = types.map((t) => ({ label: typeName(t), value: perType.get(t.value) ?? 0, color: resolveEntityColor(t.color, t.value) }))
    .filter((item) => item.value > 0).sort((x, y) => y.value - x.value);
  const assigned = typeBars.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="admin-tab-content nm-motion">
      <div className="nm-bento nm-bento--four">
        <AdminCard title="Devices by type" icon={<BarChart3 size={16} />}>
          {devicesQuery.error ? <p className="tool-note nm-chart-empty">Device counts are unavailable.</p>
            : <BarList viewId="admin.icons.device-types" label="Devices per device type" items={typeBars} empty="No devices have a type yet." />}
        </AdminCard>
        <div className="dash-stats nm-bento-stats nm-summary-band">
          <DashStat accent="teal" className="nm-motion-item" icon={<Boxes size={20} />} label="Device types" value={<CountUp value={types.length} />} sub={`${assigned} devices assigned`} />
          <DashStat accent="blue" className="nm-motion-item" icon={<Package size={20} />} label="Built in" value={<CountUp value={builtIn.length} />} sub={listNames(builtIn) || "None"} />
          <DashStat accent="purple" className="nm-motion-item" icon={<Sparkles size={20} />} label="Custom" value={<CountUp value={custom.length} />} sub={listNames(custom) || "Add one alongside"} />
          <DashStat accent="indigo" className="nm-motion-item" icon={<Palette size={20} />} label="Icon pack" value={activePack.name.replace(/^Built-in \((.*)\)$/, "$1")} sub={activePack.id === builtInIconPack.id ? "Built-in set" : "Custom set"} />
        </div>
      </div>
      <div className="nm-console">
        <div className="nm-console-main">
      <section className="panel admin-panel nm-app-panel device-types-panel nm-fill nm-motion-item" aria-label="Device types">
        {/* Icon pack is a one-control concern, so it rides in this panel's header rather
            than occupying a panel of its own whose entire body was a single button. */}
        <div className="nm-app-panel-header admin-panel-header">
          <span className="admin-panel-identity">
            <span className="admin-panel-icon" aria-hidden="true"><IconDeviceDesktop size={17} /></span>
            <span className="admin-panel-title-wrap">
              <span className="admin-panel-title">Device types</span>
              <span className="admin-panel-meta">
                {deviceTypesQuery.options.length} type{deviceTypesQuery.options.length === 1 ? "" : "s"}
                {" · "}icon pack: <strong>{activePack.name}</strong>
              </span>
            </span>
          </span>
          <button type="button" className="nm-btn nm-btn--sm" onClick={() => setIconModalOpen(true)}>
            <IconPalette size={14} /> Icon packs
          </button>
        </div>

          <AdminTaskPanel title="Type library" icon={<IconDeviceDesktop size={18} />}>


        <div className="nm-table-wrap device-types-table-wrap">
          <table className="nm-table device-types-table">
            <colgroup>
              <col className="device-types-col-name" />
              <col className="device-types-col-icon" />
              <col className="device-types-col-colour" />
              <col className="device-types-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>Type</th>
                <th>Default icon</th>
                <th>Colour</th>
                <th className="device-types-actions-head">Actions</th>
              </tr>
            </thead>
            <tbody>{deviceTypesQuery.options.map((type) => {
              const isEditing = editDraft?.originalValue === type.value;
              const currentIcon = typeIconMap[type.value] || type.icon || "device";
              if (isEditing && editDraft) {
                return (
                  <tr key={type.value} className="device-types-row device-types-row--editing">
                    <td colSpan={4}>
                      <div className="device-icons-edit-grid">
                        <label className="nm-field">
                          <span>Name</span>
                          <input
                            className="nm-input"
                            maxLength={80}
                            value={editDraft.label}
                            onChange={(event) => setEditDraft((current) => current ? { ...current, label: event.target.value } : current)}
                          />
                        </label>
                        <label className="nm-field">
                          <span>Value</span>
                          <input
                            className="nm-input"
                            maxLength={80}
                            value={editDraft.value}
                            onChange={(event) => setEditDraft((current) => current ? { ...current, value: deviceTypeValueFromLabel(event.target.value) } : current)}
                          />
                        </label>
                        <label className="nm-field">
                          <span>Icon</span>
                          <DeviceTypeIconPicker
                            currentIcon={editDraft.icon}
                            onSelect={(icon) => setEditDraft((current) => current ? { ...current, icon } : current)}
                          />
                        </label>
                        <div className="nm-table-actions">
                          <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy === `edit:${type.value}` || !editDraft.label.trim() || !editDraft.value.trim()} onClick={() => void saveEdit()}>
                            {busy === `edit:${type.value}` ? "Saving..." : "Save"}
                          </button>
                          <button type="button" className="nm-btn nm-btn--sm" onClick={() => setEditDraft(null)}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={type.value} className="device-types-row">
                  <td>
                    <span className="device-types-identity">
                      <strong>{type.label || formatDeviceTypeLabel(type.value)}</strong>
                      <small>{type.value}{type.is_builtin ? " · built-in" : " · custom"}</small>
                    </span>
                  </td>
                  <td>
                    <DeviceTypeIconPicker
                      currentIcon={currentIcon}
                      onSelect={(icon) => setTypeIconMap((current) => ({ ...current, [type.value]: icon }))}
                    />
                  </td>
                  <td>
                    <span className="device-icons-color">
                      <input
                        type="color"
                        className="entity-colors-input"
                        aria-label={`Colour for ${type.label || type.value}`}
                        disabled={busy === `color:${type.value}`}
                        value={resolveEntityColor(type.color, type.value)}
                        onChange={(event) => void saveTypeColor(type.value, event.target.value)}
                      />
                      {isValidHexColor(type.color) && (
                        <button
                          type="button"
                          className="nm-btn nm-btn--sm nm-btn--secondary"
                          disabled={busy === `color:${type.value}`}
                          title={`Reset to the automatic colour (${autoEntityColor(type.value)})`}
                          onClick={() => void saveTypeColor(type.value, null)}
                        >
                          Reset
                        </button>
                      )}
                    </span>
                  </td>
                  <td className="device-types-actions">
                    {type.is_builtin ? <span className="device-types-locked">—</span> : (
                      <span className="nm-table-actions">
                        <button type="button" className="nm-btn nm-btn--sm" disabled={Boolean(busy)} onClick={() => startEdit(type)}>Edit</button>
                        <button
                          type="button"
                          className="nm-btn nm-btn--sm nm-btn--danger"
                          disabled={Boolean(busy)}
                          onClick={() => void deleteDeviceType(type)}
                          aria-label={`Delete ${type.label || type.value}`}
                        >
                          <IconTrash size={14} /> Delete
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
          </AdminTaskPanel>

        <div className="icon-mgr-device-types-actions nm-btn-row">
          <button type="button" className="nm-btn nm-btn--primary" onClick={() => saveTypeIconMap(typeIconMap)}>
            Save icon mapping
          </button>
          <button type="button" className="nm-btn" onClick={() => saveTypeIconMap({ ...defaultDeviceTypeIconMap })}>
            Reset to defaults
          </button>
          {typeIconSaved && <span className="icon-mgr-saved-tick">Saved</span>}
        </div>
      </section>
        </div>
        <aside className="nm-console-side">
          <AdminTaskPanel title="New device type" icon={<IconDeviceDesktop size={18} />} className="nm-fill">
        <form className="device-icons-create-form" onSubmit={createDeviceType}>
          <label className="nm-field">
            <span>Device type</span>
            <input
              className="nm-input"
              maxLength={80}
              placeholder="e.g. UPS, PDU, iDRAC"
              value={newDeviceTypeLabel}
              onChange={(event) => setNewDeviceTypeLabel(event.target.value)}
            />
          </label>
          <label className="nm-field">
            <span>Default icon</span>
            <DeviceTypeIconPicker currentIcon={newDeviceTypeIcon} onSelect={setNewDeviceTypeIcon} />
          </label>
          <button type="submit" className="nm-btn nm-btn--primary" disabled={busy === "create" || !newDeviceTypeValue}>
            {busy === "create" ? "Adding..." : "Add type"}
          </button>
        </form>
          </AdminTaskPanel>
        </aside>
      </div>

      <EntityColorsPanel accessToken={accessToken} onError={onError} onSuccess={onSuccess} />

      {iconModalOpen && (
        <IconManagerModal
          activeIconPackId={activeIconPackId}
          iconPacks={iconPacks}
          localIconPacks={localIconPacks}
          iconPackLoading={iconPackLoading}
          iconPackError={iconPackError}
          onSelectIconPack={onSelectIconPack}
          onAddLocalIconPack={onAddLocalIconPack}
          onRemoveLocalIconPack={onRemoveLocalIconPack}
          onClose={() => setIconModalOpen(false)}
        />
      )}
    </div>
  );
}

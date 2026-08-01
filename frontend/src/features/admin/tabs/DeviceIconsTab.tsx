import { useMemo, useState, type FormEvent } from "react";
import { IconDeviceDesktop, IconPalette, IconTrash } from "@tabler/icons-react";

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
  readDeviceTypeIconMap,
} from "../../../icons";
import { formatDeviceTypeLabel } from "../../../utils/format";
import { autoEntityColor, isValidHexColor, resolveEntityColor } from "../../../utils/entityColor";
import { EntityColorsPanel } from "./EntityColorsPanel";

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

  const [iconModalOpen, setIconModalOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [newDeviceTypeLabel, setNewDeviceTypeLabel] = useState("");
  const [newDeviceTypeIcon, setNewDeviceTypeIcon] = useState("device");
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [typeIconMap, setTypeIconMap] = useState<Record<string, string>>(() => readDeviceTypeIconMap());
  const [typeIconSaved, setTypeIconSaved] = useState(false);

  const allPacks = useMemo(
    () => [builtInIconPack, fullTablerIconPack, ...iconPacks, ...localIconPacks],
    [iconPacks, localIconPacks],
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

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

  return (
    <div className="admin-tab-content">
      <div className="system-tab-grid">
        <div className="system-tab-col">
          <section className="panel admin-panel nm-app-panel">
            <div className="system-icon-header nm-app-panel-header nm-app-panel-header--copy">
              <div>
                <h2 className="admin-section-title" style={{ margin: 0 }}><IconDeviceDesktop size={16} />Device types</h2>
                <p className="tool-note" style={{ margin: "2px 0 0" }}>
                  Add custom types, choose their default icon, and remove unused custom entries.
                </p>
              </div>
            </div>

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
                <DeviceTypeIconPicker
                  currentIcon={newDeviceTypeIcon}
                  onSelect={setNewDeviceTypeIcon}
                />
              </label>
              <button type="submit" className="nm-btn nm-btn--primary" disabled={busy === "create" || !newDeviceTypeValue}>
                {busy === "create" ? "Adding..." : "Add type"}
              </button>
            </form>

            <div className="device-icons-list">
              {deviceTypesQuery.options.map((type) => {
                const isEditing = editDraft?.originalValue === type.value;
                const currentIcon = typeIconMap[type.value] || type.icon || "device";
                return (
                  <div key={type.value} className="device-icons-row">
                    {isEditing && editDraft ? (
                      <form className="device-icons-edit-form" onSubmit={saveEdit}>
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
                        <div className="device-icons-actions">
                          <button type="submit" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy === `edit:${type.value}` || !editDraft.label.trim() || !editDraft.value.trim()}>
                            {busy === `edit:${type.value}` ? "Saving..." : "Save"}
                          </button>
                          <button type="button" className="nm-btn nm-btn--sm" onClick={() => setEditDraft(null)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="device-icons-meta">
                          <strong>{type.label || formatDeviceTypeLabel(type.value)}</strong>
                          <span>
                            {type.value}
                            {type.is_builtin ? " · built-in" : " · custom"}
                          </span>
                        </div>
                        <DeviceTypeIconPicker
                          currentIcon={currentIcon}
                          onSelect={(icon) => setTypeIconMap((current) => ({ ...current, [type.value]: icon }))}
                        />
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
                        <div className="device-icons-actions">
                          {!type.is_builtin && (
                            <button type="button" className="nm-btn nm-btn--sm" disabled={Boolean(busy)} onClick={() => startEdit(type)}>
                              Edit
                            </button>
                          )}
                          {!type.is_builtin && (
                            <button
                              type="button"
                              className="nm-btn nm-btn--sm nm-btn--danger"
                              disabled={Boolean(busy)}
                              onClick={() => void deleteDeviceType(type)}
                              aria-label={`Delete ${type.label || type.value}`}
                            >
                              <IconTrash size={14} />
                              Delete
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

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

        <div className="system-tab-col">
          <section className="panel admin-panel nm-app-panel">
            <div className="system-icon-header nm-app-panel-header nm-app-panel-header--copy">
              <div>
                <h2 className="admin-section-title" style={{ margin: 0 }}><IconPalette size={16} />Icon packs</h2>
                <p className="tool-note" style={{ margin: "2px 0 0" }}>
                  Active: <strong>{activePack.name}</strong>
                  {" · "}{allPacks.length} pack{allPacks.length !== 1 ? "s" : ""}
                </p>
              </div>
              <button type="button" className="nm-btn nm-btn--primary" onClick={() => setIconModalOpen(true)}>
                Manage icons
              </button>
            </div>
          </section>

          <EntityColorsPanel accessToken={accessToken} onError={onError} onSuccess={onSuccess} />
        </div>
      </div>

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

import { FormEvent, useState } from "react";
import { Modal } from "./Modal";
import { deviceTypeOptions } from "../constants";
import {
  applyDeviceTypeIconMap,
  builtInIconPack,
  defaultDeviceTypeIconMap,
  extractSvgIconMarkup,
  labelFromIconValue,
  readDeviceTypeIconMap,
  sanitizeIconDefs,
  slugifyIconValue,
  type IconGlyphDefinition,
  type IconPack,
} from "../icons";
import { formatDeviceTypeLabel } from "../utils/format";
import { DeviceTypeIconPicker } from "./IconPicker";

export function IconManagerModal({
  activeIconPackId,
  iconPacks,
  localIconPacks,
  iconPackLoading,
  iconPackError,
  onSelectIconPack,
  onAddLocalIconPack,
  onRemoveLocalIconPack,
  onClose,
}: {
  activeIconPackId: string;
  iconPacks: IconPack[];
  localIconPacks: IconPack[];
  iconPackLoading: boolean;
  iconPackError: string | null;
  onSelectIconPack: (id: string) => void;
  onAddLocalIconPack: (pack: IconPack) => void;
  onRemoveLocalIconPack: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"packs" | "import" | "device-types">("packs");
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalSuccess, setModalSuccess] = useState<string | null>(null);
  const [typeIconMap, setTypeIconMap] = useState<Record<string, string>>(() => readDeviceTypeIconMap());
  const [typeIconSaved, setTypeIconSaved] = useState(false);

  const allPacksList = [
    { pack: builtInIconPack, isLocal: false },
    ...iconPacks.map((p) => ({ pack: p, isLocal: false })),
    ...localIconPacks.filter((lp) => !iconPacks.some((sp) => sp.id === lp.id)).map((p) => ({ pack: p, isLocal: true })),
  ];

  async function handleImportJson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("icon_pack_file") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;
    setBusy(true); setModalError(null); setModalSuccess(null);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as { id?: unknown; name?: unknown; icons?: unknown };
      const id = String(parsed.id ?? file.name.replace(/\.json$/i, "")).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      const name = String(parsed.name ?? id).trim();
      const icons = sanitizeIconDefs(parsed.icons);
      if (!id || !name || icons.length === 0) throw new Error("Invalid icon pack JSON. Expected: { id, name, icons[] }");
      onAddLocalIconPack({ id, name, icons });
      onSelectIconPack(id);
      setModalSuccess(`Imported "${name}" - ${icons.length} icons`);
      event.currentTarget.reset();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Failed to import icon pack");
    } finally { setBusy(false); }
  }

  async function handleImportSvg(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fileInput = event.currentTarget.elements.namedItem("icon_pack_svg_folder") as HTMLInputElement | null;
    const nameInput = event.currentTarget.elements.namedItem("icon_pack_svg_name") as HTMLInputElement | null;
    const idInput = event.currentTarget.elements.namedItem("icon_pack_svg_id") as HTMLInputElement | null;
    const files = Array.from(fileInput?.files ?? []).filter((f) => f.name.toLowerCase().endsWith(".svg"));
    const requestedName = nameInput?.value.trim() || "";
    const requestedId = slugifyIconValue(idInput?.value.trim() || requestedName || "custom-svg-pack");
    if (!requestedId || files.length === 0) { setModalError("Select a folder of SVG files and provide a pack name."); return; }
    setBusy(true); setModalError(null); setModalSuccess(null);
    try {
      const icons: IconGlyphDefinition[] = [];
      for (const file of files) {
        const path = extractSvgIconMarkup(await file.text());
        if (!path) continue;
        const base = file.name.replace(/\.svg$/i, "");
        const value = slugifyIconValue(base);
        if (value) icons.push({ value, label: labelFromIconValue(base), path });
      }
      if (icons.length === 0) throw new Error("No valid SVG shapes found in the selected folder.");
      const deduped = new Map<string, IconGlyphDefinition>();
      icons.forEach((i) => deduped.set(i.value, i));
      const pack: IconPack = { id: requestedId, name: requestedName || labelFromIconValue(requestedId), icons: Array.from(deduped.values()) };
      onAddLocalIconPack(pack); onSelectIconPack(pack.id);
      setModalSuccess(`Imported ${pack.icons.length} SVG icons as "${pack.name}"`);
      event.currentTarget.reset();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Failed to import SVG folder");
    } finally { setBusy(false); }
  }

  async function handleImportPng(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fileInput = event.currentTarget.elements.namedItem("icon_pack_png_folder") as HTMLInputElement | null;
    const nameInput = event.currentTarget.elements.namedItem("icon_pack_png_name") as HTMLInputElement | null;
    const idInput = event.currentTarget.elements.namedItem("icon_pack_png_id") as HTMLInputElement | null;
    const files = Array.from(fileInput?.files ?? []).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f.name));
    const requestedName = nameInput?.value.trim() || "";
    const requestedId = slugifyIconValue(idInput?.value.trim() || requestedName || "custom-png-pack");
    if (!requestedId || files.length === 0) { setModalError("Select a folder of image files and provide a pack name."); return; }
    setBusy(true); setModalError(null); setModalSuccess(null);
    try {
      const MAX = 256 * 1024;
      const icons: IconGlyphDefinition[] = [];
      for (const file of files) {
        if (file.size > MAX) throw new Error(`"${file.name}" exceeds the 256 KB limit.`);
        const url = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = () => rej(new Error(`Failed to read ${file.name}`));
          r.readAsDataURL(file);
        });
        const base = file.name.replace(/\.(png|jpg|jpeg|gif|webp)$/i, "");
        const value = slugifyIconValue(base);
        if (value) icons.push({ value, label: labelFromIconValue(base), url });
      }
      if (icons.length === 0) throw new Error("No valid image files found.");
      const deduped = new Map<string, IconGlyphDefinition>();
      icons.forEach((i) => deduped.set(i.value, i));
      const pack: IconPack = { id: requestedId, name: requestedName || labelFromIconValue(requestedId), icons: Array.from(deduped.values()) };
      onAddLocalIconPack(pack); onSelectIconPack(pack.id);
      setModalSuccess(`Imported ${pack.icons.length} images as "${pack.name}"`);
      event.currentTarget.reset();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Failed to import images");
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Icon Manager" onCancel={onClose} modalClassName="icon-mgr-modal" bodyClassName="modal-body--flush">
      <div className="icon-mgr-tabs">
        {(["packs", "import", "device-types"] as const).map((t) => (
          <button key={t} type="button" className={`icon-mgr-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t === "packs" ? "Packs" : t === "import" ? "Import" : "Device types"}
          </button>
        ))}
      </div>

      {(modalError || iconPackError) && (
        <div className="nm-alert nm-alert--error icon-mgr-banner">{modalError ?? iconPackError}</div>
      )}
      {modalSuccess && <div className="nm-alert nm-alert--info icon-mgr-banner icon-mgr-banner--success">{modalSuccess}</div>}

      <div className="icon-mgr-body">
          {tab === "packs" && (
            <div className="icon-mgr-packs-list">
              {iconPackLoading && <p className="tool-note" style={{ padding: "8px 16px" }}>Loading server packs...</p>}
              {allPacksList.map(({ pack, isLocal }) => {
                const isActive = pack.id === activeIconPackId;
                return (
                  <div key={pack.id} className={`icon-mgr-pack-row${isActive ? " active" : ""}`}>
                    <div className="icon-mgr-pack-meta">
                      <div className="icon-mgr-pack-name-row">
                        <span className="icon-mgr-pack-name">{pack.name}</span>
                        {isActive && <span className="icon-mgr-badge">Active</span>}
                        {isLocal && <span className="icon-mgr-badge icon-mgr-badge--local">Local</span>}
                      </div>
                      <span className="icon-mgr-pack-count">{pack.icons.length} icon{pack.icons.length !== 1 ? "s" : ""}</span>
                      <div className="icon-mgr-pack-preview">
                        {pack.icons.slice(0, 10).map((icon) => (
                          <div key={icon.value} className="icon-mgr-preview-item" title={icon.label}>
                            {icon.url ? (
                              <img src={icon.url} width={18} height={18} alt={icon.label} style={{ objectFit: "contain" }} />
                            ) : (
                              <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke={isActive ? "#2196a0" : "#7a9fb8"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <g dangerouslySetInnerHTML={{ __html: icon.path ?? "" }} />
                              </svg>
                            )}
                          </div>
                        ))}
                        {pack.icons.length > 10 && <span className="icon-mgr-preview-more">+{pack.icons.length - 10}</span>}
                      </div>
                    </div>
                    <div className="icon-mgr-pack-actions">
                      {!isActive && (
                        <button type="button" className="nm-btn nm-btn--sm" onClick={() => { onSelectIconPack(pack.id); setModalSuccess(`Switched to "${pack.name}"`); }}>
                          Use this pack
                        </button>
                      )}
                      {isLocal && (
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => onRemoveLocalIconPack(pack.id)}>
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              <p className="tool-note" style={{ padding: "12px 16px 4px", fontSize: 11 }}>
                Server packs can also be added via <code>frontend/public/icon-packs/</code>.
              </p>
            </div>
          )}

          {tab === "import" && (
            <div className="icon-mgr-import-sections">
              <div className="icon-mgr-import-section">
                <div className="icon-mgr-section-header">
                  <span className="icon-mgr-section-title">JSON Pack</span>
                  <span className="icon-mgr-section-desc">Import a pre-built icon pack <code>.json</code> file</span>
                </div>
                <form className="icon-mgr-form" onSubmit={(e) => void handleImportJson(e)}>
                  <input name="icon_pack_file" type="file" accept="application/json,.json" />
                  <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>{busy ? "Importing..." : "Import"}</button>
                </form>
              </div>
              <div className="icon-mgr-import-section">
                <div className="icon-mgr-section-header">
                  <span className="icon-mgr-section-title">SVG Folder</span>
                  <span className="icon-mgr-section-desc">Icons adapt to device colors automatically</span>
                </div>
                <form className="icon-mgr-form" onSubmit={(e) => void handleImportSvg(e)}>
                  <label>SVG files
                    <input name="icon_pack_svg_folder" type="file" accept=".svg,image/svg+xml" multiple
                      {...({ webkitdirectory: "true", directory: "true" } as Record<string, string>)} />
                  </label>
                  <div className="icon-mgr-form-row">
                    <label>Pack name <input name="icon_pack_svg_name" placeholder="My SVG Pack" /></label>
                    <label>Pack id <input name="icon_pack_svg_id" placeholder="my-svg-pack" /></label>
                  </div>
                  <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>{busy ? "Importing..." : "Import SVG folder"}</button>
                </form>
              </div>
              <div className="icon-mgr-import-section">
                <div className="icon-mgr-section-header">
                  <span className="icon-mgr-section-title">PNG / Image Folder</span>
                  <span className="icon-mgr-section-desc">PNG, JPG, GIF or WebP - stored as-is, max 256 KB per file</span>
                </div>
                <form className="icon-mgr-form" onSubmit={(e) => void handleImportPng(e)}>
                  <label>Image files
                    <input name="icon_pack_png_folder" type="file"
                      accept=".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp" multiple
                      {...({ webkitdirectory: "true", directory: "true" } as Record<string, string>)} />
                  </label>
                  <div className="icon-mgr-form-row">
                    <label>Pack name <input name="icon_pack_png_name" placeholder="My PNG Pack" /></label>
                    <label>Pack id <input name="icon_pack_png_id" placeholder="my-png-pack" /></label>
                  </div>
                  <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>{busy ? "Importing..." : "Import image folder"}</button>
                </form>
              </div>
            </div>
          )}

          {tab === "device-types" && (
            <div className="icon-mgr-device-types">
              <p className="tool-note" style={{ padding: "0 0 12px" }}>
                Set the default icon for each device type - applied automatically when a type is selected in the device form.
              </p>
              <div className="device-type-icon-grid">
                {deviceTypeOptions.map((type) => (
                  <div key={type} className="device-type-icon-row">
                    <span className="dtype-type-label">{formatDeviceTypeLabel(type)}</span>
                    <DeviceTypeIconPicker
                      currentIcon={typeIconMap[type] || "unknown"}
                      onSelect={(icon) => setTypeIconMap((c) => ({ ...c, [type]: icon }))}
                    />
                  </div>
                ))}
              </div>
              <div className="icon-mgr-device-types-actions nm-btn-row">
                <button type="button" className="nm-btn nm-btn--primary" onClick={() => { applyDeviceTypeIconMap(typeIconMap); setTypeIconSaved(true); setTimeout(() => setTypeIconSaved(false), 2000); }}>
                  Save mapping
                </button>
                <button type="button" className="nm-btn" onClick={() => { const d = { ...defaultDeviceTypeIconMap }; setTypeIconMap(d); applyDeviceTypeIconMap(d); }}>
                  Reset to defaults
                </button>
                {typeIconSaved && <span className="icon-mgr-saved-tick">Saved ✓</span>}
              </div>
            </div>
          )}
        </div>
    </Modal>
  );
}

import { useState, type FormEvent } from "react";
import DOMPurify from "dompurify";
import { Cloud, Plus, Trash2, Upload } from "lucide-react";

import { api, type CloudProviderOption } from "../../../api/client";
import { CloudProviderIcon } from "../../../components/CloudProviderIcon";
import { useConfirm } from "../../../components/ConfirmDialog";
import { useApiQuery } from "../../../hooks/useApiQuery";

async function iconDataFromFile(file: File) {
  if (file.size > 256 * 1024) throw new Error("Provider icons must be 256 KB or smaller");
  if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(file.type)) throw new Error("Use an SVG, PNG, JPEG, or WebP icon");
  let source: Blob = file;
  if (file.type === "image/svg+xml") {
    const clean = DOMPurify.sanitize(await file.text(), { USE_PROFILES: { svg: true, svgFilters: true } });
    source = new Blob([clean], { type: "image/svg+xml" });
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the selected icon"));
    reader.readAsDataURL(source);
  });
}

export function CloudProvidersPanel({ accessToken, onError, onSuccess }: { accessToken: string; onError: (message: string | null) => void; onSuccess: (message: string | null) => void }) {
  const confirm = useConfirm();
  const query = useApiQuery(() => api.listCloudProviders(accessToken), [accessToken]);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [iconData, setIconData] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function chooseNewIcon(file?: File) {
    if (!file) return;
    try { setIconData(await iconDataFromFile(file)); } catch (error) { onError(error instanceof Error ? error.message : "Unable to read icon"); }
  }

  async function createProvider(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !iconData) return;
    setBusy("create"); onError(null);
    try {
      await api.createCloudProvider(accessToken, { name: name.trim(), aliases: aliases.split(",").map((value) => value.trim()).filter(Boolean), icon: "custom", icon_data: iconData });
      await query.reload(); setName(""); setAliases(""); setIconData(null); onSuccess("Cloud provider added");
    } catch (error) { onError(error instanceof Error ? error.message : "Unable to add cloud provider"); } finally { setBusy(null); }
  }

  async function replaceIcon(provider: CloudProviderOption, file?: File) {
    if (!file) return;
    setBusy(provider.key); onError(null);
    try {
      const nextIcon = await iconDataFromFile(file);
      await api.updateCloudProvider(accessToken, provider.key, { name: provider.name, aliases: provider.aliases, icon: "custom", icon_data: nextIcon });
      await query.reload(); onSuccess(`${provider.name} icon updated`);
    } catch (error) { onError(error instanceof Error ? error.message : "Unable to update cloud provider"); } finally { setBusy(null); }
  }

  async function removeProvider(provider: CloudProviderOption) {
    if (!await confirm({ title: "Remove cloud provider", message: `Remove ${provider.name} from the reusable provider catalogue?`, detail: "Allocations and cloud assets that use it fall back to \u201cno provider\u201d; nothing else is deleted.", confirmLabel: "Remove provider" })) return;
    setBusy(provider.key); onError(null);
    try { await api.deleteCloudProvider(accessToken, provider.key); await query.reload(); onSuccess("Cloud provider removed"); }
    catch (error) { onError(error instanceof Error ? error.message : "Unable to remove cloud provider"); } finally { setBusy(null); }
  }

  return <section className="panel admin-panel nm-app-panel cloud-provider-admin">
    <div className="nm-app-panel-header admin-panel-header">
      <span className="admin-panel-identity">
        <span className="admin-panel-icon" aria-hidden="true"><Cloud size={17} /></span>
        <span className="admin-panel-title-wrap">
          <span className="admin-panel-title">Cloud providers</span>
          <span className="admin-panel-meta">Shared by External IPs and Cloud assets</span>
        </span>
      </span>
    </div>
    <p className="admin-panel-copy">
      Add your own, replace any provider&apos;s icon, or remove ones you do not use.
    </p>
    <form className="cloud-provider-create" onSubmit={createProvider}>
      <label className="nm-field"><span>Provider name</span><input className="nm-input" value={name} maxLength={80} placeholder="e.g. Oracle Cloud" onChange={(event) => setName(event.target.value)} /></label>
      <label className="nm-field"><span>Matching aliases</span><input className="nm-input" value={aliases} placeholder="OCI, Oracle, Oracle Cloud Infrastructure" onChange={(event) => setAliases(event.target.value)} /></label>
      <label className={`cloud-provider-file nm-btn${iconData ? " has-icon" : ""}`}>{iconData ? <img src={iconData} alt="Selected provider icon" /> : <Upload size={18} />}<span>{iconData ? "Icon selected" : "Choose icon"}</span><input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" onChange={(event) => { void chooseNewIcon(event.target.files?.[0]); event.target.value = ""; }} /></label>
      <button className="nm-btn nm-btn--primary" type="submit" disabled={busy === "create" || !name.trim() || !iconData}><Plus size={14} />{busy === "create" ? "Adding…" : "Add provider"}</button>
    </form>
    <div className="cloud-provider-list">{query.isLoading ? <p className="tool-note">Loading providers…</p> : (query.data ?? []).length === 0 ? <p className="tool-note">No providers yet.</p> : (query.data ?? []).map((provider) => <div className="cloud-provider-row" key={provider.key}><span className="cloud-provider-logo"><CloudProviderIcon icon={provider.icon} iconData={provider.icon_data} size={20} /></span><span className="cloud-provider-copy"><strong>{provider.name}</strong><small>{provider.aliases.length ? `Aliases: ${provider.aliases.join(", ")}` : "No aliases"}{provider.builtin ? " · built in" : ""}</small></span><span className="cloud-provider-actions"><label className="nm-btn nm-btn--sm"><Upload size={13} />Replace icon<input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" onChange={(event) => { void replaceIcon(provider, event.target.files?.[0]); event.target.value = ""; }} disabled={busy === provider.key} /></label><button className="nm-btn nm-btn--sm nm-btn--danger" type="button" onClick={() => void removeProvider(provider)} disabled={busy === provider.key}><Trash2 size={13} />Remove</button></span></div>)}</div>
  </section>;
}

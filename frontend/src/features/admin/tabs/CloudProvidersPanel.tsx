import { AdminTaskPanel } from "../AdminTaskPanel";
import { useState, type FormEvent } from "react";
import DOMPurify from "dompurify";
import { Cloud, Globe, Package, PieChart, Plus, Sparkles, Trash2, Unlink, Upload } from "lucide-react";
import { DashStat } from "../../../components/DashStat";
import { CountUp, DonutChart, type ChartColor } from "../../../components/Charts";
import { AdminCard } from "../AdminCard";

import { api, type CloudProviderOption } from "../../../api/client";
import { CloudProviderIcon } from "../../../components/CloudProviderIcon";
import { useConfirm } from "../../../components/ConfirmDialog";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { PanelSkeleton } from "../../../components/Skeleton";

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
  const usageQuery = useApiQuery(async () => {
    const [addresses, locations, accounts] = await Promise.all([
      api.listExternalAddresses(accessToken), api.listExternalLocations(accessToken), api.listExternalAccounts(accessToken),
    ]);
    return { addresses, locations, accounts };
  }, [accessToken]);
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
    if (!await confirm({ title: "Remove cloud provider", message: `Remove ${provider.name} from the reusable provider catalogue?`, detail: "External addresses that use it fall back to \u201cno provider\u201d; nothing else is deleted.", confirmLabel: "Remove provider" })) return;
    setBusy(provider.key); onError(null);
    try { await api.deleteCloudProvider(accessToken, provider.key); await query.reload(); onSuccess("Cloud provider removed"); }
    catch (error) { onError(error instanceof Error ? error.message : "Unable to remove cloud provider"); } finally { setBusy(null); }
  }

  const providers = query.data ?? [];
  const builtIn = providers.filter((p) => p.builtin);
  const custom = providers.filter((p) => !p.builtin);
  const usage = new Map<string, number>();
  let unassigned = 0;
  if (usageQuery.data) {
    const { addresses, locations, accounts } = usageQuery.data;
    const locationAccount = new Map(locations.map((l) => [l.id, l.account_id]));
    const accountProvider = new Map(accounts.map((a) => [a.id, a.provider_id]));
    const providerName = new Map(providers.map((p) => [p.id, p.name]));
    for (const address of addresses) {
      const accountId = address.location_id === null ? null : locationAccount.get(address.location_id) ?? null;
      const providerId = accountId === null ? null : accountProvider.get(accountId) ?? null;
      const name = providerId === null ? undefined : providerName.get(providerId);
      if (name) usage.set(name, (usage.get(name) ?? 0) + 1);
      else unassigned += 1;
    }
  }
  const palette: ChartColor[] = ["--dash-teal", "--dash-blue", "--dash-purple", "--dash-indigo", "--dash-amber", "--dash-green"];
  const usageItems = [...usage.entries()].sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value, color: palette[i % palette.length] }));
  if (unassigned) usageItems.push({ label: "No provider", value: unassigned, color: "--dash-muted" });
  const totalIps = usageItems.reduce((sum, item) => sum + item.value, 0);
  const names = (list: CloudProviderOption[]) => list.map((p) => p.name).join(", ");

  return <div className="admin-tab-content nm-motion">
    <div className="nm-bento nm-bento--four">
      <AdminCard title="External IPs by provider" icon={<PieChart size={16} />}>
        {usageQuery.error ? <p className="tool-note nm-chart-empty">External IP usage is unavailable.</p>
          : totalIps ? <DonutChart label="External IP addresses by provider" centre={<CountUp value={totalIps} />} sub="IPs" items={usageItems} />
          : <p className="tool-note nm-chart-empty">No external IPs recorded yet.</p>}
      </AdminCard>
      <div className="dash-stats nm-bento-stats nm-summary-band">
        <DashStat accent="teal" className="nm-motion-item" icon={<Cloud size={20} />} label="Providers" value={<CountUp value={providers.length} />} sub={names(providers) || "None yet"} />
        <DashStat accent="blue" className="nm-motion-item" icon={<Package size={20} />} label="Built in" value={<CountUp value={builtIn.length} />} sub="Seeded on install" />
        <DashStat accent="purple" className="nm-motion-item" icon={<Sparkles size={20} />} label="Custom" value={<CountUp value={custom.length} />} sub={names(custom) || "Add one alongside"} />
        <DashStat accent="amber" className="nm-motion-item" icon={<Unlink size={20} />} label="Unassigned IPs" value={<CountUp value={unassigned} />} sub="No provider set" />
      </div>
    </div>
    <div className="nm-console">
      <div className="nm-console-main">
  <section className="panel admin-panel nm-app-panel cloud-provider-admin nm-fill nm-motion-item" aria-label="Cloud providers">
    <div className="nm-app-panel-header admin-panel-header">
      <span className="admin-panel-identity">
        <span className="admin-panel-icon" aria-hidden="true"><Globe size={17} /></span>
        <span className="admin-panel-title-wrap">
          <span className="admin-panel-title">Cloud providers</span>
          <span className="admin-panel-meta">Shared by External IPs and Cloud assets</span>
        </span>
      </span>
    </div>
      <AdminTaskPanel title="Provider catalogue" icon={<Cloud size={18} />}>

    <div className="cloud-provider-list">{query.isLoading ? <PanelSkeleton lines={4} /> : providers.length === 0 ? <p className="tool-note">No providers yet.</p> : providers.map((provider) => <div className="cloud-provider-row" key={provider.key}><span className="cloud-provider-logo"><CloudProviderIcon icon={provider.icon} iconData={provider.icon_data} size={20} /></span><span className="cloud-provider-copy"><strong>{provider.name}</strong><small>{provider.aliases.length ? `Aliases: ${provider.aliases.join(", ")}` : "No aliases"}{provider.builtin ? " · built in" : ""}</small></span><span className="cloud-provider-actions"><label className="nm-btn nm-btn--sm"><Upload size={13} />Replace icon<input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" onChange={(event) => { void replaceIcon(provider, event.target.files?.[0]); event.target.value = ""; }} disabled={busy === provider.key} /></label><button className="nm-btn nm-btn--sm nm-btn--danger" type="button" onClick={() => void removeProvider(provider)} disabled={busy === provider.key}><Trash2 size={13} />Remove</button></span></div>)}</div>
      </AdminTaskPanel>
  </section>
      </div>
      <aside className="nm-console-side">
      <AdminTaskPanel title="New provider" icon={<Cloud size={18} />} className="nm-fill">
    <form className="cloud-provider-create" onSubmit={createProvider}>
      <label className="nm-field"><span>Provider name</span><input className="nm-input" value={name} maxLength={80} placeholder="e.g. Oracle Cloud" onChange={(event) => setName(event.target.value)} /></label>
      <label className="nm-field"><span>Matching aliases</span><input className="nm-input" value={aliases} placeholder="OCI, Oracle, Oracle Cloud Infrastructure" onChange={(event) => setAliases(event.target.value)} /></label>
      <label className={`cloud-provider-file nm-btn${iconData ? " has-icon" : ""}`}>{iconData ? <img src={iconData} alt="Selected provider icon" /> : <Upload size={18} />}<span>{iconData ? "Icon selected" : "Choose icon"}</span><input type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" onChange={(event) => { void chooseNewIcon(event.target.files?.[0]); event.target.value = ""; }} /></label>
      <button className="nm-btn nm-btn--primary" type="submit" disabled={busy === "create" || !name.trim() || !iconData}><Plus size={14} />{busy === "create" ? "Adding…" : "Add provider"}</button>
    </form>
      </AdminTaskPanel>
      </aside>
    </div>
  </div>;
}

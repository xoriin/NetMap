import { AdminTaskPanel } from "../AdminTaskPanel";
import { useState, type FormEvent } from "react";
import { IconServer } from "@tabler/icons-react";
import { KeyRound, Layers, Lock, PieChart, Plug } from "lucide-react";
import { DashStat } from "../../../components/DashStat";
import { CountUp, DonutChart } from "../../../components/Charts";
import { AdminCard } from "../AdminCard";
import { api, type SnmpProfile } from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";

export function CredentialsTab({
  accessToken,
  onError,
  onSuccess,
}: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const [snmpProfileForm, setSnmpProfileForm] = useState({ name: "", community: "", port: "161", timeout_seconds: "3", retries: "1" });
  const [editing, setEditing] = useState<SnmpProfile | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);

  const snmpQuery = useApiQuery(() => api.listSnmpProfiles(accessToken), [accessToken]);
  const snmpProfiles = snmpQuery.data ?? [];
  const snmpProfilesBusy = mutationBusy || snmpQuery.isLoading || snmpQuery.isRefreshing;

  function resetForm() {
    setEditing(null);
    setSnmpProfileForm({ name: "", community: "", port: "161", timeout_seconds: "3", retries: "1" });
  }

  function editProfile(profile: SnmpProfile) {
    setEditing(profile);
    setSnmpProfileForm({ name: profile.name, community: "", port: String(profile.port), timeout_seconds: String(profile.timeout_seconds), retries: String(profile.retries) });
  }

  async function saveSnmpProfile(event: FormEvent) {
    event.preventDefault();
    setMutationBusy(true);
    onError(null); onSuccess(null);
    const fields = {
      name: snmpProfileForm.name.trim(),
      port: Number(snmpProfileForm.port),
      timeout_seconds: Number(snmpProfileForm.timeout_seconds),
      retries: Number(snmpProfileForm.retries),
    };
    try {
      const saved = editing
        ? await api.updateSnmpProfile(accessToken, editing.id, snmpProfileForm.community ? { ...fields, community: snmpProfileForm.community } : fields)
        : await api.createSnmpProfile(accessToken, { ...fields, community: snmpProfileForm.community });
      snmpQuery.setData((current) => [...(current ?? []).filter((item) => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      resetForm();
      onSuccess(`SNMP profile "${saved.name}" ${editing ? "updated" : "created"}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : `Unable to ${editing ? "update" : "create"} SNMP profile`);
    } finally {
      setMutationBusy(false);
    }
  }

  async function deleteSnmpProfile(profile: SnmpProfile) {
    setMutationBusy(true);
    onError(null); onSuccess(null);
    try {
      await api.deleteSnmpProfile(accessToken, profile.id);
      snmpQuery.setData((current) => (current ?? []).filter((item) => item.id !== profile.id));
      if (editing?.id === profile.id) resetForm();
      onSuccess(`SNMP profile "${profile.name}" deleted.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to delete SNMP profile");
    } finally {
      setMutationBusy(false);
    }
  }

  const versionTag = (version: string) => `v${version.replace(/^v/i, "")}`;
  const v3 = snmpProfiles.filter((p) => versionTag(p.version) === "v3").length;
  const v2 = snmpProfiles.length - v3;
  const portCounts = new Map<number, number>();
  for (const p of snmpProfiles) portCounts.set(p.port, (portCounts.get(p.port) ?? 0) + 1);
  const [topPort, topPortCount] = [...portCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];

  return (
    <div className="admin-tab-content nm-motion">
      <div className="nm-bento nm-bento--four">
        <AdminCard hero title="Profiles by Version" icon={<PieChart size={16} />}>
          {snmpProfiles.length
            ? <DonutChart viewId="admin.snmp.versions" label="SNMP profiles by version" centre={<CountUp value={snmpProfiles.length} />} sub="Profiles" items={[
                { label: "SNMPv3", value: v3, color: "--dash-green" },
                { label: "SNMPv2c", value: v2, color: "--dash-blue" },
              ]} />
            : <p className="tool-note nm-chart-empty">No SNMP profiles yet.</p>}
        </AdminCard>
        <div className="dash-stats nm-bento-stats nm-summary-band">
          <DashStat accent="teal" className="nm-motion-item" icon={<Layers size={20} />} label="Profiles" value={<CountUp value={snmpProfiles.length} />}
            sub={snmpProfiles.length ? snmpProfiles.map((p) => p.name).join(", ") : "None configured"} />
          <DashStat accent="green" className="nm-motion-item" icon={<Lock size={20} />} label="SNMPv3" value={<CountUp value={v3} />} sub="Authenticated and encrypted" />
          <DashStat accent="blue" className="nm-motion-item" icon={<KeyRound size={20} />} label="SNMPv2c" value={<CountUp value={v2} />} sub="Community string" />
          <DashStat accent="purple" className="nm-motion-item" icon={<Plug size={20} />} label="Most used port" value={topPort ?? "—"}
            sub={topPort ? `${topPortCount} of ${snmpProfiles.length} profiles` : "No profiles yet"} />
        </div>
      </div>
      <div className="nm-console">
        <div className="nm-console-main">
          <section className="panel admin-panel nm-app-panel nm-fill nm-motion-item" aria-label="SNMP Profiles">
            <div className="admin-panel-header nm-app-panel-header">
              <h2 className="admin-section-title"><IconServer size={16} />SNMP Profiles</h2>
              <button type="button" className="nm-btn" disabled={snmpProfilesBusy} onClick={() => void snmpQuery.reload()}>
                Refresh
              </button>
            </div>
            <p className="tool-note">
              Reusable credentials for probes, discovery ARP enrichment and router or L3-switch devices.
            </p>
            <AdminTaskPanel title="Profile Library" icon={<IconServer size={18} />}>
              <div className="admin-users-table admin-snmp-table">
                <div className="admin-users-header">
                  <span>Profile</span>
                  <span>Version</span>
                  <span>Port</span>
                  <span>Timeout</span>
                  <span>Retries</span>
                  <span className="admin-col-right">Actions</span>
                </div>
                {snmpProfiles.map((profile) => (
                  <div className="admin-users-row" key={profile.id}>
                    <div className="admin-user-identity">
                      <span className="admin-user-name">{profile.name}</span>
                    </div>
                    <span><span className="notif-method-tag">{versionTag(profile.version)}</span></span>
                    <span>{profile.port}</span>
                    <span>{profile.timeout_seconds} s</span>
                    <span>{profile.retries}</span>
                    <div className="admin-row-actions">
                      <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={snmpProfilesBusy} aria-pressed={editing?.id === profile.id}
                        aria-label={`Edit ${profile.name}`} onClick={() => editProfile(profile)}>Edit</button>
                      <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={snmpProfilesBusy}
                        aria-label={`Delete ${profile.name}`} onClick={() => void deleteSnmpProfile(profile)}>Delete</button>
                    </div>
                  </div>
                ))}
                {snmpProfiles.length === 0 && <p className="audit-empty">No SNMP profiles configured.</p>}
              </div>
            </AdminTaskPanel>
          </section>
        </div>
        <aside className="nm-console-side">
          <AdminTaskPanel title={editing ? `Edit ${editing.name}` : "Add SNMP Profile"} icon={<IconServer size={18} />} className="nm-fill">
            <form className="tool-form admin-create-form" onSubmit={saveSnmpProfile}>
              <label>
                Name
                <input required maxLength={120} placeholder="Core network SNMP" value={snmpProfileForm.name} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, name: e.target.value }))} />
              </label>
              <label>
                Community{editing && <span className="tool-note" style={{ fontWeight: "normal" }}> (leave blank to keep)</span>}
                <input required={!editing} maxLength={128} type="password" value={snmpProfileForm.community} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, community: e.target.value }))} />
              </label>
              <div className="tool-form-grid admin-snmp-numbers">
                <label>
                  Port
                  <input required min={1} max={65535} type="number" value={snmpProfileForm.port} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, port: e.target.value }))} />
                </label>
                <label>
                  Timeout
                  <input required min={1} max={15} type="number" value={snmpProfileForm.timeout_seconds} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, timeout_seconds: e.target.value }))} />
                </label>
                <label>
                  Retries
                  <input required min={0} max={3} type="number" value={snmpProfileForm.retries} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, retries: e.target.value }))} />
                </label>
              </div>
              <div className="admin-row-actions">
                <button type="submit" className="nm-btn nm-btn--primary" disabled={snmpProfilesBusy}>
                  {snmpProfilesBusy ? "Saving..." : editing ? "Save changes" : "Create profile"}
                </button>
                {editing && <button type="button" className="nm-btn nm-btn--secondary" onClick={resetForm}>Cancel</button>}
              </div>
            </form>
          </AdminTaskPanel>
        </aside>
      </div>
    </div>
  );
}

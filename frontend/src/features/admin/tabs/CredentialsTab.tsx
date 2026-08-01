import { useState, type FormEvent } from "react";
import { IconServer } from "@tabler/icons-react";
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
  const [mutationBusy, setMutationBusy] = useState(false);

  const snmpQuery = useApiQuery(() => api.listSnmpProfiles(accessToken), [accessToken]);
  const snmpProfiles = snmpQuery.data ?? [];
  const snmpProfilesBusy = mutationBusy || snmpQuery.isLoading || snmpQuery.isRefreshing;

  async function createSnmpProfile(event: FormEvent) {
    event.preventDefault();
    setMutationBusy(true);
    onError(null); onSuccess(null);
    try {
      const created = await api.createSnmpProfile(accessToken, {
        name: snmpProfileForm.name.trim(),
        community: snmpProfileForm.community,
        port: Number(snmpProfileForm.port),
        timeout_seconds: Number(snmpProfileForm.timeout_seconds),
        retries: Number(snmpProfileForm.retries),
      });
      snmpQuery.setData((current) => [...(current ?? []), created].sort((a, b) => a.name.localeCompare(b.name)));
      setSnmpProfileForm({ name: "", community: "", port: "161", timeout_seconds: "3", retries: "1" });
      onSuccess(`SNMP profile "${created.name}" created.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to create SNMP profile");
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
      onSuccess(`SNMP profile "${profile.name}" deleted.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to delete SNMP profile");
    } finally {
      setMutationBusy(false);
    }
  }

  return (
    <div className="admin-tab-content">
      <section className="panel admin-panel nm-app-panel">
        <div className="admin-panel-header nm-app-panel-header">
          <h2 className="admin-section-title"><IconServer size={16} />SNMP profiles</h2>
          <button type="button" className="nm-btn" disabled={snmpProfilesBusy} onClick={() => void snmpQuery.reload()}>
            Refresh
          </button>
        </div>
        <p className="tool-note">
          SNMPv2c profiles store reusable community strings for probes, discovery ARP enrichment, and assigned router/L3-switch devices.
        </p>
        <form className="tool-form admin-create-form" onSubmit={createSnmpProfile}>
          <h3>Add SNMP profile</h3>
          <div className="tool-form-grid">
            <label>
              Name
              <input required maxLength={120} placeholder="Core network SNMP" value={snmpProfileForm.name} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, name: e.target.value }))} />
            </label>
            <label>
              Community
              <input required maxLength={128} type="password" value={snmpProfileForm.community} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, community: e.target.value }))} />
            </label>
          </div>
          <div className="tool-form-grid">
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
          <button type="submit" className="nm-btn nm-btn--primary" disabled={snmpProfilesBusy}>
            {snmpProfilesBusy ? "Saving..." : "Create profile"}
          </button>
        </form>
        <div className="admin-users-table">
          <div className="admin-users-header">
            <span>Profile</span>
            <span className="admin-col-center">Version</span>
            <span className="admin-col-center">Connection</span>
            <span className="admin-col-center">Actions</span>
          </div>
          {snmpProfiles.map((profile) => (
            <div className="admin-users-row" key={profile.id}>
              <div className="admin-user-identity">
                <span className="admin-user-name">{profile.name}</span>
              </div>
              <span className="admin-col-center">{profile.version}</span>
              <span className="admin-col-center">:{profile.port} · {profile.timeout_seconds}s · {profile.retries} retries</span>
              <div className="admin-row-actions">
                <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={snmpProfilesBusy} onClick={() => void deleteSnmpProfile(profile)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          {snmpProfiles.length === 0 && <p className="audit-empty">No SNMP profiles configured.</p>}
        </div>
      </section>
    </div>
  );
}

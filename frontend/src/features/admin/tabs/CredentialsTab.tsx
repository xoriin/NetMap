import { AdminTaskPanel } from "../AdminTaskPanel";
import { useState, type FormEvent } from "react";
import { IconServer } from "@tabler/icons-react";
import { KeyRound, Layers, Lock, PieChart, Plug } from "lucide-react";
import { DashStat } from "../../../components/DashStat";
import { CountUp, DonutChart } from "../../../components/Charts";
import { AdminCard } from "../AdminCard";
import {
  ApiError,
  api,
  type SnmpAuthProtocol,
  type SnmpPrivProtocol,
  type SnmpProfile,
  type SnmpProfileWrite,
  type SnmpSecurityLevel,
  type SnmpVersion,
} from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";

const AUTH_PROTOCOLS: SnmpAuthProtocol[] = ["MD5", "SHA", "SHA-224", "SHA-256", "SHA-384", "SHA-512"];
const PRIV_PROTOCOLS: SnmpPrivProtocol[] = ["DES", "AES", "AES-192", "AES-256"];
const KEEP_SECRET = "leave blank to keep";

const emptyForm = {
  name: "",
  version: "v2c" as SnmpVersion,
  community: "",
  username: "",
  security_level: "authPriv" as SnmpSecurityLevel,
  auth_protocol: "SHA-256" as SnmpAuthProtocol,
  auth_key: "",
  priv_protocol: "AES" as SnmpPrivProtocol,
  priv_key: "",
  context_name: "",
  port: "161",
  timeout_seconds: "3",
  retries: "1",
};

type ProfileForm = typeof emptyForm;

function versionTag(version: string) {
  return `v${version.replace(/^v/i, "")}`;
}

function isV3(version: string) {
  return versionTag(version) === "v3";
}

function needsAuth(level: SnmpSecurityLevel) {
  return level === "authNoPriv" || level === "authPriv";
}

function formErrorMessage(err: unknown, fallback: string) {
  if (err instanceof ApiError && typeof err.detail === "string" && err.detail.trim()) return err.detail;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function secretLengthError(label: string, value: string, required: boolean) {
  if (!value) return required ? `${label} is required.` : null;
  if (value.length < 8 || value.length > 256) return `${label} must be 8 to 256 characters.`;
  return null;
}

function buildSnmpProfilePayload(form: ProfileForm, editing: SnmpProfile | null): { payload: SnmpProfileWrite } | { error: string } {
  const name = form.name.trim();
  if (!name) return { error: "Name is required." };
  if (name.length > 120) return { error: "Name must be at most 120 characters." };
  const payload: SnmpProfileWrite = {
    name,
    version: form.version,
    port: Number(form.port),
    timeout_seconds: Number(form.timeout_seconds),
    retries: Number(form.retries),
  };
  if (form.version === "v2c") {
    const community = form.community.trim();
    const mustSet = !editing?.has_community;
    if (!community && mustSet) return { error: "Community is required." };
    if (community && (community.length < 1 || community.length > 128)) return { error: "Community must be 1 to 128 characters." };
    if (community) payload.community = community;
    return { payload };
  }
  const username = form.username.trim();
  if (!username) return { error: "Username is required." };
  if (username.length > 255) return { error: "Username must be at most 255 characters." };
  payload.username = username;
  payload.security_level = form.security_level;
  const context = form.context_name.trim();
  if (context.length > 255) return { error: "Context name must be at most 255 characters." };
  payload.context_name = context || null;
  if (needsAuth(form.security_level)) {
    payload.auth_protocol = form.auth_protocol;
    const authError = secretLengthError("Auth key", form.auth_key, !editing?.has_auth_key);
    if (authError) return { error: authError };
    if (form.auth_key) payload.auth_key = form.auth_key;
  }
  if (form.security_level === "authPriv") {
    payload.priv_protocol = form.priv_protocol;
    const privError = secretLengthError("Privacy key", form.priv_key, !editing?.has_priv_key);
    if (privError) return { error: privError };
    if (form.priv_key) payload.priv_key = form.priv_key;
  }
  return { payload };
}

export function CredentialsTab({
  accessToken,
  onError,
  onSuccess,
}: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const [snmpProfileForm, setSnmpProfileForm] = useState<ProfileForm>(emptyForm);
  const [editing, setEditing] = useState<SnmpProfile | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);

  const snmpQuery = useApiQuery(() => api.listSnmpProfiles(accessToken), [accessToken]);
  const snmpProfiles = snmpQuery.data ?? [];
  const snmpProfilesBusy = mutationBusy || snmpQuery.isLoading || snmpQuery.isRefreshing;

  function updateForm<K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) {
    setSnmpProfileForm((current) => ({ ...current, [key]: value }));
  }

  function resetForm() {
    setEditing(null);
    setSnmpProfileForm(emptyForm);
  }

  function editProfile(profile: SnmpProfile) {
    setEditing(profile);
    setSnmpProfileForm({
      name: profile.name,
      version: isV3(profile.version) ? "v3" : "v2c",
      community: "",
      username: profile.username ?? "",
      security_level: (profile.security_level as SnmpSecurityLevel | null) ?? "authPriv",
      auth_protocol: (profile.auth_protocol as SnmpAuthProtocol | null) ?? "SHA-256",
      auth_key: "",
      priv_protocol: (profile.priv_protocol as SnmpPrivProtocol | null) ?? "AES",
      priv_key: "",
      context_name: profile.context_name ?? "",
      port: String(profile.port),
      timeout_seconds: String(profile.timeout_seconds),
      retries: String(profile.retries),
    });
  }

  async function saveSnmpProfile(event: FormEvent) {
    event.preventDefault();
    const built = buildSnmpProfilePayload(snmpProfileForm, editing);
    if ("error" in built) {
      onError(built.error);
      return;
    }
    setMutationBusy(true);
    onError(null); onSuccess(null);
    try {
      const saved = editing
        ? await api.updateSnmpProfile(accessToken, editing.id, built.payload)
        : await api.createSnmpProfile(accessToken, built.payload);
      snmpQuery.setData((current) => [...(current ?? []).filter((item) => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      resetForm();
      onSuccess(`SNMP profile "${saved.name}" ${editing ? "updated" : "created"}.`);
    } catch (err) {
      onError(formErrorMessage(err, `Unable to ${editing ? "update" : "create"} SNMP profile`));
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
      onError(formErrorMessage(err, "Unable to delete SNMP profile"));
    } finally {
      setMutationBusy(false);
    }
  }

  const v3 = snmpProfiles.filter((profile) => isV3(profile.version)).length;
  const v2 = snmpProfiles.length - v3;
  const portCounts = new Map<number, number>();
  for (const profile of snmpProfiles) portCounts.set(profile.port, (portCounts.get(profile.port) ?? 0) + 1);
  const [topPort, topPortCount] = [...portCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const showAuth = snmpProfileForm.version === "v3" && needsAuth(snmpProfileForm.security_level);
  const showPriv = snmpProfileForm.version === "v3" && snmpProfileForm.security_level === "authPriv";
  const keepCommunity = Boolean(editing?.has_community);
  const keepAuth = Boolean(editing?.has_auth_key);
  const keepPriv = Boolean(editing?.has_priv_key);

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
                <input required maxLength={120} placeholder="Core network SNMP" value={snmpProfileForm.name} onChange={(e) => updateForm("name", e.target.value)} />
              </label>
              <label>
                Version
                <select value={snmpProfileForm.version} onChange={(e) => updateForm("version", e.target.value as SnmpVersion)}>
                  <option value="v2c">SNMPv2c</option>
                  <option value="v3">SNMPv3</option>
                </select>
              </label>
              {snmpProfileForm.version === "v2c" && (
                <label>
                  Community
                  <input
                    required={!keepCommunity}
                    maxLength={128}
                    type="password"
                    autoComplete="off"
                    placeholder={keepCommunity ? KEEP_SECRET : undefined}
                    value={snmpProfileForm.community}
                    onChange={(e) => updateForm("community", e.target.value)}
                  />
                </label>
              )}
              {snmpProfileForm.version === "v3" && (
                <>
                  <label>
                    Username
                    <input required maxLength={255} autoComplete="off" value={snmpProfileForm.username} onChange={(e) => updateForm("username", e.target.value)} />
                  </label>
                  <label>
                    Security level
                    <select value={snmpProfileForm.security_level} onChange={(e) => updateForm("security_level", e.target.value as SnmpSecurityLevel)}>
                      <option value="noAuthNoPriv">noAuthNoPriv</option>
                      <option value="authNoPriv">authNoPriv</option>
                      <option value="authPriv">authPriv</option>
                    </select>
                  </label>
                  {showAuth && (
                    <>
                      <label>
                        Auth protocol
                        <select value={snmpProfileForm.auth_protocol} onChange={(e) => updateForm("auth_protocol", e.target.value as SnmpAuthProtocol)}>
                          {AUTH_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
                        </select>
                      </label>
                      <label>
                        Auth key
                        <input
                          required={!keepAuth}
                          minLength={keepAuth ? undefined : 8}
                          maxLength={256}
                          type="password"
                          autoComplete="off"
                          placeholder={keepAuth ? KEEP_SECRET : undefined}
                          value={snmpProfileForm.auth_key}
                          onChange={(e) => updateForm("auth_key", e.target.value)}
                        />
                      </label>
                    </>
                  )}
                  {showPriv && (
                    <>
                      <label>
                        Privacy protocol
                        <select value={snmpProfileForm.priv_protocol} onChange={(e) => updateForm("priv_protocol", e.target.value as SnmpPrivProtocol)}>
                          {PRIV_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
                        </select>
                      </label>
                      <label>
                        Privacy key
                        <input
                          required={!keepPriv}
                          minLength={keepPriv ? undefined : 8}
                          maxLength={256}
                          type="password"
                          autoComplete="off"
                          placeholder={keepPriv ? KEEP_SECRET : undefined}
                          value={snmpProfileForm.priv_key}
                          onChange={(e) => updateForm("priv_key", e.target.value)}
                        />
                      </label>
                    </>
                  )}
                  <label>
                    Context name
                    <input maxLength={255} autoComplete="off" value={snmpProfileForm.context_name} onChange={(e) => updateForm("context_name", e.target.value)} />
                  </label>
                </>
              )}
              <div className="tool-form-grid admin-snmp-numbers">
                <label>
                  Port
                  <input required min={1} max={65535} type="number" value={snmpProfileForm.port} onChange={(e) => updateForm("port", e.target.value)} />
                </label>
                <label>
                  Timeout
                  <input required min={1} max={15} type="number" value={snmpProfileForm.timeout_seconds} onChange={(e) => updateForm("timeout_seconds", e.target.value)} />
                </label>
                <label>
                  Retries
                  <input required min={0} max={3} type="number" value={snmpProfileForm.retries} onChange={(e) => updateForm("retries", e.target.value)} />
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

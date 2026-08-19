import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, KeySquare, Shield } from "lucide-react";
import { api, type ApiKeyAdmin, type OidcSettings, type OidcTestResult, type User } from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { useToast } from "../../../components/Toast";
import { useConfirm } from "../../../components/ConfirmDialog";
import { triggerDownload } from "../../../utils/download";

type SsoFormState = {
  enabled: boolean;
  provider_name: string;
  issuer: string;
  client_id: string;
  redirect_url: string;
  scopes: string;
  allowed_email_domains: string;
  auto_provision: boolean;
  link_by_email: boolean;
  allow_unverified_email: boolean;
  group_claim: string;
  role_mappings: string;
  manage_roles: boolean;
  default_role: string;
  allow_super_admin: boolean;
};

function formStateFrom(settings: OidcSettings): SsoFormState {
  return {
    enabled: settings.enabled,
    provider_name: settings.provider_name,
    issuer: settings.issuer,
    client_id: settings.client_id,
    redirect_url: settings.redirect_url,
    scopes: settings.scopes,
    allowed_email_domains: settings.allowed_email_domains,
    auto_provision: settings.auto_provision,
    link_by_email: settings.link_by_email,
    allow_unverified_email: settings.allow_unverified_email,
    group_claim: settings.group_claim,
    role_mappings: settings.role_mappings,
    manage_roles: settings.manage_roles,
    default_role: settings.default_role,
    allow_super_admin: settings.allow_super_admin,
  };
}

function SsoSettingsPanel({ accessToken }: { accessToken: string }) {
  const toast = useToast();
  const confirmAction = useConfirm();
  const settingsQuery = useApiQuery(() => api.getOidcSettings(accessToken), [accessToken]);
  const rolesQuery = useApiQuery(() => api.getRolePermissions(accessToken), [accessToken]);

  const [form, setForm] = useState<SsoFormState | null>(null);
  const [clientSecret, setClientSecret] = useState("");
  const [secretDirty, setSecretDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<OidcTestResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (settingsQuery.data && form === null) {
      setForm(formStateFrom(settingsQuery.data));
    }
  }, [settingsQuery.data, form]);

  const settings = settingsQuery.data;

  function update<K extends keyof SsoFormState>(key: K, value: SsoFormState[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setFormError(null);
    try {
      const payload = secretDirty ? { ...form, client_secret: clientSecret } : { ...form };
      const updated = await api.updateOidcSettings(accessToken, payload);
      settingsQuery.setData(updated);
      setForm(formStateFrom(updated));
      setClientSecret("");
      setSecretDirty(false);
      setTestResult(null);
      toast.success("Single sign-on settings saved");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to save SSO settings";
      setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function runProviderTest() {
    setTesting(true);
    setFormError(null);
    try {
      setTestResult(await api.testOidcProvider(accessToken));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Provider test failed");
    } finally {
      setTesting(false);
    }
  }

  async function toggleRequireSso(next: boolean) {
    if (!settings) return;
    if (next) {
      const confirmed = await confirmAction({
        title: "Require single sign-on?",
        message: "Local password sign-in will be disabled for everyone except SuperAdmins.",
        detail:
          "SuperAdmin local sign-in stays available as the emergency recovery path. NetMap verifies the provider configuration before enabling this, and you can turn it off again at any time. Save any pending settings changes first — this check runs against the stored configuration.",
        confirmLabel: "Require SSO",
        danger: true,
      });
      if (!confirmed) return;
    }
    setFormError(null);
    try {
      const updated = await api.updateOidcSettings(accessToken, { require_sso: next });
      settingsQuery.setData(updated);
      toast.success(next ? "SSO is now required for sign-in" : "Local sign-in re-enabled for all users");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to change SSO requirement";
      setFormError(message);
      toast.error(message);
    }
  }

  return (
    <section className="panel admin-panel nm-app-panel">
      <div className="admin-panel-header nm-app-panel-header">
        <h2 className="admin-section-title"><KeyRound size={16} />Single Sign-On (OIDC)</h2>
        <div className="admin-panel-actions">
          <button type="button" className="nm-btn" disabled={testing || !settings} onClick={() => void runProviderTest()}>
            {testing ? "Testing…" : "Test provider"}
          </button>
        </div>
      </div>
      {settingsQuery.error && <div className="form-error">{settingsQuery.error}</div>}
      {settings?.env_configured && (
        <p className="auth-field-hint">
          Some values are provided by environment variables; settings saved here override them.
        </p>
      )}
      {testResult && (
        <div className="sso-check-list">
          {testResult.checks.map((check) => (
            <div key={check.name} className={`sso-check-row ${check.ok ? "ok" : "err"}`}>
              <span className="sso-check-status">{check.ok ? "✓" : "✕"}</span>
              <span className="sso-check-name">{check.name.replace(/_/g, " ")}</span>
              <span className="sso-check-message">{check.message}</span>
            </div>
          ))}
        </div>
      )}
      {form && settings && (
        <form className="tool-form" onSubmit={(e) => void save(e)}>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => update("enabled", e.target.checked)} />
            <span className="tool-form-check-copy">
              <span>Enable "Continue with SSO" on the login screen</span>
              <span className="tool-note">Shows the SSO button on login while keeping local sign-in available unless SSO is required.</span>
            </span>
          </label>
          <div className="tool-form-grid">
            <label>Provider name (login button label)
              <input maxLength={60} placeholder="SSO" value={form.provider_name} onChange={(e) => update("provider_name", e.target.value)} />
            </label>
            <label>Issuer URL
              <input maxLength={512} placeholder="https://auth.example.com/realms/main" value={form.issuer} onChange={(e) => update("issuer", e.target.value)} />
            </label>
          </div>
          <div className="tool-form-grid">
            <label>Client ID
              <input maxLength={255} value={form.client_id} onChange={(e) => update("client_id", e.target.value)} />
            </label>
            <label>Client secret {settings.client_secret_set && !secretDirty ? "(stored — leave blank to keep)" : "(optional with PKCE)"}
              <input
                type="password"
                maxLength={512}
                autoComplete="new-password"
                placeholder={settings.client_secret_set ? "••••••••••••" : "Leave empty for a public client"}
                value={clientSecret}
                onChange={(e) => { setClientSecret(e.target.value); setSecretDirty(true); }}
              />
            </label>
          </div>
          <div className="tool-form-grid">
            <label>Redirect URL
              <input maxLength={512} placeholder={settings.effective_redirect_url || "Set APP_URL or enter the callback URL"} value={form.redirect_url} onChange={(e) => update("redirect_url", e.target.value)} />
            </label>
            <label>Scopes
              <input maxLength={255} placeholder="openid profile email" value={form.scopes} onChange={(e) => update("scopes", e.target.value)} />
            </label>
          </div>
          <span className="auth-field-hint">
            Register this redirect URL with the provider: {settings.effective_redirect_url || "(configure APP_URL or a redirect URL above)"}
          </span>
          <div className="tool-form-grid">
            <label>Allowed email domains (comma-separated, empty = any)
              <input maxLength={1024} placeholder="example.com, corp.example" value={form.allowed_email_domains} onChange={(e) => update("allowed_email_domains", e.target.value)} />
            </label>
            <label>Default role for new SSO users
              <select value={form.default_role} onChange={(e) => update("default_role", e.target.value)}>
                {Object.keys(rolesQuery.data?.roles ?? { NetworkAdmin: [], SecurityAnalyst: [], Viewer: [] })
                  .filter((role) => role !== "SuperAdmin")
                  .sort((left, right) => {
                    const order = ["Viewer", "SecurityAnalyst", "NetworkAdmin"];
                    const leftIndex = order.indexOf(left);
                    const rightIndex = order.indexOf(right);
                    if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
                    return left.localeCompare(right);
                  })
                  .map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
          </div>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={form.auto_provision} onChange={(e) => update("auto_provision", e.target.checked)} />
            <span className="tool-form-check-copy">
              <span>Auto-provision new users on first SSO sign-in</span>
              <span className="tool-note">Creates a NetMap user automatically after the provider identity passes validation.</span>
            </span>
          </label>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={form.link_by_email} onChange={(e) => update("link_by_email", e.target.checked)} />
            <span className="tool-form-check-copy">
              <span>Link first-time SSO sign-ins to existing users by verified email</span>
              <span className="tool-note">Allows an SSO identity to attach to an existing local account when the email is verified.</span>
            </span>
          </label>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={form.allow_unverified_email} onChange={(e) => update("allow_unverified_email", e.target.checked)} />
            <span className="tool-form-check-copy">
              <span>Accept unverified email addresses</span>
              <span className="tool-note">Only enable this for providers that do not send a verified email claim, such as some Microsoft Entra ID setups.</span>
            </span>
          </label>
          <div className="tool-form-grid">
            <label>Group claim name
              <input maxLength={120} placeholder="groups" value={form.group_claim} onChange={(e) => update("group_claim", e.target.value)} />
            </label>
            <label>{'Group → role mappings (JSON object)'}
              <input maxLength={4096} placeholder={'{"netmap-admins": "NetworkAdmin"}'} value={form.role_mappings} onChange={(e) => update("role_mappings", e.target.value)} />
            </label>
          </div>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={form.manage_roles} onChange={(e) => update("manage_roles", e.target.checked)} />
            <span className="tool-form-check-copy">
              <span>Provider-managed roles</span>
              <span className="tool-note">Re-applies mapped roles on every SSO sign-in. Leave off when local role assignments should win.</span>
            </span>
          </label>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={form.allow_super_admin} onChange={(e) => update("allow_super_admin", e.target.checked)} />
            <span className="tool-form-check-copy">
              <span>Allow role mappings to grant SuperAdmin</span>
              <span className="tool-note">Keep off unless the identity provider group mapping is tightly controlled and audited.</span>
            </span>
          </label>
          {formError && <div className="form-error">{formError}</div>}
          <button type="submit" className="nm-btn nm-btn--primary" disabled={saving}>
            {saving ? "Saving…" : "Save SSO settings"}
          </button>
        </form>
      )}
      {settings && (
        <div className="sso-require-block">
          <label className="tool-form-inline-check">
            <input
              type="checkbox"
              checked={settings.require_sso}
              onChange={(e) => void toggleRequireSso(e.target.checked)}
            />
            <span className="tool-form-check-copy">
              <span>Require SSO for sign-in</span>
              <span className="tool-note">SuperAdmins keep local sign-in as an emergency recovery path.</span>
            </span>
          </label>
          {settings.require_sso && (
            <span className="auth-field-hint">
              Local password sign-in is currently disabled for non-SuperAdmin users. Disable this toggle to roll back.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function ApiKeysOversightPanel({ accessToken }: { accessToken: string }) {
  const toast = useToast();
  const confirmAction = useConfirm();
  const keysQuery = useApiQuery(() => api.listAllApiKeys(accessToken), [accessToken]);
  const [revokeBusy, setRevokeBusy] = useState(false);

  async function revokeKey(key: ApiKeyAdmin) {
    const confirmed = await confirmAction({
      title: "Revoke this API key?",
      message: `"${key.name}" (owned by ${key.username}) will stop working immediately.`,
      detail: "Any integration or script using this key will lose access to NetMap. This cannot be undone.",
      confirmLabel: "Revoke key",
      danger: true,
    });
    if (!confirmed) return;
    setRevokeBusy(true);
    try {
      await api.adminRevokeApiKey(accessToken, key.id);
      toast.success(`API key "${key.name}" revoked`);
      await keysQuery.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke API key");
    } finally {
      setRevokeBusy(false);
    }
  }

  const keys = keysQuery.data ?? [];
  const activeKeys = keys.filter((key) => key.revoked_at === null);
  const revokedCount = keys.length - activeKeys.length;

  return (
    <section className="panel admin-panel nm-app-panel">
      <div className="admin-panel-header nm-app-panel-header">
        <h2 className="admin-section-title"><KeySquare size={16} />API Keys</h2>
        <div className="admin-panel-actions">
          <button type="button" className="nm-btn" onClick={() => void keysQuery.reload()}>Refresh</button>
        </div>
      </div>
      {keysQuery.error && <div className="form-error">{keysQuery.error}</div>}
      <p className="auth-field-hint">
        All registered API keys across users. Keys inherit their owner's role permissions; users create their own
        keys from the Profile page.{revokedCount > 0 ? ` ${revokedCount} revoked key${revokedCount === 1 ? "" : "s"} hidden.` : ""}
      </p>
      {activeKeys.length === 0
        ? <p className="auth-field-hint">{keysQuery.isLoading ? "Loading…" : "No active API keys."}</p>
        : (
          <div className="nm-table-wrap">
            <table className="nm-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {activeKeys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.username}</td>
                    <td>{key.name}</td>
                    <td>
                      <span
                        className="profile-key-mask nm-table-mono"
                        title={key.suffix
                          ? "Only the final four characters are retained for identification"
                          : "The ending will appear after this legacy key is next successfully used"}
                      >
                        {key.suffix ? `•••• •••• •••• ${key.suffix}` : "•••• •••• •••• ••••"}
                      </span>
                    </td>
                    <td>{new Date(key.created_at).toLocaleDateString()}</td>
                    <td>{key.expires_at ? new Date(key.expires_at).toLocaleDateString() : "Never"}</td>
                    <td>{key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "Never"}</td>
                    <td className="nm-table-actions">
                      <button
                        type="button"
                        className="nm-btn nm-btn--sm nm-btn--danger"
                        disabled={revokeBusy}
                        onClick={() => void revokeKey(key)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

export function SecurityTab({
  accessToken,
  users,
  initialUserFilter,
}: {
  accessToken: string;
  users: User[];
  initialUserFilter: number | null;
}) {
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditUserFilter, setAuditUserFilter] = useState<number | null>(initialUserFilter);
  const [auditView, setAuditView] = useState<"all" | "login">("all");
  const [exportBusy, setExportBusy] = useState(false);
  const toast = useToast();

  async function exportLoginHistory() {
    setExportBusy(true);
    try {
      const result = await api.exportLoginHistory(accessToken, auditUserFilter ?? undefined);
      triggerDownload(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportBusy(false);
    }
  }

  const auditQuery = useApiQuery(() => {
    const params: { limit: number; offset: number; actor_user_id?: number; category?: "login" } = { limit: 50, offset: auditOffset };
    if (auditUserFilter !== null) params.actor_user_id = auditUserFilter;
    if (auditView === "login") params.category = "login";
    return api.listAuditLogs(accessToken, params);
  }, [accessToken, auditOffset, auditUserFilter, auditView]);

  const auditLogs = auditQuery.data?.records ?? [];
  const auditLogsTotal = auditQuery.data?.total ?? 0;

  function auditLogUsername(log: { actor_user_id: number | null; target: string | null }): string {
    if (log.actor_user_id) return users.find((u) => u.id === log.actor_user_id)?.username ?? `#${log.actor_user_id}`;
    if (log.target?.startsWith("user:")) return log.target.slice(5);
    return "—";
  }

  function loginResultBadge(action: string): { label: string; tone: "ok" | "warn" | "err" } {
    switch (action) {
      case "auth.login_success": return { label: "Success", tone: "ok" };
      case "auth.logout": return { label: "Logout", tone: "ok" };
      case "auth.login_failed": return { label: "Failed", tone: "err" };
      case "auth.login_blocked": return { label: "Blocked (rate limit)", tone: "err" };
      case "auth.login_blocked_sso_required": return { label: "Blocked (SSO required)", tone: "warn" };
      default: return { label: action, tone: "warn" };
    }
  }

  function ipFromDetail(detail: string | null): string {
    const match = detail?.match(/ip=(\S+)/);
    return match ? match[1] : "—";
  }

  return (
    <div className="admin-tab-content">
      <SsoSettingsPanel accessToken={accessToken} />
      <ApiKeysOversightPanel accessToken={accessToken} />
      <section className="panel admin-panel nm-app-panel admin-security-audit-panel">
        <div className="admin-panel-header nm-app-panel-header">
          <h2 className="admin-section-title"><Shield size={16} />{auditUserFilter ? `Activity — ${users.find((u) => u.id === auditUserFilter)?.username ?? "user"}` : auditView === "login" ? "Login History" : "Login & Audit History"}</h2>
          <div className="admin-panel-actions">
            <button type="button" className={`nm-btn nm-btn--sm${auditView === "all" ? " nm-btn--active" : ""}`} onClick={() => { setAuditView("all"); setAuditOffset(0); }}>All activity</button>
            <button type="button" className={`nm-btn nm-btn--sm${auditView === "login" ? " nm-btn--active" : ""}`} onClick={() => { setAuditView("login"); setAuditOffset(0); }}>Login history</button>
            {auditView === "login" && (
              <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={exportBusy} onClick={() => void exportLoginHistory()}>
                {exportBusy ? "Exporting…" : "Export CSV"}
              </button>
            )}
            {auditUserFilter && <button type="button" className="nm-btn" onClick={() => { setAuditUserFilter(null); setAuditOffset(0); }}>All users</button>}
            <button type="button" className="nm-btn" onClick={() => void auditQuery.reload()}>Refresh</button>
          </div>
        </div>
        {auditQuery.error && <div className="form-error">{auditQuery.error}</div>}
        {auditView === "login" ? (
          <div className="audit-log-table audit-log-table--login">
            <div className="audit-log-header">
              <span>Time</span>
              <span>User</span>
              <span>Result</span>
              <span>IP address</span>
            </div>
            {auditLogs.length === 0 && <p className="audit-empty">{auditQuery.isLoading ? "Loading…" : "No login events found."}</p>}
            {auditLogs.map((log) => {
              const dt = new Date(log.created_at);
              const result = loginResultBadge(log.action);
              return (
                <div className="audit-log-row" key={log.id}>
                  <div className="audit-time-cell">
                    <span className="audit-date">{dt.toLocaleDateString()}</span>
                    <span className="audit-time">{dt.toLocaleTimeString()}</span>
                  </div>
                  <span className="audit-actor">{auditLogUsername(log)}</span>
                  <span className={`notif-result${result.tone === "ok" ? " ok" : " err"}`}>{result.label}</span>
                  <span className="audit-detail nm-table-mono">{ipFromDetail(log.detail)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="audit-log-table">
            <div className="audit-log-header">
              <span>Time</span>
              <span>Event</span>
              <span>Actor</span>
              <span>Context</span>
            </div>
            {auditLogs.length === 0 && <p className="audit-empty">{auditQuery.isLoading ? "Loading…" : "No audit records found."}</p>}
            {auditLogs.map((log) => {
              const dt = new Date(log.created_at);
              const category = log.action.split(".")[0];
              const actor = log.actor_user_id
                ? (users.find((u) => u.id === log.actor_user_id)?.username ?? `#${log.actor_user_id}`)
                : "system";
              return (
                <div className="audit-log-row" key={log.id}>
                  <div className="audit-time-cell">
                    <span className="audit-date">{dt.toLocaleDateString()}</span>
                    <span className="audit-time">{dt.toLocaleTimeString()}</span>
                  </div>
                  <div className="audit-event-cell">
                    <span className={`audit-category-badge audit-category-badge--${category}`}>{category}</span>
                    <span className="audit-action">{log.action.includes(".") ? log.action.slice(log.action.indexOf(".") + 1) : log.action}</span>
                  </div>
                  <span className="audit-actor">{actor}</span>
                  <div className="audit-context-cell">
                    {log.target && <span className="audit-target">{log.target}</span>}
                    {log.detail && <span className="audit-detail">{log.detail}</span>}
                    {!log.target && !log.detail && <span className="audit-detail">—</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="audit-pagination">
          <button type="button" className="nm-btn" disabled={auditOffset === 0} onClick={() => setAuditOffset((current) => Math.max(0, current - 50))}>← Prev</button>
          <span>{auditOffset + 1}–{Math.min(auditOffset + 50, auditLogsTotal)} of {auditLogsTotal}</span>
          <button type="button" className="nm-btn" disabled={auditOffset + 50 >= auditLogsTotal} onClick={() => setAuditOffset((current) => current + 50)}>Next →</button>
        </div>
      </section>
    </div>
  );
}

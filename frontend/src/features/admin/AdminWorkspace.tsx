import { useState, useEffect, useMemo, type FormEvent } from "react";
import { Settings, Shield, Check, X, Pencil, UserCircle } from "lucide-react";
import {
  IconUsers, IconShieldCheck, IconCloud, IconAlertCircle,
  IconDatabase, IconDeviceDesktop, IconBolt, IconPalette, IconServer,
} from "@tabler/icons-react";
import {
  api,
  type User, type SyslogStatus, type SystemSettings, type NotificationSettings,
  type AlertRule, type AlertRulePayload, type AlertRuleEventType,
  type RolePermissions, type VersionInfo, type SystemDiagnostics,
  type DashboardSummary, type TopologyGraph, type AuditLog,
} from "../../api/client";
import { builtInIconPack, allRuntimePacks, type IconPack } from "../../icons";
import { userInitials, formatEventTime } from "../../utils/format";
import { triggerDownload } from "../../utils/download";
import { IconManagerModal } from "../../components/IconManagerModal";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function AdminWorkspace({
  accessToken,
  graph,
  summary,
  activeIconPackId,
  iconPackError,
  iconPackLoading,
  iconPacks,
  localIconPacks,
  onSelectIconPack,
  onAddLocalIconPack,
  onRemoveLocalIconPack,
  versionInfo,
}: {
  accessToken: string;
  graph: TopologyGraph;
  summary: DashboardSummary | null;
  activeIconPackId: string;
  iconPackError: string | null;
  iconPackLoading: boolean;
  iconPacks: IconPack[];
  localIconPacks: IconPack[];
  onSelectIconPack: (packId: string) => void;
  onAddLocalIconPack: (pack: IconPack) => void;
  onRemoveLocalIconPack: (packId: string) => void;
  versionInfo: VersionInfo | null;
}) {
  const [activeTab, setActiveTab] = useState<"system" | "users" | "security" | "notifications" | "alerts" | "groups">("system");
  const [users, setUsers] = useState<User[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [syslogStatus, setSyslogStatus] = useState<SyslogStatus | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLogsTotal, setAuditLogsTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditUserFilter, setAuditUserFilter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [resetPasswordForm, setResetPasswordForm] = useState<{ userId: number | null; password: string }>({ userId: null, password: "" });
  const [editingEmailId, setEditingEmailId] = useState<number | null>(null);
  const [editingEmailValue, setEditingEmailValue] = useState("");
  const [settingsForm, setSettingsForm] = useState<SystemSettings>({ app_name: "NetMap", login_message: "", announcement: "", live_ping_enabled: true, idle_timeout_minutes: 15, active_network_public_targets_enabled: false });
  const [idleTimeoutRaw, setIdleTimeoutRaw] = useState("15");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({ username: "", password: "", email: "", role: "Viewer", is_active: true });
  const [iconModalOpen, setIconModalOpen] = useState(false);
  const [notifSettings, setNotifSettings] = useState<NotificationSettings>({
    ntfy_url: "", ntfy_token: "",
    telegram_bot_token: "", telegram_chat_id: "",
    signal_url: "", signal_number: "", signal_recipient: "",
    smtp_host: "", smtp_port: "587", smtp_user: "", smtp_password: "", smtp_from: "", smtp_to: "", smtp_tls: "true",
  });
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifTestResult, setNotifTestResult] = useState<Record<string, string>>({});
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [alertRulesBusy, setAlertRulesBusy] = useState(false);
  const [alertRulesError, setAlertRulesError] = useState<string | null>(null);
  const [alertTestResults, setAlertTestResults] = useState<Record<number, Record<string, string>>>({});
  const [alertTestBusy, setAlertTestBusy] = useState<number | null>(null);
  const [showAlertForm, setShowAlertForm] = useState(false);
  const [editingAlertRule, setEditingAlertRule] = useState<AlertRule | null>(null);
  const [alertForm, setAlertForm] = useState<AlertRulePayload>({
    name: "",
    enabled: true,
    event_type: "device_offline",
    device_id: null,
    channels: [],
    cooldown_minutes: 30,
  });
  const [rolePermissions, setRolePermissions] = useState<RolePermissions | null>(null);
  const [localRolePerms, setLocalRolePerms] = useState<Record<string, string[]>>({});
  const [groupsBusy, setGroupsBusy] = useState(false);
  const [showNewGroupForm, setShowNewGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  async function loadAdminData() {
    setLoading(true);
    setError(null);
    try {
      const [userRows, syslog, settingsData] = await Promise.all([
        api.listUsers(accessToken),
        api.syslogStatus(accessToken),
        api.adminSettings(accessToken),
      ]);
      setUsers(userRows);
      setSyslogStatus(syslog);
      setSettingsForm(settingsData);
      setIdleTimeoutRaw(String(settingsData.idle_timeout_minutes));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load admin data");
    } finally {
      setLoading(false);
    }
  }

  async function loadAuditLogs(offset = 0, userId: number | null = null) {
    try {
      const params: { limit: number; offset: number; actor_user_id?: number } = { limit: 50, offset };
      if (userId !== null) params.actor_user_id = userId;
      const result = await api.listAuditLogs(accessToken, params);
      setAuditLogs(result.records);
      setAuditLogsTotal(result.total);
      setAuditOffset(offset);
      setAuditUserFilter(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load audit logs");
    }
  }

  useEffect(() => { void loadAdminData(); }, [accessToken]);
  useEffect(() => { if (activeTab === "security") void loadAuditLogs(0, null); }, [activeTab]);
  useEffect(() => {
    if (activeTab !== "notifications") return;
    void api.getNotificationSettings(accessToken).then(setNotifSettings).catch(() => {});
  }, [activeTab, accessToken]);
  useEffect(() => { if (activeTab === "alerts") void loadAlertRules(); }, [activeTab]);
  useEffect(() => {
    if (activeTab !== "groups") return;
    void api.getRolePermissions(accessToken).then((data) => {
      setRolePermissions(data);
      setLocalRolePerms(data.roles);
    }).catch(() => {});
  }, [activeTab, accessToken]);

  async function saveRolePermissions() {
    setGroupsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateRolePermissions(accessToken, localRolePerms);
      setRolePermissions(updated);
      setLocalRolePerms(updated.roles);
      setSuccess("Role permissions saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save role permissions");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function createGroup(name: string) {
    if (!name.trim()) return;
    setGroupsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.createRole(accessToken, name.trim());
      setRolePermissions(updated);
      setLocalRolePerms(updated.roles);
      setNewGroupName("");
      setShowNewGroupForm(false);
      setSuccess(`Role "${name.trim()}" created.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create role");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function deleteGroup(name: string) {
    setGroupsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.deleteRole(accessToken, name);
      setRolePermissions(updated);
      setLocalRolePerms(updated.roles);
      setSuccess(`Role "${name}" deleted. Affected users reassigned to Viewer.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete role");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function saveNotifSettings() {
    setNotifBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateNotificationSettings(accessToken, notifSettings);
      setNotifSettings(updated);
      setSuccess("Notification settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save notification settings");
    } finally { setNotifBusy(false); }
  }

  async function testNotif(channel: string) {
    setNotifTestResult((c) => ({ ...c, [channel]: "Sending…" }));
    try {
      await api.updateNotificationSettings(accessToken, notifSettings);
      const res = await api.testNotification(accessToken, channel);
      setNotifTestResult((c) => ({ ...c, [channel]: res.status === "ok" ? "Sent successfully" : res.status }));
    } catch (err) {
      setNotifTestResult((c) => ({ ...c, [channel]: err instanceof Error ? err.message : "Failed" }));
    }
  }

  async function loadAlertRules() {
    try {
      const rules = await api.listAlertRules(accessToken);
      setAlertRules(rules);
    } catch {
      // silent
    }
  }

  async function saveAlertRule() {
    setAlertRulesBusy(true);
    setAlertRulesError(null);
    try {
      if (editingAlertRule) {
        await api.updateAlertRule(accessToken, editingAlertRule.id, alertForm);
      } else {
        await api.createAlertRule(accessToken, alertForm);
      }
      setShowAlertForm(false);
      setEditingAlertRule(null);
      await loadAlertRules();
    } catch (err) {
      setAlertRulesError(err instanceof Error ? err.message : "Failed to save rule");
    } finally {
      setAlertRulesBusy(false);
    }
  }

  async function deleteAlertRule(id: number) {
    try {
      await api.deleteAlertRule(accessToken, id);
      await loadAlertRules();
    } catch {
      // silent
    }
  }

  async function toggleAlertRule(rule: AlertRule) {
    await api.updateAlertRule(accessToken, rule.id, { enabled: !rule.enabled });
    await loadAlertRules();
  }

  async function runAlertTest(ruleId: number) {
    setAlertTestBusy(ruleId);
    setAlertTestResults((prev) => ({ ...prev, [ruleId]: {} }));
    try {
      const raw = await api.testAlertRule(accessToken, ruleId);
      // Backend returns "ok" on success — normalise to a readable label
      const normalised = Object.fromEntries(
        Object.entries(raw).map(([ch, res]) => [ch, res === "ok" ? "Sent successfully" : res])
      );
      setAlertTestResults((prev) => ({ ...prev, [ruleId]: normalised }));
    } catch (err) {
      setAlertTestResults((prev) => ({ ...prev, [ruleId]: { error: err instanceof Error ? err.message : "Test failed" } }));
    } finally {
      setAlertTestBusy(null);
    }
  }

  async function updateUser(userId: number, payload: { role?: string; is_active?: boolean; email?: string | null; avatar_data?: string | null }) {
    setBusyUserId(userId);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateUser(accessToken, userId, payload);
      setUsers((current) => current.map((u) => (u.id === updated.id ? updated : u)));
      setSuccess(`Updated ${updated.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update user");
    } finally { setBusyUserId(null); }
  }

  function handleAdminAvatarUpload(userId: number, file: File) {
    if (!file.type.startsWith("image/")) { setError("Please select an image file."); return; }
    if (file.size > 2 * 1024 * 1024) { setError("Image must be under 2 MB."); return; }
    const reader = new FileReader();
    reader.onload = (e) => { void updateUser(userId, { avatar_data: e.target?.result as string }); };
    reader.readAsDataURL(file);
  }

  async function saveEmail(userId: number, email: string) {
    setEditingEmailId(null);
    const value = email.trim() || null;
    const user = users.find((u) => u.id === userId);
    if (value === (user?.email ?? null)) return;
    await updateUser(userId, { email: value });
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    if (resetPasswordForm.userId === null || !resetPasswordForm.password) return;
    setBusyUserId(resetPasswordForm.userId);
    setError(null); setSuccess(null);
    try {
      await api.resetUserPassword(accessToken, resetPasswordForm.userId, resetPasswordForm.password);
      const user = users.find((u) => u.id === resetPasswordForm.userId);
      setSuccess(`Password reset for ${user?.username ?? "user"}`);
      setResetPasswordForm({ userId: null, password: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset password");
    } finally { setBusyUserId(null); }
  }

  async function forceLogout(userId: number) {
    setBusyUserId(userId);
    setError(null); setSuccess(null);
    try {
      await api.forceLogoutUser(accessToken, userId);
      const user = users.find((u) => u.id === userId);
      setSuccess(`Logged out all sessions for ${user?.username ?? "user"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to force logout");
    } finally { setBusyUserId(null); }
  }

  async function unlockLogin(userId: number) {
    setBusyUserId(userId);
    setError(null); setSuccess(null);
    try {
      await api.unlockUserLogin(accessToken, userId);
      const user = users.find((u) => u.id === userId);
      setSuccess(`Login lockout cleared for ${user?.username ?? "user"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to unlock login");
    } finally { setBusyUserId(null); }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setError(null); setSuccess(null);
    try {
      const created = await api.createUser(accessToken, createForm);
      setUsers((current) => [...current, created].sort((a, b) => a.username.localeCompare(b.username)));
      setCreateForm({ username: "", password: "", email: "", role: "Viewer", is_active: true });
      setSuccess(`Created ${created.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create user");
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSettingsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateAdminSettings(accessToken, settingsForm);
      setSettingsForm(updated);
      setIdleTimeoutRaw(String(updated.idle_timeout_minutes));
      setSuccess("Settings saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save settings");
    } finally { setSettingsBusy(false); }
  }

  async function runBackup() {
    setBackupBusy("backup");
    setError(null); setSuccess(null);
    try {
      const result = await api.downloadBackup(accessToken);
      triggerDownload(result);
      setSuccess(`Downloaded ${result.filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    } finally { setBackupBusy(null); }
  }

  async function runRestore() {
    if (!restoreFile) return;
    setBackupBusy("restore");
    setError(null); setSuccess(null);
    try {
      await api.restoreBackup(accessToken, restoreFile);
      setSuccess(`Restored from ${restoreFile.name}`);
      setRestoreFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally { setBackupBusy(null); }
  }

  async function loadDiagnostics() {
    setDiagBusy(true);
    try {
      const data = await api.getSystemDiagnostics(accessToken);
      setDiagnostics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load diagnostics");
    } finally {
      setDiagBusy(false);
    }
  }

  const filteredUsers = useMemo(
    () => users.filter((u) => !userSearch || u.username.toLowerCase().includes(userSearch.toLowerCase())),
    [users, userSearch],
  );
  const adminTabs = [
    { id: "system", label: "System", Icon: Settings },
    { id: "users", label: "Users", Icon: IconUsers },
    { id: "groups", label: "Groups", Icon: IconShieldCheck },
    { id: "notifications", label: "Notifications", Icon: IconCloud },
    { id: "alerts", label: "Alerts", Icon: IconAlertCircle },
    { id: "security", label: "Security", Icon: Shield },
  ] as const;

  return (
    <section className="admin-layout">
      <div className="admin-tabs">
        {adminTabs.map(({ id, label, Icon }) => (
          <button key={id} type="button" className={`admin-tab-btn${activeTab === id ? " active" : ""}`} onClick={() => setActiveTab(id)}>
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {error && <div className="form-error">{error}</div>}
      {success && <div className="success-banner">{success}</div>}

      {activeTab === "users" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><IconUsers size={16} />Users</h2>
              <button type="button" className="ipam-btn" onClick={() => void loadAdminData()}>Refresh</button>
            </div>
            <input className="admin-search" type="search" placeholder="Search users…" value={userSearch} onChange={(e) => setUserSearch(e.target.value)} />
            {loading ? <p>Loading…</p> : (
              <div className="admin-users-table">
                <div className="admin-users-header">
                  <span>User</span>
                  <span className="admin-col-center">Role</span>
                  <span className="admin-col-center">Status</span>
                  <span className="admin-col-center">Actions</span>
                </div>
                {filteredUsers.map((row) => (
                  <div className="admin-users-row" key={row.id}>
                    <div className="admin-user-identity">
                      <div className="admin-user-avatar-wrap">
                        <label className={`admin-user-avatar admin-user-avatar--${row.role.toLowerCase()}`} title="Upload photo">
                          {row.avatar_data
                            ? <img src={row.avatar_data} alt={row.username} className="admin-avatar-img" />
                            : <span className="admin-avatar-initials">{userInitials(row.username)}</span>
                          }
                          <span className="admin-avatar-overlay" aria-hidden="true">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                          </span>
                          <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAdminAvatarUpload(row.id, f); e.target.value = ""; }} />
                        </label>
                        {row.avatar_data && (
                          <button type="button" className="admin-avatar-clear" title="Remove photo" onClick={() => void updateUser(row.id, { avatar_data: null })}>×</button>
                        )}
                      </div>
                      <div className="admin-user-info">
                        <span className="admin-user-name">{row.username}</span>
                        {editingEmailId === row.id ? (
                          <div className="admin-email-edit-row">
                            <input
                              className="admin-email-input"
                              type="email"
                              autoFocus
                              maxLength={254}
                              placeholder="Email address"
                              value={editingEmailValue}
                              onChange={(e) => setEditingEmailValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); void saveEmail(row.id, editingEmailValue); }
                                if (e.key === "Escape") setEditingEmailId(null);
                              }}
                              onBlur={() => void saveEmail(row.id, editingEmailValue)}
                            />
                            <button type="button" className="admin-email-btn admin-email-btn--save" onMouseDown={(e) => { e.preventDefault(); void saveEmail(row.id, editingEmailValue); }}><Check size={11} /></button>
                            <button type="button" className="admin-email-btn" onMouseDown={(e) => { e.preventDefault(); setEditingEmailId(null); }}><X size={11} /></button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="admin-email-display"
                            onClick={() => { setEditingEmailId(row.id); setEditingEmailValue(row.email ?? ""); }}
                          >
                            {row.email
                              ? <span className="admin-user-email">{row.email}</span>
                              : <span className="admin-email-placeholder">Add email…</span>
                            }
                            <Pencil size={10} className="admin-email-pencil" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div>
                      <select
                        className={`admin-role-select admin-role-select--${row.role.toLowerCase()}`}
                        value={row.role}
                        disabled={busyUserId === row.id}
                        onChange={(e) => void updateUser(row.id, { role: e.target.value })}
                      >
                        <option value="SuperAdmin">SuperAdmin</option>
                        <option value="NetworkAdmin">NetworkAdmin</option>
                        <option value="SecurityAnalyst">SecurityAnalyst</option>
                        <option value="Viewer">Viewer</option>
                        {Object.keys(localRolePerms).filter(r => !["SuperAdmin","NetworkAdmin","SecurityAnalyst","Viewer"].includes(r)).sort().map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                    <div className="admin-col-center">
                      <label className="admin-status-toggle">
                        <input type="checkbox" checked={row.is_active} disabled={busyUserId === row.id} onChange={(e) => void updateUser(row.id, { is_active: e.target.checked })} />
                        <span className={`admin-status-pill ${row.is_active ? "active" : "suspended"}`}>
                          {row.is_active ? "Active" : "Disabled"}
                        </span>
                      </label>
                    </div>
                    <div className="admin-row-actions">
                      <button type="button" className="admin-action-btn" disabled={busyUserId === row.id} onClick={() => setResetPasswordForm({ userId: row.id, password: "" })}>Reset PW</button>
                      <button type="button" className="admin-action-btn" disabled={busyUserId === row.id} onClick={() => void unlockLogin(row.id)}>Unlock</button>
                      <button type="button" className="admin-action-btn admin-action-btn--danger" disabled={busyUserId === row.id} onClick={() => void forceLogout(row.id)}>Logout</button>
                      <button type="button" className="admin-action-btn" onClick={() => { setActiveTab("security"); void loadAuditLogs(0, row.id); }}>Audit</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {resetPasswordForm.userId !== null && (
              <form className="tool-form admin-reset-form" onSubmit={resetPassword}>
                <h3>Reset password — {users.find((u) => u.id === resetPasswordForm.userId)?.username}</h3>
                <label>
                  New password (min 12 chars)
                  <input required minLength={12} type="password" value={resetPasswordForm.password} onChange={(e) => setResetPasswordForm((c) => ({ ...c, password: e.target.value }))} />
                </label>
                <div className="admin-reset-actions">
                  <button type="submit" className="ipam-btn ipam-btn--primary" disabled={busyUserId === resetPasswordForm.userId}>Save</button>
                  <button type="button" className="ipam-btn" onClick={() => setResetPasswordForm({ userId: null, password: "" })}>Cancel</button>
                </div>
              </form>
            )}
            <form className="tool-form admin-create-form" onSubmit={createUser}>
              <h3>Add user</h3>
              <div className="tool-form-grid">
                <label>Username <input required minLength={3} maxLength={80} value={createForm.username} onChange={(e) => setCreateForm((c) => ({ ...c, username: e.target.value }))} /></label>
                <label>Password <input required minLength={12} type="password" value={createForm.password} onChange={(e) => setCreateForm((c) => ({ ...c, password: e.target.value }))} /></label>
              </div>
              <div className="tool-form-grid">
                <label>Email <input type="email" maxLength={254} placeholder="Optional — for password reset emails" value={createForm.email} onChange={(e) => setCreateForm((c) => ({ ...c, email: e.target.value }))} /></label>
                <label>Role
                  <select value={createForm.role} onChange={(e) => setCreateForm((c) => ({ ...c, role: e.target.value }))}>
                    <option value="Viewer">Viewer</option>
                    <option value="SecurityAnalyst">SecurityAnalyst</option>
                    <option value="NetworkAdmin">NetworkAdmin</option>
                    <option value="SuperAdmin">SuperAdmin</option>
                    {Object.keys(localRolePerms).filter(r => !["SuperAdmin","NetworkAdmin","SecurityAnalyst","Viewer"].includes(r)).sort().map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="inline-toggle"><input checked={createForm.is_active} type="checkbox" onChange={(e) => setCreateForm((c) => ({ ...c, is_active: e.target.checked }))} />Active on create</label>
              <button type="submit" className="ipam-btn ipam-btn--primary">Create user</button>
            </form>
          </section>
        </div>
      )}

      {activeTab === "security" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><Shield size={16} />{auditUserFilter ? `Activity — ${users.find((u) => u.id === auditUserFilter)?.username ?? "user"}` : "Login & Audit History"}</h2>
              <div className="admin-panel-actions">
                {auditUserFilter && <button type="button" className="ipam-btn" onClick={() => void loadAuditLogs(0, null)}>All users</button>}
                <button type="button" className="ipam-btn" onClick={() => void loadAuditLogs(auditOffset, auditUserFilter)}>Refresh</button>
              </div>
            </div>
            <div className="audit-log-table">
              <div className="audit-log-header">
                <span>Time</span>
                <span>Event</span>
                <span>Actor</span>
                <span>Context</span>
              </div>
              {auditLogs.length === 0 && <p className="audit-empty">No audit records found.</p>}
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
            <div className="audit-pagination">
              <button type="button" className="ipam-btn" disabled={auditOffset === 0} onClick={() => void loadAuditLogs(Math.max(0, auditOffset - 50), auditUserFilter)}>← Prev</button>
              <span>{auditOffset + 1}–{Math.min(auditOffset + 50, auditLogsTotal)} of {auditLogsTotal}</span>
              <button type="button" className="ipam-btn" disabled={auditOffset + 50 >= auditLogsTotal} onClick={() => void loadAuditLogs(auditOffset + 50, auditUserFilter)}>Next →</button>
            </div>
          </section>
        </div>
      )}

      {activeTab === "system" && (
        <div className="admin-tab-content">
          <div className="admin-system-stats">
            <div className="admin-system-stat">
              <span className="admin-system-stat-icon admin-system-stat-icon--teal"><IconDeviceDesktop size={22} /></span>
              <div>
                <strong>{summary?.device_count ?? graph.devices.length}</strong>
                <span>Devices</span>
              </div>
            </div>
            <div className="admin-system-stat">
              <span className="admin-system-stat-icon admin-system-stat-icon--blue"><IconBolt size={22} /></span>
              <div>
                <strong>{summary?.relationship_count ?? graph.relationships.length}</strong>
                <span>Links</span>
              </div>
            </div>
            <div className="admin-system-stat">
              <span className="admin-system-stat-icon admin-system-stat-icon--purple"><IconUsers size={22} /></span>
              <div>
                <strong>{summary?.group_count ?? new Set(graph.devices.map((d) => d.topology_group).filter(Boolean)).size}</strong>
                <span>Groups</span>
              </div>
            </div>
            <div className="admin-system-stat">
              <span className="admin-system-stat-icon admin-system-stat-icon--teal"><UserCircle size={22} /></span>
              <div>
                <strong>{users.length}</strong>
                <span>Users</span>
              </div>
            </div>
          </div>
          <div className="system-tab-grid">
            <div className="system-tab-col">
              <section className="panel admin-panel">
                <h2 className="admin-section-title"><Settings size={16} />App settings</h2>
                <form className="tool-form" onSubmit={saveSettings}>
                  <label>App name <input maxLength={80} value={settingsForm.app_name} onChange={(e) => setSettingsForm((c) => ({ ...c, app_name: e.target.value }))} /></label>
                  <label>Login page message <textarea maxLength={300} rows={2} value={settingsForm.login_message} onChange={(e) => setSettingsForm((c) => ({ ...c, login_message: e.target.value }))} /></label>
                  <label>
                    Announcement banner
                    <textarea maxLength={500} rows={3} placeholder="Leave empty to hide. Shown to all logged-in users." value={settingsForm.announcement} onChange={(e) => setSettingsForm((c) => ({ ...c, announcement: e.target.value }))} />
                  </label>
                  <label className="tool-form-inline-check">
                    <input type="checkbox" checked={settingsForm.live_ping_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, live_ping_enabled: e.target.checked }))} />
                    Enable live ping monitoring
                    <span className="tool-note" style={{ margin: 0 }}>Uncheck to disable all background ping checks across the app</span>
                  </label>
                  <label className="tool-form-inline-check">
                    <input type="checkbox" checked={settingsForm.active_network_public_targets_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, active_network_public_targets_enabled: e.target.checked }))} />
                    Allow public active network targets
                    <span className="tool-note" style={{ margin: 0 }}>Enables public IP and hostname targets for ping, traceroute, and TCP checks</span>
                  </label>
                  <label>
                    Idle session timeout (minutes)
                    {(() => {
                      const n = parseInt(idleTimeoutRaw, 10);
                      const err = idleTimeoutRaw.trim() === "" || isNaN(n) ? "Must be a number" : n < 1 ? "Minimum is 1 minute" : n > 480 ? "Maximum is 480 minutes (8 hours)" : null;
                      return (
                        <>
                          <input
                            type="text"
                            inputMode="numeric"
                            placeholder="e.g. 15"
                            value={idleTimeoutRaw}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setIdleTimeoutRaw(raw);
                              const parsed = parseInt(raw, 10);
                              if (!isNaN(parsed) && parsed >= 1 && parsed <= 480) {
                                setSettingsForm((c) => ({ ...c, idle_timeout_minutes: parsed }));
                              }
                            }}
                            style={err ? { borderColor: "var(--dash-red)" } : undefined}
                          />
                          {err
                            ? <span className="tool-note" style={{ margin: 0, color: "var(--dash-red)" }}>{err}</span>
                            : <span className="tool-note" style={{ margin: 0 }}>Users are logged out after this many minutes of inactivity (1–480). Set to 480 to effectively disable.</span>
                          }
                        </>
                      );
                    })()}
                  </label>
                  <button type="submit" className="ipam-btn ipam-btn--primary" disabled={settingsBusy || (() => { const n = parseInt(idleTimeoutRaw, 10); return isNaN(n) || n < 1 || n > 480; })()}>
                    {settingsBusy ? "Saving…" : "Save settings"}
                  </button>
                </form>
              </section>
              <section className="panel admin-panel">
                <h2 className="admin-section-title"><IconDatabase size={16} />Database backup &amp; restore</h2>
                <p className="tool-note">SuperAdmin only. Operates directly on the SQLite database file.</p>
                <div className="tool-form">
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={backupBusy === "backup"} onClick={() => void runBackup()}>
                    {backupBusy === "backup" ? "Preparing…" : "Download backup"}
                  </button>
                  <label>
                    Restore from backup
                    <input accept=".db,application/octet-stream" type="file" disabled={backupBusy === "restore"} onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} />
                  </label>
                  {restoreFile && (
                    <button type="button" className="ipam-btn ipam-btn--primary" disabled={backupBusy === "restore"} onClick={() => void runRestore()}>
                      {backupBusy === "restore" ? "Restoring…" : `Restore ${restoreFile.name}`}
                    </button>
                  )}
                </div>
              </section>
            </div>
            <div className="system-tab-col">
              {versionInfo && (
                <section className="panel admin-panel">
                  <h2 className="admin-section-title"><IconCloud size={16} />Version</h2>
                  <dl className="admin-config-grid">
                    <dt>Installed</dt>
                    <dd>v{versionInfo.current}</dd>
                    <dt>Latest</dt>
                    <dd>
                      {versionInfo.latest ? (
                        versionInfo.up_to_date ? (
                          <span style={{ color: "var(--dash-green)" }}>v{versionInfo.latest} — up to date</span>
                        ) : (
                          <a href={versionInfo.release_url} target="_blank" rel="noreferrer" style={{ color: "var(--dash-yellow)" }}>
                            v{versionInfo.latest} — update available
                          </a>
                        )
                      ) : (
                        <span style={{ opacity: 0.5 }}>unavailable</span>
                      )}
                    </dd>
                  </dl>
                </section>
              )}
              <section className="panel admin-panel">
                <div className="system-icon-header">
                  <div>
                    <h2 className="admin-section-title" style={{ margin: 0 }}><IconPalette size={16} />Icons</h2>
                    <p className="tool-note" style={{ margin: "2px 0 0" }}>
                      Active: <strong>{[builtInIconPack, ...iconPacks, ...localIconPacks].find((p) => p.id === activeIconPackId)?.name ?? "Built-in"}</strong>
                      {" · "}{allRuntimePacks.length} pack{allRuntimePacks.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <button type="button" className="ipam-btn ipam-btn--primary" onClick={() => setIconModalOpen(true)}>
                    Manage icons →
                  </button>
                </div>
              </section>
              <section className="panel admin-panel">
                <h2 className="admin-section-title"><IconDatabase size={16} />Syslog configuration</h2>
                {syslogStatus ? (
                  <dl className="admin-config-grid">
                    <dt>Firewall retention</dt><dd>{syslogStatus.retention_days} days</dd>
                    <dt>UDP listener</dt><dd>{syslogStatus.udp_enabled ? `enabled :${syslogStatus.udp_port}` : "disabled"}</dd>
                    <dt>TCP listener</dt><dd>{syslogStatus.tcp_enabled ? `enabled :${syslogStatus.tcp_port}` : "disabled"}</dd>
                    <dt>TLS listener</dt><dd>{syslogStatus.tls_enabled ? `enabled :${syslogStatus.tls_port}` : "disabled"}</dd>
                    <dt>Allowlist</dt><dd>{syslogStatus.allowlist_enabled ? "enabled" : "off"}</dd>
                    <dt>Stored events</dt><dd>{syslogStatus.total_events.toLocaleString()}</dd>
                    <dt>Last cleanup</dt><dd>{syslogStatus.retention_last_run_at ? new Date(syslogStatus.retention_last_run_at).toLocaleString() : "n/a"}</dd>
                    <dt>Last event</dt><dd>{syslogStatus.last_event_received_at ? new Date(syslogStatus.last_event_received_at).toLocaleString() : "n/a"}</dd>
                  </dl>
                ) : <p>Loading…</p>}
              </section>
              <section className="panel admin-panel">
                <div className="system-icon-header">
                  <h2 className="admin-section-title"><IconServer size={16} />System diagnostics</h2>
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={diagBusy} onClick={() => void loadDiagnostics()}>
                    {diagBusy ? "Loading…" : diagnostics ? "Refresh" : "Load"}
                  </button>
                </div>
                {diagnostics ? (
                  <dl className="admin-config-grid">
                    <dt>Main DB</dt>
                    <dd>{fmtBytes(diagnostics.database.main.total_bytes)}{diagnostics.database.main.wal_bytes > 0 ? ` (WAL: ${fmtBytes(diagnostics.database.main.wal_bytes)})` : ""}</dd>
                    <dt>Firewall DB</dt>
                    <dd>{fmtBytes(diagnostics.database.firewall.total_bytes)}{diagnostics.database.firewall.wal_bytes > 0 ? ` (WAL: ${fmtBytes(diagnostics.database.firewall.wal_bytes)})` : ""}</dd>
                    <dt>Last monitor check</dt>
                    <dd>{diagnostics.monitoring.last_checked_at ? new Date(diagnostics.monitoring.last_checked_at).toLocaleString() : "n/a"}</dd>
                    <dt>Device statuses</dt>
                    <dd>{Object.entries(diagnostics.monitoring.device_status_counts).map(([s, n]) => `${s}: ${n}`).join(", ") || "—"}</dd>
                    <dt>Cache — fleet</dt>
                    <dd>{diagnostics.monitoring.cache.fleet_summary.cached
                      ? `hit · ${diagnostics.monitoring.cache.fleet_summary.age_seconds?.toFixed(0) ?? "?"}s old · ${diagnostics.monitoring.cache.fleet_summary.hits}h/${diagnostics.monitoring.cache.fleet_summary.misses}m`
                      : "cold"}</dd>
                    <dt>Cache — devices</dt>
                    <dd>{diagnostics.monitoring.cache.device_summaries.cached
                      ? `hit · ${diagnostics.monitoring.cache.device_summaries.age_seconds?.toFixed(0) ?? "?"}s old · ${diagnostics.monitoring.cache.device_summaries.hits}h/${diagnostics.monitoring.cache.device_summaries.misses}m`
                      : "cold"}</dd>
                    <dt>Syslog events</dt>
                    <dd>{diagnostics.syslog.total_events.toLocaleString()}</dd>
                    <dt>Last syslog event</dt>
                    <dd>{diagnostics.syslog.last_event_received_at ? new Date(diagnostics.syslog.last_event_received_at).toLocaleString() : "n/a"}</dd>
                    <dt>Retention last run</dt>
                    <dd>{diagnostics.syslog.retention_last_run_at ? new Date(diagnostics.syslog.retention_last_run_at).toLocaleString() : "n/a"}</dd>
                    {diagnostics.syslog.retention_last_error && (
                      <>
                        <dt>Retention error</dt>
                        <dd style={{ color: "var(--dash-red)" }}>{diagnostics.syslog.retention_last_error}</dd>
                      </>
                    )}
                    <dt>Process PID</dt>
                    <dd>{diagnostics.process.pid}</dd>
                    <dt>Generated</dt>
                    <dd style={{ opacity: 0.7 }}>{new Date(diagnostics.generated_at).toLocaleString()}</dd>
                  </dl>
                ) : (
                  <p className="tool-note">Click Load to fetch current runtime diagnostics.</p>
                )}
              </section>
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
      )}

      {activeTab === "notifications" && (
        <div className="admin-tab-content">
          <div className="admin-grid">

            <section className="panel admin-panel">
              <h2 className="admin-section-title notif-provider-heading"><IconCloud size={16} />ntfy</h2>
              <p className="tool-note">Push notifications via ntfy.sh or a self-hosted ntfy server.</p>
              <div className="tool-form">
                <label>Topic URL
                  <input placeholder="https://ntfy.sh/my-topic" value={notifSettings.ntfy_url} onChange={(e) => setNotifSettings((c) => ({ ...c, ntfy_url: e.target.value }))} />
                </label>
                <label>Access token <span className="tool-note">(optional)</span>
                  <input type="password" placeholder="tk_…" value={notifSettings.ntfy_token} onChange={(e) => setNotifSettings((c) => ({ ...c, ntfy_token: e.target.value }))} />
                </label>
                <div className="notif-actions">
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={notifBusy} onClick={() => void saveNotifSettings()}>{notifBusy ? "Saving…" : "Save"}</button>
                  <button type="button" className="ipam-btn" onClick={() => void testNotif("ntfy")}>Send test</button>
                  {notifTestResult.ntfy && <span className={`notif-result${notifTestResult.ntfy === "Sent successfully" ? " ok" : " err"}`}>{notifTestResult.ntfy}</span>}
                </div>
              </div>
            </section>

            <section className="panel admin-panel">
              <h2 className="admin-section-title notif-provider-heading"><IconCloud size={16} />Telegram</h2>
              <p className="tool-note">Send messages via a Telegram bot to a chat or channel.</p>
              <div className="tool-form">
                <label>Bot token
                  <input type="password" placeholder="123456:ABC-DEF…" value={notifSettings.telegram_bot_token} onChange={(e) => setNotifSettings((c) => ({ ...c, telegram_bot_token: e.target.value }))} />
                </label>
                <label>Chat ID
                  <input placeholder="-100123456789" value={notifSettings.telegram_chat_id} onChange={(e) => setNotifSettings((c) => ({ ...c, telegram_chat_id: e.target.value }))} />
                </label>
                <div className="notif-actions">
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={notifBusy} onClick={() => void saveNotifSettings()}>{notifBusy ? "Saving…" : "Save"}</button>
                  <button type="button" className="ipam-btn" onClick={() => void testNotif("telegram")}>Send test</button>
                  {notifTestResult.telegram && <span className={`notif-result${notifTestResult.telegram === "Sent successfully" ? " ok" : " err"}`}>{notifTestResult.telegram}</span>}
                </div>
              </div>
            </section>

            <section className="panel admin-panel">
              <h2 className="admin-section-title notif-provider-heading"><IconCloud size={16} />Signal</h2>
              <p className="tool-note">Requires a running <a href="https://github.com/bbernhard/signal-cli-rest-api" target="_blank" rel="noreferrer">signal-cli REST API</a> instance.</p>
              <div className="tool-form">
                <label>REST API URL
                  <input placeholder="http://localhost:8080" value={notifSettings.signal_url} onChange={(e) => setNotifSettings((c) => ({ ...c, signal_url: e.target.value }))} />
                </label>
                <label>Sender number <span className="tool-note">(E.164)</span>
                  <input placeholder="+447700000000" value={notifSettings.signal_number} onChange={(e) => setNotifSettings((c) => ({ ...c, signal_number: e.target.value }))} />
                </label>
                <label>Recipient number <span className="tool-note">(E.164)</span>
                  <input placeholder="+447700000001" value={notifSettings.signal_recipient} onChange={(e) => setNotifSettings((c) => ({ ...c, signal_recipient: e.target.value }))} />
                </label>
                <div className="notif-actions">
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={notifBusy} onClick={() => void saveNotifSettings()}>{notifBusy ? "Saving…" : "Save"}</button>
                  <button type="button" className="ipam-btn" onClick={() => void testNotif("signal")}>Send test</button>
                  {notifTestResult.signal && <span className={`notif-result${notifTestResult.signal === "Sent successfully" ? " ok" : " err"}`}>{notifTestResult.signal}</span>}
                </div>
              </div>
            </section>

            <section className="panel admin-panel">
              <h2 className="admin-section-title notif-provider-heading"><IconCloud size={16} />SMTP / Email</h2>
              <p className="tool-note">Send email alerts via any SMTP server (Gmail, SendGrid, local relay, etc.).</p>
              <div className="tool-form">
                <label>SMTP host
                  <input placeholder="smtp.gmail.com" value={notifSettings.smtp_host} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_host: e.target.value }))} />
                </label>
                <label>Port
                  <input placeholder="587" value={notifSettings.smtp_port} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_port: e.target.value }))} />
                </label>
                <label>Username
                  <input placeholder="you@example.com" value={notifSettings.smtp_user} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_user: e.target.value }))} />
                </label>
                <label>Password
                  <input type="password" value={notifSettings.smtp_password} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_password: e.target.value }))} />
                </label>
                <label>From address <span className="tool-note">(defaults to username)</span>
                  <input placeholder="netmap@example.com" value={notifSettings.smtp_from} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_from: e.target.value }))} />
                </label>
                <label>Send alerts to
                  <input placeholder="admin@example.com" value={notifSettings.smtp_to} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_to: e.target.value }))} />
                </label>
                <label className="inline-toggle">
                  <input type="checkbox" checked={notifSettings.smtp_tls === "true"} onChange={(e) => setNotifSettings((c) => ({ ...c, smtp_tls: e.target.checked ? "true" : "false" }))} />
                  Use STARTTLS
                </label>
                <div className="notif-actions">
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={notifBusy} onClick={() => void saveNotifSettings()}>{notifBusy ? "Saving…" : "Save"}</button>
                  <button type="button" className="ipam-btn" onClick={() => void testNotif("smtp")}>Send test</button>
                  {notifTestResult.smtp && <span className={`notif-result${notifTestResult.smtp === "Sent successfully" ? " ok" : " err"}`}>{notifTestResult.smtp}</span>}
                </div>
              </div>
            </section>

          </div>
        </div>
      )}

      {activeTab === "alerts" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><IconAlertCircle size={16} />Alert Rules</h2>
              <div className="admin-panel-actions">
                <button type="button" className="ipam-btn ipam-btn--primary" onClick={() => {
                  setEditingAlertRule(null);
                  setAlertForm({ name: "", enabled: true, event_type: "device_offline", device_id: null, channels: [], cooldown_minutes: 30 });
                  setShowAlertForm(true);
                }}>+ Add rule</button>
              </div>
            </div>
            <p className="tool-note">Rules run every 5 minutes in the background. Notifications are sent via the channels configured in the Notifications tab.</p>
            {alertRulesError && <div className="form-error">{alertRulesError}</div>}

            {showAlertForm && (
              <div className="tool-form" style={{ marginBottom: 16, padding: '14px 16px', background: 'rgba(29,154,176,0.04)', borderRadius: 8, border: '1px solid rgba(29,154,176,0.15)' }}>
                <label>Rule name
                  <input value={alertForm.name} maxLength={120} onChange={(e) => setAlertForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Core router offline" />
                </label>
                <label>Trigger
                  <select value={alertForm.event_type} onChange={(e) => setAlertForm(f => ({...f, event_type: e.target.value as AlertRuleEventType}))}>
                    <option value="device_offline">Device goes offline</option>
                    <option value="device_online">Device comes back online</option>
                    <option value="device_warning">Device status becomes Warning</option>
                    <option value="any_status_change">Any status change</option>
                  </select>
                </label>
                <label>Device
                  <select value={alertForm.device_id ?? ""} onChange={(e) => setAlertForm(f => ({...f, device_id: e.target.value ? Number(e.target.value) : null}))}>
                    <option value="">All devices</option>
                    {graph.devices.map(d => (
                      <option key={d.id} value={d.id}>{d.display_name || d.hostname || d.ip_address}</option>
                    ))}
                  </select>
                </label>
                <fieldset style={{ border: '1px solid #d0dde6', borderRadius: 6, padding: '8px 12px' }}>
                  <legend style={{ fontSize: 12, fontWeight: 700, color: '#314656', padding: '0 4px' }}>Notify via</legend>
                  {(["smtp", "ntfy", "telegram", "signal"] as const).map(ch => (
                    <label key={ch} className="tool-form-inline-check" style={{ marginBottom: 4 }}>
                      <input type="checkbox" checked={alertForm.channels.includes(ch)}
                        onChange={(e) => setAlertForm(f => ({
                          ...f,
                          channels: e.target.checked ? [...f.channels, ch] : f.channels.filter(c => c !== ch)
                        }))} />
                      {ch === "smtp" ? "Email (SMTP)" : ch === "ntfy" ? "ntfy" : ch === "telegram" ? "Telegram" : "Signal"}
                    </label>
                  ))}
                </fieldset>
                <label>Cooldown
                  <select value={alertForm.cooldown_minutes} onChange={(e) => setAlertForm(f => ({...f, cooldown_minutes: Number(e.target.value)}))}>
                    <option value={5}>5 minutes</option>
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={240}>4 hours</option>
                    <option value={1440}>24 hours</option>
                  </select>
                </label>
                <label className="tool-form-inline-check">
                  <input type="checkbox" checked={alertForm.enabled} onChange={(e) => setAlertForm(f => ({...f, enabled: e.target.checked}))} />
                  Enabled
                </label>
                <div className="ipam-form-actions">
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={alertRulesBusy || !alertForm.name || alertForm.channels.length === 0} onClick={() => void saveAlertRule()}>
                    {alertRulesBusy ? "Saving…" : editingAlertRule ? "Update rule" : "Create rule"}
                  </button>
                  <button type="button" className="ipam-btn" onClick={() => { setShowAlertForm(false); setEditingAlertRule(null); }}>Cancel</button>
                </div>
              </div>
            )}

            {alertRules.length === 0 ? (
              <p className="tool-note">No alert rules yet. Add one to start receiving automated notifications.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid rgba(175,198,216,0.5)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Name</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Trigger</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Device</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Channels</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Cooldown</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Status</th>
                    <th style={{ padding: '8px 10px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {alertRules.map(rule => {
                    const triggerLabels: Record<string, string> = {
                      device_offline: "Goes offline",
                      device_online: "Comes online",
                      device_warning: "Warning status",
                      any_status_change: "Any status change",
                    };
                    const deviceName = rule.device_id
                      ? (() => { const d = graph.devices.find(x => x.id === rule.device_id); return d ? (d.display_name || d.hostname || d.ip_address) : `#${rule.device_id}`; })()
                      : "All devices";
                    const testResult = alertTestResults[rule.id];
                    return (
                      <tr key={rule.id} style={{ borderBottom: '1px solid rgba(175,198,216,0.3)' }}>
                        <td style={{ padding: '10px 10px', fontWeight: 600 }}>{rule.name}</td>
                        <td style={{ padding: '10px 10px', color: '#4a6474' }}>{triggerLabels[rule.event_type] ?? rule.event_type}</td>
                        <td style={{ padding: '10px 10px', color: '#4a6474', fontSize: 12 }}>{deviceName}</td>
                        <td style={{ padding: '10px 10px', fontSize: 12 }}>{rule.channels.join(", ") || "—"}</td>
                        <td style={{ padding: '10px 10px', color: '#4a6474', fontSize: 12 }}>{rule.cooldown_minutes >= 60 ? `${rule.cooldown_minutes / 60}h` : `${rule.cooldown_minutes}m`}</td>
                        <td style={{ padding: '10px 10px' }}>
                          <span className={`alert-status-pill${rule.enabled ? " alert-status-pill--active" : ""}`}>
                            {rule.enabled ? "Active" : "Paused"}
                          </span>
                        </td>
                        <td style={{ padding: '10px 10px' }}>
                          <div className="admin-panel-actions">
                            <button type="button" className="admin-action-btn" disabled={alertTestBusy === rule.id} onClick={() => void runAlertTest(rule.id)}>
                              {alertTestBusy === rule.id ? "Testing…" : "Test"}
                            </button>
                            <button type="button" className="admin-action-btn" onClick={() => void toggleAlertRule(rule)}>
                              {rule.enabled ? "Pause" : "Enable"}
                            </button>
                            <button type="button" className="admin-action-btn" onClick={() => {
                              setEditingAlertRule(rule);
                              setAlertForm({ name: rule.name, enabled: rule.enabled, event_type: rule.event_type, device_id: rule.device_id, channels: rule.channels, cooldown_minutes: rule.cooldown_minutes });
                              setShowAlertForm(true);
                            }}>Edit</button>
                            <button type="button" className="admin-action-btn admin-action-btn--danger" onClick={() => void deleteAlertRule(rule.id)}>Delete</button>
                          </div>
                          {testResult && Object.keys(testResult).length > 0 && (
                            <div className="alert-test-results">
                              {Object.entries(testResult).map(([ch, res]) => (
                                <span key={ch} className={`notif-result${res === "Sent successfully" ? " ok" : " err"}`}>
                                  {ch}: {res}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}

      {activeTab === "groups" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><IconShieldCheck size={16} />Role Permissions</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="ipam-btn" onClick={() => { setShowNewGroupForm((v) => !v); setNewGroupName(""); }}>
                  {showNewGroupForm ? "Cancel" : "+ New group"}
                </button>
                <button type="button" className="ipam-btn ipam-btn--primary" disabled={groupsBusy} onClick={() => void saveRolePermissions()}>
                  {groupsBusy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
            <p className="tool-note">SuperAdmin always has full access. Use the checkboxes below to configure which permissions each role is granted. Custom groups can be assigned to users.</p>

            {showNewGroupForm && (
              <div className="rbac-new-group-form">
                <input
                  className="rbac-new-group-input"
                  type="text"
                  placeholder="Group name (e.g. ReadOnly)"
                  maxLength={40}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createGroup(newGroupName); }}
                  autoFocus
                />
                <button
                  type="button"
                  className="ipam-btn ipam-btn--primary"
                  disabled={groupsBusy || !newGroupName.trim() || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(newGroupName.trim())}
                  onClick={() => void createGroup(newGroupName)}
                >
                  Create
                </button>
                {newGroupName && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(newGroupName.trim()) && (
                  <span className="rbac-name-error">Must start with a letter, then letters/numbers/- only</span>
                )}
              </div>
            )}

            {rolePermissions ? (() => {
              const BUILT_IN = ["NetworkAdmin", "SecurityAnalyst", "Viewer"] as const;
              const customRoles = Object.keys(localRolePerms).filter(r => !["SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"].includes(r)).sort();
              const allRoles = [...BUILT_IN, ...customRoles];
              return (
                <div className="rbac-roles-grid">
                  {allRoles.map((role) => {
                    const isCustom = !["NetworkAdmin", "SecurityAnalyst", "Viewer"].includes(role);
                    const label = role === "NetworkAdmin" ? "Network Admin" : role === "SecurityAnalyst" ? "Security Analyst" : role;
                    return (
                      <div key={role} className={`rbac-role-card${isCustom ? " rbac-role-card--custom" : ""}`}>
                        <div className="rbac-role-header">
                          <h3 className="rbac-role-name">{label}</h3>
                          <button
                            type="button"
                            className="rbac-delete-btn"
                            title={`Delete "${role}" group`}
                            disabled={groupsBusy}
                            onClick={() => { if (confirm(`Delete role "${role}"? Users assigned this role will be moved to Viewer.`)) void deleteGroup(role); }}
                          >✕</button>
                        </div>
                        <ul className="rbac-perm-list">
                          {rolePermissions.permissions.map((perm) => {
                            const granted = (localRolePerms[role] ?? []).includes(perm.key);
                            return (
                              <li key={perm.key} className="rbac-perm-row">
                                <label className="rbac-perm-label">
                                  <input
                                    type="checkbox"
                                    checked={granted}
                                    onChange={(e) => {
                                      setLocalRolePerms((prev) => {
                                        const current = prev[role] ?? [];
                                        return {
                                          ...prev,
                                          [role]: e.target.checked
                                            ? [...current, perm.key]
                                            : current.filter((k) => k !== perm.key),
                                        };
                                      });
                                    }}
                                  />
                                  <span className="rbac-perm-label-text">
                                    <strong>{perm.label}</strong>
                                    <span className="rbac-perm-desc">{perm.description}</span>
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              );
            })() : (
              <p>Loading permissions…</p>
            )}
          </section>
        </div>
      )}

    </section>
  );
}

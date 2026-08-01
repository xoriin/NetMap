import { useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { Check, X, Pencil } from "lucide-react";
import { IconUsers } from "@tabler/icons-react";
import { api, type User } from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { userInitials } from "../../../utils/format";

const BUILT_IN_ROLES = ["SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"];

export function UsersTab({
  accessToken,
  users,
  usersLoading,
  setUsers,
  onReloadUsers,
  onShowUserAudit,
  onError,
  onSuccess,
}: {
  accessToken: string;
  users: User[];
  usersLoading: boolean;
  setUsers: Dispatch<SetStateAction<User[] | null>>;
  onReloadUsers: () => void;
  onShowUserAudit: (userId: number) => void;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const [userSearch, setUserSearch] = useState("");
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [resetPasswordForm, setResetPasswordForm] = useState<{ userId: number | null; password: string }>({ userId: null, password: "" });
  const [editingEmailId, setEditingEmailId] = useState<number | null>(null);
  const [editingEmailValue, setEditingEmailValue] = useState("");
  const [createForm, setCreateForm] = useState({ username: "", password: "", email: "", role: "Viewer", is_active: true });

  const rolesQuery = useApiQuery(() => api.getRolePermissions(accessToken), [accessToken]);
  const customRoles = Object.keys(rolesQuery.data?.roles ?? {}).filter((r) => !BUILT_IN_ROLES.includes(r)).sort();

  async function updateUser(userId: number, payload: { role?: string; is_active?: boolean; email?: string | null; avatar_data?: string | null }) {
    setBusyUserId(userId);
    onError(null); onSuccess(null);
    try {
      const updated = await api.updateUser(accessToken, userId, payload);
      setUsers((current) => (current ?? []).map((u) => (u.id === updated.id ? updated : u)));
      onSuccess(`Updated ${updated.username}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to update user");
    } finally { setBusyUserId(null); }
  }

  function handleAdminAvatarUpload(userId: number, file: File) {
    if (!file.type.startsWith("image/")) { onError("Please select an image file."); return; }
    if (file.size > 2 * 1024 * 1024) { onError("Image must be under 2 MB."); return; }
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
    onError(null); onSuccess(null);
    try {
      await api.resetUserPassword(accessToken, resetPasswordForm.userId, resetPasswordForm.password);
      const user = users.find((u) => u.id === resetPasswordForm.userId);
      onSuccess(`Password reset for ${user?.username ?? "user"}`);
      setResetPasswordForm({ userId: null, password: "" });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to reset password");
    } finally { setBusyUserId(null); }
  }

  async function forceLogout(userId: number) {
    setBusyUserId(userId);
    onError(null); onSuccess(null);
    try {
      await api.forceLogoutUser(accessToken, userId);
      const user = users.find((u) => u.id === userId);
      onSuccess(`Logged out all sessions for ${user?.username ?? "user"}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to force logout");
    } finally { setBusyUserId(null); }
  }

  async function unlockLogin(userId: number) {
    setBusyUserId(userId);
    onError(null); onSuccess(null);
    try {
      await api.unlockUserLogin(accessToken, userId);
      const user = users.find((u) => u.id === userId);
      onSuccess(`Login lockout cleared for ${user?.username ?? "user"}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to unlock login");
    } finally { setBusyUserId(null); }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    onError(null); onSuccess(null);
    try {
      const created = await api.createUser(accessToken, createForm);
      setUsers((current) => [...(current ?? []), created].sort((a, b) => a.username.localeCompare(b.username)));
      setCreateForm({ username: "", password: "", email: "", role: "Viewer", is_active: true });
      onSuccess(`Created ${created.username}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to create user");
    }
  }

  const filteredUsers = useMemo(
    () => users.filter((u) => !userSearch || u.username.toLowerCase().includes(userSearch.toLowerCase())),
    [users, userSearch],
  );

  return (
    <div className="admin-tab-content">
      <section className="panel admin-panel nm-app-panel">
        <div className="admin-panel-header nm-app-panel-header">
          <h2 className="admin-section-title"><IconUsers size={16} />Users</h2>
          <button type="button" className="nm-btn" onClick={onReloadUsers}>Refresh</button>
        </div>
        <input className="admin-search" type="search" placeholder="Search users…" value={userSearch} onChange={(e) => setUserSearch(e.target.value)} />
        {usersLoading ? <p>Loading…</p> : (
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
                    <span className="admin-user-name">
                      {row.username}
                      {row.auth_source === "oidc" && (
                        <span
                          className="nm-pill nm-pill--sso"
                          title={`Signs in with single sign-on${row.sso_issuer ? ` — ${row.sso_issuer}` : ""}${row.sso_last_login_at ? ` (last SSO login ${new Date(row.sso_last_login_at).toLocaleString()})` : ""}`}
                        >
                          SSO
                        </span>
                      )}
                    </span>
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
                    {customRoles.map(r => (
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
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busyUserId === row.id} onClick={() => setResetPasswordForm({ userId: row.id, password: "" })}>Reset PW</button>
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busyUserId === row.id} onClick={() => void unlockLogin(row.id)}>Unlock</button>
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={busyUserId === row.id} onClick={() => void forceLogout(row.id)}>Logout</button>
                  <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => onShowUserAudit(row.id)}>Audit</button>
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
              <button type="submit" className="nm-btn nm-btn--primary" disabled={busyUserId === resetPasswordForm.userId}>Save</button>
              <button type="button" className="nm-btn" onClick={() => setResetPasswordForm({ userId: null, password: "" })}>Cancel</button>
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
                {customRoles.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="inline-toggle"><input checked={createForm.is_active} type="checkbox" onChange={(e) => setCreateForm((c) => ({ ...c, is_active: e.target.checked }))} />Active on create</label>
          <button type="submit" className="nm-btn nm-btn--primary">Create user</button>
        </form>
      </section>
    </div>
  );
}

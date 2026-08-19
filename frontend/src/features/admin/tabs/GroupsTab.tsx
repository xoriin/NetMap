import { useEffect, useState } from "react";
import { IconShieldCheck } from "@tabler/icons-react";
import { api } from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { useConfirm } from "../../../components/ConfirmDialog";

export function GroupsTab({
  accessToken,
  onError,
  onSuccess,
}: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const confirmAction = useConfirm();
  const [localRolePerms, setLocalRolePerms] = useState<Record<string, string[]>>({});
  const [groupsBusy, setGroupsBusy] = useState(false);
  const [showNewGroupForm, setShowNewGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const permsQuery = useApiQuery(() => api.getRolePermissions(accessToken), [accessToken]);
  const rolePermissions = permsQuery.data;

  useEffect(() => {
    if (permsQuery.data) setLocalRolePerms(permsQuery.data.roles);
  }, [permsQuery.data]);

  async function saveRolePermissions() {
    setGroupsBusy(true);
    onError(null); onSuccess(null);
    try {
      const updated = await api.updateRolePermissions(accessToken, localRolePerms);
      permsQuery.setData(updated);
      setLocalRolePerms(updated.roles);
      onSuccess("Role permissions saved.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to save role permissions");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function createGroup(name: string) {
    if (!name.trim()) return;
    setGroupsBusy(true);
    onError(null); onSuccess(null);
    try {
      const updated = await api.createRole(accessToken, name.trim());
      permsQuery.setData(updated);
      setLocalRolePerms(updated.roles);
      setNewGroupName("");
      setShowNewGroupForm(false);
      onSuccess(`Role "${name.trim()}" created.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to create role");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function deleteGroup(name: string) {
    setGroupsBusy(true);
    onError(null); onSuccess(null);
    try {
      const updated = await api.deleteRole(accessToken, name);
      permsQuery.setData(updated);
      setLocalRolePerms(updated.roles);
      onSuccess(`Role "${name}" deleted. Affected users reassigned to Viewer.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to delete role");
    } finally {
      setGroupsBusy(false);
    }
  }

  return (
    <div className="admin-tab-content">
      <section className="panel admin-panel nm-app-panel">
        <div className="admin-panel-header nm-app-panel-header">
          <h2 className="admin-section-title"><IconShieldCheck size={16} />Role Permissions</h2>
          <div className="admin-panel-actions">
            <button type="button" className="nm-btn" onClick={() => { setShowNewGroupForm((v) => !v); setNewGroupName(""); }}>
              {showNewGroupForm ? "Cancel" : "+ New group"}
            </button>
            <button type="button" className="nm-btn nm-btn--primary" disabled={groupsBusy} onClick={() => void saveRolePermissions()}>
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
              className="nm-btn nm-btn--primary"
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
          const BUILT_IN = ["SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"] as const;
          const customRoles = Object.keys(localRolePerms).filter(r => !["SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"].includes(r)).sort();
          const allRoles = [...BUILT_IN, ...customRoles];
          return (
            <div className="rbac-roles-grid">
              {allRoles.map((role) => {
                const isSuperAdmin = role === "SuperAdmin";
                const isCustom = !["SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"].includes(role);
                const label = role === "NetworkAdmin" ? "Network Admin" : role === "SecurityAnalyst" ? "Security Analyst" : role;
                return (
                  <div key={role} className={`rbac-role-card${isCustom ? " rbac-role-card--custom" : ""}`}>
                    <div className="rbac-role-header">
                      <h3 className="rbac-role-name">{label}</h3>
                      {isCustom && <button
                        type="button"
                        className="rbac-delete-btn"
                        title={`Delete "${role}" group`}
                        disabled={groupsBusy}
                        onClick={() => {
                          void confirmAction({
                            title: "Delete role",
                            message: `Delete the "${role}" role?`,
                            detail: "Users assigned this role will be moved to Viewer.",
                            confirmLabel: "Delete role",
                          }).then((confirmed) => { if (confirmed) void deleteGroup(role); });
                        }}
                      >✕</button>}
                    </div>
                    <ul className="rbac-perm-list">
                      {rolePermissions.permissions.map((perm) => {
                        const granted = isSuperAdmin || (localRolePerms[role] ?? []).includes(perm.key);
                        return (
                          <li key={perm.key} className="rbac-perm-row">
                            <label className="rbac-perm-label">
                              <input
                                type="checkbox"
                                checked={granted}
                                disabled={isSuperAdmin}
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
  );
}

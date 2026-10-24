import { AdminTaskPanel } from "../AdminTaskPanel";
import { useEffect, useState } from "react";
import { IconShieldCheck } from "@tabler/icons-react";
import { KeyRound, ShieldCheck, UserPlus, Users } from "lucide-react";
import { api, type User } from "../../../api/client";
import { DashStat } from "../../../components/DashStat";
import { BarList, CountUp } from "../../../components/Charts";
import { AdminCard } from "../AdminCard";

const BUILT_IN_ROLES = ["SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"];
const roleLabel = (role: string) => role === "NetworkAdmin" ? "Network Admin" : role === "SecurityAnalyst" ? "Security Analyst" : role;
import { useApiQuery } from "../../../hooks/useApiQuery";
import { useConfirm } from "../../../components/ConfirmDialog";
import { PanelSkeleton } from "../../../components/Skeleton";

export function GroupsTab({
  accessToken,
  users = [],
  onError,
  onSuccess,
}: {
  accessToken: string;
  users?: User[];
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
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmedName)) {
      onError("Group names must start with a letter and contain only letters, numbers, underscores, or hyphens.");
      return;
    }
    setGroupsBusy(true);
    onError(null); onSuccess(null);
    try {
      const updated = await api.createRole(accessToken, trimmedName);
      permsQuery.setData(updated);
      setLocalRolePerms(updated.roles);
      setNewGroupName("");
      setShowNewGroupForm(false);
      onSuccess(`Role "${trimmedName}" created.`);
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

  const permissionCount = rolePermissions?.permissions.length ?? 0;
  const roleNames = [...BUILT_IN_ROLES, ...Object.keys(localRolePerms).filter((r) => !BUILT_IN_ROLES.includes(r)).sort()];
  const grantedCount = (role: string) => role === "SuperAdmin" ? permissionCount : (localRolePerms[role] ?? []).length;
  const customCount = roleNames.length - BUILT_IN_ROLES.length;
  const areas = new Set((rolePermissions?.permissions ?? []).map((p) => p.key.split("_")[0])).size;
  const usersPerRole = new Map<string, number>();
  for (const u of users) usersPerRole.set(u.role, (usersPerRole.get(u.role) ?? 0) + 1);
  const largestRole = [...usersPerRole.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  return (
    <div className="admin-tab-content nm-motion">
      <div className="nm-bento nm-bento--four">
        <AdminCard title="Permission coverage" icon={<ShieldCheck size={16} />}>
          {rolePermissions ? <>
            <p className="tool-note">Permissions granted to each role, out of {permissionCount}.</p>
            <BarList label="Permissions granted per role" max={permissionCount}
              items={roleNames.map((role) => ({ label: roleLabel(role), value: grantedCount(role), hint: `${grantedCount(role)} of ${permissionCount}` }))} />
          </> : <PanelSkeleton lines={4} />}
        </AdminCard>
        <div className="dash-stats nm-bento-stats nm-summary-band">
          <DashStat accent="teal" className="nm-motion-item" icon={<ShieldCheck size={20} />} label="Roles" value={<CountUp value={roleNames.length} />} sub={`${BUILT_IN_ROLES.length} built-in`} />
          <DashStat accent="purple" className="nm-motion-item" icon={<UserPlus size={20} />} label="Custom groups" value={<CountUp value={customCount} />}
            sub={customCount ? roleNames.slice(BUILT_IN_ROLES.length).join(", ") : "Add one with + New group"} />
          <DashStat accent="blue" className="nm-motion-item" icon={<KeyRound size={20} />} label="Permissions" value={<CountUp value={permissionCount} />} sub={`Across ${areas} areas`} />
          <DashStat accent="green" className="nm-motion-item" icon={<Users size={20} />} label="Users assigned" value={<CountUp value={users.length} />}
            sub={largestRole ? `${roleLabel(largestRole)} is the largest role` : "No users loaded"} />
        </div>
      </div>
      <section className="panel admin-panel nm-app-panel nm-motion-item" aria-label="Role permissions">
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
          return (
            <div className="rbac-roles-grid">
              {roleNames.map((role) => {
                const isSuperAdmin = role === "SuperAdmin";
                const isCustom = !BUILT_IN_ROLES.includes(role);
                return (
                  <AdminTaskPanel key={role} title={roleLabel(role)} icon={<IconShieldCheck size={18} />} className="admin-role-panel"
                    actions={<div className="admin-panel-actions">
                      <span className="admin-task-count">{grantedCount(role)} of {permissionCount}</span>
                      {isCustom && (<button
                        type="button"
                        className="nm-btn nm-btn--sm nm-btn--danger"
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
                      >✕</button>)}
                    </div>}>
                    <ul className="rbac-perm-list admin-perm-scroll">
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
                  </AdminTaskPanel>
                );
              })}
            </div>
          );
        })() : (
          <PanelSkeleton lines={8} />
        )}
      </section>
    </div>
  );
}

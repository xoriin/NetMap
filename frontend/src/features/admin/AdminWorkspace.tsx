import { useCallback, useEffect, useMemo, useState } from "react";
import "./admin.css";
import {
  api,
  type SystemSettings, type VersionInfo,
  type TopologyGraph, type User,
} from "../../api/client";
import { useApiQuery } from "../../hooks/useApiQuery";
import { useToast } from "../../components/Toast";

import { SystemTab } from "./tabs/SystemTab";
import { UsersTab } from "./tabs/UsersTab";
import { SecurityTab } from "./tabs/SecurityTab";
import { NotificationsTab } from "./tabs/NotificationsTab";
import { AlertsTab } from "./tabs/AlertsTab";
import { GroupsTab } from "./tabs/GroupsTab";
import { CredentialsTab } from "./tabs/CredentialsTab";
import { AutomationTab } from "./tabs/AutomationTab";
import { DeviceIconsTab } from "./tabs/DeviceIconsTab";
import { CloudProvidersPanel } from "./tabs/CloudProvidersPanel";
import { DelegatedSystemTab } from "./tabs/DelegatedSystemTab";
import {
  ADMIN_TAB_CHANGE_EVENT,
  availableAdminTabs,
  navigateToAdminTab,
  readAdminTabFromLocation,
  type AdminTabId,
} from "./adminNavigation";
import { userHasPermission } from "../../utils/permissions";

export function AdminWorkspace({
  accessToken,
  graph,
  onSettingsChange,
  onOpenWhatsNew,
  versionInfo,
  user,
}: {
  accessToken: string;
  graph: TopologyGraph;
  onSettingsChange: (settings: SystemSettings) => void;
  onOpenWhatsNew: () => void;
  versionInfo: VersionInfo | null;
  user: User;
}) {
  const allowedTabs = useMemo(() => availableAdminTabs(user), [user]);
  const [activeTab, setActiveTab] = useState<AdminTabId>(() => {
    const requested = readAdminTabFromLocation();
    return allowedTabs.some((tab) => tab.id === requested) ? requested : allowedTabs[0]?.id ?? "system";
  });
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  // Set when the Users section jumps to Security with a per-user audit filter;
  // cleared whenever navigation selects another Admin section.
  const [auditFocusUserId, setAuditFocusUserId] = useState<number | null>(null);

  const canManageUsers = userHasPermission(user, "user_manage");
  const usersQuery = useApiQuery(() => canManageUsers ? api.listUsers(accessToken) : Promise.resolve([]), [accessToken, canManageUsers]);
  const users = usersQuery.data ?? [];

  useEffect(() => {
    const syncAdminTab = () => {
      setAuditFocusUserId(null);
      const requested = readAdminTabFromLocation();
      setActiveTab(allowedTabs.some((tab) => tab.id === requested) ? requested : allowedTabs[0]?.id ?? "system");
    };
    window.addEventListener("popstate", syncAdminTab);
    window.addEventListener("hashchange", syncAdminTab);
    window.addEventListener(ADMIN_TAB_CHANGE_EVENT, syncAdminTab);
    return () => {
      window.removeEventListener("popstate", syncAdminTab);
      window.removeEventListener("hashchange", syncAdminTab);
      window.removeEventListener(ADMIN_TAB_CHANGE_EVENT, syncAdminTab);
    };
  }, [allowedTabs]);

  function showUserAudit(userId: number) {
    navigateToAdminTab("security");
    setAuditFocusUserId(userId);
  }

  const showSuccess = useCallback((message: string | null) => {
    if (message) toast.success(message);
  }, [toast]);

  return (
    <section className="admin-layout nm-admin-workspace">
      <div className="admin-purpose-content">
        {error && <div className="form-error">{error}</div>}
        {usersQuery.error && <div className="form-error">{usersQuery.error}</div>}

        {activeTab === "system" && user.role === "SuperAdmin" && (
          <SystemTab
            accessToken={accessToken}
            versionInfo={versionInfo}
            onOpenWhatsNew={onOpenWhatsNew}
            onSettingsChange={onSettingsChange}
            onError={setError}
            onSuccess={showSuccess}
          />
        )}
        {activeTab === "system" && user.role !== "SuperAdmin" && (
          <DelegatedSystemTab accessToken={accessToken} canViewDiagnostics={userHasPermission(user, "diagnostics_view")} canManageBackups={userHasPermission(user, "backup_manage")} />
        )}
        {activeTab === "users" && (
          <UsersTab
            accessToken={accessToken}
            users={users}
            usersLoading={usersQuery.isLoading}
            setUsers={usersQuery.setData}
            onReloadUsers={() => void usersQuery.reload()}
            onShowUserAudit={showUserAudit}
            onError={setError}
            onSuccess={showSuccess}
            canManageSuperAdmins={user.role === "SuperAdmin"}
            canViewAudit={userHasPermission(user, "audit_view")}
          />
        )}
        {activeTab === "devices-icons" && (
          <DeviceIconsTab accessToken={accessToken} onError={setError} onSuccess={showSuccess} />
        )}
        {activeTab === "cloud-providers" && (
          <div className="admin-tab-content admin-tab-content--single">
            <CloudProvidersPanel accessToken={accessToken} onError={setError} onSuccess={showSuccess} />
          </div>
        )}
        {activeTab === "security" && (
          <SecurityTab
            accessToken={accessToken}
            users={users}
            initialUserFilter={auditFocusUserId}
            showSensitivePanels={user.role === "SuperAdmin"}
          />
        )}
        {activeTab === "notifications" && (
          <NotificationsTab accessToken={accessToken} onError={setError} onSuccess={showSuccess} />
        )}
        {activeTab === "alerts" && (
          <AlertsTab accessToken={accessToken} graph={graph} />
        )}
        {activeTab === "groups" && (
          <GroupsTab accessToken={accessToken} onError={setError} onSuccess={showSuccess} />
        )}
        {activeTab === "credentials" && (
          <CredentialsTab accessToken={accessToken} onError={setError} onSuccess={showSuccess} />
        )}
        {activeTab === "automation" && (
          <AutomationTab accessToken={accessToken} onError={setError} onSuccess={showSuccess} canManageAutomation={userHasPermission(user, "automation_manage")} canManageDiscovery={userHasPermission(user, "discovery_manage")} />
        )}
      </div>
    </section>
  );
}

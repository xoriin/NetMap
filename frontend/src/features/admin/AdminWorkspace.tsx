import { useCallback, useEffect, useState } from "react";
import "./admin.css";
import {
  api,
  type SystemSettings, type VersionInfo,
  type TopologyGraph,
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
import {
  ADMIN_TAB_CHANGE_EVENT,
  navigateToAdminTab,
  readAdminTabFromLocation,
  type AdminTabId,
} from "./adminNavigation";

export function AdminWorkspace({
  accessToken,
  graph,
  onSettingsChange,
  onOpenWhatsNew,
  versionInfo,
}: {
  accessToken: string;
  graph: TopologyGraph;
  onSettingsChange: (settings: SystemSettings) => void;
  onOpenWhatsNew: () => void;
  versionInfo: VersionInfo | null;
}) {
  const [activeTab, setActiveTab] = useState<AdminTabId>(() => readAdminTabFromLocation());
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  // Set when the Users section jumps to Security with a per-user audit filter;
  // cleared whenever navigation selects another Admin section.
  const [auditFocusUserId, setAuditFocusUserId] = useState<number | null>(null);

  const usersQuery = useApiQuery(() => api.listUsers(accessToken), [accessToken]);
  const users = usersQuery.data ?? [];

  useEffect(() => {
    const syncAdminTab = () => {
      setAuditFocusUserId(null);
      setActiveTab(readAdminTabFromLocation());
    };
    window.addEventListener("popstate", syncAdminTab);
    window.addEventListener("hashchange", syncAdminTab);
    window.addEventListener(ADMIN_TAB_CHANGE_EVENT, syncAdminTab);
    return () => {
      window.removeEventListener("popstate", syncAdminTab);
      window.removeEventListener("hashchange", syncAdminTab);
      window.removeEventListener(ADMIN_TAB_CHANGE_EVENT, syncAdminTab);
    };
  }, []);

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

        {activeTab === "system" && (
          <SystemTab
            accessToken={accessToken}
            versionInfo={versionInfo}
            onOpenWhatsNew={onOpenWhatsNew}
            onSettingsChange={onSettingsChange}
            onError={setError}
            onSuccess={showSuccess}
          />
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
          />
        )}
        {activeTab === "devices-icons" && (
          <DeviceIconsTab accessToken={accessToken} onError={setError} onSuccess={showSuccess} />
        )}
        {activeTab === "security" && (
          <SecurityTab
            accessToken={accessToken}
            users={users}
            initialUserFilter={auditFocusUserId}
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
          <AutomationTab accessToken={accessToken} onError={setError} onSuccess={showSuccess} />
        )}
      </div>
    </section>
  );
}

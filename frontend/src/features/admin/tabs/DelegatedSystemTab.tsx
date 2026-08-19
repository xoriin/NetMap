import { useEffect, useState } from "react";
import { IconDatabase, IconServer } from "@tabler/icons-react";
import { api, type ScheduledBackup, type SystemDiagnostics } from "../../../api/client";
import { useConfirm } from "../../../components/ConfirmDialog";
import { triggerDownload } from "../../../utils/download";
import { fmtBytes } from "../notificationProfiles";

export function DelegatedSystemTab({ accessToken, canViewDiagnostics, canManageBackups }: { accessToken: string; canViewDiagnostics: boolean; canManageBackups: boolean }) {
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [backups, setBackups] = useState<ScheduledBackup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  useEffect(() => {
    if (canViewDiagnostics) void api.getSystemDiagnostics(accessToken).then(setDiagnostics).catch((err) => setError(err instanceof Error ? err.message : "Unable to load diagnostics"));
    if (canManageBackups) void api.listScheduledBackups(accessToken).then(setBackups).catch((err) => setError(err instanceof Error ? err.message : "Unable to load backups"));
  }, [accessToken, canManageBackups, canViewDiagnostics]);
  async function remove(filename: string) {
    if (!await confirm({ title: "Delete scheduled backup", message: `Permanently delete ${filename}?`, confirmLabel: "Delete backup" })) return;
    await api.deleteScheduledBackup(accessToken, filename);
    setBackups((current) => current.filter((entry) => entry.filename !== filename));
  }
  return <div className="admin-tab-content admin-system-page">
    {error && <div className="form-error">{error}</div>}
    {canManageBackups && <section className="panel admin-panel nm-app-panel admin-system-card">
      <div className="admin-system-card-header nm-app-panel-header"><h2 className="admin-section-title"><IconDatabase size={16} />Database backups</h2></div>
      <div className="admin-system-card-body"><p className="tool-note">Create and manage backups. Database restore remains restricted to SuperAdmin.</p>
        <button className="nm-btn nm-btn--primary" type="button" onClick={() => void api.downloadBackup(accessToken).then(triggerDownload)}>Download backup</button>
        <div className="admin-schedule-card-list">{backups.map((backup) => <article className="admin-schedule-card" key={backup.filename}>
          <strong>{backup.filename}</strong><span>{fmtBytes(backup.size_bytes)}</span><div className="admin-row-actions">
            <button className="nm-btn nm-btn--sm" type="button" onClick={() => void api.downloadScheduledBackup(accessToken, backup.filename).then(triggerDownload)}>Download</button>
            <button className="nm-btn nm-btn--sm nm-btn--danger" type="button" onClick={() => void remove(backup.filename)}>Delete</button>
          </div></article>)}{backups.length === 0 && <p className="tool-note">No scheduled backup files are available.</p>}</div>
      </div>
    </section>}
    {canViewDiagnostics && <section className="panel admin-panel nm-app-panel admin-system-card"><div className="admin-system-card-header nm-app-panel-header"><h2 className="admin-section-title"><IconServer size={16} />System diagnostics</h2></div><div className="admin-system-card-body">{diagnostics ? <pre className="nm-code-block">{JSON.stringify(diagnostics, null, 2)}</pre> : <p className="tool-note">Loading diagnostics…</p>}</div></section>}
  </div>;
}

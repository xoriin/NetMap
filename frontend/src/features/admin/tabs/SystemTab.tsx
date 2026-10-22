import { AdminTaskPanel } from "../AdminTaskPanel";
import { useEffect, useState, type FormEvent } from "react";
import { Activity, CalendarClock, Download, FileUp, Palette, Settings, Timer, Upload } from "lucide-react";
import {
  IconCloud, IconDatabase,
  IconServer,
} from "@tabler/icons-react";
import {
  api,
  type SystemSettings, type SystemDiagnostics, type VersionInfo, type RestoreValidationResult,
  type ScheduledBackup,
} from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { useConfirm } from "../../../components/ConfirmDialog";
import { triggerDownload } from "../../../utils/download";
import { fmtBytes, legacyChannelLabels, notificationProfileMethodLabel } from "../notificationProfiles";
import { EncryptedBackupModal } from "../EncryptedBackupModal";
import { PanelSkeleton } from "../../../components/Skeleton";
import { StatusCssErrors } from "../../status-pages/StatusCssErrors";
import { cssErrors, statusPageDefaultCssApi } from "../../status-pages/statusPagesEditorApi";

function StatusPageDefaultCssCard({ accessToken, onError, onSuccess }: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const [css, setCss] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    statusPageDefaultCssApi.get(accessToken)
      .then((result) => { if (!cancelled) setCss(result.css ?? ""); })
      .catch((err) => { if (!cancelled) { setCss(""); onError(err instanceof Error ? err.message : "Unable to load the default status page CSS"); } });
    return () => { cancelled = true; };
  }, [accessToken, onError]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (css === null) return;
    setBusy(true);
    setProblems([]);
    try {
      const result = await statusPageDefaultCssApi.save(accessToken, css.trim() ? css : null);
      setCss(result.css ?? "");
      onSuccess("Default status page CSS saved");
    } catch (err) {
      const found = cssErrors(err);
      if (found) setProblems(found);
      else onError(err instanceof Error ? err.message : "Unable to save the default status page CSS");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel admin-panel nm-app-panel admin-system-card">
      <div className="admin-system-card-header nm-app-panel-header">
        <h2 className="admin-section-title"><Palette size={16} />Status page default CSS</h2>
      </div>
      {css === null ? <div className="admin-system-card-body"><PanelSkeleton lines={4} /></div> : (
        <form className="tool-form admin-system-card-body" onSubmit={(event) => void save(event)}>
          <label>
            Default CSS for new status pages
            <textarea
              rows={8}
              spellCheck={false}
              value={css}
              placeholder=".sp-row { … }"
              aria-invalid={problems.length > 0 || undefined}
              aria-describedby={problems.length > 0 ? "status-default-css-errors" : undefined}
              onChange={(event) => { setProblems([]); setCss(event.target.value); }}
            />
            <span className="tool-note tool-note--hint">Copied into each new status page when it is created. Existing pages keep their own CSS.</span>
          </label>
          {problems.length > 0 && <StatusCssErrors id="status-default-css-errors" errors={problems} />}
          <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>
            {busy ? "Saving…" : "Save default CSS"}
          </button>
        </form>
      )}
    </section>
  );
}

export function SystemTab({
  accessToken,
  versionInfo,
  onOpenWhatsNew,
  onSettingsChange,
  onError,
  onSuccess,
}: {
  accessToken: string;
  versionInfo: VersionInfo | null;
  onOpenWhatsNew: () => void;
  onSettingsChange: (settings: SystemSettings) => void;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const [settingsForm, setSettingsForm] = useState<SystemSettings>({
    app_name: "NetMap",
    login_message: "",
    announcement: "",
    support_email: "",
    support_url: "",
    live_ping_enabled: true,
    monitor_interval_seconds: 300,
    idle_timeout_minutes: 0,
    active_network_public_targets_enabled: false,
    ip_reservation_default_expiry_enabled: true,
    ip_reservation_reminder_enabled: false,
    ip_reservation_reminder_days: 3,
    ip_reservation_reminder_channels: [],
    backup_schedule_enabled: false,
    backup_schedule_interval_hours: 24,
    backup_retention_count: 7,
    totp_required: "off",
  });
  const [monitorIntervalRaw, setMonitorIntervalRaw] = useState("300");
  const [idleTimeoutRaw, setIdleTimeoutRaw] = useState("0");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreValidation, setRestoreValidation] = useState<RestoreValidationResult | null>(null);
  const [restoreValidationError, setRestoreValidationError] = useState<string | null>(null);
  const [backupDirectory, setBackupDirectory] = useState<string | null>(null);
  useEffect(() => { void api.getBackupLocation(accessToken).then((result) => setBackupDirectory(result.directory)).catch(() => setBackupDirectory(null)); }, [accessToken]);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [showEncryptedBackupModal, setShowEncryptedBackupModal] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduledBackups, setScheduledBackups] = useState<ScheduledBackup[]>([]);
  const [scheduledBackupsBusyName, setScheduledBackupsBusyName] = useState<string | null>(null);
  const confirmAction = useConfirm();

  async function loadScheduledBackups() {
    try {
      setScheduledBackups(await api.listScheduledBackups(accessToken));
    } catch { /* ignore — surfaced via the panel staying empty */ }
  }

  useEffect(() => {
    void loadScheduledBackups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  async function saveBackupSchedule() {
    const prefix = settingsForm.backup_filename_prefix ?? "netmap-backup";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(prefix)) {
      onError("Use a filename prefix starting with a letter or number, followed by letters, numbers, underscores or hyphens (up to 60 characters).");
      return;
    }
    setScheduleBusy(true);
    onError(null); onSuccess(null);
    try {
      const updated = await api.updateAdminSettings(accessToken, {
        backup_schedule_enabled: settingsForm.backup_schedule_enabled,
        backup_schedule_interval_hours: settingsForm.backup_schedule_interval_hours,
        backup_retention_count: settingsForm.backup_retention_count,
        backup_filename_prefix: settingsForm.backup_filename_prefix ?? "netmap-backup",
        backup_date_format: settingsForm.backup_date_format ?? "yyyy-MM-dd",
      });
      setSettingsForm(updated);
      onSettingsChange(updated);
      onSuccess("Backup schedule saved");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to save backup schedule");
    } finally { setScheduleBusy(false); }
  }

  async function downloadScheduledBackupFile(filename: string) {
    setScheduledBackupsBusyName(filename);
    try {
      const result = await api.downloadScheduledBackup(accessToken, filename);
      triggerDownload(result);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Download failed");
    } finally { setScheduledBackupsBusyName(null); }
  }

  async function deleteScheduledBackupFile(filename: string) {
    const confirmed = await confirmAction({
      title: "Delete scheduled backup",
      message: `This permanently deletes ${filename}.`,
      confirmLabel: "Delete backup",
    });
    if (!confirmed) return;
    setScheduledBackupsBusyName(filename);
    try {
      await api.deleteScheduledBackup(accessToken, filename);
      setScheduledBackups((prev) => prev.filter((b) => b.filename !== filename));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Delete failed");
    } finally { setScheduledBackupsBusyName(null); }
  }

  const systemQuery = useApiQuery(async () => {
    const [syslog, settings] = await Promise.all([
      api.syslogStatus(accessToken),
      api.adminSettings(accessToken),
    ]);
    return { syslog, settings };
  }, [accessToken]);
  const syslogStatus = systemQuery.data?.syslog ?? null;

  const notificationProfilesQuery = useApiQuery(() => api.listNotificationProfiles(accessToken), [accessToken]);
  const notificationProfiles = notificationProfilesQuery.data ?? [];

  useEffect(() => {
    const settings = systemQuery.data?.settings;
    if (!settings) return;
    setSettingsForm(settings);
    setMonitorIntervalRaw(String(settings.monitor_interval_seconds));
    setIdleTimeoutRaw(String(settings.idle_timeout_minutes));
  }, [systemQuery.data]);

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSettingsBusy(true);
    onError(null); onSuccess(null);
    try {
      const { totp_required, ...payload } = settingsForm;
      const updated = await api.updateAdminSettings(accessToken, payload);
      setSettingsForm(updated);
      setMonitorIntervalRaw(String(updated.monitor_interval_seconds));
      setIdleTimeoutRaw(String(updated.idle_timeout_minutes));
      onSettingsChange(updated);
      onSuccess("Settings saved");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to save settings");
    } finally { setSettingsBusy(false); }
  }

  async function runBackup(passphrase?: string) {
    setBackupBusy(passphrase ? "encrypted-backup" : "backup");
    onError(null); onSuccess(null);
    try {
      const result = passphrase
        ? await api.downloadEncryptedBackup(accessToken, passphrase)
        : await api.downloadBackup(accessToken);
      triggerDownload(result);
      onSuccess(`Downloaded ${result.filename}`);
      if (passphrase) setShowEncryptedBackupModal(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Backup failed");
    } finally { setBackupBusy(null); }
  }

  async function runValidateRestore() {
    if (!restoreFile) return;
    setBackupBusy("validate");
    setRestoreValidationError(null);
    setRestoreValidation(null);
    onError(null); onSuccess(null);
    try {
      const result = await api.validateRestoreBackup(
        accessToken,
        restoreFile,
        restorePassphrase || undefined,
      );
      setRestoreValidation(result);
    } catch (err) {
      setRestoreValidationError(err instanceof Error ? err.message : "Validation failed");
    } finally { setBackupBusy(null); }
  }

  async function runRestore() {
    if (!restoreFile || !restoreValidation?.valid) return;
    const confirmed = await confirmAction({
      title: "Restore database",
      message: `This overwrites the current live database with ${restoreFile.name}.`,
      detail: `Everything since that backup — ${restoreValidation.devices ?? 0} devices, ${restoreValidation.users ?? 0} users, ${restoreValidation.subnets ?? 0} subnets, and all other data — will be replaced. This cannot be undone.`,
      confirmLabel: "Restore database",
      typeToConfirm: "restore",
    });
    if (!confirmed) return;
    setBackupBusy("restore");
    onError(null); onSuccess(null);
    try {
      await api.restoreBackup(accessToken, restoreFile, restorePassphrase || undefined);
      onSuccess(`Restored from ${restoreFile.name}`);
      setRestoreFile(null);
      setRestorePassphrase("");
      setRestoreValidation(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Restore failed");
    } finally { setBackupBusy(null); }
  }

  async function loadDiagnostics() {
    setDiagBusy(true);
    try {
      const data = await api.getSystemDiagnostics(accessToken);
      setDiagnostics(data);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to load diagnostics");
    } finally {
      setDiagBusy(false);
    }
  }

  return (
    <div className="admin-tab-content admin-system-page">
      <section className="panel admin-panel nm-app-panel admin-system-card admin-settings-card">
        <div className="admin-system-card-header nm-app-panel-header">
          <h2 className="admin-section-title"><Settings size={16} />App settings</h2>
        </div>
        <form className="tool-form admin-system-card-body" onSubmit={saveSettings}>
          <div className="admin-task-grid">
            <div className="admin-task-col">
            <AdminTaskPanel title="Identity and support" icon={<Settings size={18} />}>

          <label>App name <input maxLength={80} value={settingsForm.app_name} onChange={(e) => setSettingsForm((c) => ({ ...c, app_name: e.target.value }))} /></label>
          <label>Login page message <textarea maxLength={300} rows={2} value={settingsForm.login_message} onChange={(e) => setSettingsForm((c) => ({ ...c, login_message: e.target.value }))} /></label>
          <label>
            Announcement banner
            <textarea maxLength={500} rows={3} placeholder="Leave empty to hide. Shown to all logged-in users." value={settingsForm.announcement} onChange={(e) => setSettingsForm((c) => ({ ...c, announcement: e.target.value }))} />
          </label>
          <label>
            Support email
            <input type="email" maxLength={254} placeholder="help@example.com" value={settingsForm.support_email} onChange={(e) => setSettingsForm((c) => ({ ...c, support_email: e.target.value }))} />
            <span className="tool-note tool-note--hint">Included in password-reset emails so users know who to contact.</span>
          </label>
          <label>
            Support URL
            <input type="text" maxLength={500} placeholder="https://example.com/support" value={settingsForm.support_url} onChange={(e) => setSettingsForm((c) => ({ ...c, support_url: e.target.value }))} />
          </label>
            </AdminTaskPanel>
            <AdminTaskPanel title="Session policy" icon={<Timer size={18} />}>
          <label className="tool-form-inline-check">
            <input
              type="checkbox"
              checked={settingsForm.idle_timeout_minutes > 0}
              onChange={(e) => {
                if (e.target.checked) {
                  const previous = parseInt(idleTimeoutRaw, 10);
                  const minutes = previous >= 1 && previous <= 480 ? previous : 15;
                  setIdleTimeoutRaw(String(minutes));
                  setSettingsForm((c) => ({ ...c, idle_timeout_minutes: minutes }));
                } else {
                  setSettingsForm((c) => ({ ...c, idle_timeout_minutes: 0 }));
                }
              }}
            />
            <span className="tool-form-check-copy">
              <span>Log out inactive users</span>
              <span className="tool-note">When off, users stay signed in until they sign out, their session expires, or it is revoked.</span>
            </span>
          </label>
          {settingsForm.idle_timeout_minutes > 0 && (
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
                      ? <span className="tool-note tool-note--hint" style={{ color: "var(--dash-red)" }}>{err}</span>
                      : <span className="tool-note tool-note--hint">Users are logged out after this many minutes of inactivity (1–480).</span>
                    }
                  </>
                );
              })()}
            </label>
          )}
            </AdminTaskPanel>
            </div>
            <div className="admin-task-col">
            <AdminTaskPanel title="Monitoring and network checks" icon={<Activity size={18} />}>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={settingsForm.live_ping_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, live_ping_enabled: e.target.checked }))} />
            <span className="tool-form-check-copy">
              <span>Enable live ping monitoring</span>
              <span className="tool-note">Uncheck to disable all background ping checks across the app</span>
            </span>
          </label>
          <label>
            Live ping interval (seconds)
            {(() => {
              const n = parseInt(monitorIntervalRaw, 10);
              const err = monitorIntervalRaw.trim() === "" || isNaN(n) ? "Must be a number" : n < 30 ? "Minimum is 30 seconds" : n > 3600 ? "Maximum is 3600 seconds (1 hour)" : null;
              return (
                <>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="e.g. 300"
                    value={monitorIntervalRaw}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setMonitorIntervalRaw(raw);
                      const parsed = parseInt(raw, 10);
                      if (!isNaN(parsed) && parsed >= 30 && parsed <= 3600) {
                        setSettingsForm((c) => ({ ...c, monitor_interval_seconds: parsed }));
                      }
                    }}
                    style={err ? { borderColor: "var(--dash-red)" } : undefined}
                  />
                  {err
                    ? <span className="tool-note tool-note--hint" style={{ color: "var(--dash-red)" }}>{err}</span>
                    : <span className="tool-note tool-note--hint">How often NetMap runs background ping and service checks. Default is 300 seconds.</span>
                  }
                </>
              );
            })()}
          </label>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={settingsForm.active_network_public_targets_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, active_network_public_targets_enabled: e.target.checked }))} />
            <span className="tool-form-check-copy">
              <span>Allow public active network targets</span>
              <span className="tool-note">Enables public IP and hostname targets for ping, traceroute, and TCP checks</span>
            </span>
          </label>
            </AdminTaskPanel>
            <AdminTaskPanel title="IP reservation policy" icon={<CalendarClock size={18} />}>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={settingsForm.ip_reservation_default_expiry_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, ip_reservation_default_expiry_enabled: e.target.checked }))} />
            <span className="tool-form-check-copy">
              <span>Default new IP reservations to +90 days</span>
              <span className="tool-note">When enabled, new IPAM reservations prefill an expiry date 90 days ahead. Users can clear the field before saving.</span>
            </span>
          </label>
          <label className="tool-form-inline-check">
            <input type="checkbox" checked={settingsForm.ip_reservation_reminder_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, ip_reservation_reminder_enabled: e.target.checked }))} />
            <span className="tool-form-check-copy">
              <span>Send IP reservation expiry reminders</span>
              <span className="tool-note">Notifies the channels below once per reservation when it is within the lead time of its expiry date.</span>
            </span>
          </label>
          {settingsForm.ip_reservation_reminder_enabled && (
            <>
              <label>Reminder lead time (days)
                <select value={settingsForm.ip_reservation_reminder_days} onChange={(e) => setSettingsForm((c) => ({ ...c, ip_reservation_reminder_days: Number(e.target.value) }))}>
                  <option value={1}>1 day</option>
                  <option value={3}>3 days</option>
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                </select>
              </label>
              <fieldset className="admin-system-fieldset">
                <legend>Notify via saved methods</legend>
                {settingsForm.ip_reservation_reminder_channels.filter((channel) => !channel.startsWith("profile:")).map(ch => (
                  <label key={ch} className="tool-form-inline-check" style={{ marginBottom: 4 }}>
                    <input type="checkbox" checked
                      onChange={() => setSettingsForm(c => ({
                        ...c,
                        ip_reservation_reminder_channels: c.ip_reservation_reminder_channels.filter(x => x !== ch),
                      }))} />
                    {legacyChannelLabels[ch] ?? ch} <span className="tool-note">(legacy)</span>
                  </label>
                ))}
                {notificationProfiles.map(profile => {
                  const target = `profile:${profile.id}`;
                  return (
                    <label key={target} className="tool-form-inline-check" style={{ marginBottom: 4 }}>
                      <input type="checkbox" checked={settingsForm.ip_reservation_reminder_channels.includes(target)}
                        onChange={(e) => setSettingsForm(c => ({
                          ...c,
                          ip_reservation_reminder_channels: e.target.checked
                            ? [...c.ip_reservation_reminder_channels, target]
                            : c.ip_reservation_reminder_channels.filter(x => x !== target),
                        }))} />
                      {profile.name} <span className="tool-note">({notificationProfileMethodLabel(profile)}{profile.enabled ? "" : ", disabled"})</span>
                    </label>
                  );
                })}
                {notificationProfiles.length === 0 && (
                  <p className="tool-note" style={{ margin: '6px 0 0' }}>Add notification methods in Notifications to receive reservation reminders.</p>
                )}
              </fieldset>
            </>
          )}
            </AdminTaskPanel>
            </div>
          </div>
          <button type="submit" className="nm-btn nm-btn--primary" disabled={settingsBusy || (() => { const n = parseInt(idleTimeoutRaw, 10); const m = parseInt(monitorIntervalRaw, 10); const idleInvalid = settingsForm.idle_timeout_minutes > 0 && (isNaN(n) || n < 1 || n > 480); return idleInvalid || isNaN(m) || m < 30 || m > 3600; })()}>
            {settingsBusy ? "Saving…" : "Save settings"}
          </button>
        </form>
      </section>
      <div className="system-tab-grid">
        <div className="system-tab-col">
          <section className="panel admin-panel nm-app-panel admin-system-card">
            <div className="admin-system-card-header nm-app-panel-header">
              <h2 className="admin-section-title"><IconDatabase size={16} />Database backup &amp; restore</h2>
            </div>
            <div className="admin-system-card-body">
              <div className="tool-form">
              <div className="admin-backup-step" role="group" aria-labelledby="admin-backup-download-title">
                <span className="admin-backup-step-title" id="admin-backup-download-title">Download a backup</span>
                <div className="admin-backup-downloads">
                  <button type="button" className="nm-btn nm-btn--primary" disabled={backupBusy !== null} onClick={() => setShowEncryptedBackupModal(true)}>
                    <Download size={14} aria-hidden="true" />Download encrypted backup
                  </button>
                  <button type="button" className="nm-btn nm-btn--secondary" disabled={backupBusy !== null} onClick={() => void runBackup()}>
                    <Download size={14} aria-hidden="true" />{backupBusy === "backup" ? "Preparing…" : "Download unencrypted .db"}
                  </button>
                </div>
              </div>
              <label>
                Restore from backup
                <span className="nm-file" aria-disabled={backupBusy === "restore" || backupBusy === "validate"}>
                  <FileUp size={17} aria-hidden="true" />
                  <span className="nm-file-copy">
                    <strong>{restoreFile ? restoreFile.name : "Choose a backup file"}</strong>
                    <small>.nmbak or .db, up to 256 MB</small>
                  </span>
                  <input
                    accept=".db,.nmbak,application/octet-stream,application/vnd.netmap.backup"
                    type="file"
                    aria-label="Backup file"
                    disabled={backupBusy === "restore" || backupBusy === "validate"}
                    onChange={(e) => {
                      setRestoreFile(e.target.files?.[0] ?? null);
                      setRestoreValidation(null);
                      setRestoreValidationError(null);
                      setRestorePassphrase("");
                    }}
                  />
                </span>
              </label>
              {restoreFile?.name.toLowerCase().endsWith(".nmbak") && (
                <label>
                  Backup passphrase
                  <input
                    autoComplete="current-password"
                    maxLength={256}
                    minLength={12}
                    type="password"
                    value={restorePassphrase}
                    onChange={(event) => {
                      setRestorePassphrase(event.target.value);
                      setRestoreValidation(null);
                      setRestoreValidationError(null);
                    }}
                  />
                </label>
              )}
              {!restoreValidation && (
                <button type="button" className="nm-btn nm-btn--secondary admin-backup-upload" disabled={!restoreFile || backupBusy === "validate" || (restoreFile.name.toLowerCase().endsWith(".nmbak") && restorePassphrase.length < 12)} onClick={() => void runValidateRestore()}>
                  <Upload size={14} aria-hidden="true" />{backupBusy === "validate" ? "Uploading…" : "Upload backup"}
                </button>
              )}
              {restoreValidationError && <div className="form-error">{restoreValidationError}</div>}
              {restoreValidation?.valid && (
                <>
                  <p className="tool-note">
                    ✓ Valid {restoreValidation.encrypted ? "encrypted " : ""}backup — {restoreValidation.devices ?? 0} devices, {restoreValidation.users ?? 0} users,{" "}
                    {restoreValidation.subnets ?? 0} subnets, {restoreValidation.table_count} tables,{" "}
                    {fmtBytes(restoreValidation.size_bytes)}. Restoring will overwrite the current live database.
                  </p>
                  <button type="button" className="nm-btn nm-btn--primary" disabled={backupBusy === "restore"} onClick={() => void runRestore()}>
                    {backupBusy === "restore" ? "Restoring…" : `Restore ${restoreFile?.name}`}
                  </button>
                </>
              )}
              </div>
            </div>
          </section>
          <section className="panel admin-panel nm-app-panel admin-system-card">
            <div className="admin-system-card-header nm-app-panel-header">
              <h2 className="admin-section-title"><IconDatabase size={16} />Scheduled backups</h2>
            </div>
            <div className="admin-system-card-body">
              <p className="admin-backup-step-title">Saves an unencrypted backup on a schedule and removes older copies.</p>
              <p className="tool-note">Saved to <code>{backupDirectory ?? "unknown folder"}</code> · set <code>BACKUP_DIR</code> to change it.</p>
              <div className="tool-form">
              <label className="tool-form-inline-check">
                <input type="checkbox" checked={settingsForm.backup_schedule_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, backup_schedule_enabled: e.target.checked }))} />
                <span className="tool-form-check-copy">
                  <span>Enable scheduled backups</span>
                  <span className="tool-note">Runs in the background using the interval and retention below.</span>
                </span>
              </label>
              {settingsForm.backup_schedule_enabled && (
                <>
                  <label>Interval
                    <select value={settingsForm.backup_schedule_interval_hours} onChange={(e) => setSettingsForm((c) => ({ ...c, backup_schedule_interval_hours: Number(e.target.value) }))}>
                      <option value={6}>Every 6 hours</option>
                      <option value={12}>Every 12 hours</option>
                      <option value={24}>Daily</option>
                      <option value={168}>Weekly</option>
                    </select>
                  </label>
                  <label>Filename prefix<input className="nm-input" maxLength={60} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" value={settingsForm.backup_filename_prefix ?? "netmap-backup"} onChange={(event) => setSettingsForm((current) => ({ ...current, backup_filename_prefix: event.target.value }))} /></label>
                  <label>Date format<select className="nm-select" value={settingsForm.backup_date_format ?? "yyyy-MM-dd"} onChange={(event) => setSettingsForm((current) => ({ ...current, backup_date_format: event.target.value as SystemSettings["backup_date_format"] }))}><option>yyyy-MM-dd</option><option>MM-dd-yyyy</option><option>dd-MM-yyyy</option></select><small>UTC time and a unique suffix prevent overwrites.</small></label>
                  <label>Keep last
                    <select value={settingsForm.backup_retention_count} onChange={(e) => setSettingsForm((c) => ({ ...c, backup_retention_count: Number(e.target.value) }))}>
                      <option value={3}>3 backups</option>
                      <option value={7}>7 backups</option>
                      <option value={14}>14 backups</option>
                      <option value={30}>30 backups</option>
                    </select>
                  </label>
                </>
              )}
              <button type="button" className="nm-btn nm-btn--primary" disabled={scheduleBusy} onClick={() => void saveBackupSchedule()}>
                {scheduleBusy ? "Saving…" : "Save schedule"}
              </button>
              </div>
              {scheduledBackups.length > 0 ? (
                <div className="mon-port-rows" style={{ marginTop: 12 }}>
                  {scheduledBackups.map((b) => (
                    <div key={b.filename} className="mon-port-row">
                      <span className="mon-port-label" style={{ fontFamily: "monospace", fontSize: 12 }}>{b.filename}</span>
                      <span className="dash-panel-meta">{fmtBytes(b.size_bytes)} · {new Date(b.created_at).toLocaleString()}</span>
                      <div className="admin-panel-actions">
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={scheduledBackupsBusyName === b.filename} onClick={() => void downloadScheduledBackupFile(b.filename)}>
                          Download
                        </button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={scheduledBackupsBusyName === b.filename} onClick={() => void deleteScheduledBackupFile(b.filename)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="tool-note">No scheduled backups yet.</p>
              )}
            </div>
          </section>
          <StatusPageDefaultCssCard accessToken={accessToken} onError={onError} onSuccess={onSuccess} />
        </div>
        <div className="system-tab-col">
          {versionInfo && (
            <section className="panel admin-panel nm-app-panel admin-system-card">
              <div className="system-icon-header admin-system-card-header nm-app-panel-header">
                <h2 className="admin-section-title" style={{ margin: 0 }}><IconCloud size={16} />Version</h2>
                <button type="button" className="nm-btn nm-btn--primary" onClick={onOpenWhatsNew}>
                  What&apos;s new
                </button>
              </div>
              <dl className="admin-config-grid admin-system-card-body">
                <dt>Installed</dt>
                <dd>{versionInfo.channel ? `${versionInfo.channel}: ` : "v"}{versionInfo.current}</dd>
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
          <section className="panel admin-panel nm-app-panel admin-system-card">
            <div className="system-icon-header admin-system-card-header nm-app-panel-header">
              <h2 className="admin-section-title"><IconServer size={16} />System diagnostics</h2>
              <button type="button" className="nm-btn nm-btn--primary" disabled={diagBusy} onClick={() => void loadDiagnostics()}>
                {diagBusy ? "Loading…" : diagnostics ? "Refresh" : "Load"}
              </button>
            </div>
            <div className="admin-system-card-body">
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
                <p className="tool-note">Choose Load to show current runtime diagnostics.</p>
              )}
            </div>
          </section>
          <section className="panel admin-panel nm-app-panel admin-system-card">
            <div className="admin-system-card-header nm-app-panel-header">
              <h2 className="admin-section-title"><IconDatabase size={16} />Syslog configuration</h2>
            </div>
            <div className="admin-system-card-body">
              {syslogStatus ? (
                <dl className="admin-config-grid">
                <dt>Firewall retention</dt><dd>{syslogStatus.retention_days} days</dd>
                <dt>UDP listener</dt><dd>{syslogStatus.udp_enabled ? `enabled :${syslogStatus.udp_port}` : "disabled"}</dd>
                <dt>TCP listener</dt><dd>{syslogStatus.tcp_enabled ? `enabled :${syslogStatus.tcp_port}` : "disabled"}</dd>
                <dt>TLS listener</dt><dd>{syslogStatus.tls_enabled ? `enabled :${syslogStatus.tls_port}` : "disabled"}</dd>
                <dt>Allowlist</dt><dd>{syslogStatus.allowlist_enabled ? "enabled" : "off"}</dd>
                <dt>Stored events</dt><dd>{syslogStatus.total_events.toLocaleString()}</dd>
                <dt>Received packets</dt><dd>{syslogStatus.received_packets.toLocaleString()}</dd>
                <dt>Stored since start</dt><dd>{syslogStatus.stored_events.toLocaleString()}</dd>
                <dt>Dropped unparsed</dt><dd>{syslogStatus.dropped_unparsed.toLocaleString()}</dd>
                <dt>Denied senders</dt><dd>{syslogStatus.denied_senders.toLocaleString()}</dd>
                <dt>Last packet</dt><dd>{syslogStatus.last_packet_at ? `${new Date(syslogStatus.last_packet_at).toLocaleString()} from ${syslogStatus.last_packet_sender ?? "unknown"}` : "n/a"}</dd>
                <dt>Last stored</dt><dd>{syslogStatus.last_stored_at ? `${new Date(syslogStatus.last_stored_at).toLocaleString()} from ${syslogStatus.last_stored_sender ?? "unknown"}` : "n/a"}</dd>
                <dt>Last parse drop</dt><dd>{syslogStatus.last_drop_at ? `${new Date(syslogStatus.last_drop_at).toLocaleString()} from ${syslogStatus.last_drop_sender ?? "unknown"}` : "n/a"}</dd>
                {syslogStatus.last_drop_raw && (
                  <>
                    <dt>Dropped sample</dt><dd><code>{syslogStatus.last_drop_raw}</code></dd>
                  </>
                )}
                <dt>Last cleanup</dt><dd>{syslogStatus.retention_last_run_at ? new Date(syslogStatus.retention_last_run_at).toLocaleString() : "n/a"}</dd>
                <dt>Last event</dt><dd>{syslogStatus.last_event_received_at ? new Date(syslogStatus.last_event_received_at).toLocaleString() : "n/a"}</dd>
                </dl>
              ) : <PanelSkeleton lines={8} />}
            </div>
          </section>
        </div>
      </div>
      {showEncryptedBackupModal && (
        <EncryptedBackupModal
          busy={backupBusy === "encrypted-backup"}
          onCancel={() => { if (backupBusy === null) setShowEncryptedBackupModal(false); }}
          onDownload={(passphrase) => runBackup(passphrase)}
        />
      )}
    </div>
  );
}

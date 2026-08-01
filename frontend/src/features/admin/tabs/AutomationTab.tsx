import { useState, type FormEvent } from "react";
import { IconCalendarClock } from "@tabler/icons-react";
import {
  api,
  type DiscoverySchedule, type DiscoveryObservation, type DiscoverySchedulePayload,
  type DiscoveryScanType,
} from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { useConfirm } from "../../../components/ConfirmDialog";

export function AutomationTab({
  accessToken,
  onError,
  onSuccess,
}: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const confirmAction = useConfirm();
  const [mutationBusy, setMutationBusy] = useState(false);
  const [schedForm, setSchedForm] = useState<{
    name: string; target: string; scan_type: DiscoveryScanType;
    interval_minutes: string; enabled: boolean; group_id: string; notif_profile_id: string;
  }>({ name: "", target: "", scan_type: "ping", interval_minutes: "1440", enabled: true, group_id: "", notif_profile_id: "" });

  const automationQuery = useApiQuery(async () => {
    const [schedules, observations, groups, profiles] = await Promise.all([
      api.listDiscoverySchedules(accessToken),
      api.listDiscoveryObservations(accessToken, { status_filter: "all" }),
      api.topologyGroups(accessToken),
      api.listNotificationProfiles(accessToken),
    ]);
    return { schedules, observations, groups, profiles };
  }, [accessToken]);

  const schedules = automationQuery.data?.schedules ?? [];
  const observations = automationQuery.data?.observations ?? [];
  const automationGroups = automationQuery.data?.groups ?? [];
  const notificationProfiles = automationQuery.data?.profiles ?? [];
  const automationBusy = mutationBusy || automationQuery.isLoading || automationQuery.isRefreshing;

  async function createSchedule(event: FormEvent) {
    event.preventDefault();
    if (!schedForm.target.trim()) return;
    setMutationBusy(true);
    onError(null); onSuccess(null);
    try {
      const payload: DiscoverySchedulePayload = {
        name: schedForm.name.trim() || schedForm.target.trim(),
        target: schedForm.target.trim(),
        scan_type: schedForm.scan_type,
        enabled: schedForm.enabled,
        interval_minutes: Number(schedForm.interval_minutes),
        confirm_large_scan: false,
        topology_group_id: schedForm.group_id ? Number(schedForm.group_id) : null,
        notification_targets: schedForm.notif_profile_id ? [`profile:${schedForm.notif_profile_id}`] : [],
      };
      await api.createDiscoverySchedule(accessToken, payload);
      setSchedForm({ name: "", target: "", scan_type: "ping", interval_minutes: "1440", enabled: true, group_id: "", notif_profile_id: "" });
      await automationQuery.reload();
      onSuccess("Schedule created.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setMutationBusy(false);
    }
  }

  async function toggleSchedule(schedule: DiscoverySchedule) {
    setMutationBusy(true);
    try {
      await api.updateDiscoverySchedule(accessToken, schedule.id, { enabled: !schedule.enabled });
      await automationQuery.reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update schedule");
    } finally {
      setMutationBusy(false);
    }
  }

  async function runScheduleNow(schedule: DiscoverySchedule) {
    setMutationBusy(true);
    try {
      const result = await api.runDiscoverySchedule(accessToken, schedule.id);
      await automationQuery.reload();
      if (result.error) onError(`Scan completed with error: ${result.error}`);
      else onSuccess(`Scan completed — ${schedule.name}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to run schedule");
    } finally {
      setMutationBusy(false);
    }
  }

  async function deleteSchedule(schedule: DiscoverySchedule) {
    const confirmed = await confirmAction({
      title: "Delete schedule",
      message: `Delete the "${schedule.name}" discovery schedule?`,
      detail: "Future scheduled scans for this range will stop. Existing observations are kept.",
      confirmLabel: "Delete schedule",
    });
    if (!confirmed) return;
    setMutationBusy(true);
    try {
      await api.deleteDiscoverySchedule(accessToken, schedule.id);
      await automationQuery.reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete schedule");
    } finally {
      setMutationBusy(false);
    }
  }

  async function updateObservation(observation: DiscoveryObservation, status: "acknowledged" | "resolved") {
    try {
      await api.updateDiscoveryObservation(accessToken, observation.id, status);
      automationQuery.setData((current) => current
        ? { ...current, observations: current.observations.map((o) => o.id === observation.id ? { ...o, status } : o) }
        : current);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update observation");
    }
  }

  async function applyObservation(observation: DiscoveryObservation) {
    setMutationBusy(true);
    try {
      const updated = await api.applyObservation(accessToken, observation.id);
      automationQuery.setData((current) => current
        ? { ...current, observations: current.observations.map((o) => o.id === observation.id ? updated : o) }
        : current);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to apply observation");
    } finally {
      setMutationBusy(false);
    }
  }

  const openObs = observations.filter((o) => o.status !== "resolved");
  const resolvedObs = observations.filter((o) => o.status === "resolved");
  const obsTypeLabel: Record<string, string> = {
    new_device: "New device",
    ip_change: "IP change",
    field_change: "Field change",
    disappeared: "Disappeared",
  };

  return (
    <div className="admin-tab-content">
      <section className="panel admin-panel nm-app-panel">
        <div className="admin-panel-header nm-app-panel-header">
          <h2 className="admin-section-title"><IconCalendarClock size={16} />Scheduled scans</h2>
          <button type="button" className="nm-btn" disabled={automationBusy} onClick={() => void automationQuery.reload()}>Refresh</button>
        </div>
        <p className="tool-note">
          Scheduled scans automatically probe your network at a set interval and record observations for new devices, IP address changes, field changes, and hosts that disappear.
        </p>
        <div className="admin-automation-split">
          <form className="tool-form admin-create-form" onSubmit={(e) => void createSchedule(e)}>
            <h3>New schedule</h3>
            <div className="tool-form-grid">
              <label>
                Target <span className="tool-note" style={{ fontWeight: "normal" }}>(IP, CIDR, or range)</span>
                <input
                  required
                  placeholder="192.168.1.0/24"
                  value={schedForm.target}
                  onChange={(e) => setSchedForm((f) => ({ ...f, target: e.target.value }))}
                />
              </label>
              <label>
                Name <span className="tool-note" style={{ fontWeight: "normal" }}>(optional)</span>
                <input
                  placeholder="Home network"
                  value={schedForm.name}
                  onChange={(e) => setSchedForm((f) => ({ ...f, name: e.target.value }))}
                />
              </label>
            </div>
            <div className="tool-form-grid">
              <label>
                Scan type
                <select value={schedForm.scan_type} onChange={(e) => setSchedForm((f) => ({ ...f, scan_type: e.target.value as DiscoveryScanType }))}>
                  <option value="ping">Ping only — host discovery</option>
                  <option value="basic_ports">Ping + port scan — common ports</option>
                </select>
              </label>
              <label>
                Interval
                <select value={schedForm.interval_minutes} onChange={(e) => setSchedForm((f) => ({ ...f, interval_minutes: e.target.value }))}>
                  <option value="15">Every 15 minutes</option>
                  <option value="30">Every 30 minutes</option>
                  <option value="60">Every hour</option>
                  <option value="360">Every 6 hours</option>
                  <option value="720">Every 12 hours</option>
                  <option value="1440">Every 24 hours</option>
                </select>
              </label>
            </div>
            <div className="tool-form-grid">
              <label>
                Group <span className="tool-note" style={{ fontWeight: "normal" }}>(optional)</span>
                <select value={schedForm.group_id} onChange={(e) => setSchedForm((f) => ({ ...f, group_id: e.target.value }))}>
                  <option value="">— none —</option>
                  {automationGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
              <label>
                Notify on change <span className="tool-note" style={{ fontWeight: "normal" }}>(optional)</span>
                <select value={schedForm.notif_profile_id} onChange={(e) => setSchedForm((f) => ({ ...f, notif_profile_id: e.target.value }))}>
                  <option value="">— none —</option>
                  {notificationProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
            <label className="checkbox-label">
              <input type="checkbox" checked={schedForm.enabled} onChange={(e) => setSchedForm((f) => ({ ...f, enabled: e.target.checked }))} />
              Enable immediately
            </label>
            <button type="submit" className="nm-btn nm-btn--primary" disabled={automationBusy || !schedForm.target.trim()}>
              {automationBusy ? "Saving…" : "Create schedule"}
            </button>
          </form>

          <section className="admin-schedule-library" aria-label="Created schedules">
            <div className="admin-schedule-library-header">
              <div>
                <h3>Created schedules</h3>
                <span>{schedules.length} configured</span>
              </div>
            </div>
            {schedules.length === 0
              ? <p className="admin-schedule-empty">{automationBusy ? "Loading schedules…" : "No schedules yet. Create one using the form alongside."}</p>
              : (
                <div className="admin-schedule-card-list">
                  {schedules.map((sched) => (
                    <article key={sched.id} className="admin-schedule-card">
                      <div className="admin-schedule-card-heading">
                        <div>
                          <strong>{sched.name}</strong>
                          <span className="mono">{sched.target}</span>
                        </div>
                        <span className={`status-pill status-pill--${sched.enabled ? "online" : "unknown"}`}>
                          {sched.enabled ? "Active" : "Paused"}
                        </span>
                      </div>
                      <div className="admin-schedule-card-meta">
                        <span><small>Type</small><strong>{sched.scan_type === "ping" ? "Ping" : "Port scan"}</strong></span>
                        <span><small>Interval</small><strong>{sched.interval_minutes < 60 ? `${sched.interval_minutes}m` : `${sched.interval_minutes / 60}h`}</strong></span>
                        <span><small>Last run</small><strong>{sched.last_run_at ? new Date(sched.last_run_at).toLocaleString() : "Never"}</strong></span>
                        <span><small>Changes</small><strong>{sched.open_observation_count} open</strong></span>
                      </div>
                      {sched.last_error && <p className="admin-schedule-error">Last run failed: {sched.last_error}</p>}
                      <div className="admin-row-actions">
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={automationBusy} onClick={() => void runScheduleNow(sched)}>Run</button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={automationBusy} onClick={() => void toggleSchedule(sched)}>{sched.enabled ? "Pause" : "Enable"}</button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={automationBusy} onClick={() => void deleteSchedule(sched)}>Delete</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
          </section>
        </div>
      </section>

      <section className="panel admin-panel nm-app-panel admin-panel-spaced">
        <div className="admin-panel-header nm-app-panel-header">
          <h2 className="admin-section-title"><IconCalendarClock size={16} />Change observations</h2>
          <span className="tool-note">{openObs.length} open · {resolvedObs.length} resolved</span>
        </div>
        <p className="tool-note">
          Each scheduled scan logs what changed on your network. Acknowledge to mark as seen; resolve to dismiss.
        </p>
        {openObs.length === 0 && <p className="tool-note">No open observations.</p>}
        {openObs.length > 0 && (
          <div className="scan-observation-list">
            {openObs.map((obs) => (
              <div key={obs.id} className="scan-observation-row">
                <div>
                  <span className={`scan-observation-badge scan-observation-badge--${obs.observation_type}`}>
                    {obsTypeLabel[obs.observation_type] ?? obs.observation_type}
                  </span>
                  <strong>{obs.summary}</strong>
                  <span>
                    {[obs.hostname, obs.ip_address, obs.mac_address].filter(Boolean).join(" · ")}
                    {" · seen "}{new Date(obs.last_seen_at).toLocaleString()}
                    {" · "}{schedules.find((s) => s.id === obs.schedule_id)?.name ?? `scan #${obs.schedule_id}`}
                  </span>
                </div>
                <div className="scan-schedule-actions">
                  {(obs.observation_type === "new_device" || obs.observation_type === "ip_change" || obs.observation_type === "field_change") && (
                    <button
                      type="button"
                      className="nm-btn nm-btn--primary"
                      disabled={automationBusy}
                      onClick={() => void applyObservation(obs)}
                    >
                      {obs.observation_type === "new_device" ? "Add to inventory" : "Apply"}
                    </button>
                  )}
                  {obs.status === "open" && (
                    <button type="button" className="nm-btn" disabled={automationBusy} onClick={() => void updateObservation(obs, "acknowledged")}>Acknowledge</button>
                  )}
                  <button type="button" className="nm-btn nm-btn--danger" disabled={automationBusy} onClick={() => void updateObservation(obs, "resolved")}>Resolve</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

import { AdminTaskPanel } from "../AdminTaskPanel";
import { AdminCard } from "../AdminCard";
import { useState, type FormEvent } from "react";
import { IconCalendarClock } from "@tabler/icons-react";
import { Activity, CalendarClock, CircleCheck, Clock, History, Radar, Repeat, Timer, TriangleAlert } from "lucide-react";
import { DashStat } from "../../../components/DashStat";
import { ColumnChart, CountUp } from "../../../components/Charts";
import { lastDays, shortDateTime } from "../../../utils/history";
import {
  api,
  type DiscoverySchedule, type DiscoveryObservation, type DiscoverySchedulePayload,
  type DiscoveryScanType,
} from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { useConfirm } from "../../../components/ConfirmDialog";
import { PanelSkeleton } from "../../../components/Skeleton";

export function AutomationTab({
  accessToken,
  onError,
  onSuccess,
  canManageAutomation = true,
  canManageDiscovery = true,
}: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
  canManageAutomation?: boolean;
  canManageDiscovery?: boolean;
}) {
  const confirmAction = useConfirm();
  const [mutationBusy, setMutationBusy] = useState(false);
  const [schedForm, setSchedForm] = useState<{
    name: string; target: string; scan_type: DiscoveryScanType;
    interval_minutes: string; enabled: boolean; group_id: string; notif_profile_id: string;
  }>({ name: "", target: "", scan_type: "ping", interval_minutes: "1440", enabled: true, group_id: "", notif_profile_id: "" });

  const automationQuery = useApiQuery(async () => {
    const [schedules, observations, groups, profiles] = await Promise.all([
      canManageAutomation ? api.listDiscoverySchedules(accessToken) : Promise.resolve([]),
      canManageDiscovery ? api.listDiscoveryObservations(accessToken, { status_filter: "all" }) : Promise.resolve([]),
      api.topologyGroups(accessToken),
      api.listNotificationProfiles(accessToken),
    ]);
    return { schedules, observations, groups, profiles };
  }, [accessToken, canManageAutomation, canManageDiscovery]);
  const summaryQuery = useApiQuery(
    () => canManageDiscovery ? api.observationSummary(accessToken) : Promise.resolve(null),
    [accessToken, canManageDiscovery],
  );

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
  const labels = lastDays(14).map((d) => d.label);
  const summaryDays = Array.isArray(summaryQuery.data?.days) ? summaryQuery.data.days : [];
  const changeRows = summaryDays.map((d, i) => ({
    label: labels[i] ?? d.date, new_device: d.new_device, ip_change: d.ip_change, disappeared: d.disappeared,
  }));
  const activeSchedules = schedules.filter((s) => s.enabled);
  const nextRun = activeSchedules.map((s) => s.next_run_at).filter((v): v is string => !!v).sort()[0];
  const nextRunSchedule = activeSchedules.find((s) => s.next_run_at === nextRun);
  const interval = (minutes: number) => minutes < 60 ? `Every ${minutes} min` : minutes === 60 ? "Every hour" : `Every ${minutes / 60} h`;

  const scheduleForm = (
    <AdminTaskPanel title="New Schedule" icon={<IconCalendarClock size={18} />} className="nm-fill">
      <form className="tool-form admin-create-form" onSubmit={(e) => void createSchedule(e)}>
        <label>
          Target <span className="tool-note" style={{ fontWeight: "normal" }}>(IP, CIDR, or range)</span>
          <input required placeholder="192.168.1.0/24" value={schedForm.target}
            onChange={(e) => setSchedForm((f) => ({ ...f, target: e.target.value }))} />
        </label>
        <label>
          Name <span className="tool-note" style={{ fontWeight: "normal" }}>(optional)</span>
          <input placeholder="Home network" value={schedForm.name}
            onChange={(e) => setSchedForm((f) => ({ ...f, name: e.target.value }))} />
        </label>
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
        <label className="tool-form-inline-check">
          <input type="checkbox" checked={schedForm.enabled} onChange={(e) => setSchedForm((f) => ({ ...f, enabled: e.target.checked }))} />
          Enable immediately
        </label>
        <button type="submit" className="nm-btn nm-btn--primary" disabled={automationBusy || !schedForm.target.trim()}>
          {automationBusy ? "Saving…" : "Create schedule"}
        </button>
      </form>
    </AdminTaskPanel>
  );

  return (
    <div className="admin-tab-content nm-motion">
      <div className="nm-bento nm-bento--four nm-bento--chart">
        <AdminCard hero title="Changes Found, Last 14 Days" icon={<Activity size={16} />} actions={(
          <ul className="nm-header-legend" aria-hidden="true">
            <li><span className="nm-chart-swatch" style={{ background: "var(--dash-blue)" }} />New devices</li>
            <li><span className="nm-chart-swatch" style={{ background: "var(--dash-amber)" }} />Address changes</li>
            <li><span className="nm-chart-swatch" style={{ background: "var(--dash-purple)" }} />Disappeared</li>
          </ul>
        )}>
          {!canManageDiscovery ? <p className="tool-note nm-chart-empty">Change history needs discovery access.</p>
            : summaryQuery.error ? <p className="tool-note nm-chart-empty">Change history is unavailable.</p>
            : <ColumnChart viewId="admin.automation.changes" label="Changes found per day, last 14 days, by type" rows={changeRows} height={168} valueLabels
                series={[
                  { key: "new_device", label: "New devices", color: "--dash-blue" },
                  { key: "ip_change", label: "Address changes", color: "--dash-amber" },
                  { key: "disappeared", label: "Disappeared", color: "--dash-purple" },
                ]} />}
        </AdminCard>
        <div className="dash-stats nm-bento-stats nm-summary-band">
          <DashStat accent="teal" className="nm-motion-item" icon={<CalendarClock size={20} />} label="Schedules" value={<CountUp value={schedules.length} />}
            sub={schedules.length === 1 ? "1 scan range" : `${schedules.length} scan ranges`} />
          <DashStat accent="green" className="nm-motion-item" icon={<CircleCheck size={20} />} label="Active" value={<CountUp value={activeSchedules.length} />}
            sub={schedules.length - activeSchedules.length ? `${schedules.length - activeSchedules.length} paused` : "None paused"} />
          <DashStat accent="blue" className="nm-motion-item" icon={<Clock size={20} />} label="Next run"
            value={nextRun ? new Date(nextRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
            sub={nextRunSchedule ? nextRunSchedule.name : "Nothing scheduled"} />
          <DashStat accent="amber" className="nm-motion-item" icon={<TriangleAlert size={20} />} label="Open changes" value={<CountUp value={openObs.length} />}
            sub={`${resolvedObs.length} resolved`} />
        </div>
      </div>

      <div className="nm-console">
        <div className="nm-console-main">
          {canManageAutomation && <section className="panel admin-panel nm-app-panel nm-motion-item" aria-label="Scheduled Scans">
            <div className="admin-panel-header nm-app-panel-header">
              <h2 className="admin-section-title"><IconCalendarClock size={16} />Scheduled Scans</h2>
              <div className="admin-panel-actions">
                <span className="admin-task-count">{schedules.length} configured</span>
                <button type="button" className="nm-btn" disabled={automationBusy} onClick={() => void automationQuery.reload()}>Refresh</button>
              </div>
            </div>
            <p className="tool-note">
              Scheduled scans automatically probe your network at a set interval and record observations for new devices, IP address changes, field changes, and hosts that disappear.
            </p>
            {automationQuery.isLoading
              ? <PanelSkeleton lines={4} />
              : schedules.length === 0
              ? <p className="admin-schedule-empty">No schedules yet. Create one using the form alongside.</p>
              : (
                <div className="admin-schedule-card-list">
                  {schedules.map((sched) => (
                    <article key={sched.id} className="admin-schedule-card" aria-label={sched.name}>
                      <header className="admin-schedule-card-heading">
                        <div>
                          <strong>{sched.name}</strong>
                          <span className="mono">{sched.target}</span>
                        </div>
                        <span className={`status-pill status-pill--${sched.enabled ? "online" : "unknown"}`}>
                          {sched.enabled ? "Active" : "Paused"}
                        </span>
                      </header>
                      <dl className="admin-schedule-metrics">
                        <div><Radar size={16} aria-hidden="true" /><span><dt>Scan type</dt><dd>{sched.scan_type === "ping" ? "Ping" : "Ping + ports"}</dd></span></div>
                        <div><Repeat size={16} aria-hidden="true" /><span><dt>Interval</dt><dd>{interval(sched.interval_minutes)}</dd></span></div>
                        <div><History size={16} aria-hidden="true" /><span><dt>Last run</dt><dd>{sched.last_run_at ? shortDateTime(sched.last_run_at) : "Never"}</dd></span></div>
                        <div><Timer size={16} aria-hidden="true" /><span><dt>Next run</dt><dd>{sched.enabled && sched.next_run_at ? shortDateTime(sched.next_run_at) : "—"}</dd></span></div>
                        <div><TriangleAlert size={16} aria-hidden="true" /><span><dt>Open changes</dt><dd>{sched.open_observation_count}</dd></span></div>
                      </dl>
                      {sched.last_error && <p className="admin-schedule-error">Last run failed: {sched.last_error}</p>}
                      <footer className="admin-row-actions">
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={automationBusy} onClick={() => void runScheduleNow(sched)}>Run now</button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={automationBusy} onClick={() => void toggleSchedule(sched)}>{sched.enabled ? "Pause" : "Resume"}</button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={automationBusy} onClick={() => void deleteSchedule(sched)}>Delete</button>
                      </footer>
                    </article>
                  ))}
                </div>
              )}
          </section>}
          {canManageDiscovery && <section className="panel admin-panel nm-app-panel nm-motion-item" aria-label="Change Observations">
            <div className="admin-panel-header nm-app-panel-header">
              <h2 className="admin-section-title"><IconCalendarClock size={16} />Change Observations</h2>
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
                      <button type="button" className="nm-btn nm-btn--secondary" disabled={automationBusy} onClick={() => void updateObservation(obs, "resolved")}>Resolve</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>}
        </div>
        {canManageAutomation && <aside className="nm-console-side">{scheduleForm}</aside>}
      </div>
    </div>
  );
}

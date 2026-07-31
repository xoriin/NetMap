import { useState } from "react";
import { IconAlertCircle } from "@tabler/icons-react";
import {
  api,
  type AlertRule, type AlertRulePayload, type AlertRuleEventType, type TopologyGraph, type PortTarget, type Monitor,
} from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { formatEventTime } from "../../../utils/format";
import { legacyChannelLabels, notificationTargetLabel, notificationProfileMethodLabel } from "../notificationProfiles";

export function AlertsTab({
  accessToken,
  graph,
}: {
  accessToken: string;
  graph: TopologyGraph;
}) {
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
    port_target_id: null,
    monitor_id: null,
    channels: [],
    cooldown_minutes: 30,
    threshold_ms: null,
    loss_pct_threshold: null,
    loss_window_minutes: 60,
  });

  const rulesQuery = useApiQuery(() => api.listAlertRules(accessToken), [accessToken]);
  const profilesQuery = useApiQuery(() => api.listNotificationProfiles(accessToken), [accessToken]);
  const deliveriesQuery = useApiQuery(() => api.listNotificationDeliveries(accessToken), [accessToken]);
  const portTargetsQuery = useApiQuery(() => api.listPortTargets(accessToken), [accessToken]);
  const monitorsQuery = useApiQuery(() => api.listMonitors(accessToken), [accessToken]);

  const alertRules = rulesQuery.data ?? [];
  const notificationProfiles = profilesQuery.data ?? [];
  const deliveries = deliveriesQuery.data ?? [];
  const portTargets: PortTarget[] = portTargetsQuery.data ?? [];
  const monitors: Monitor[] = monitorsQuery.data ?? [];

  function serviceCheckLabel(target: PortTarget): string {
    const deviceName = target.device_id
      ? (() => { const d = graph.devices.find(x => x.id === target.device_id); return d ? (d.display_name || d.hostname || d.ip_address) : `#${target.device_id}`; })()
      : "All devices";
    return `${target.label} (${target.check_type.toUpperCase()}:${target.port} · ${deviceName})`;
  }

  const targetLabel = (target: string) => notificationTargetLabel(notificationProfiles, target);

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
      await rulesQuery.reload();
    } catch (err) {
      setAlertRulesError(err instanceof Error ? err.message : "Failed to save rule");
    } finally {
      setAlertRulesBusy(false);
    }
  }

  async function deleteAlertRule(id: number) {
    try {
      await api.deleteAlertRule(accessToken, id);
      await rulesQuery.reload();
    } catch (err) {
      setAlertRulesError(err instanceof Error ? err.message : "Failed to delete rule");
    }
  }

  async function toggleAlertRule(rule: AlertRule) {
    await api.updateAlertRule(accessToken, rule.id, { enabled: !rule.enabled });
    await rulesQuery.reload();
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

  return (
    <div className="admin-tab-content">
      <section className="panel admin-panel">
        <div className="admin-panel-header">
          <h2 className="admin-section-title"><IconAlertCircle size={16} />Alert Rules</h2>
          <div className="admin-panel-actions">
            <button type="button" className="nm-btn nm-btn--primary" onClick={() => {
              setEditingAlertRule(null);
              setAlertForm({ name: "", enabled: true, event_type: "device_offline", device_id: null, port_target_id: null, monitor_id: null, channels: [], cooldown_minutes: 30, threshold_ms: null, loss_pct_threshold: null, loss_window_minutes: 60 });
              setShowAlertForm(true);
            }}>+ Add rule</button>
          </div>
        </div>
        <p className="tool-note">Rules run on the configured live ping interval in the background. Notifications are sent via the channels configured in the Notifications tab.</p>
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
                <option value="rtt_above">Response time above threshold</option>
                <option value="device_flapping">Device is flapping (repeated status changes)</option>
                <option value="ping_loss_above">Ping loss above threshold</option>
                <option value="service_down">Service check goes down</option>
                <option value="service_slow">Service check response time above threshold</option>
                <option value="monitor_down">Standalone monitor goes down</option>
                <option value="monitor_slow">Standalone monitor response time above threshold</option>
                <option value="monitor_certificate_expiry">Standalone monitor certificate nearing expiry</option>
              </select>
            </label>
            {alertForm.event_type === "rtt_above" && (
              <label>RTT threshold (ms)
                <input type="number" min={1} max={60000} value={alertForm.threshold_ms ?? ""} placeholder="e.g. 200"
                  onChange={(e) => setAlertForm(f => ({...f, threshold_ms: e.target.value ? Number(e.target.value) : null}))} />
              </label>
            )}
            {(alertForm.event_type === "service_slow" || alertForm.event_type === "monitor_slow") && (
              <label>Response time threshold (ms)
                <input type="number" min={1} max={60000} value={alertForm.threshold_ms ?? ""} placeholder="e.g. 1000"
                  onChange={(e) => setAlertForm(f => ({...f, threshold_ms: e.target.value ? Number(e.target.value) : null}))} />
              </label>
            )}
            {alertForm.event_type === "ping_loss_above" && (
              <>
                <label>Ping loss threshold (%)
                  <input type="number" min={1} max={100} value={alertForm.loss_pct_threshold ?? ""} placeholder="e.g. 50"
                    onChange={(e) => setAlertForm(f => ({...f, loss_pct_threshold: e.target.value ? Number(e.target.value) : null}))} />
                </label>
                <label>Sample window
                  <select value={alertForm.loss_window_minutes ?? 60} onChange={(e) => setAlertForm(f => ({...f, loss_window_minutes: Number(e.target.value)}))}>
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={180}>3 hours</option>
                    <option value={360}>6 hours</option>
                  </select>
                </label>
              </>
            )}
            {(alertForm.event_type === "service_down" || alertForm.event_type === "service_slow") ? (
              <label>Service check
                <select value={alertForm.port_target_id ?? ""} onChange={(e) => setAlertForm(f => ({...f, port_target_id: e.target.value ? Number(e.target.value) : null}))}>
                  <option value="">Any service check</option>
                  {portTargets.map(t => (
                    <option key={t.id} value={t.id}>{serviceCheckLabel(t)}</option>
                  ))}
                </select>
              </label>
            ) : (["monitor_down", "monitor_slow", "monitor_certificate_expiry"] as AlertRuleEventType[]).includes(alertForm.event_type) ? (
              <label>Monitor
                <select value={alertForm.monitor_id ?? ""} onChange={(e) => setAlertForm(f => ({...f, monitor_id: e.target.value ? Number(e.target.value) : null}))}>
                  <option value="">Any monitor</option>
                  {monitors.map(m => (
                    <option key={m.id} value={m.id}>{m.name} ({m.url})</option>
                  ))}
                </select>
              </label>
            ) : (
              <label>Device
                <select value={alertForm.device_id ?? ""} onChange={(e) => setAlertForm(f => ({...f, device_id: e.target.value ? Number(e.target.value) : null}))}>
                  <option value="">All devices</option>
                  {graph.devices.map(d => (
                    <option key={d.id} value={d.id}>{d.display_name || d.hostname || d.ip_address}</option>
                  ))}
                </select>
              </label>
            )}
            <fieldset style={{ border: '1px solid #d0dde6', borderRadius: 6, padding: '8px 12px' }}>
              <legend style={{ fontSize: 12, fontWeight: 700, color: '#314656', padding: '0 4px' }}>Notify via saved methods</legend>
              {alertForm.channels.filter((channel) => !channel.startsWith("profile:")).map(ch => (
                <label key={ch} className="tool-form-inline-check" style={{ marginBottom: 4 }}>
                  <input type="checkbox" checked
                    onChange={(e) => setAlertForm(f => ({
                      ...f,
                      channels: e.target.checked ? f.channels : f.channels.filter(c => c !== ch)
                    }))} />
                  {legacyChannelLabels[ch] ?? ch} <span className="tool-note">(legacy)</span>
                </label>
              ))}
              {notificationProfiles.map(profile => {
                const target = `profile:${profile.id}`;
                return (
                  <label key={target} className="tool-form-inline-check" style={{ marginBottom: 4 }}>
                    <input type="checkbox" checked={alertForm.channels.includes(target)}
                      onChange={(e) => setAlertForm(f => ({
                        ...f,
                        channels: e.target.checked ? [...f.channels, target] : f.channels.filter(c => c !== target)
                      }))} />
                    {profile.name} <span className="tool-note">({notificationProfileMethodLabel(profile)}{profile.enabled ? "" : ", disabled"})</span>
                  </label>
                );
              })}
              {notificationProfiles.length === 0 && (
                <p className="tool-note" style={{ margin: '6px 0 0' }}>Add notification methods in Notifications to target alert rules.</p>
              )}
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
              <button type="button" className="nm-btn nm-btn--primary" disabled={alertRulesBusy || !alertForm.name || alertForm.channels.length === 0 || ((alertForm.event_type === "rtt_above" || alertForm.event_type === "service_slow" || alertForm.event_type === "monitor_slow") && !alertForm.threshold_ms) || (alertForm.event_type === "ping_loss_above" && !alertForm.loss_pct_threshold)} onClick={() => void saveAlertRule()}>
                {alertRulesBusy ? "Saving…" : editingAlertRule ? "Update rule" : "Create rule"}
              </button>
              <button type="button" className="nm-btn" onClick={() => { setShowAlertForm(false); setEditingAlertRule(null); }}>Cancel</button>
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
                <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Device / Service</th>
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
                  rtt_above: rule.threshold_ms ? `RTT above ${rule.threshold_ms} ms` : "RTT above threshold",
                  device_flapping: "Flapping",
                  ping_loss_above: rule.loss_pct_threshold ? `Ping loss above ${rule.loss_pct_threshold}%` : "Ping loss above threshold",
                  service_down: "Service check down",
                  service_slow: rule.threshold_ms ? `Service response above ${rule.threshold_ms} ms` : "Service response above threshold",
                  monitor_down: "Monitor down",
                  monitor_slow: rule.threshold_ms ? `Monitor response above ${rule.threshold_ms} ms` : "Monitor response above threshold",
                  monitor_certificate_expiry: "Monitor certificate nearing expiry",
                };
                const isServiceRule = rule.event_type === "service_down" || rule.event_type === "service_slow";
                const isMonitorRule = (["monitor_down", "monitor_slow", "monitor_certificate_expiry"] as AlertRuleEventType[]).includes(rule.event_type);
                const deviceName = isServiceRule
                  ? (rule.port_target_id
                      ? (() => { const t = portTargets.find(x => x.id === rule.port_target_id); return t ? serviceCheckLabel(t) : `Service check #${rule.port_target_id}`; })()
                      : "Any service check")
                  : isMonitorRule
                  ? (rule.monitor_id
                      ? (() => { const m = monitors.find(x => x.id === rule.monitor_id); return m ? `${m.name} (${m.url})` : `Monitor #${rule.monitor_id}`; })()
                      : "Any monitor")
                  : (rule.device_id
                      ? (() => { const d = graph.devices.find(x => x.id === rule.device_id); return d ? (d.display_name || d.hostname || d.ip_address) : `#${rule.device_id}`; })()
                      : "All devices");
                const testResult = alertTestResults[rule.id];
                return (
                  <tr key={rule.id} style={{ borderBottom: '1px solid rgba(175,198,216,0.3)' }}>
                    <td style={{ padding: '10px 10px', fontWeight: 600 }}>{rule.name}</td>
                    <td style={{ padding: '10px 10px', color: '#4a6474' }}>{triggerLabels[rule.event_type] ?? rule.event_type}</td>
                    <td style={{ padding: '10px 10px', color: '#4a6474', fontSize: 12 }}>{deviceName}</td>
                    <td style={{ padding: '10px 10px', fontSize: 12 }}>{rule.channels.map(targetLabel).join(", ") || "—"}</td>
                    <td style={{ padding: '10px 10px', color: '#4a6474', fontSize: 12 }}>{rule.cooldown_minutes >= 60 ? `${rule.cooldown_minutes / 60}h` : `${rule.cooldown_minutes}m`}</td>
                    <td style={{ padding: '10px 10px' }}>
                      <span className={`alert-status-pill${rule.enabled ? " alert-status-pill--active" : ""}`}>
                        {rule.enabled ? "Active" : "Paused"}
                      </span>
                    </td>
                    <td style={{ padding: '10px 10px' }}>
                      <div className="admin-panel-actions">
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={alertTestBusy === rule.id} onClick={() => void runAlertTest(rule.id)}>
                          {alertTestBusy === rule.id ? "Testing…" : "Test"}
                        </button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => void toggleAlertRule(rule)}>
                          {rule.enabled ? "Pause" : "Enable"}
                        </button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => {
                          setEditingAlertRule(rule);
                          setAlertForm({ name: rule.name, enabled: rule.enabled, event_type: rule.event_type, device_id: rule.device_id, port_target_id: rule.port_target_id, monitor_id: rule.monitor_id, channels: rule.channels, cooldown_minutes: rule.cooldown_minutes, threshold_ms: rule.threshold_ms, loss_pct_threshold: rule.loss_pct_threshold, loss_window_minutes: rule.loss_window_minutes ?? 60 });
                          setShowAlertForm(true);
                        }}>Edit</button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void deleteAlertRule(rule.id)}>Delete</button>
                      </div>
                      {testResult && Object.keys(testResult).length > 0 && (
                        <div className="alert-test-results">
                          {Object.entries(testResult).map(([ch, res]) => (
                            <span key={ch} className={`notif-result${res === "Sent successfully" ? " ok" : " err"}`}>
                              {targetLabel(ch)}: {res}
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

      <section className="panel admin-panel admin-alert-delivery-panel">
        <div className="admin-panel-header">
          <h2 className="admin-section-title"><IconAlertCircle size={16} />Delivery history</h2>
        </div>
        <p className="tool-note">The most recent alert notification attempts and whether each provider accepted them. Kept for 30 days.</p>
        {deliveries.length === 0 ? (
          <p className="tool-note">No notifications have been sent yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid rgba(175,198,216,0.5)', textAlign: 'left' }}>
                <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Sent</th>
                <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Rule</th>
                <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Target</th>
                <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} style={{ borderBottom: '1px solid rgba(175,198,216,0.3)' }}>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: '#4a6474' }}>{formatEventTime(d.sent_at)}</td>
                  <td style={{ padding: '8px 10px', fontWeight: 600 }}>{d.rule_name || "—"}</td>
                  <td style={{ padding: '8px 10px', fontSize: 12 }}>{targetLabel(d.target)}</td>
                  <td style={{ padding: '8px 10px' }}>
                    <span className={`notif-result${d.status === "sent" ? " ok" : " err"}`}>
                      {d.status === "sent" ? "Sent" : d.detail || "Failed"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

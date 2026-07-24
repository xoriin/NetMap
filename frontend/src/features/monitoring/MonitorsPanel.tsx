import { useEffect, useMemo, useState, type FormEvent } from "react";
import { IconGauge, IconPlugConnected, IconWifi, IconWifiOff } from "@tabler/icons-react";
import { api, type HttpMethod, type Monitor, type MonitorCheckHistoryPoint, type MonitorPayload } from "../../api/client";
import { DashStat } from "../../components/DashStat";
import { Modal } from "../../components/Modal";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";

const HTTP_METHODS: HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"];

const INTERVAL_OPTIONS = [
  { value: 20, label: "20 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
  { value: 1800, label: "30 minutes" },
  { value: 3600, label: "1 hour" },
];

function emptyForm(): MonitorPayload {
  return {
    name: "",
    url: "",
    http_method: "GET",
    expected_status_min: 200,
    expected_status_max: 399,
    timeout_seconds: 10,
    verify_tls: true,
    follow_redirects: true,
    check_interval_seconds: 60,
    max_retries: 0,
    enabled: true,
  };
}

function fmtRtt(ms: number | null): string {
  return ms !== null ? `${ms.toFixed(0)} ms` : "—";
}

function fmtUptime(pct: number | null): string {
  return pct !== null ? `${pct.toFixed(1)}%` : "—";
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

export type MonitorStats = { total: number; online: number; offline: number; avgRtt: number | null };

export function MonitorsPanel({
  accessToken,
  canWrite,
  embedded = false,
  onStatsChange,
}: {
  accessToken: string;
  canWrite: boolean;
  /** Renders just the toolbar + table + drilldown, for embedding inside another panel's body. */
  embedded?: boolean;
  onStatsChange?: (stats: MonitorStats) => void;
}) {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<MonitorPayload>(emptyForm());
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [history, setHistory] = useState<MonitorCheckHistoryPoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const confirmAction = useConfirm();
  const toast = useToast();

  async function load() {
    try {
      setMonitors(await api.listMonitors(accessToken));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load monitors");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  useEffect(() => {
    if (selectedId === null) { setHistory([]); return; }
    setHistoryLoading(true);
    void api.getMonitorHistory(accessToken, selectedId, 24)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [accessToken, selectedId]);

  const selectedMonitor = useMemo(() => monitors.find((m) => m.id === selectedId) ?? null, [monitors, selectedId]);

  const stats = useMemo(() => {
    const total = monitors.length;
    const online = monitors.filter((m) => m.last_status === "online").length;
    const offline = monitors.filter((m) => m.last_status === "offline").length;
    const withRtt = monitors.filter((m) => m.avg_response_time_24h !== null);
    const avgRtt = withRtt.length > 0
      ? withRtt.reduce((sum, m) => sum + (m.avg_response_time_24h ?? 0), 0) / withRtt.length
      : null;
    return { total, online, offline, avgRtt };
  }, [monitors]);

  useEffect(() => {
    onStatsChange?.(stats);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats]);

  function openAddForm() {
    setEditingId(null);
    setForm(emptyForm());
    setFormError(null);
    setShowForm(true);
  }

  function openEditForm(monitor: Monitor) {
    setEditingId(monitor.id);
    setForm({
      name: monitor.name,
      url: monitor.url,
      http_method: monitor.http_method,
      expected_status_min: monitor.expected_status_min,
      expected_status_max: monitor.expected_status_max,
      timeout_seconds: monitor.timeout_seconds,
      verify_tls: monitor.verify_tls,
      follow_redirects: monitor.follow_redirects,
      check_interval_seconds: monitor.check_interval_seconds,
      max_retries: monitor.max_retries,
      enabled: monitor.enabled,
    });
    setFormError(null);
    setShowForm(true);
  }

  async function saveMonitor(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.url.trim()) { setFormError("Name and URL are required"); return; }
    setFormBusy(true);
    setFormError(null);
    try {
      if (editingId !== null) {
        await api.updateMonitor(accessToken, editingId, form);
        toast.success(`Monitor "${form.name}" updated`);
      } else {
        await api.createMonitor(accessToken, form);
        toast.success(`Monitor "${form.name}" created`);
      }
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save monitor");
    } finally {
      setFormBusy(false);
    }
  }

  async function deleteMonitor(monitor: Monitor) {
    const confirmed = await confirmAction({
      title: "Delete monitor",
      message: `This permanently deletes "${monitor.name}" and its check history.`,
      confirmLabel: "Delete monitor",
    });
    if (!confirmed) return;
    try {
      await api.deleteMonitor(accessToken, monitor.id);
      if (selectedId === monitor.id) setSelectedId(null);
      toast.success(`Monitor "${monitor.name}" deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete monitor");
    }
  }

  async function toggleEnabled(monitor: Monitor) {
    try {
      await api.updateMonitor(accessToken, monitor.id, { enabled: !monitor.enabled });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update monitor");
    }
  }

  const body = (
    <>
      {error && <div className="form-error">{error}</div>}

      <div className={embedded ? "monitors-toolbar monitors-toolbar--embedded" : "monitors-toolbar"}>
        {embedded ? (
          <p className="tool-note tool-note--hint monitors-toolbar-hint">Standalone HTTP/HTTPS monitors, checked independently of inventory devices.</p>
        ) : (
          <p className="tool-note">Standalone HTTP/HTTPS monitors, checked independently of inventory devices.</p>
        )}
        {canWrite && <button type="button" className="nm-btn nm-btn--primary nm-btn--sm" onClick={openAddForm}>+ Add monitor</button>}
      </div>

      {loading ? (
        <p className="dash-empty">Loading monitors…</p>
      ) : monitors.length === 0 ? (
        <p className="dash-empty">No standalone monitors yet. Add one to start tracking an HTTP/HTTPS endpoint.</p>
      ) : (
        <div className="monitors-layout">
          <div className="nm-table-wrap monitors-table-wrap">
            <table className="nm-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>URL</th>
                  <th>Uptime 24h</th>
                  <th>Uptime 7d</th>
                  <th>Avg RTT</th>
                  <th>Last checked</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {monitors.map((monitor) => (
                  <tr
                    key={monitor.id}
                    className={selectedId === monitor.id ? "is-active" : ""}
                    onClick={() => setSelectedId(monitor.id)}
                    style={{ cursor: "pointer", opacity: monitor.enabled ? 1 : 0.55 }}
                  >
                    <td><span className={`mon-dot mon-dot-${monitor.last_status ?? "unknown"}`} /></td>
                    <td>{monitor.name}</td>
                    <td className="nm-table-mono">{monitor.url}</td>
                    <td className="nm-table-num">{fmtUptime(monitor.uptime_24h)}</td>
                    <td className="nm-table-num">{fmtUptime(monitor.uptime_7d)}</td>
                    <td className="nm-table-num">{fmtRtt(monitor.avg_response_time_24h)}</td>
                    <td>{fmtWhen(monitor.last_checked_at)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {canWrite && (
                        <div className="nm-table-actions">
                          <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => toggleEnabled(monitor)}>
                            {monitor.enabled ? "Pause" : "Resume"}
                          </button>
                          <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => openEditForm(monitor)}>Edit</button>
                          <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void deleteMonitor(monitor)}>Delete</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedMonitor && (
            <div className="monitors-drilldown">
              <div className="monitors-drilldown-header">
                <span className={`mon-dot mon-dot-${selectedMonitor.last_status ?? "unknown"}`} />
                <div>
                  <strong>{selectedMonitor.name}</strong>
                  <span className="dash-panel-meta">{selectedMonitor.url}</span>
                </div>
              </div>
              <div className="monitors-drilldown-stats">
                <div><span className="dash-panel-meta">Uptime 24h</span><strong>{fmtUptime(selectedMonitor.uptime_24h)}</strong></div>
                <div><span className="dash-panel-meta">Uptime 7d</span><strong>{fmtUptime(selectedMonitor.uptime_7d)}</strong></div>
                <div><span className="dash-panel-meta">Avg response (24h)</span><strong>{fmtRtt(selectedMonitor.avg_response_time_24h)}</strong></div>
                <div><span className="dash-panel-meta">Check interval</span><strong>{selectedMonitor.check_interval_seconds}s</strong></div>
              </div>

              <div className="monitors-heartbeat-strip">
                {historyLoading ? (
                  <p className="dash-empty">Loading history…</p>
                ) : history.length === 0 ? (
                  <p className="dash-empty">No checks recorded yet.</p>
                ) : (
                  <div className="heartbeat-bar heartbeat-bar--lg">
                    {history.slice(-60).map((point) => (
                      <span
                        key={point.id}
                        className="heartbeat-beat"
                        style={{ background: point.status === "online" ? "var(--nm-success)" : "var(--nm-danger)" }}
                        title={`${new Date(point.checked_at).toLocaleString()} — ${point.status}${point.response_time_ms !== null ? ` — ${point.response_time_ms.toFixed(0)} ms` : ""}${point.error ? ` — ${point.error}` : ""}`}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="monitors-history-list">
                {history.slice(-15).reverse().map((point) => (
                  <div key={point.id} className="monitors-history-row">
                    <span className={`mon-dot mon-dot-${point.status}`} />
                    <span className="dash-panel-meta">{new Date(point.checked_at).toLocaleTimeString()}</span>
                    <span className="nm-table-mono">{point.status_code ?? "—"}</span>
                    <span className="nm-table-num">{fmtRtt(point.response_time_ms)}</span>
                    {point.error && <span className="monitors-history-error">{point.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {showForm && (
        <Modal
          title={editingId !== null ? "Edit monitor" : "Add monitor"}
          size="lg"
          onCancel={() => setShowForm(false)}
          headerSubmitFormId="monitor-form"
          headerSubmitLabel={formBusy ? "Saving…" : editingId !== null ? "Save" : "Add monitor"}
          headerSubmitDisabled={formBusy}
        >
          <form id="monitor-form" className="tool-form modal-form" onSubmit={(e) => void saveMonitor(e)}>
            {formError && <div className="form-error">{formError}</div>}
            <label>Name
              <input className="nm-input" maxLength={120} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Company website" autoFocus />
            </label>
            <label>URL
              <input className="nm-input" maxLength={2048} value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://example.com/health" />
            </label>
            <div className="nm-form-row">
              <label>Method
                <select className="nm-select" value={form.http_method} onChange={(e) => setForm((f) => ({ ...f, http_method: e.target.value as HttpMethod }))}>
                  {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label>Check interval
                <select className="nm-select" value={form.check_interval_seconds} onChange={(e) => setForm((f) => ({ ...f, check_interval_seconds: Number(e.target.value) }))}>
                  {INTERVAL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            </div>
            <div className="nm-form-row">
              <label>Expected status min
                <input className="nm-input" type="number" min={100} max={599} value={form.expected_status_min} onChange={(e) => setForm((f) => ({ ...f, expected_status_min: Number(e.target.value) }))} />
              </label>
              <label>Expected status max
                <input className="nm-input" type="number" min={100} max={599} value={form.expected_status_max} onChange={(e) => setForm((f) => ({ ...f, expected_status_max: Number(e.target.value) }))} />
              </label>
            </div>
            <div className="nm-form-row">
              <label>Timeout (seconds)
                <input className="nm-input" type="number" min={1} max={60} value={form.timeout_seconds} onChange={(e) => setForm((f) => ({ ...f, timeout_seconds: Number(e.target.value) }))} />
              </label>
              <label>Retries before down
                <input className="nm-input" type="number" min={0} max={10} value={form.max_retries} onChange={(e) => setForm((f) => ({ ...f, max_retries: Number(e.target.value) }))} />
                <span className="tool-note tool-note--hint">Consecutive failures required before the monitor flips to down.</span>
              </label>
            </div>
            <label className="tool-form-inline-check">
              <input type="checkbox" checked={form.verify_tls} onChange={(e) => setForm((f) => ({ ...f, verify_tls: e.target.checked }))} />
              Verify TLS certificate
            </label>
            <label className="tool-form-inline-check">
              <input type="checkbox" checked={form.follow_redirects} onChange={(e) => setForm((f) => ({ ...f, follow_redirects: e.target.checked }))} />
              Follow redirects
            </label>
            <label className="tool-form-inline-check">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
              Enabled
            </label>
          </form>
        </Modal>
      )}
    </>
  );

  if (embedded) return body;

  return (
    <div className="monitors-panel">
      <div className="dash-stats">
        <DashStat label="Monitors" value={stats.total} sub={stats.total === 0 ? "none yet" : "standalone targets"} icon={<IconPlugConnected size={20} />} accent="teal" />
        <DashStat label="Up" value={stats.online} sub="responding" icon={<IconWifi size={20} />} accent="green" />
        <DashStat label="Down" value={stats.offline} sub={stats.offline > 0 ? "need attention" : "all clear"} icon={<IconWifiOff size={20} />} accent={stats.offline > 0 ? "red" : "green"} />
        <DashStat label="Avg response" value={fmtRtt(stats.avgRtt)} sub="last 24h" icon={<IconGauge size={20} />} accent="indigo" />
      </div>
      {body}
    </div>
  );
}

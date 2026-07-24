import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { IconGauge, IconPlugConnected, IconWifi, IconWifiOff } from "@tabler/icons-react";
import { api, type HttpMethod, type Monitor, type MonitorCheckHistoryPoint, type MonitorPayload } from "../../api/client";
import { DashStat } from "../../components/DashStat";
import { Modal } from "../../components/Modal";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { MonitorDetails } from "./MonitorDetails";
import {
  MONITORS_COL_WIDTHS_KEY,
  MONITORS_DEFAULT_COL_WIDTHS,
  MONITORS_FILLER_MIN_WIDTH,
  MONITORS_PAGE_SIZE_KEY,
  PAGE_SIZE_OPTIONS,
  fmtMonitorRtt,
  fmtMonitorUptime,
  fmtMonitorWhen,
  loadMonitorsColWidths,
  loadPageSize,
} from "../../utils/monitoring";

const MONITORS_STATUS_COL_WIDTH = 64;
const MONITORS_ACTIONS_COL_WIDTH = 210;

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

export type MonitorStats = { total: number; online: number; offline: number; avgRtt: number | null };

export function MonitorsPanel({
  accessToken,
  canWrite,
  embedded = false,
  visible = true,
  onStatsChange,
}: {
  accessToken: string;
  canWrite: boolean;
  /** Renders just the toolbar + table + drilldown, for embedding inside another panel's body. */
  embedded?: boolean;
  /** Whether this panel is the visible tab right now — the panel stays mounted-but-hidden
   * (display:none) while on the other tab, and a hidden element reports zero size, so the
   * table-width measurement needs to be redone once it's actually shown again. */
  visible?: boolean;
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
  // Always a fully-explicit 6-length array (never null/flexible <col>s) — mixing
  // flexible and fixed columns meant the very first resize "froze" whatever
  // inflated width the browser had given the flexible columns at that instant,
  // producing a jarring jump. Explicit widths from the start make every drag
  // change only the column being dragged.
  const [colWidths, setColWidths] = useState<number[]>(() => loadMonitorsColWidths() ?? MONITORS_DEFAULT_COL_WIDTHS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPageSize(MONITORS_PAGE_SIZE_KEY));
  const resizingRef = useRef<{ colIdx: number; startX: number; startWidth: number } | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1200);
  const confirmAction = useConfirm();
  const toast = useToast();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // The panel stays mounted (display:none) while on the other tab, so the
    // observer attached back then saw a 0-width element and never fires again
    // on its own once revealed. Re-measure directly whenever this becomes the
    // active tab, then let the observer take over for actual resizes.
    if (visible) {
      const rect = el.getBoundingClientRect();
      if (rect.width) setContainerWidth(rect.width);
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // "Last checked" isn't user-resizable — it silently absorbs whatever space is
  // left after the status column, the 5 resizable columns, and the actions
  // column, so the table always spans the full wrapper width. Dragging one of
  // the 5 resizable columns only ever changes that column and this filler.
  const fillerWidth = Math.max(
    MONITORS_FILLER_MIN_WIDTH,
    containerWidth - MONITORS_STATUS_COL_WIDTH - MONITORS_ACTIONS_COL_WIDTH - colWidths.reduce((sum, w) => sum + w, 0),
  );

  function startColResize(colIdx: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[colIdx];
    resizingRef.current = { colIdx, startX, startWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      if (!resizingRef.current) return;
      const { colIdx: ci, startX: sx, startWidth: sw } = resizingRef.current;
      const rawNext = Math.max(60, sw + (ev.clientX - sx));
      setColWidths((prev) => {
        const othersSum = prev.reduce((sum, w, i) => (i === ci ? sum : sum + w), 0);
        const maxForThis = Math.max(
          60,
          containerWidth - MONITORS_STATUS_COL_WIDTH - MONITORS_ACTIONS_COL_WIDTH - MONITORS_FILLER_MIN_WIDTH - othersSum,
        );
        const updated = [...prev];
        updated[ci] = Math.min(rawNext, maxForThis);
        return updated;
      });
    }

    function onUp() {
      resizingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setColWidths((prev) => {
        window.localStorage.setItem(MONITORS_COL_WIDTHS_KEY, JSON.stringify(prev));
        return prev;
      });
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

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

  const paginatedMonitors = useMemo(() => {
    const start = (page - 1) * pageSize;
    return monitors.slice(start, start + pageSize);
  }, [monitors, page, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [monitors.length, pageSize]);

  useEffect(() => {
    window.localStorage.setItem(MONITORS_PAGE_SIZE_KEY, String(pageSize));
  }, [pageSize]);

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
          <span className="dash-panel-meta monitors-toolbar-hint">Standalone HTTP/HTTPS monitors, checked independently of inventory devices.</span>
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
          <div className="nm-table-wrap monitors-table-wrap" ref={wrapRef}>
            <table
              className="nm-table monitors-table"
              ref={tableRef}
              style={{ tableLayout: "fixed", width: containerWidth }}
            >
              <colgroup>
                <col style={{ width: MONITORS_STATUS_COL_WIDTH }} />
                {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
                <col style={{ width: fillerWidth }} />
                <col style={{ width: MONITORS_ACTIONS_COL_WIDTH }} />
              </colgroup>
              <thead>
                <tr>
                  <th></th>
                  <th>
                    Name
                    <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(0, e)} />
                  </th>
                  <th>
                    URL
                    <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(1, e)} />
                  </th>
                  <th>
                    Uptime 24h
                    <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(2, e)} />
                  </th>
                  <th>
                    Uptime 7d
                    <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(3, e)} />
                  </th>
                  <th>
                    Avg RTT
                    <div className="mon-col-resize-handle" onMouseDown={(e) => startColResize(4, e)} />
                  </th>
                  <th>Last checked</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {paginatedMonitors.map((monitor) => (
                  <tr
                    key={monitor.id}
                    className={selectedId === monitor.id ? "is-active" : ""}
                    onClick={() => setSelectedId(monitor.id)}
                    style={{ cursor: "pointer", opacity: monitor.enabled ? 1 : 0.55 }}
                  >
                    <td className="monitors-dot-cell"><span className={`mon-dot mon-dot-${monitor.last_status ?? "unknown"}`} /></td>
                    <td>{monitor.name}</td>
                    <td className="nm-table-mono">{monitor.url}</td>
                    <td className="nm-table-num">{fmtMonitorUptime(monitor.uptime_24h)}</td>
                    <td className="nm-table-num">{fmtMonitorUptime(monitor.uptime_7d)}</td>
                    <td className="nm-table-num">{fmtMonitorRtt(monitor.avg_response_time_24h)}</td>
                    <td>{fmtMonitorWhen(monitor.last_checked_at)}</td>
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
            <aside className="details-panel monitors-details-panel">
              <MonitorDetails
                monitor={selectedMonitor}
                history={history}
                historyLoading={historyLoading}
                onClose={() => setSelectedId(null)}
              />
            </aside>
          )}
        </div>
      )}

      {monitors.length > 0 && (
        <div className="inv-pagination">
          <span className="inv-pagination-info">
            Showing {Math.min((page - 1) * pageSize + 1, monitors.length)}–{Math.min(page * pageSize, monitors.length)} of {monitors.length} monitor{monitors.length !== 1 ? "s" : ""}
          </span>
          <div className="inv-pagination-controls">
            <span style={{ fontSize: 11, opacity: 0.7 }}>Per page:</span>
            <select
              className="inv-pagination-select"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button
              type="button"
              className="inv-pagination-btn"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ‹ Prev
            </button>
            <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>
              {page} / {Math.max(1, Math.ceil(monitors.length / pageSize))}
            </span>
            <button
              type="button"
              className="inv-pagination-btn"
              disabled={page >= Math.ceil(monitors.length / pageSize)}
              onClick={() => setPage((p) => p + 1)}
            >
              Next ›
            </button>
          </div>
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
        <DashStat label="Avg response" value={fmtMonitorRtt(stats.avgRtt)} sub="last 24h" icon={<IconGauge size={20} />} accent="indigo" />
      </div>
      {body}
    </div>
  );
}

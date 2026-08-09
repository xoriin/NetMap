import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Search, Star } from "lucide-react";
import { IconGauge, IconPlugConnected, IconWifi, IconWifiOff } from "@tabler/icons-react";
import { api, type HttpMethod, type Monitor, type MonitorCheckHistoryPoint, type MonitorPayload } from "../../api/client";
import { DashStat } from "../../components/DashStat";
import { HeartbeatBar } from "../../components/HeartbeatBar";
import { Modal } from "../../components/Modal";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { MonitorDetails } from "./MonitorDetails";
import { MonitorFormFields, type MonitorFormState } from "./MonitorFormFields";
import {
  MONITORS_PAGE_SIZE_KEY,
  PAGE_SIZE_OPTIONS,
  fmtMonitorRtt,
  fmtMonitorUptime,
  fmtMonitorWhen,
  loadPageSize,
} from "../../utils/monitoring";

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

function emptyForm(): MonitorFormState {
  return {
    name: "",
    description: "",
    tags_text: "",
    url: "",
    http_method: "GET",
    expected_status_min: 200,
    expected_status_max: 399,
    timeout_seconds: 10,
    verify_tls: true,
    follow_redirects: true,
    max_redirects: 10,
    accepted_status_codes: "200-399",
    request_headers_text: "",
    request_body: "",
    body_encoding: "json",
    auth_type: "none",
    auth_username: "",
    auth_password: "",
    bearer_token: "",
    oauth_token_url: "",
    oauth_client_id: "",
    oauth_client_secret: "",
    oauth_scopes: "",
    oauth_audience: "",
    oauth_auth_method: "client_secret_basic",
    proxy_url: "",
    tls_ca: "",
    tls_cert: "",
    tls_key: "",
    keyword: "",
    keyword_inverted: false,
    json_path: "",
    json_operator: "equals",
    expected_value: "",
    cache_bust: false,
    upside_down: false,
    check_interval_seconds: 60,
    max_retries: 0,
    retry_interval_seconds: 20,
    certificate_expiry_alert: false,
    certificate_expiry_days: 14,
    enabled: true,
  };
}

export type MonitorStats = { total: number; online: number; offline: number; avgRtt: number | null };

export function MonitorsPanel({
  accessToken,
  canWrite,
  embedded = false,
  onStatsChange,
  onFavouritesChange,
}: {
  accessToken: string;
  canWrite: boolean;
  /** Renders just the toolbar + table + drilldown, for embedding inside another panel's body. */
  embedded?: boolean;
  onStatsChange?: (stats: MonitorStats) => void;
  /** Fired after a star toggle so Overview's favourites panel can refetch. */
  onFavouritesChange?: () => void;
}) {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<MonitorFormState>(emptyForm());
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [history, setHistory] = useState<MonitorCheckHistoryPoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => loadPageSize(MONITORS_PAGE_SIZE_KEY));
  const confirmAction = useConfirm();
  const toast = useToast();

  async function load() {
    try {
      setMonitors(await api.listMonitors(accessToken));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load endpoints");
    } finally {
      setLoading(false);
    }
  }

  async function toggleFavourite(monitor: Monitor) {
    // Optimistic: the star must feel instant, and the 15s poll reconciles.
    setMonitors((current) => current.map((row) =>
      row.id === monitor.id ? { ...row, is_favourite: !row.is_favourite } : row));
    try {
      const updated = await api.toggleMonitorFavourite(accessToken, monitor.id);
      setMonitors((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      onFavouritesChange?.();
    } catch (err) {
      setMonitors((current) => current.map((row) =>
        row.id === monitor.id ? { ...row, is_favourite: monitor.is_favourite } : row));
      toast.error(err instanceof Error ? err.message : "Could not update favourite");
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
    setHistory([]);
    setHistoryLoading(true);
    void api.getMonitorHistory(accessToken, selectedId, 24)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [accessToken, selectedId]);

  const selectedMonitor = useMemo(() => monitors.find((m) => m.id === selectedId) ?? null, [monitors, selectedId]);

  const filteredMonitors = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return monitors.filter((monitor) => {
      const effectiveStatus = !monitor.enabled ? "paused" : monitor.last_status ?? "unknown";
      if (statusFilter !== "all" && effectiveStatus !== statusFilter) return false;
      return !query || monitor.name.toLowerCase().includes(query) || monitor.url.toLowerCase().includes(query);
    });
  }, [monitors, searchQuery, statusFilter]);

  const paginatedMonitors = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredMonitors.slice(start, start + pageSize);
  }, [filteredMonitors, page, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [filteredMonitors.length, pageSize, searchQuery, statusFilter]);

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
      description: monitor.description ?? "",
      tags_text: monitor.tags.join(", "),
      url: monitor.url,
      http_method: monitor.http_method,
      expected_status_min: monitor.expected_status_min,
      expected_status_max: monitor.expected_status_max,
      timeout_seconds: monitor.timeout_seconds,
      verify_tls: monitor.verify_tls,
      follow_redirects: monitor.follow_redirects,
      max_redirects: monitor.max_redirects,
      accepted_status_codes: monitor.accepted_status_codes,
      request_headers_text: "",
      request_body: "",
      body_encoding: monitor.body_encoding,
      auth_type: monitor.auth_type,
      auth_username: monitor.auth_username ?? "",
      auth_password: "",
      bearer_token: "",
      oauth_token_url: monitor.oauth_token_url ?? "",
      oauth_client_id: monitor.oauth_client_id ?? "",
      oauth_client_secret: "",
      oauth_scopes: monitor.oauth_scopes ?? "",
      oauth_audience: monitor.oauth_audience ?? "",
      oauth_auth_method: monitor.oauth_auth_method,
      proxy_url: "",
      tls_ca: "",
      tls_cert: "",
      tls_key: "",
      keyword: monitor.keyword ?? "",
      keyword_inverted: monitor.keyword_inverted,
      json_path: monitor.json_path ?? "",
      json_operator: monitor.json_operator,
      expected_value: monitor.expected_value ?? "",
      cache_bust: monitor.cache_bust,
      upside_down: monitor.upside_down,
      check_interval_seconds: monitor.check_interval_seconds,
      max_retries: monitor.max_retries,
      retry_interval_seconds: monitor.retry_interval_seconds,
      certificate_expiry_alert: monitor.certificate_expiry_alert,
      certificate_expiry_days: monitor.certificate_expiry_days,
      enabled: monitor.enabled,
    });
    setFormError(null);
    setShowForm(true);
  }

  async function saveMonitor(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.url.trim()) { setFormError("Name and URL are required"); return; }
    let requestHeaders: Record<string, string> | undefined;
    if (form.request_headers_text.trim()) {
      try {
        const parsed: unknown = JSON.parse(form.request_headers_text);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some((value) => typeof value !== "string")) {
          throw new Error("Headers must be a JSON object whose values are strings");
        }
        requestHeaders = parsed as Record<string, string>;
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "Headers must be valid JSON");
        return;
      }
    }
    const payload: MonitorPayload = {
      ...form,
      description: form.description?.trim() || null,
      tags: form.tags_text.split(",").map((tag) => tag.trim()).filter(Boolean),
      keyword: form.keyword?.trim() || null,
      json_path: form.json_path?.trim() || null,
      expected_value: form.expected_value ?? null,
      oauth_token_url: form.oauth_token_url?.trim() || null,
      oauth_client_id: form.oauth_client_id?.trim() || null,
      oauth_scopes: form.oauth_scopes?.trim() || null,
      oauth_audience: form.oauth_audience?.trim() || null,
    };
    delete (payload as MonitorPayload & { tags_text?: string }).tags_text;
    delete (payload as MonitorPayload & { request_headers_text?: string }).request_headers_text;
    if (requestHeaders) payload.request_headers = requestHeaders;
    for (const key of ["request_body", "auth_password", "bearer_token", "oauth_client_secret", "proxy_url", "tls_ca", "tls_cert", "tls_key"] as const) {
      if (!payload[key]) delete payload[key];
    }
    setFormBusy(true);
    setFormError(null);
    try {
      if (editingId !== null) {
        await api.updateMonitor(accessToken, editingId, payload);
        toast.success(`Monitor "${form.name}" updated`);
      } else {
        await api.createMonitor(accessToken, payload);
        toast.success(`Monitor "${form.name}" created`);
      }
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save endpoint");
    } finally {
      setFormBusy(false);
    }
  }

  async function deleteMonitor(monitor: Monitor) {
    const confirmed = await confirmAction({
      title: "Delete endpoint",
      message: `This permanently deletes "${monitor.name}" and its check history.`,
      confirmLabel: "Delete endpoint",
    });
    if (!confirmed) return;
    try {
      await api.deleteMonitor(accessToken, monitor.id);
      if (selectedId === monitor.id) setSelectedId(null);
      toast.success(`Endpoint "${monitor.name}" deleted`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete endpoint");
    }
  }

  async function toggleEnabled(monitor: Monitor) {
    try {
      await api.updateMonitor(accessToken, monitor.id, { enabled: !monitor.enabled });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update endpoint");
    }
  }

  const body = (
    <div className={embedded ? "monitors-panel-content monitors-panel-content--embedded" : "monitors-panel-content"}>
      {error && <div className="form-error">{error}</div>}

      <div className="dash-panel-header monitors-table-toolbar">
        <div className="monitors-table-toolbar-meta">
          <strong>HTTP/HTTPS endpoints</strong>
          <span className="dash-panel-meta">
            {filteredMonitors.length === monitors.length
              ? `${monitors.length} endpoint${monitors.length === 1 ? "" : "s"}`
              : `${filteredMonitors.length} of ${monitors.length}`}
          </span>
        </div>
        <div className="mon-panel-controls">
          <select className="toolbar-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter endpoints by status">
            <option value="all">All statuses</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="paused">Paused</option>
            <option value="unknown">Awaiting check</option>
          </select>
          <div className="mon-search-wrap nm-search monitors-search-wrap">
            <Search size={13} className="nm-search-icon" />
            <input
              className="mon-search nm-input"
              placeholder="Search name or URL…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          {canWrite && <button type="button" className="nm-btn nm-btn--primary nm-btn--sm" onClick={openAddForm}>+ Add endpoint</button>}
        </div>
      </div>

      {loading ? (
        <p className="dash-empty">Loading endpoints…</p>
      ) : monitors.length === 0 ? (
        <p className="dash-empty">No HTTP/HTTPS endpoints yet. Add one to start tracking availability and response time.</p>
      ) : filteredMonitors.length === 0 ? (
        <p className="dash-empty">No endpoints match the current filters.</p>
      ) : (
        <div className="monitors-layout">
          <div className="nm-table-wrap monitors-table-wrap">
            <table className="nm-table monitors-table">
              <colgroup>
                <col className="monitors-col-fav" />
                <col className="monitors-col-status" />
                <col className="monitors-col-name" />
                <col className="monitors-col-heartbeat" />
                <col className="monitors-col-url" />
                <col className="monitors-col-uptime" />
                <col className="monitors-col-uptime" />
                <col className="monitors-col-rtt" />
                <col className="monitors-col-checked" />
                <col className="monitors-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th></th>
                  <th></th>
                  <th>Name</th>
                  <th>Heartbeat</th>
                  <th>URL</th>
                  <th>Uptime 24h</th>
                  <th>Uptime 7d</th>
                  <th>Avg RTT</th>
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
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className={`fav-btn${monitor.is_favourite ? " fav-btn--active" : ""}`}
                        title={monitor.is_favourite ? "Remove from favourites" : "Add to favourites"}
                        aria-label={monitor.is_favourite ? "Remove from favourites" : "Add to favourites"}
                        aria-pressed={monitor.is_favourite}
                        onClick={() => void toggleFavourite(monitor)}
                      >
                        <Star size={13} fill={monitor.is_favourite ? "currentColor" : "none"} />
                      </button>
                    </td>
                    <td className="monitors-dot-cell"><span className={`mon-dot mon-dot-${monitor.last_status ?? "unknown"}`} /></td>
                    <td>{monitor.name}</td>
                    <td className="monitors-heartbeat-cell">
                      {monitor.heartbeat.length > 0 ? (
                        <HeartbeatBar beats={monitor.heartbeat} size="sm" />
                      ) : (
                        <span className="monitors-heartbeat-empty">Awaiting checks</span>
                      )}
                    </td>
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

          {selectedMonitor && createPortal(
            <div
              className="mon-hero-backdrop monitor-http-backdrop"
              role="dialog"
              aria-modal="true"
              aria-label={`${selectedMonitor.name} monitor overview`}
              onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}
            >
              <MonitorDetails
                monitor={selectedMonitor}
                history={history}
                historyLoading={historyLoading}
                onClose={() => setSelectedId(null)}
              />
            </div>,
            document.body,
          )}
        </div>
      )}

      {filteredMonitors.length > 0 && (
        <div className="inv-pagination">
          <span className="inv-pagination-info">
              Showing {Math.min((page - 1) * pageSize + 1, filteredMonitors.length)}–{Math.min(page * pageSize, filteredMonitors.length)} of {filteredMonitors.length} endpoint{filteredMonitors.length !== 1 ? "s" : ""}
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
              {page} / {Math.max(1, Math.ceil(filteredMonitors.length / pageSize))}
            </span>
            <button
              type="button"
              className="inv-pagination-btn"
              disabled={page >= Math.ceil(filteredMonitors.length / pageSize)}
              onClick={() => setPage((p) => p + 1)}
            >
              Next ›
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <Modal
          title={editingId !== null ? "Edit endpoint" : "Add endpoint"}
          size="lg"
          modalClassName="monitor-form-modal"
          onCancel={() => setShowForm(false)}
          headerSubmitFormId="monitor-form"
          headerSubmitLabel={formBusy ? "Saving…" : editingId !== null ? "Save" : "Add endpoint"}
          headerSubmitDisabled={formBusy}
        >
          <form id="monitor-form" className="modal-form monitor-form" onSubmit={(e) => void saveMonitor(e)}>
            {formError && <div className="form-error">{formError}</div>}
            <MonitorFormFields
              form={form}
              setForm={setForm}
              editingMonitor={editingId === null ? null : selectedMonitor ?? monitors.find((monitor) => monitor.id === editingId) ?? null}
              httpMethods={HTTP_METHODS}
              intervalOptions={INTERVAL_OPTIONS}
            />
          </form>
        </Modal>
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <div className="monitors-panel">
      <div className="dash-stats">
        <DashStat label="Endpoints" value={stats.total} sub={stats.total === 0 ? "none yet" : "HTTP/HTTPS targets"} icon={<IconPlugConnected size={20} />} accent="teal" />
        <DashStat label="Up" value={stats.online} sub="responding" icon={<IconWifi size={20} />} accent="green" />
        <DashStat label="Down" value={stats.offline} sub={stats.offline > 0 ? "need attention" : "all clear"} icon={<IconWifiOff size={20} />} accent={stats.offline > 0 ? "red" : "green"} />
        <DashStat label="Avg response" value={fmtMonitorRtt(stats.avgRtt)} sub="last 24h" icon={<IconGauge size={20} />} accent="indigo" />
      </div>
      {body}
    </div>
  );
}

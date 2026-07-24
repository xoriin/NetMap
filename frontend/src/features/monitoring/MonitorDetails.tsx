import { X } from "lucide-react";
import type { Monitor, MonitorCheckHistoryPoint } from "../../api/client";
import { fmtMonitorRtt, fmtMonitorUptime } from "../../utils/monitoring";

export function MonitorDetails({
  monitor,
  history,
  historyLoading,
  onClose,
}: {
  monitor: Monitor;
  history: MonitorCheckHistoryPoint[];
  historyLoading: boolean;
  onClose: () => void;
}) {
  return (
    <div>
      <div className="details-heading">
        <span className={`mon-dot mon-dot-${monitor.last_status ?? "unknown"}`} />
        <div className="details-heading-body">
          <div className="details-heading-title-row">
            <h3>{monitor.name}</h3>
          </div>
          <span className="dash-panel-meta monitors-details-url">{monitor.url}</span>
        </div>
        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary monitors-details-close" onClick={onClose} aria-label="Close monitor details">
          <X size={14} />
        </button>
      </div>

      <div className="monitors-drilldown-stats">
        <div><span className="dash-panel-meta">Uptime 24h</span><strong>{fmtMonitorUptime(monitor.uptime_24h)}</strong></div>
        <div><span className="dash-panel-meta">Uptime 7d</span><strong>{fmtMonitorUptime(monitor.uptime_7d)}</strong></div>
        <div><span className="dash-panel-meta">Avg response (24h)</span><strong>{fmtMonitorRtt(monitor.avg_response_time_24h)}</strong></div>
        <div><span className="dash-panel-meta">Check interval</span><strong>{monitor.check_interval_seconds}s</strong></div>
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
            <span className="nm-table-num">{fmtMonitorRtt(point.response_time_ms)}</span>
            {point.error && <span className="monitors-history-error">{point.error}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

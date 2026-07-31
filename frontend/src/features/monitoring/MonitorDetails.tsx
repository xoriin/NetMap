import { useMemo } from "react";
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
  const effectiveStatus = monitor.enabled ? monitor.last_status ?? "unknown" : "paused";
  const statusLabel = !monitor.enabled
    ? "Paused"
    : monitor.last_status === "online"
      ? "Online"
      : monitor.last_status === "offline"
        ? "Offline"
        : "Awaiting check";
  const lastChecked = monitor.last_checked_at
    ? new Date(monitor.last_checked_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "Not checked yet";
  const certDaysRemaining = monitor.last_cert_expires_at
    ? Math.ceil((new Date(monitor.last_cert_expires_at).getTime() - Date.now()) / 86_400_000)
    : null;
  const { commonStatusCode, failedChecks, fastest, latest, p95, slowest, successfulChecks, successRate } = useMemo(() => {
    const latestPoint = history.length > 0 ? history[history.length - 1] : null;
    const successes = history.filter((point) => point.status === "online").length;
    const failures = history.length - successes;
    const times = history
      .flatMap((point) => point.response_time_ms === null ? [] : [point.response_time_ms])
      .sort((a, b) => a - b);
    const codeCounts = history.reduce<Map<number, number>>((counts, point) => {
      if (point.status_code !== null) counts.set(point.status_code, (counts.get(point.status_code) ?? 0) + 1);
      return counts;
    }, new Map());
    return {
      latest: latestPoint,
      successfulChecks: successes,
      failedChecks: failures,
      successRate: history.length > 0 ? (successes / history.length) * 100 : null,
      fastest: times[0] ?? null,
      slowest: times.length > 0 ? times[times.length - 1] : null,
      p95: times.length > 0 ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] : null,
      commonStatusCode: [...codeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    };
  }, [history]);

  return (
    <div className="mon-hero monitor-http-hero">
      <div className={`mon-hero-header mon-hero-header--${effectiveStatus}`}>
        <div className="mon-hero-header-left">
          <span className={`mon-dot mon-dot-${monitor.last_status ?? "unknown"}`} />
          <div>
            <div className="mon-hero-name">{monitor.name}</div>
            <div className="mon-hero-sub monitor-http-url">{monitor.url}</div>
          </div>
        </div>
        <div className="mon-hero-actions">
          <span className={`nm-pill monitor-http-status monitor-http-status--${effectiveStatus}`}>{statusLabel}</span>
          <button type="button" className="mon-hero-close" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      <div className="mon-hero-stats">
        <div className="mon-hero-stat">
          <span className="mon-hero-stat-label">24 h uptime</span>
          <strong className="mon-hero-stat-val">{fmtMonitorUptime(monitor.uptime_24h)}</strong>
        </div>
        <div className="mon-hero-stat">
          <span className="mon-hero-stat-label">7 d uptime</span>
          <strong className="mon-hero-stat-val">{fmtMonitorUptime(monitor.uptime_7d)}</strong>
        </div>
        <div className="mon-hero-stat">
          <span className="mon-hero-stat-label">Avg response (24 h)</span>
          <strong className="mon-hero-stat-val">{fmtMonitorRtt(monitor.avg_response_time_24h)}</strong>
        </div>
        <div className="mon-hero-stat">
          <span className="mon-hero-stat-label">Latest HTTP status</span>
          <strong className="mon-hero-stat-val">{latest?.status_code ?? "—"}</strong>
        </div>
        <div className="mon-hero-stat">
          <span className="mon-hero-stat-label">Last checked</span>
          <strong className="mon-hero-stat-val">{lastChecked}</strong>
        </div>
      </div>

      <div className="mon-hero-body">
        <div className="mon-hero-cols monitor-http-cols">
          <div className="mon-hero-col">
            <section className="mon-hero-section">
              <div className="mon-hero-section-title">
                HTTP performance
                <span className="dash-panel-meta">loaded history</span>
              </div>
              <div className="mon-analysis-body">
                <div className="mon-analysis-row"><span className="dash-panel-meta">Successful checks</span><strong className="mon-analysis-val">{successfulChecks}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Failed checks</span><strong className={failedChecks > 0 ? "mon-analysis-val mon-analysis-val--warn" : "mon-analysis-val"}>{failedChecks}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Success rate</span><strong className="mon-analysis-val">{successRate === null ? "—" : `${successRate.toFixed(1)}%`}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Fastest / slowest</span><strong className="mon-analysis-val">{fmtMonitorRtt(fastest)} / {fmtMonitorRtt(slowest)}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">p95 response</span><strong className="mon-analysis-val">{fmtMonitorRtt(p95)}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Most common status</span><strong className="mon-analysis-val">{commonStatusCode ?? "—"}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Current failure streak</span><strong className={monitor.consecutive_failures > 0 ? "mon-analysis-val mon-analysis-val--warn" : "mon-analysis-val"}>{monitor.consecutive_failures}</strong></div>
              </div>
            </section>

            <section className="mon-hero-section">
              <div className="mon-hero-section-title">Endpoint configuration</div>
              <div className="mon-analysis-body">
                <div className="mon-analysis-row"><span className="dash-panel-meta">Request method</span><strong className="mon-analysis-val">{monitor.http_method}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Accepted status</span><strong className="mon-analysis-val">{monitor.accepted_status_codes}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Check interval</span><strong className="mon-analysis-val">{monitor.check_interval_seconds}s</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Request timeout</span><strong className="mon-analysis-val">{monitor.timeout_seconds}s</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Retries before down</span><strong className="mon-analysis-val">{monitor.max_retries}</strong></div>
                {monitor.max_retries > 0 && <div className="mon-analysis-row"><span className="dash-panel-meta">Retry interval</span><strong className="mon-analysis-val">{monitor.retry_interval_seconds}s</strong></div>}
                <div className="mon-analysis-row"><span className="dash-panel-meta">TLS verification</span><strong className="mon-analysis-val">{monitor.verify_tls ? "Enabled" : "Disabled"}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Redirects</span><strong className="mon-analysis-val">{monitor.follow_redirects ? `Up to ${monitor.max_redirects}` : "Disabled"}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Authentication</span><strong className="mon-analysis-val">{monitor.auth_type === "none" ? "None" : monitor.auth_type.toUpperCase()}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Response checks</span><strong className="mon-analysis-val">{[monitor.keyword ? "keyword" : "", monitor.json_path ? "JSON" : ""].filter(Boolean).join(" + ") || "Status only"}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Cache busting</span><strong className="mon-analysis-val">{monitor.cache_bust ? "Enabled" : "Disabled"}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Inverted result</span><strong className="mon-analysis-val">{monitor.upside_down ? "Enabled" : "Disabled"}</strong></div>
              </div>
            </section>

            <section className="mon-hero-section">
              <div className="mon-hero-section-title">TLS certificate</div>
              <div className="mon-analysis-body">
                <div className="mon-analysis-row"><span className="dash-panel-meta">Expires</span><strong className="mon-analysis-val">{monitor.last_cert_expires_at ? new Date(monitor.last_cert_expires_at).toLocaleDateString() : "Not available"}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Days remaining</span><strong className={certDaysRemaining !== null && certDaysRemaining <= monitor.certificate_expiry_days ? "mon-analysis-val mon-analysis-val--warn" : "mon-analysis-val"}>{certDaysRemaining ?? "—"}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Expiry warning</span><strong className="mon-analysis-val">{monitor.certificate_expiry_alert ? `${monitor.certificate_expiry_days} days` : "Disabled"}</strong></div>
                <div className="mon-analysis-row"><span className="dash-panel-meta">Issuer</span><strong className="mon-analysis-val monitor-http-issuer">{monitor.last_cert_issuer ?? "—"}</strong></div>
              </div>
            </section>
          </div>

          <div className="mon-hero-col">
            <section className="mon-hero-section">
              <div className="mon-hero-section-title">
                Heartbeat
                <span className="dash-panel-meta">latest 60 checks</span>
              </div>
              <div className="mon-heartbeat-body">
                {historyLoading ? (
                  <p className="dash-empty">Loading history…</p>
                ) : history.length === 0 ? (
                  <p className="dash-empty">No checks recorded yet.</p>
                ) : (
                  <div className="heartbeat-bar heartbeat-bar--lg monitor-http-heartbeat">
                    {history.slice(-60).map((point) => (
                      <span
                        key={point.id}
                        className="heartbeat-beat"
                        style={{ background: point.status === "online" ? "var(--nm-success)" : "var(--nm-danger)" }}
                        title={`${new Date(point.checked_at).toLocaleString()} — ${point.status}${point.status_code !== null ? ` — HTTP ${point.status_code}` : ""}${point.response_time_ms !== null ? ` — ${point.response_time_ms.toFixed(0)} ms` : ""}${point.error ? ` — ${point.error}` : ""}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="mon-hero-section">
              <div className="mon-hero-section-title">
                Recent HTTP checks
                <span className="dash-panel-meta">{history.length} loaded</span>
              </div>
              <div className="monitor-http-history">
                {history.slice(-15).reverse().map((point) => (
                  <div key={point.id} className="monitor-http-history-row">
                    <span className={`mon-dot mon-dot-${point.status}`} />
                    <span className="monitor-http-history-time">{new Date(point.checked_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="monitor-http-code">{point.status_code === null ? "No response" : `HTTP ${point.status_code}`}</span>
                    <span className="nm-table-num">{fmtMonitorRtt(point.response_time_ms)}</span>
                    <span className="monitor-http-history-error">{point.error ?? point.assertion_detail ?? (point.response_size_bytes !== null ? `${(point.response_size_bytes / 1024).toFixed(1)} KiB` : "")}</span>
                  </div>
                ))}
                {!historyLoading && history.length === 0 && <p className="dash-empty">No HTTP checks recorded yet.</p>}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import "./exports.css";
import { Database, Download, FileText, History, ShieldCheck, TableProperties } from "lucide-react";
import { api, type DownloadResult, type ExportSummary, type User } from "../../api/client";
import { useToast } from "../../components/Toast";
import { triggerDownload } from "../../utils/download";
import { userHasPermission } from "../../utils/permissions";
import { PanelSkeleton } from "../../components/Skeleton";

function ExportPanelHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="exports-panel-header nm-app-panel-header">
      <span className="exports-panel-identity">
        <span className="exports-panel-icon">{icon}</span><h2>{title}</h2>
      </span>
    </div>
  );
}

const EMPTY_FIREWALL_FILTERS = {
  q: "", src_ip: "", dst_ip: "", action: "", protocol: "", interface: "", limit: "5000",
};

export function ExportsWorkspace({ accessToken, user }: { accessToken: string; user: User }) {
  const toast = useToast();
  const canExportInventory = userHasPermission(user, "inventory_export");
  const canExportFirewall = userHasPermission(user, "firewall_export");
  const canExportReport = userHasPermission(user, "report_export");
  const hasStack = canExportInventory || canExportReport;
  const [firewallFormat, setFirewallFormat] = useState<"csv" | "json">("csv");
  const [inventoryFormat, setInventoryFormat] = useState<"csv" | "json">("csv");
  const [firewallFilters, setFirewallFilters] = useState(EMPTY_FIREWALL_FILTERS);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);

  const refreshSummary = useCallback(() => {
    api.getExportSummary(accessToken).then((data) => { setSummary(data); setSummaryFailed(false); }).catch(() => setSummaryFailed(true));
  }, [accessToken]);

  useEffect(() => refreshSummary(), [refreshSummary]);

  async function runDownload(key: string, action: () => Promise<DownloadResult>) {
    setBusyKey(key);
    setError(null);
    try {
      const result = await action();
      triggerDownload(result);
      toast.success(`Downloaded ${result.filename}`);
      refreshSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusyKey(null);
    }
  }

  const activeFirewallFilters = Object.entries(firewallFilters)
    .filter(([key, value]) => key !== "limit" && value.trim()).length;

  return (
    <section className="exports-layout">
      {error && <div className="form-error">{error}</div>}

      <div className="exports-workspace-grid">
        <div className={`exports-console-grid${hasStack && canExportFirewall ? "" : " exports-console-grid--single"}`}>
          {hasStack && <div className="exports-stack">
            {canExportInventory && <section className="exports-panel nm-app-panel">
              <ExportPanelHeader icon={<Database size={18} />} title="Device Inventory" />
              <div className="exports-panel-body">
                <p className="exports-panel-copy">Download the current inventory with device identity, addressing, status and assignment fields.</p>
                <div className="exports-format-callout">
                  <span className="exports-format-icon"><TableProperties size={18} /></span>
                  <span><strong>{inventoryFormat.toUpperCase()} inventory</strong><small>{inventoryFormat === "csv" ? "Best for spreadsheets and bulk review" : "Best for scripts, integrations and archival"}</small></span>
                </div>
                <label className="nm-field">Format
                  <select className="nm-select" disabled={!canExportInventory} value={inventoryFormat} onChange={(event) => setInventoryFormat(event.target.value as "csv" | "json")}>
                    <option value="csv">CSV — Spreadsheet compatible</option>
                    <option value="json">JSON — Structured data</option>
                  </select>
                </label>
                <div className="exports-panel-actions">
                  <button type="button" className="nm-btn nm-btn--primary" disabled={!canExportInventory || busyKey === "inventory"} onClick={() => runDownload("inventory", () => api.downloadInventory(accessToken, inventoryFormat))}>
                    <Download size={15} />{busyKey === "inventory" ? "Preparing…" : "Download inventory"}
                  </button>
                </div>
              </div>
            </section>}

            {canExportReport && <section className="exports-panel nm-app-panel">
              <ExportPanelHeader icon={<FileText size={18} />} title="Network Report" />
              <div className="exports-panel-body">
                <p className="exports-panel-copy">Generate a presentation-ready report combining topology, inventory, subnet utilisation and blocked-traffic leaders.</p>
                <div className="exports-report-contents" aria-label="Report contents">
                  <span>Topology summary</span><span>Inventory snapshot</span><span>Subnet summary</span><span>Traffic leaders</span>
                </div>
                <div className="exports-panel-actions">
                  <button type="button" className="nm-btn nm-btn--primary" disabled={!canExportReport || busyKey === "report"} onClick={() => runDownload("report", () => api.downloadReport(accessToken))}>
                    <Download size={15} />{busyKey === "report" ? "Preparing…" : "Download PDF report"}
                  </button>
                </div>
              </div>
            </section>}
          </div>}

          {canExportFirewall && <section className="exports-panel exports-panel--firewall nm-app-panel">
            <ExportPanelHeader icon={<ShieldCheck size={18} />} title="Firewall Events" />
            <div className="exports-panel-body">
              <p className="exports-panel-copy">Export retained firewall events with optional query filters. Empty filters include all available events up to the selected limit.</p>
              <div className="exports-firewall-form">
                <label className="nm-field">Format
                  <select className="nm-select" disabled={!canExportFirewall} value={firewallFormat} onChange={(event) => setFirewallFormat(event.target.value as "csv" | "json")}>
                    <option value="csv">CSV — Spreadsheet compatible</option>
                    <option value="json">JSON — Structured data</option>
                  </select>
                </label>
                <label className="nm-field">Row limit
                  <input className="nm-input" min={1} max={10000} type="number" disabled={!canExportFirewall} value={firewallFilters.limit} onChange={(event) => setFirewallFilters((current) => ({ ...current, limit: event.target.value }))} />
                </label>
                <label className="nm-field exports-field--wide">Search raw logs and metadata
                  <input className="nm-input" placeholder="Rule, reason, address or raw text" disabled={!canExportFirewall} value={firewallFilters.q} onChange={(event) => setFirewallFilters((current) => ({ ...current, q: event.target.value }))} />
                </label>
                <label className="nm-field">Source IP
                  <input className="nm-input nm-input--mono" placeholder="Any source" disabled={!canExportFirewall} value={firewallFilters.src_ip} onChange={(event) => setFirewallFilters((current) => ({ ...current, src_ip: event.target.value }))} />
                </label>
                <label className="nm-field">Destination IP
                  <input className="nm-input nm-input--mono" placeholder="Any destination" disabled={!canExportFirewall} value={firewallFilters.dst_ip} onChange={(event) => setFirewallFilters((current) => ({ ...current, dst_ip: event.target.value }))} />
                </label>
                <label className="nm-field">Action
                  <input className="nm-input" placeholder="e.g. block or pass" disabled={!canExportFirewall} value={firewallFilters.action} onChange={(event) => setFirewallFilters((current) => ({ ...current, action: event.target.value }))} />
                </label>
                <label className="nm-field">Protocol
                  <input className="nm-input" placeholder="e.g. tcp or udp" disabled={!canExportFirewall} value={firewallFilters.protocol} onChange={(event) => setFirewallFilters((current) => ({ ...current, protocol: event.target.value }))} />
                </label>
                <label className="nm-field exports-field--wide">Interface
                  <input className="nm-input" placeholder="e.g. wan" disabled={!canExportFirewall} value={firewallFilters.interface} onChange={(event) => setFirewallFilters((current) => ({ ...current, interface: event.target.value }))} />
                </label>
              </div>
              <div className="exports-filter-summary"><span>{activeFirewallFilters} active filters</span><span>Up to {(Number(firewallFilters.limit) || 5000).toLocaleString()} rows</span></div>
              <div className="exports-panel-actions exports-panel-actions--split">
                <button type="button" className="nm-btn nm-btn--secondary" disabled={!canExportFirewall} onClick={() => setFirewallFilters(EMPTY_FIREWALL_FILTERS)}>Clear filters</button>
                <button type="button" className="nm-btn nm-btn--primary" disabled={!canExportFirewall || busyKey === "firewall"} onClick={() => runDownload("firewall", () => api.downloadFirewallExport(accessToken, { format: firewallFormat, q: firewallFilters.q, src_ip: firewallFilters.src_ip, dst_ip: firewallFilters.dst_ip, action: firewallFilters.action, protocol: firewallFilters.protocol, interface: firewallFilters.interface, limit: Number(firewallFilters.limit) || 5000 }))}>
                  <Download size={15} />{busyKey === "firewall" ? "Preparing…" : "Download firewall export"}
                </button>
              </div>
            </div>
          </section>}
        </div>
        <aside className="exports-context" aria-label="Export information">
          <section className="exports-panel nm-app-panel">
            <ExportPanelHeader icon={<History size={18} />} title="Export Activity" />
            <div className="exports-panel-body exports-activity">
              {!summary && !summaryFailed ? <PanelSkeleton lines={3} /> : summaryFailed && !summary ? (
                <div className="nm-alert nm-alert--error" role="alert">Export activity is unavailable. <button type="button" className="nm-btn nm-btn--sm" onClick={refreshSummary}>Retry</button></div>
              ) : summary && <>
                <div className="exports-activity-metric">
                  <span className="exports-activity-symbol" aria-hidden="true"><Download size={28} /></span>
                  <div><strong className="exports-activity-value">{summary.exports_last_30_days.toLocaleString()}</strong><span className="nm-panel-meta">Your downloads in 30 days</span></div>
                </div>
                <dl className="exports-availability" aria-label="Available export data">
                  {canExportInventory && <div><dt><Database size={15} aria-hidden="true" />Inventory rows</dt><dd>{summary.inventory_rows?.toLocaleString() ?? "—"}</dd></div>}
                  {canExportFirewall && <div><dt><ShieldCheck size={15} aria-hidden="true" />Firewall events</dt><dd>{summary.firewall_events?.toLocaleString() ?? "—"}</dd></div>}
                </dl>
                <div className="exports-last-download">
                  <span className="nm-panel-meta">Latest download</span>
                  <strong>{summary.last_export_type ?? "No downloads yet"}</strong>
                  {summary.last_export_at && <time className="nm-panel-meta" dateTime={summary.last_export_at}>{new Date(summary.last_export_at).toLocaleString()}</time>}
                </div>
                {summaryFailed && <p className="nm-panel-meta" role="status">Activity could not refresh. <button type="button" className="nm-btn nm-btn--sm" onClick={refreshSummary}>Retry</button></p>}
              </>}
            </div>
          </section>
          <section className="exports-panel nm-app-panel">
            <ExportPanelHeader icon={<FileText size={18} />} title="Choose a Format" />
            <div className="exports-panel-body exports-format-guide">
              {(canExportInventory || canExportFirewall) && <>
                <div><span className="nm-chip">CSV</span><p className="nm-panel-meta">Open in a spreadsheet to sort, filter and review rows.</p></div>
                <div><span className="nm-chip">JSON</span><p className="nm-panel-meta">Keep structured fields for scripts and integrations.</p></div>
              </>}
              {canExportReport && <div><span className="nm-chip">PDF</span><p className="nm-panel-meta">Share a network snapshot with topology, inventory and subnet summaries.</p></div>}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

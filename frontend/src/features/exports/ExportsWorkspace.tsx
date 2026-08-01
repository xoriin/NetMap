import { useCallback, useEffect, useState, type ReactNode } from "react";
import "./exports.css";
import { CalendarClock, Database, Download, FileText, History, ShieldCheck, TableProperties } from "lucide-react";
import { api, type DownloadResult, type ExportSummary, type User } from "../../api/client";
import { useToast } from "../../components/Toast";
import { triggerDownload } from "../../utils/download";
import { formatEventTime } from "../../utils/format";

function ExportPanelHeader({ icon, title, allowed }: { icon: ReactNode; title: string; allowed: boolean }) {
  return (
    <div className="exports-panel-header nm-app-panel-header">
      <span className="exports-panel-identity">
        <span className="exports-panel-icon">{icon}</span><span aria-hidden="true">-</span><strong>{title}</strong>
      </span>
      <span className={`tool-badge ${allowed ? "active" : "locked"}`}>{allowed ? "Allowed" : "Restricted"}</span>
    </div>
  );
}

const EMPTY_FIREWALL_FILTERS = {
  q: "", src_ip: "", dst_ip: "", action: "", protocol: "", interface: "", limit: "5000",
};

export function ExportsWorkspace({ accessToken, user }: { accessToken: string; user: User }) {
  const toast = useToast();
  const canExportInventory = user.role === "SuperAdmin" || user.role === "NetworkAdmin";
  const canExportFirewall = canExportInventory || user.role === "SecurityAnalyst";
  const [firewallFormat, setFirewallFormat] = useState<"csv" | "json">("csv");
  const [inventoryFormat, setInventoryFormat] = useState<"csv" | "json">("csv");
  const [firewallFilters, setFirewallFilters] = useState(EMPTY_FIREWALL_FILTERS);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);

  const refreshSummary = useCallback(() => {
    api.getExportSummary(accessToken).then(setSummary).catch(() => { /* non-critical */ });
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

      <div className="exports-summary-grid nm-summary-band" aria-label="Export activity summary">
        <div className="exports-summary-card nm-app-panel">
          <span className="exports-summary-icon"><Database size={19} /></span>
          <span><small>Inventory rows</small><strong>{summary?.inventory_rows?.toLocaleString() ?? "—"}</strong><em>{summary?.inventory_rows == null && summary ? "Restricted for this role" : "Available in the next export"}</em></span>
        </div>
        <div className="exports-summary-card nm-app-panel is-data">
          <span className="exports-summary-icon is-data"><ShieldCheck size={19} /></span>
          <span><small>Firewall events</small><strong>{summary?.firewall_events?.toLocaleString() ?? "—"}</strong><em>{summary?.firewall_events == null && summary ? "Restricted for this role" : "Retained events available"}</em></span>
        </div>
        <div className="exports-summary-card nm-app-panel is-json">
          <span className="exports-summary-icon is-json"><History size={19} /></span>
          <span><small>Exports in 30 days</small><strong>{summary?.exports_last_30_days.toLocaleString() ?? "—"}</strong><em>Your completed downloads</em></span>
        </div>
        <div className="exports-summary-card nm-app-panel is-report">
          <span className="exports-summary-icon is-report"><CalendarClock size={19} /></span>
          <span><small>Last export</small><strong className="exports-summary-last">{summary?.last_export_type ?? "None yet"}</strong><em>{summary?.last_export_at ? formatEventTime(summary.last_export_at) : "No recorded exports"}</em></span>
        </div>
      </div>

      <div className="exports-console-grid">
        <div className="exports-stack">
          <section className="exports-panel nm-app-panel">
            <ExportPanelHeader icon={<Database size={18} />} title="Device inventory" allowed={canExportInventory} />
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
              {!canExportInventory && <p className="exports-permission-note">Only NetworkAdmin and SuperAdmin can export inventory data.</p>}
              <div className="exports-panel-actions">
                <button type="button" className="nm-btn nm-btn--primary" disabled={!canExportInventory || busyKey === "inventory"} onClick={() => runDownload("inventory", () => api.downloadInventory(accessToken, inventoryFormat))}>
                  <Download size={15} />{busyKey === "inventory" ? "Preparing…" : "Download inventory"}
                </button>
              </div>
            </div>
          </section>

          <section className="exports-panel nm-app-panel">
            <ExportPanelHeader icon={<FileText size={18} />} title="Network report" allowed={canExportInventory} />
            <div className="exports-panel-body">
              <p className="exports-panel-copy">Generate a presentation-ready report combining topology, inventory, subnet utilisation and blocked-traffic leaders.</p>
              <div className="exports-report-contents" aria-label="Report contents">
                <span>Topology summary</span><span>Inventory snapshot</span><span>Subnet summary</span><span>Traffic leaders</span>
              </div>
              {!canExportInventory && <p className="exports-permission-note">Only NetworkAdmin and SuperAdmin can generate reports.</p>}
              <div className="exports-panel-actions">
                <button type="button" className="nm-btn nm-btn--primary" disabled={!canExportInventory || busyKey === "report"} onClick={() => runDownload("report", () => api.downloadReport(accessToken))}>
                  <Download size={15} />{busyKey === "report" ? "Preparing…" : "Download PDF report"}
                </button>
              </div>
            </div>
          </section>
        </div>

        <section className="exports-panel exports-panel--firewall nm-app-panel">
          <ExportPanelHeader icon={<ShieldCheck size={18} />} title="Firewall events" allowed={canExportFirewall} />
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
            {!canExportFirewall && <p className="exports-permission-note">Your role cannot export firewall data.</p>}
            <div className="exports-filter-summary"><span>{activeFirewallFilters} active filters</span><span>Up to {(Number(firewallFilters.limit) || 5000).toLocaleString()} rows</span></div>
            <div className="exports-panel-actions exports-panel-actions--split">
              <button type="button" className="nm-btn nm-btn--secondary" disabled={!canExportFirewall} onClick={() => setFirewallFilters(EMPTY_FIREWALL_FILTERS)}>Clear filters</button>
              <button type="button" className="nm-btn nm-btn--primary" disabled={!canExportFirewall || busyKey === "firewall"} onClick={() => runDownload("firewall", () => api.downloadFirewallExport(accessToken, { format: firewallFormat, q: firewallFilters.q, src_ip: firewallFilters.src_ip, dst_ip: firewallFilters.dst_ip, action: firewallFilters.action, protocol: firewallFilters.protocol, interface: firewallFilters.interface, limit: Number(firewallFilters.limit) || 5000 }))}>
                <Download size={15} />{busyKey === "firewall" ? "Preparing…" : "Download firewall export"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

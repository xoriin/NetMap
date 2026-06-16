import { useState } from "react";
import { api, type DownloadResult, type User } from "../../api/client";
import { triggerDownload } from "../../utils/download";

export function ExportsWorkspace({
  accessToken,
  user,
}: {
  accessToken: string;
  user: User;
}) {
  const canExportInventory = user.role === "SuperAdmin" || user.role === "NetworkAdmin";
  const canExportFirewall =
    user.role === "SuperAdmin" || user.role === "NetworkAdmin" || user.role === "SecurityAnalyst";
  const [firewallFormat, setFirewallFormat] = useState<"csv" | "json">("csv");
  const [inventoryFormat, setInventoryFormat] = useState<"csv" | "json">("csv");
  const [firewallFilters, setFirewallFilters] = useState({
    q: "",
    src_ip: "",
    dst_ip: "",
    action: "",
    protocol: "",
    interface: "",
    limit: "5000",
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runDownload(key: string, action: () => Promise<DownloadResult>) {
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      triggerDownload(result);
      setMessage(`Downloaded ${result.filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="exports-layout">
      {error && <div className="form-error">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      <div className="tools-grid exports-grid">

        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Device Inventory</span>
            <span className={`tool-badge ${canExportInventory ? "active" : "locked"}`}>
              {canExportInventory ? "Allowed" : "Restricted"}
            </span>
          </div>
          <div className="dash-panel-body" style={{ padding: "14px 18px" }}>
            <div className="ipam-subnet-form">
              <div className="ipam-form-row">
                <label className="ipam-form-label">Format
                  <select className="ipam-form-input" disabled={!canExportInventory} value={inventoryFormat} onChange={(event) => setInventoryFormat(event.target.value as "csv" | "json")}>
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                  </select>
                </label>
              </div>
              {!canExportInventory && <p className="tool-note" style={{ margin: 0 }}>Only NetworkAdmin and SuperAdmin can export inventory data.</p>}
              <div className="ipam-form-actions">
                <button type="button" className="nm-btn nm-btn--primary" disabled={!canExportInventory || busyKey === "inventory"} onClick={() => runDownload("inventory", () => api.downloadInventory(accessToken, inventoryFormat))}>
                  {busyKey === "inventory" ? "Preparing…" : "Download inventory"}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Firewall Events</span>
            <span className={`tool-badge ${canExportFirewall ? "active" : "locked"}`}>
              {canExportFirewall ? "Allowed" : "Restricted"}
            </span>
          </div>
          <div className="dash-panel-body" style={{ padding: "14px 18px" }}>
            <div className="ipam-subnet-form">
              <div className="vlan-form-grid">
                <label className="ipam-form-label">Format
                  <select className="ipam-form-input" disabled={!canExportFirewall} value={firewallFormat} onChange={(event) => setFirewallFormat(event.target.value as "csv" | "json")}>
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                  </select>
                </label>
                <label className="ipam-form-label">Row limit
                  <input className="ipam-form-input" min={1} max={10000} type="number" disabled={!canExportFirewall} value={firewallFilters.limit} onChange={(event) => setFirewallFilters((current) => ({ ...current, limit: event.target.value }))} />
                </label>
                <label className="ipam-form-label">Search
                  <input className="ipam-form-input" disabled={!canExportFirewall} value={firewallFilters.q} onChange={(event) => setFirewallFilters((current) => ({ ...current, q: event.target.value }))} />
                </label>
                <label className="ipam-form-label">Source IP
                  <input className="ipam-form-input ipam-form-input--mono" disabled={!canExportFirewall} value={firewallFilters.src_ip} onChange={(event) => setFirewallFilters((current) => ({ ...current, src_ip: event.target.value }))} />
                </label>
                <label className="ipam-form-label">Destination IP
                  <input className="ipam-form-input ipam-form-input--mono" disabled={!canExportFirewall} value={firewallFilters.dst_ip} onChange={(event) => setFirewallFilters((current) => ({ ...current, dst_ip: event.target.value }))} />
                </label>
                <label className="ipam-form-label">Action
                  <input className="ipam-form-input" disabled={!canExportFirewall} value={firewallFilters.action} onChange={(event) => setFirewallFilters((current) => ({ ...current, action: event.target.value }))} />
                </label>
                <label className="ipam-form-label">Protocol
                  <input className="ipam-form-input" disabled={!canExportFirewall} value={firewallFilters.protocol} onChange={(event) => setFirewallFilters((current) => ({ ...current, protocol: event.target.value }))} />
                </label>
                <label className="ipam-form-label">Interface
                  <input className="ipam-form-input" disabled={!canExportFirewall} value={firewallFilters.interface} onChange={(event) => setFirewallFilters((current) => ({ ...current, interface: event.target.value }))} />
                </label>
              </div>
              {!canExportFirewall && <p className="tool-note" style={{ margin: 0 }}>Viewer cannot export firewall data.</p>}
              <div className="ipam-form-actions">
                <button type="button" className="nm-btn nm-btn--primary" disabled={!canExportFirewall || busyKey === "firewall"} onClick={() => runDownload("firewall", () => api.downloadFirewallExport(accessToken, { format: firewallFormat, q: firewallFilters.q, src_ip: firewallFilters.src_ip, dst_ip: firewallFilters.dst_ip, action: firewallFilters.action, protocol: firewallFilters.protocol, interface: firewallFilters.interface, limit: Number(firewallFilters.limit) || 5000 }))}>
                  {busyKey === "firewall" ? "Preparing…" : "Download firewall export"}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="dash-panel">
          <div className="dash-panel-header">
            <span className="dash-panel-title">Network Report</span>
            <span className={`tool-badge ${canExportInventory ? "active" : "locked"}`}>
              {canExportInventory ? "Allowed" : "Restricted"}
            </span>
          </div>
          <div className="dash-panel-body" style={{ padding: "14px 18px" }}>
            <div className="ipam-subnet-form">
              <p className="tool-note" style={{ margin: 0 }}>Generates a PDF with topology summary, inventory snapshot, subnet summary, and blocked traffic leaders.</p>
              {!canExportInventory && <p className="tool-note" style={{ margin: 0 }}>Only NetworkAdmin and SuperAdmin can generate reports.</p>}
              <div className="ipam-form-actions">
                <button type="button" className="nm-btn nm-btn--primary" disabled={!canExportInventory || busyKey === "report"} onClick={() => runDownload("report", () => api.downloadReport(accessToken))}>
                  {busyKey === "report" ? "Preparing…" : "Download PDF report"}
                </button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}

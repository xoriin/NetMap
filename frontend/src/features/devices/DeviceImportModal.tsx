import { useState } from "react";
import { Upload } from "lucide-react";
import { api } from "../../api/client";
import { type ImportRow } from "../../types";
import { parseImportFile, rowsToImportRows } from "../../utils/csv";
import { Modal } from "../../components/Modal";

export function DeviceImportModal({
  accessToken,
  onClose,
  onImported,
}: {
  accessToken: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number; errors: string[] } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const validRows = rows.filter((r) => r.ip_address && !r._rowError);
  const errorRows = rows.filter((r) => !r.ip_address || r._rowError);

  async function handleFile(file: File) {
    setParseError(null);
    setRows([]);
    setResult(null);
    setFileName(file.name);
    try {
      const raw = await parseImportFile(file);
      setRows(rowsToImportRows(raw));
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Failed to parse file");
    }
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  async function doImport() {
    if (!validRows.length) return;
    setBusy(true);
    try {
      const res = await api.importDevices(accessToken, validRows);
      setResult(res);
      onImported();
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  const footer = !result && fileName && rows.length > 0 ? (
    <>
      <button type="button" className="nm-btn" onClick={onClose}>
        Cancel
      </button>
      <button
        type="button"
        className="nm-btn nm-btn--primary"
        disabled={busy || validRows.length === 0}
        onClick={() => void doImport()}
      >
        {busy ? "Importing…" : `Import ${validRows.length} device${validRows.length !== 1 ? "s" : ""}`}
      </button>
    </>
  ) : result ? (
    <button type="button" className="nm-btn nm-btn--primary" onClick={onClose}>
      Done
    </button>
  ) : undefined;

  return (
    <Modal title="Import devices" onCancel={onClose} size="lg" bodyClassName="modal-body modal-body--flush" footer={footer}>
      <div className="import-modal-body">
        {!fileName && (
          <label
            className={`import-dropzone${dragOver ? " import-dropzone--over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <Upload size={28} style={{ opacity: 0.5 }} />
            <span className="import-dropzone-label">Drop a file here or click to browse</span>
            <span className="import-dropzone-hint">Supports CSV and JSON</span>
            <input type="file" accept=".csv,.json" style={{ display: "none" }} onChange={onFileInput} />
          </label>
        )}

        {fileName && !result && (
          <>
            <div className="import-file-row">
              <span className="import-file-name">{fileName}</span>
              <button type="button" className="nm-btn nm-btn--ghost" onClick={() => { setFileName(null); setRows([]); setParseError(null); }}>
                Change file
              </button>
            </div>

            {parseError && <p className="nm-alert nm-alert--error">{parseError}</p>}

            {rows.length > 0 && (
              <>
                <div className="import-summary-row">
                  <span className="import-summary-ok">{validRows.length} valid row{validRows.length !== 1 ? "s" : ""}</span>
                  {errorRows.length > 0 && (
                    <span className="import-summary-err">
                      {errorRows.length} row{errorRows.length !== 1 ? "s" : ""} with errors (will be skipped)
                    </span>
                  )}
                </div>

                <div className="import-preview-wrap">
                  <table className="mon-table import-preview-table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>IP address</th>
                        <th>Display name</th>
                        <th>Hostname</th>
                        <th>Vendor</th>
                        <th>Type</th>
                        <th>VLAN</th>
                        <th>Group</th>
                        <th>Tags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 50).map((row, i) => (
                        <tr key={i} className={`mon-row${row._rowError ? " import-row--error" : ""}`}>
                          <td>
                            {row._rowError
                              ? <span title={row._rowError} style={{ color: "var(--nm-danger)" }}>✕</span>
                              : <span style={{ color: "var(--nm-success)" }}>✓</span>}
                          </td>
                          <td className="mon-cell-mono">{row.ip_address || <em style={{ opacity: 0.5 }}>missing</em>}</td>
                          <td>{row.display_name ?? "—"}</td>
                          <td>{row.hostname ?? "—"}</td>
                          <td>{row.vendor ?? "—"}</td>
                          <td>{row.device_type ?? "—"}</td>
                          <td>{row.vlan_id ?? "—"}</td>
                          <td>{row.topology_group ?? "—"}</td>
                          <td>{row.tags?.join(", ") || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > 50 && <p className="import-truncate-note">Showing first 50 of {rows.length} rows.</p>}
                </div>
              </>
            )}
          </>
        )}

        {result && (
          <div className="import-result">
            <div className="import-result-stats">
              <span className="import-result-stat import-result-stat--ok">
                <strong>{result.created}</strong> created
              </span>
              <span className="import-result-stat import-result-stat--warn">
                <strong>{result.updated}</strong> updated
              </span>
              {result.errors.length > 0 && (
                <span className="import-result-stat import-result-stat--err">
                  <strong>{result.errors.length}</strong> errors
                </span>
              )}
            </div>
            {result.errors.length > 0 && (
              <ul className="import-result-errors">
                {result.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      <details className="import-field-ref">
        <summary>Supported column names</summary>
        <table className="import-ref-table">
          <thead><tr><th>Field</th><th>Accepted header names</th></tr></thead>
          <tbody>
            <tr><td>IP address <strong>*</strong></td><td>ip, ip_address, ip address</td></tr>
            <tr><td>Display name</td><td>display_name, display name, label, friendly name</td></tr>
            <tr><td>Hostname</td><td>hostname, host, name</td></tr>
            <tr><td>MAC address</td><td>mac, mac_address, mac address</td></tr>
            <tr><td>Vendor</td><td>vendor, manufacturer, make</td></tr>
            <tr><td>Device type</td><td>type, device_type, device type</td></tr>
            <tr><td>VLAN ID</td><td>vlan, vlan_id, vlan id</td></tr>
            <tr><td>Group</td><td>group, topology_group, site, location</td></tr>
            <tr><td>Notes</td><td>notes, description, note</td></tr>
            <tr><td>Tags</td><td>tags, tag, labels (comma-separated)</td></tr>
          </tbody>
        </table>
      </details>
    </Modal>
  );
}

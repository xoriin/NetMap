import { useState, useEffect, useRef, type FormEvent } from "react";
import {
  ApiError,
  type DiscoveryScan,
  type DiscoveryScanStatus,
  type DiscoveryScanType,
  type DiscoveryHost,
  type SnmpProfile,
  type TopologyGroup,
  type Site,
  api,
} from "../../api/client";
import { estimateScanTarget } from "../../utils/ip";
import { Modal } from "../../components/Modal";
import { ScanProgress } from "../../components/ScanProgress";

const proposedUpdateLabels: Record<string, string> = {
  ip_address: "IP address",
  hostname: "Hostname",
  mac_address: "MAC",
  vendor: "Vendor",
  os: "OS",
};

const scanTypeLabels: Record<string, string> = {
  ping: "Ping sweep, ports not scanned",
  basic_ports: "Basic port detection",
};

const scanStatusLabels: Record<string, string> = {
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Async scans: poll every 3s, then every 5s once a scan has run for a minute.
const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 5_000;
const POLL_SLOW_AFTER_MS = 60_000;

function isTerminalStatus(status: DiscoveryScanStatus | string) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Resolves after `ms`, or straight away when `signal` aborts. */
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Server timestamps carry a UTC offset; treat a bare one as UTC rather than local time. */
function parseServerTime(value: string | null | undefined) {
  if (!value) return Number.NaN;
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
}

export function DiscoveryModal({
  accessToken,
  canImport,
  onCancel,
  onImported,
}: {
  accessToken: string | null;
  canImport: boolean;
  onCancel: () => void;
  onImported: () => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [scanType, setScanType] = useState<DiscoveryScanType>("ping");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupBusy, setNewGroupBusy] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<string>("");
  const [sites, setSites] = useState<Site[]>([]);
  const [showNewSite, setShowNewSite] = useState(false);
  const [newSiteName, setNewSiteName] = useState("");
  const [newSiteBusy, setNewSiteBusy] = useState(false);
  const [confirmLargeScan, setConfirmLargeScan] = useState(false);
  const [snmpEnabled, setSnmpEnabled] = useState(false);
  const [snmpProfiles, setSnmpProfiles] = useState<SnmpProfile[]>([]);
  const [snmpProfileId, setSnmpProfileId] = useState("");
  const [snmpTargets, setSnmpTargets] = useState("");
  const [snmpCommunity, setSnmpCommunity] = useState("public");
  const [snmpPort, setSnmpPort] = useState("161");
  const [snmpTimeout, setSnmpTimeout] = useState("3");
  const [scan, setScan] = useState<DiscoveryScan | null>(null);
  // A queued/running async scan being polled; `scan` only holds finished scans.
  const [activeScan, setActiveScan] = useState<DiscoveryScan | null>(null);
  const [attached, setAttached] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const trackingRef = useRef<AbortController | null>(null);
  const [selectedIps, setSelectedIps] = useState<Set<string>>(new Set());
  const [importMode, setImportMode] = useState<"new_only" | "fill_missing" | "override_existing">("fill_missing");
  const [updateFields, setUpdateFields] = useState<Array<"hostname" | "mac_address" | "vendor" | "os">>(["hostname", "mac_address", "vendor", "os"]);
  const [updateIpOnMacMatch, setUpdateIpOnMacMatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetEstimate = estimateScanTarget(target);
  const requiresConfirmation = targetEstimate.hostCount > 256;
  const canStartScan = !busy && target.trim().length > 0 && (!requiresConfirmation || confirmLargeScan);
  const selectedGroup = groups.find((group) => String(group.id) === selectedGroupId) ?? null;

  // Closing the modal unmounts it: stop polling and drop any late responses.
  useEffect(() => () => trackingRef.current?.abort(), []);

  const activeScanId = activeScan?.id ?? null;
  useEffect(() => {
    if (activeScanId === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeScanId]);

  useEffect(() => {
    if (!accessToken) return;
    api.topologyGroups(accessToken).then(setGroups).catch(() => {});
    api.sites(accessToken).then(setSites).catch(() => {});
    api.listSnmpProfiles(accessToken).then(setSnmpProfiles).catch(() => {});
  }, [accessToken]);

  async function createNewGroup() {
    if (!accessToken || !newGroupName.trim()) return;
    setNewGroupBusy(true);
    try {
      const created = await api.createTopologyGroup(accessToken, {
        name: newGroupName.trim(),
        display_name: null,
        ip_range: null,
        description: null,
      });
      setGroups((prev) => [...prev, created]);
      setSelectedGroupId(String(created.id));
      setNewGroupName("");
      setShowNewGroup(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group");
    } finally {
      setNewGroupBusy(false);
    }
  }

  async function createNewSite() {
    if (!accessToken || !newSiteName.trim()) return;
    setNewSiteBusy(true);
    try {
      const created = await api.createSite(accessToken, {
        name: newSiteName.trim(),
        display_name: null,
        description: null,
        address: null,
        color: null,
      });
      setSites((prev) => [...prev, created]);
      setSelectedSiteId(String(created.id));
      setNewSiteName("");
      setShowNewSite(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create location");
    } finally {
      setNewSiteBusy(false);
    }
  }

  /**
   * Polls a queued/running scan until it finishes. Returns null when tracking
   * was abandoned (modal closed or a newer scan started); callers must not
   * touch state in that case.
   */
  async function followScan(token: string, scanId: number, initial: DiscoveryScan | null, signal: AbortSignal) {
    const followedAt = Date.now();
    let current = initial;
    while (!signal.aborted) {
      if (current && isTerminalStatus(current.status)) return current;
      if (current) setActiveScan(current);
      // With no record yet (attaching after a 409) fetch straight away.
      if (current) await wait(Date.now() - followedAt < POLL_SLOW_AFTER_MS ? POLL_FAST_MS : POLL_SLOW_MS, signal);
      if (signal.aborted) break;
      current = await api.getDiscoveryScan(token, scanId, signal);
    }
    return null;
  }

  function showFinishedScan(finished: DiscoveryScan) {
    if (finished.status === "cancelled") {
      setNotice(`Scan of ${finished.target} cancelled.`);
      return;
    }
    setScan(finished);
    setSelectedIps(new Set(finished.results.map((host) => host.ip_address)));
    if (finished.status === "failed") {
      setError(finished.error || "Scan failed");
    }
  }

  async function stopScan() {
    if (!accessToken || !activeScan) return;
    setStopping(true);
    try {
      setActiveScan(await api.cancelDiscoveryScan(accessToken, activeScan.id));
    } catch (err) {
      // 409: it finished first; polling shows the result.
      if (!(err instanceof ApiError && err.status === 409)) {
        setStopping(false);
        setError(err instanceof Error ? err.message : "Unable to stop the scan");
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!accessToken) {
      return;
    }
    trackingRef.current?.abort();
    const tracking = new AbortController();
    trackingRef.current = tracking;
    setBusy(true);
    setError(null);
    setNotice(null);
    setScan(null);
    setActiveScan(null);
    setAttached(false);
    try {
      let started: DiscoveryScan | null = null;
      let scanId: number;
      try {
        started = await api.startDiscoveryScan(accessToken, {
          target,
          scan_type: scanType,
          confirm_large_scan: confirmLargeScan,
          topology_group_id: selectedGroupId ? Number(selectedGroupId) : null,
          snmp_community: snmpEnabled && !snmpProfileId ? snmpCommunity : null,
          snmp_profile_id: snmpEnabled && snmpProfileId ? Number(snmpProfileId) : null,
          snmp_targets: snmpEnabled
            ? (snmpTargets.trim() || selectedGroup?.gateway || "").split(/[\s,]+/).map((value) => value.trim()).filter(Boolean)
            : [],
          snmp_port: Number(snmpPort),
          snmp_timeout_seconds: Number(snmpTimeout),
        });
        scanId = started.id;
      } catch (err) {
        // 409: a manual scan is already running. Follow that one instead.
        if (!(err instanceof ApiError && err.status === 409 && err.scanId !== null)) throw err;
        scanId = err.scanId;
        if (!tracking.signal.aborted) setAttached(true);
      }
      // The synchronous backend answers with a finished scan, which needs no polling.
      const finished = await followScan(accessToken, scanId, started, tracking.signal);
      if (finished) showFinishedScan(finished);
    } catch (err) {
      if (!tracking.signal.aborted) setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      if (!tracking.signal.aborted) {
        setBusy(false);
        setStopping(false);
        setActiveScan(null);
        setAttached(false);
        trackingRef.current = null;
      }
    }
  }

  async function importSelected() {
    if (!accessToken || !scan) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const resolvedGroupId = selectedGroupId ? Number(selectedGroupId) : null;
      const siteId = selectedSiteId ? Number(selectedSiteId) : null;
      await api.importDiscoveryResults(
        accessToken,
        scan.id,
        [...selectedIps],
        resolvedGroupId,
        siteId,
        importMode,
        updateFields,
        updateIpOnMacMatch,
      );
      await onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function updateAllChanged() {
    if (!accessToken || !scan) return;
    const changedIps = scan.results
      .filter((h) => h.import_status === "changed")
      .map((h) => h.ip_address);
    if (changedIps.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.importDiscoveryResults(
        accessToken,
        scan.id,
        changedIps,
        selectedGroupId ? Number(selectedGroupId) : null,
        selectedSiteId ? Number(selectedSiteId) : null,
        "fill_missing",
        ["hostname", "mac_address", "vendor", "os"],
        false,
      );
      await onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  function toggleHost(host: DiscoveryHost) {
    setSelectedIps((current) => {
      const next = new Set(current);
      if (next.has(host.ip_address)) {
        next.delete(host.ip_address);
      } else {
        next.add(host.ip_address);
      }
      return next;
    });
  }

  function toggleUpdateField(field: "hostname" | "mac_address" | "vendor" | "os") {
    setUpdateFields((current) =>
      current.includes(field) ? current.filter((value) => value !== field) : [...current, field],
    );
  }

  const scanCounts = scan?.results.reduce(
    (counts, host) => {
      counts[host.import_status] += 1;
      return counts;
    },
    { new: 0, existing: 0, changed: 0 },
  ) ?? { new: 0, existing: 0, changed: 0 };
  const activeScanStartedAt = activeScan ? parseServerTime(activeScan.started_at ?? activeScan.created_at) : Number.NaN;
  const activeScanElapsed = Number.isNaN(activeScanStartedAt) ? null : Math.max(0, Math.floor((now - activeScanStartedAt) / 1_000));
  return (
    <Modal title="Discover devices" onCancel={onCancel}>
      <form className="modal-form" onSubmit={(e) => void submit(e)}>
        <div className="scan-form-grid">
          <label>
            Target
            <input
              placeholder="192.168.1.0/24, 192.168.1.10, or 192.168.1.1-192.168.1.50"
              required
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
          <label>
            Scan type
            <select value={scanType} onChange={(event) => setScanType(event.target.value as DiscoveryScanType)}>
              <option value="ping">Host discovery (ping sweep)</option>
              <option value="basic_ports">Basic port detection</option>
            </select>
            <span className="dash-panel-meta">
              {scanType === "ping"
                ? "Finds online hosts and resolves available hostnames; it does not scan ports."
                : "Finds hosts and scans their 20 most common TCP ports."}
            </span>
          </label>
          <div className="scan-group-row">
            <label className="scan-group-select-label">
              Assign to VLAN / group
              <select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)}>
                <option value="">— None (unassigned) —</option>
                {groups.map((g) => (
                  <option key={g.id} value={String(g.id)}>{g.display_name || g.name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="nm-btn nm-btn--sm"
              title="Create a new VLAN / group"
              onClick={() => { setShowNewGroup((v) => !v); setNewGroupName(""); }}
            >
              {showNewGroup ? "✕" : "+ New"}
            </button>
          </div>
          {showNewGroup && (
            <div className="scan-new-group-row">
              <input
                placeholder="Group name (e.g. Lab-VLAN-10)"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createNewGroup(); } }}
              />
              <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={!newGroupName.trim() || newGroupBusy} onClick={() => void createNewGroup()}>
                {newGroupBusy ? "Creating…" : "Create"}
              </button>
            </div>
          )}
          <div className="scan-group-row">
            <label className="scan-group-select-label">
              Assign to location
              <select value={selectedSiteId} onChange={(e) => setSelectedSiteId(e.target.value)}>
                <option value="">— None (unassigned) —</option>
                {sites.map((s) => (
                  <option key={s.id} value={String(s.id)}>{s.display_name ?? s.name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="nm-btn nm-btn--sm"
              title="Create a new location"
              onClick={() => { setShowNewSite((v) => !v); setNewSiteName(""); }}
            >
              {showNewSite ? "✕" : "+ New"}
            </button>
          </div>
          {showNewSite && (
            <div className="scan-new-group-row">
              <input
                placeholder="Location name (e.g. London HQ)"
                value={newSiteName}
                onChange={(e) => setNewSiteName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createNewSite(); } }}
              />
              <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={!newSiteName.trim() || newSiteBusy} onClick={() => void createNewSite()}>
                {newSiteBusy ? "Creating…" : "Create"}
              </button>
            </div>
          )}
          <div className="scan-snmp-toggle-row">
            <button
              type="button"
              className={`nm-btn nm-btn--sm${snmpEnabled ? " nm-btn--active" : ""}`}
              aria-pressed={snmpEnabled}
              onClick={() => setSnmpEnabled((current) => !current)}
            >
              {snmpEnabled ? "SNMP enrichment on" : "SNMP enrichment"}
            </button>
            <span className="dash-panel-meta">
              {snmpEnabled
                ? "MAC and vendor data will be pulled from router ARP tables"
                : "Optional — fill MAC/vendor from an L3 device after the scan"}
            </span>
          </div>
          {snmpEnabled && (
            <div className="scan-snmp-panel">
              <p className="scan-snmp-intro">
                Query a router or L3 switch SNMP ARP table to enrich discovered hosts with MAC addresses and vendors.
              </p>
              <label>
                SNMP profile
                <select value={snmpProfileId} onChange={(event) => setSnmpProfileId(event.target.value)}>
                  <option value="">Manual community</option>
                  {snmpProfiles.map((profile) => (
                    <option key={profile.id} value={String(profile.id)}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                SNMP router / L3 switch IPs
                <input
                  placeholder={selectedGroup?.gateway ? `Using VLAN gateway ${selectedGroup.gateway} if left blank` : "192.168.1.1, 192.168.1.254"}
                  value={snmpTargets}
                  onChange={(event) => setSnmpTargets(event.target.value)}
                />
              </label>
              {selectedGroup?.gateway && (
                <span className="tool-note" style={{ margin: 0 }}>
                  Leave blank to use the selected VLAN/group gateway: {selectedGroup.gateway}
                </span>
              )}
              <div className="tool-form-grid">
                {!snmpProfileId && <label>
                  Community
                  <input required={snmpEnabled} value={snmpCommunity} onChange={(event) => setSnmpCommunity(event.target.value)} />
                </label>}
                {!snmpProfileId && <label>
                  Port
                  <input min={1} max={65535} required={snmpEnabled} type="number" value={snmpPort} onChange={(event) => setSnmpPort(event.target.value)} />
                </label>}
                {!snmpProfileId && <label>
                  Timeout
                  <input min={1} max={15} required={snmpEnabled} type="number" value={snmpTimeout} onChange={(event) => setSnmpTimeout(event.target.value)} />
                </label>}
              </div>
            </div>
          )}
        </div>
        <div className="scan-target-info">
          <span className={requiresConfirmation ? "scan-target-label warning" : "scan-target-label"}>
            {targetEstimate.label}
          </span>
          <span className="scan-target-help">{targetEstimate.help}</span>
          {requiresConfirmation && (
            <label className="scan-confirm-check">
              <input
                checked={confirmLargeScan}
                type="checkbox"
                onChange={(event) => setConfirmLargeScan(event.target.checked)}
              />
              Confirm large scan
            </label>
          )}
        </div>
        {busy && (activeScan ? (
          <ScanProgress
            scanType={activeScan.scan_type}
            status={activeScan.status}
            progress={activeScan.progress}
            elapsedSeconds={activeScanElapsed}
            note={attached ? `A scan of ${activeScan.target} was already running, so this shows its progress instead of starting another.` : null}
          />
        ) : <ScanProgress scanType={scanType} />)}
        {error && <div className="nm-alert nm-alert--error">{error}</div>}
        {notice && <div className="nm-alert nm-alert--info" role="status">{notice}</div>}
        <div className="modal-actions modal-actions--plain">
          {busy && activeScan && (
            <button type="button" className="nm-btn nm-btn--danger" disabled={stopping} onClick={() => void stopScan()}>
              {stopping ? "Stopping..." : "Stop scan"}
            </button>
          )}
          <button type="button" className="nm-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="nm-btn nm-btn--primary" disabled={!canStartScan}>
            {busy ? "Scanning..." : "Start scan"}
          </button>
        </div>
      </form>
      {scan && (
        <div className="scan-results">
          <div className="scan-summary">
            <div className="scan-summary-count">
              <strong>{scan.result_count}</strong>
              <span>{scan.result_count === 1 ? "host found" : "hosts found"}</span>
            </div>
            <span className="scan-summary-counts">
              {scanCounts.new} new · {scanCounts.changed} to update · {scanCounts.existing} known
            </span>
            <span className="scan-summary-meta">
              {scan.host_count} addresses scanned · {scanTypeLabels[scan.scan_type] ?? scan.scan_type} · {scanStatusLabels[scan.status] ?? scan.status}
            </span>
          </div>
          {scan.results.length === 0 ? (
            <div className="empty-results">No hosts responded to this scan.</div>
          ) : (
            <>
              <div className="scan-table">
                <div className="scan-table-header">
                  <span />
                  <span>IP address</span>
                  <span>Hostname</span>
                  <span>Vendor / MAC</span>
                  <span>{scan.scan_type === "ping" ? "Status" : "Status / ports"}</span>
                </div>
                {scan.results.map((host) => (
                  <label key={host.ip_address} className="scan-row">
                    <input
                      checked={selectedIps.has(host.ip_address)}
                      type="checkbox"
                      onChange={() => toggleHost(host)}
                    />
                    <span className="scan-cell">{host.ip_address}</span>
                    <span className="scan-cell">
                      {host.hostname || <span className="scan-cell-empty">—</span>}
                      {host.os && <span className="scan-cell-sub">{host.os}</span>}
                    </span>
                    <span className="scan-cell">
                      {host.vendor || host.mac_address || <span className="scan-cell-empty">—</span>}
                      {host.vendor && host.mac_address && <span className="scan-cell-sub">{host.mac_address}</span>}
                    </span>
                    <span className="scan-cell">
                      <strong>
                        {host.import_status === "new" ? "New" : host.import_status === "changed" ? "Update available" : "Known"}
                      </strong>
                      {host.proposed_updates.length > 0 && (
                        <span className="scan-cell-sub">{host.proposed_updates.map((field) => proposedUpdateLabels[field] ?? field).join(", ")}</span>
                      )}
                      {scan.scan_type !== "ping" && (
                        <span className="scan-cell-sub">
                          {host.open_ports.length ? `Open ${host.open_ports.join(", ")}` : "No open ports"}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              {canImport && <div className="scan-target-info">
                <label>
                  Existing devices
                  <select value={importMode} onChange={(event) => setImportMode(event.target.value as typeof importMode)}>
                    <option value="new_only">Import new devices only</option>
                    <option value="fill_missing">Fill missing fields only</option>
                    <option value="override_existing">Override selected existing fields</option>
                  </select>
                </label>
                <div className="scan-confirm-check" style={{ alignItems: "flex-start" }}>
                  <span className="dash-panel-meta">Fields</span>
                  <label>
                    <input
                      checked={updateIpOnMacMatch}
                      disabled={importMode === "new_only"}
                      type="checkbox"
                      onChange={(event) => setUpdateIpOnMacMatch(event.target.checked)}
                    />
                    Update IP when MAC matches
                  </label>
                  <label>
                    <input
                      checked={updateFields.includes("hostname")}
                      disabled={importMode === "new_only"}
                      type="checkbox"
                      onChange={() => toggleUpdateField("hostname")}
                    />
                    Hostname
                  </label>
                  <label>
                    <input
                      checked={updateFields.includes("mac_address")}
                      disabled={importMode === "new_only"}
                      type="checkbox"
                      onChange={() => toggleUpdateField("mac_address")}
                    />
                    MAC
                  </label>
                  <label>
                    <input
                      checked={updateFields.includes("vendor")}
                      disabled={importMode === "new_only"}
                      type="checkbox"
                      onChange={() => toggleUpdateField("vendor")}
                    />
                    Vendor
                  </label>
                  <label>
                    <input
                      checked={updateFields.includes("os")}
                      disabled={importMode === "new_only"}
                      type="checkbox"
                      onChange={() => toggleUpdateField("os")}
                    />
                    OS
                  </label>
                </div>
              </div>}
              {canImport ? <div className="modal-actions modal-actions--plain scan-import-actions">
                <button type="button" className="nm-btn nm-btn--primary" disabled={busy || selectedIps.size === 0} onClick={() => void importSelected()}>
                  Import selected
                </button>
                {scanCounts.changed > 0 && (
                  <button type="button" className="nm-btn" disabled={busy} onClick={() => void updateAllChanged()}>
                    Update {scanCounts.changed} existing
                  </button>
                )}
              </div> : <div className="tool-note">You can review these results. Importing or updating inventory also requires Edit inventory &amp; topology.</div>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

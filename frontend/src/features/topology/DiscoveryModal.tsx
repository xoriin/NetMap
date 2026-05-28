import { useState, useEffect, type FormEvent } from "react";
import {
  type DiscoveryScan,
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

export function DiscoveryModal({
  accessToken,
  onCancel,
  onImported,
}: {
  accessToken: string | null;
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
  const [selectedIps, setSelectedIps] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetEstimate = estimateScanTarget(target);
  const requiresConfirmation = targetEstimate.hostCount > 256;
  const canStartScan = !busy && target.trim().length > 0 && (!requiresConfirmation || confirmLargeScan);
  const selectedGroup = groups.find((group) => String(group.id) === selectedGroupId) ?? null;

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!accessToken) {
      return;
    }
    setBusy(true);
    setError(null);
    setScan(null);
    try {
      const nextScan = await api.startDiscoveryScan(accessToken, {
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
      setScan(nextScan);
      setSelectedIps(new Set(nextScan.results.map((host) => host.ip_address)));
      if (nextScan.status === "failed") {
        setError(nextScan.error || "Scan failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setBusy(false);
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
      await api.importDiscoveryResults(accessToken, scan.id, [...selectedIps], resolvedGroupId, siteId);
      await onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
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

  return (
    <Modal title="Discover devices" onCancel={onCancel}>
      <form className="modal-form" onSubmit={(e) => void submit(e)}>
        <div className="scan-form-grid">
          <label>
            Target
            <input
              placeholder="10.30.30.0/24, 10.30.30.10, or 10.30.30.1-10.30.30.50"
              required
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </label>
          <label>
            Scan type
            <select value={scanType} onChange={(event) => setScanType(event.target.value as DiscoveryScanType)}>
              <option value="ping">Ping sweep</option>
              <option value="basic_ports">Basic port detection</option>
            </select>
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
              className="toolbar-btn"
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
              <button type="button" className="ipam-btn ipam-btn--primary" disabled={!newGroupName.trim() || newGroupBusy} onClick={() => void createNewGroup()}>
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
              className="toolbar-btn"
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
              <button type="button" className="ipam-btn ipam-btn--primary" disabled={!newSiteName.trim() || newSiteBusy} onClick={() => void createNewSite()}>
                {newSiteBusy ? "Creating…" : "Create"}
              </button>
            </div>
          )}
          <label className="scan-confirm-check">
            <input
              checked={snmpEnabled}
              type="checkbox"
              onChange={(event) => setSnmpEnabled(event.target.checked)}
            />
            Enrich MAC/vendor from SNMP ARP table
          </label>
          {snmpEnabled && (
            <>
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
                  placeholder={selectedGroup?.gateway ? `Using VLAN gateway ${selectedGroup.gateway} if left blank` : "192.168.1.1, 10.30.20.1"}
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
            </>
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
        {busy && <ScanProgress scanType={scanType} />}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="ipam-btn" onClick={onCancel}>
            Close
          </button>
          <button type="submit" className="ipam-btn ipam-btn--primary" disabled={!canStartScan}>
            {busy ? "Scanning..." : "Start scan"}
          </button>
        </div>
      </form>
      {scan && (
        <div className="scan-results">
          <div className="scan-summary">
            <strong>{scan.result_count}</strong>
            <span>
              hosts found from {scan.host_count} target addresses · {scan.scan_type} · {scan.status}
            </span>
          </div>
          {scan.results.length === 0 ? (
            <div className="empty-results">No hosts responded to this scan.</div>
          ) : (
            <>
              <div className="scan-table-header">
                <span />
                <span>IP address</span>
                <span>Hostname</span>
                <span>MAC / vendor</span>
                <span>Ports</span>
              </div>
              <div className="scan-table">
                {scan.results.map((host) => (
                  <label key={host.ip_address} className="scan-row">
                    <input
                      checked={selectedIps.has(host.ip_address)}
                      type="checkbox"
                      onChange={() => toggleHost(host)}
                    />
                    <span>{host.ip_address}</span>
                    <span>{host.hostname || "No hostname"}</span>
                    <span>{host.vendor || host.mac_address || "No MAC/vendor"}</span>
                    <span>{host.open_ports.length ? host.open_ports.join(", ") : "No open ports"}</span>
                  </label>
                ))}
              </div>
              <div className="modal-actions scan-import-actions">
                <button type="button" className="ipam-btn ipam-btn--primary" disabled={busy || selectedIps.size === 0} onClick={() => void importSelected()}>
                  Import selected
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

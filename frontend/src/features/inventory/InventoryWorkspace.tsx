import { useState, useEffect, useMemo, useContext } from "react";
import { ObservationsAlert } from "../../components/ObservationsAlert";
import { Search, Star, ChevronUp, ChevronDown } from "lucide-react";
import { IconServer, IconWifi, IconWifiOff, IconTopologyRing } from "@tabler/icons-react";
import {
  api,
  type Device, type DevicePayload, type DeviceStatus, type DeviceLiveStatus,
  type TopologyGraph, type TopologyGroup, type Site, type DeviceIcon,
  type DeviceSecurityEventSummary, type SnmpProfile,
} from "../../api/client";
import { deviceTypeOptions } from "../../constants";
import { deviceTypeIconMap, iconLabel } from "../../icons";
import { compareGroupLabels } from "../../utils/sort";
import { deviceLabel, statusColor, formatDeviceTypeLabel } from "../../utils/format";
import { ipSortKey } from "../../utils/ip";
import { compareDevices } from "../../utils/sort";
import { TopbarNoteCtx } from "../../context";
import { DashStat } from "../../components/DashStat";
import { DeviceTypeIcon } from "../../components/DeviceTypeIcon";
import { DeviceDetails } from "../devices/DeviceDetails";
import { DeviceForm } from "../devices/DeviceForm";
import { DiscoveryModal } from "../topology/DiscoveryModal";
import { DeviceImportModal } from "../devices/DeviceImportModal";

export function InventoryWorkspace({
  accessToken,
  canViewSecurity,
  canWrite,
  favouriteIds,
  graph,
  livePingEnabled,
  onDeviceChange,
  onDevicesRemove,
  onGraphChange,
  onObservationActioned,
  onToggleFavourite,
  openObservationCount,
}: {
  accessToken: string;
  canViewSecurity: boolean;
  canWrite: boolean;
  favouriteIds: Set<number>;
  graph: TopologyGraph;
  livePingEnabled: boolean;
  onDeviceChange: (device: Device) => void;
  onDevicesRemove: (deviceIds: number[]) => void;
  onGraphChange: () => Promise<void>;
  onObservationActioned?: () => void;
  onToggleFavourite: (deviceId: number) => void;
  openObservationCount?: number;
}) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(graph.devices[0]?.id ?? null);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<number>>(new Set());
  const [selectedGroupFilter, setSelectedGroupFilter] = useState('all');
  const [selectedSiteFilter, setSelectedSiteFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [favouriteFilter, setFavouriteFilter] = useState(false);
  const [bulkGroupId, setBulkGroupId] = useState('');
  const [bulkDeviceType, setBulkDeviceType] = useState('');
  const [bulkSiteId, setBulkSiteId] = useState('');
  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [snmpProfiles, setSnmpProfiles] = useState<SnmpProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventorySortKey, setInventorySortKey] = useState<string>("device");
  const [inventorySortDir, setInventorySortDir] = useState<"asc" | "desc">("asc");
  const [inventorySearch, setInventorySearch] = useState("");
  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [deviceSecuritySummary, setDeviceSecuritySummary] = useState<DeviceSecurityEventSummary | null>(null);
  const [deviceSecurityLoading, setDeviceSecurityLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => {
    const saved = window.localStorage.getItem("netmap.inventory.pageSize");
    return saved ? Math.max(1, Number(saved)) : 10;
  });

  const selectedDevice = graph.devices.find((device) => device.id === selectedDeviceId) ?? null;
  const groupOptions = useMemo(
    () => [...new Set(graph.devices.map((device) => device.topology_group))].filter(Boolean).sort(compareGroupLabels),
    [graph.devices],
  );
  const liveStatusByDeviceId = useMemo<Map<number, DeviceLiveStatus>>(() => new Map(graph.devices.map((device) => {
    const status = device.status === "disabled" ? "disabled" : (device.monitor_status ?? device.status);
    return [device.id, {
      device_id: device.id,
      status,
      latency_ms: null,
      last_checked_at: device.last_monitored_at ?? device.updated_at,
      error: null,
    } satisfies DeviceLiveStatus];
  })), [graph.devices]);
  const filteredDevices = useMemo(() => {
    let devs = selectedGroupFilter === 'all' ? graph.devices : graph.devices.filter((d) => d.topology_group === selectedGroupFilter);
    if (selectedSiteFilter === 'unassigned') {
      devs = devs.filter((d) => d.site_id === null);
    } else if (selectedSiteFilter !== 'all') {
      const siteId = Number(selectedSiteFilter);
      devs = devs.filter((d) => d.site_id === siteId);
    }
    if (statusFilter !== 'all') {
      devs = devs.filter((d) => {
        const live = liveStatusByDeviceId.get(d.id);
        const s = d.status === 'disabled' ? 'disabled' : (live?.status ?? d.monitor_status ?? d.status);
        return s === statusFilter;
      });
    }
    if (favouriteFilter) {
      devs = devs.filter((d) => favouriteIds.has(d.id));
    }
    if (inventorySearch.trim()) {
      const q = inventorySearch.trim().toLowerCase();
      devs = devs.filter((d) =>
        d.display_name?.toLowerCase().includes(q) ||
        d.hostname?.toLowerCase().includes(q) ||
        d.ip_address?.toLowerCase().includes(q) ||
        d.topology_group?.toLowerCase().includes(q) ||
        d.device_type?.toLowerCase().includes(q)
      );
    }
    return devs;
  }, [graph.devices, selectedGroupFilter, selectedSiteFilter, statusFilter, favouriteFilter, favouriteIds, inventorySearch, liveStatusByDeviceId]);

  const sortedDevices = useMemo(() => {
    return filteredDevices.slice().sort((a, b) => {
      const dir = inventorySortDir === "asc" ? 1 : -1;
      let cmp = 0;
      switch (inventorySortKey) {
        case "device": cmp = deviceLabel(a).toLowerCase().localeCompare(deviceLabel(b).toLowerCase()); break;
        case "ip":     cmp = ipSortKey(a.ip_address).localeCompare(ipSortKey(b.ip_address)); break;
        case "type":   cmp = (a.device_type ?? "").toLowerCase().localeCompare((b.device_type ?? "").toLowerCase()); break;
        case "status": {
          const sa = liveStatusByDeviceId.get(a.id)?.status ?? a.status;
          const sb = liveStatusByDeviceId.get(b.id)?.status ?? b.status;
          cmp = sa.localeCompare(sb);
          break;
        }
        case "latency": {
          const la = liveStatusByDeviceId.get(a.id)?.latency_ms ?? Infinity;
          const lb = liveStatusByDeviceId.get(b.id)?.latency_ms ?? Infinity;
          cmp = la - lb;
          break;
        }
        case "group":    cmp = (a.topology_group ?? "").toLowerCase().localeCompare((b.topology_group ?? "").toLowerCase()); break;
        case "location": {
          const sl = (id: number | null) => { const s = sites.find((x) => x.id === id); return (s?.display_name ?? s?.name ?? "").toLowerCase(); };
          cmp = sl(a.site_id).localeCompare(sl(b.site_id));
          break;
        }
        default: cmp = compareDevices(a, b);
      }
      return cmp * dir;
    });
  }, [filteredDevices, inventorySortKey, inventorySortDir, liveStatusByDeviceId, sites]);

  const paginatedDevices = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedDevices.slice(start, start + pageSize);
  }, [sortedDevices, currentPage, pageSize]);

  useEffect(() => {
    setCurrentPage(1);
  }, [filteredDevices, pageSize]);

  useEffect(() => {
    window.localStorage.setItem("netmap.inventory.pageSize", String(pageSize));
  }, [pageSize]);

  useEffect(() => {
    let cancelled = false;
    async function loadGroups() {
      try {
        const rows = await api.topologyGroups(accessToken);
        if (!cancelled) setGroups(rows);
      } catch {
        // inventory remains functional without group metadata
      }
    }
    async function loadSites() {
      try {
        const rows = await api.sites(accessToken);
        if (!cancelled) setSites(rows);
      } catch {
        // inventory remains functional without site metadata
      }
    }
    async function loadSnmpProfiles() {
      try {
        const rows = await api.listSnmpProfiles(accessToken);
        if (!cancelled) setSnmpProfiles(rows);
      } catch {
        // SNMP controls remain optional
      }
    }
    void loadGroups();
    void loadSites();
    void loadSnmpProfiles();
    return () => {
      cancelled = true;
    };
  }, [accessToken, graph.devices]);

  useEffect(() => {
    if ((!selectedDeviceId || !graph.devices.some((device) => device.id === selectedDeviceId)) && graph.devices.length > 0) {
      setSelectedDeviceId(graph.devices[0].id);
    }
  }, [graph.devices, selectedDeviceId]);

  useEffect(() => {
    setSelectedDeviceIds((current) => new Set([...current].filter((id) => graph.devices.some((device) => device.id === id))));
  }, [graph.devices]);

  useEffect(() => {
    if (!canViewSecurity || !accessToken || !selectedDevice) {
      setDeviceSecuritySummary(null);
      setDeviceSecurityLoading(false);
      return;
    }
    const deviceId = selectedDevice.id;
    let cancelled = false;
    async function loadDeviceSummary() {
      setDeviceSecurityLoading(true);
      try {
        const summary = await api.deviceSecurityEvents(accessToken, deviceId, {
          window_hours: 24,
          limit: 8,
        });
        if (!cancelled) {
          setDeviceSecuritySummary(summary);
        }
      } catch (err) {
        if (!cancelled) {
          setDeviceSecuritySummary(null);
          setInventoryError(err instanceof Error ? err.message : "Unable to load device security activity");
        }
      } finally {
        if (!cancelled) {
          setDeviceSecurityLoading(false);
        }
      }
    }
    void loadDeviceSummary();
    return () => {
      cancelled = true;
    };
  }, [accessToken, canViewSecurity, selectedDevice]);

  async function applyBulkActions() {
    if (!canWrite || selectedDeviceIds.size === 0) return;
    const patch: Parameters<typeof api.updateDevice>[2] = {};
    if (bulkGroupId === '0') patch.topology_group_id = null;
    else if (bulkGroupId) patch.topology_group_id = Number(bulkGroupId);
    if (bulkDeviceType) {
      patch.device_type = bulkDeviceType;
      patch.icon = (deviceTypeIconMap[bulkDeviceType] || "device") as DeviceIcon;
    }
    if (bulkSiteId === 'unassign') patch.site_id = null;
    else if (bulkSiteId) patch.site_id = Number(bulkSiteId);
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    setInventoryError(null);
    try {
      const updatedDevices = await Promise.all([...selectedDeviceIds].map((id) => api.updateDevice(accessToken, id, patch)));
      updatedDevices.forEach(onDeviceChange);
      setSelectedDeviceIds(new Set());
      setBulkGroupId('');
      setBulkDeviceType('');
      setBulkSiteId('');
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to apply bulk actions');
    } finally {
      setBusy(false);
    }
  }

  function selectAllFiltered() {
    setSelectedDeviceIds(new Set(filteredDevices.map((device) => device.id)));
  }

  function clearSelection() {
    setSelectedDeviceIds(new Set());
  }

  function toggleSort(key: string) {
    if (inventorySortKey === key) {
      setInventorySortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setInventorySortKey(key);
      setInventorySortDir("asc");
    }
  }

  async function deleteSelected() {
    if (!canWrite || selectedDeviceIds.size === 0) {
      return;
    }
    if (!window.confirm(`Delete ${selectedDeviceIds.size} selected devices?`)) {
      return;
    }
    setBusy(true);
    setInventoryError(null);
    try {
      const deletedIds = [...selectedDeviceIds];
      await Promise.all(deletedIds.map((deviceId) => api.deleteDevice(accessToken, deviceId)));
      onDevicesRemove(deletedIds);
      setSelectedDeviceIds(new Set());
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to delete selected devices');
    } finally {
      setBusy(false);
    }
  }

  async function updateSelectedStatus(status: DeviceStatus) {
    if (!canWrite || selectedDeviceIds.size === 0) {
      return;
    }
    setBusy(true);
    setInventoryError(null);
    try {
      const updatedDevices = await Promise.all([...selectedDeviceIds].map((deviceId) => api.updateDevice(accessToken, deviceId, { status })));
      updatedDevices.forEach(onDeviceChange);
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to update selected devices');
    } finally {
      setBusy(false);
    }
  }

  async function updateDeviceGroup(deviceId: number, groupId: string) {
    if (!canWrite) {
      return;
    }
    setBusy(true);
    setInventoryError(null);
    try {
      const updated = await api.updateDevice(accessToken, deviceId, {
        topology_group_id: groupId ? Number(groupId) : null,
      });
      onDeviceChange(updated);
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : "Unable to update device group");
    } finally {
      setBusy(false);
    }
  }

  async function updateDeviceSite(deviceId: number, siteIdStr: string) {
    if (!canWrite) return;
    setBusy(true);
    setInventoryError(null);
    try {
      const updated = await api.updateDevice(accessToken, deviceId, { site_id: siteIdStr ? Number(siteIdStr) : null });
      onDeviceChange(updated);
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to update device location');
    } finally {
      setBusy(false);
    }
  }

  async function submitDeviceUpdate(deviceId: number, payload: DevicePayload) {
    setBusy(true);
    setInventoryError(null);
    try {
      const updated = await api.updateDevice(accessToken, deviceId, payload);
      onDeviceChange(updated);
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to save device');
    } finally {
      setBusy(false);
    }
  }

  function toggleFav(deviceId: number) {
    onToggleFavourite(deviceId);
  }

  async function submitNewDevice(payload: DevicePayload) {
    setBusy(true);
    setInventoryError(null);
    try {
      const created = await api.createDevice(accessToken, payload);
      onDeviceChange(created);
      setShowDeviceForm(false);
    } catch (err) {
      setInventoryError(err instanceof Error ? err.message : 'Unable to create device');
    } finally {
      setBusy(false);
    }
  }

  const groupCount = new Set(graph.devices.map((d) => d.topology_group).filter(Boolean)).size;
  const invOnlineCount = graph.devices.filter((d) => d.status !== "disabled" && (d.monitor_status ?? d.status) === "online").length;
  const invOfflineCount = graph.devices.filter((d) => d.status !== "disabled" && (d.monitor_status ?? d.status) === "offline").length;

  const selectedDeviceLive = selectedDevice && livePingEnabled ? (liveStatusByDeviceId.get(selectedDevice.id) ?? null) : null;
  const setTopbarNote = useContext(TopbarNoteCtx);

  useEffect(() => {
    setTopbarNote(
      <span className={`app-topbar-status${livePingEnabled ? "" : " app-topbar-status--paused"}`}>
        <span aria-hidden="true" />{livePingEnabled ? "Live" : "Paused"}
      </span>,
    );
  }, [livePingEnabled, setTopbarNote]);

  useEffect(() => () => setTopbarNote(""), [setTopbarNote]);

  return (
    <section className="topology-layout inventory-layout">
      <div className="dash-stats inventory-stats">
        <DashStat label="Devices" value={graph.devices.length} sub="in inventory" icon={<IconServer size={20} />} accent="teal" />
        <DashStat label="Online" value={invOnlineCount} sub="reachable" icon={<IconWifi size={20} />} accent="green" />
        <DashStat label="Offline" value={invOfflineCount} sub={invOfflineCount > 0 ? "need attention" : "all clear"} icon={<IconWifiOff size={20} />} accent={invOfflineCount > 0 ? "red" : "green"} />
        <DashStat label="Groups" value={groupCount} sub="topology segments" icon={<IconTopologyRing size={20} />} accent="purple" />
      </div>

      <ObservationsAlert
        accessToken={accessToken}
        openObservationCount={openObservationCount}
        onObservationActioned={onObservationActioned}
      />

      {inventoryError && <div className="form-error">{inventoryError}</div>}
      {/* ── Table + details panel ──────────────────────────────────────── */}
      <div className={selectedDevice ? "topology-content details-open" : "topology-content"}>
        <div className="inventory-surface">
          <div className="inventory-panel-header">
            <span className="inv-panel-title">
              Devices
              {filteredDevices.length !== graph.devices.length
                ? ` (${filteredDevices.length} of ${graph.devices.length})`
                : ` (${graph.devices.length})`}
            </span>
            <select className="inv-select" value={selectedGroupFilter} onChange={(e) => setSelectedGroupFilter(e.target.value)}>
              <option value="all">All groups</option>
              {groupOptions.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <select className="inv-select" value={selectedSiteFilter} onChange={(e) => setSelectedSiteFilter(e.target.value)}>
              <option value="all">All sites</option>
              <option value="unassigned">Unassigned</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.display_name ?? s.name}</option>)}
            </select>
            <select
              className="inv-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | "online" | "offline" | "warning" | "disabled")}
            >
              <option value="all">All statuses</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="warning">Warning</option>
              <option value="disabled">Disabled</option>
            </select>
            <button
              type="button"
              className={`inv-status-tab inv-fav-filter${favouriteFilter ? " active" : ""}`}
              onClick={() => setFavouriteFilter((current) => !current)}
              title={favouriteFilter ? "Show all devices" : "Show favourites only"}
            >
              <Star size={13} fill={favouriteFilter ? "currentColor" : "none"} />
              Favs
            </button>
            {canWrite && (
              <>
                <span className="inv-sep" />
                <details className="inv-bulk-menu">
                  <summary className="nm-btn">
                    {selectedDeviceIds.size > 0 ? `${selectedDeviceIds.size} selected` : "Bulk"}
                    <ChevronDown size={13} />
                  </summary>
                  <div className="inv-bulk-menu-panel">
                    <div className="inv-bulk-selection">
                      <button
                        type="button"
                        className="inv-status-tab inv-status-tab--muted"
                        disabled={filteredDevices.length === 0}
                        onClick={selectAllFiltered}
                      >
                        Select all ({filteredDevices.length})
                      </button>
                      <button
                        type="button"
                        className="inv-status-tab inv-status-tab--muted"
                        disabled={selectedDeviceIds.size === 0}
                        onClick={clearSelection}
                      >
                        Clear selection
                      </button>
                    </div>
                    <div className="inv-bulk-menu-grid">
                      <label>
                        VLAN / Group
                        <select className="inv-select" value={bulkGroupId} onChange={(e) => setBulkGroupId(e.target.value)}>
                          <option value="">No change</option>
                          <option value="0">Clear group</option>
                          {groups.map((g) => <option key={g.id} value={String(g.id)}>{g.display_name || g.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Device type
                        <select className="inv-select" value={bulkDeviceType} onChange={(e) => setBulkDeviceType(e.target.value)}>
                          <option value="">No change</option>
                          {deviceTypeOptions.map((t) => <option key={t} value={t}>{formatDeviceTypeLabel(t)}</option>)}
                        </select>
                      </label>
                      <label>
                        Location
                        <select className="inv-select" value={bulkSiteId} onChange={(e) => setBulkSiteId(e.target.value)}>
                          <option value="">No change</option>
                          <option value="unassign">Clear location</option>
                          {sites.map((s) => <option key={s.id} value={String(s.id)}>{s.display_name ?? s.name}</option>)}
                        </select>
                      </label>
                    </div>
                    <div className="inv-bulk-menu-actions">
                      <button type="button" className="inv-status-tab" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void applyBulkActions()}>
                        Apply changes
                      </button>
                      <button type="button" className="inv-status-tab" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void updateSelectedStatus("online")}>
                        Enable
                      </button>
                      <button type="button" className="inv-status-tab" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void updateSelectedStatus("disabled")}>
                        Disable
                      </button>
                      <button type="button" className="inv-status-tab inv-status-tab--danger" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void deleteSelected()}>
                        Delete
                      </button>
                    </div>
                  </div>
                </details>
                <span className="inv-sep" />
                <button type="button" className="nm-btn nm-btn--primary" onClick={() => setShowDeviceForm(true)}>
                  + Device
                </button>
                <button type="button" className="nm-btn" onClick={() => setShowScanModal(true)}>
                  Scan
                </button>
                <button type="button" className="nm-btn" onClick={() => setShowImportModal(true)}>
                  Import
                </button>
              </>
            )}
            <div className="inv-search-box nm-search">
              <Search size={14} className="nm-search-icon" />
              <input
                className="nm-input"
                placeholder="Search devices…"
                value={inventorySearch}
                onChange={(e) => setInventorySearch(e.target.value)}
              />
            </div>
          </div>
          <div className="inventory-table">
            <div className="inventory-table-header">
              <span>Select</span>
              {["device", "ip", "type", "status", "latency", "group", "location"].map((key, i) => {
                const labels = ["Device", "IP", "Device Type", "Status", "Latency", "VLAN / Group", "Location"];
                const active = inventorySortKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`inventory-sort-btn${active ? " active" : ""}`}
                    onClick={() => toggleSort(key)}
                  >
                    {labels[i]}
                    {active && (inventorySortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                  </button>
                );
              })}
            </div>
            {filteredDevices.length === 0 ? (
              <div className="inventory-empty">No devices match the current filters.</div>
            ) : (
              paginatedDevices.map((device) => {
                const liveStatus = livePingEnabled ? (liveStatusByDeviceId.get(device.id) ?? null) : null;
                const status = device.status === 'disabled' ? 'disabled' : livePingEnabled ? (liveStatus?.status ?? device.monitor_status ?? device.status) : "paused";
                return (
                  <button key={device.id} className={device.id === selectedDeviceId ? 'inventory-row active' : 'inventory-row'} type="button" onClick={() => setSelectedDeviceId(device.id)}>
                    <span className="inventory-row-check">
                      <input
                        checked={selectedDeviceIds.has(device.id)}
                        type="checkbox"
                        onChange={(event) => {
                          event.stopPropagation();
                          setSelectedDeviceIds((current) => {
                            const next = new Set(current);
                            if (next.has(device.id)) { next.delete(device.id); } else { next.add(device.id); }
                            return next;
                          });
                        }}
                      />
                      <button
                        type="button"
                        className={`fav-btn${favouriteIds.has(device.id) ? " fav-btn--active" : ""}`}
                        title={favouriteIds.has(device.id) ? "Remove from favourites" : "Add to favourites"}
                        onClick={(event) => { event.stopPropagation(); toggleFav(device.id); }}
                      >
                        <Star size={13} fill={favouriteIds.has(device.id) ? "currentColor" : "none"} />
                      </button>
                    </span>
                    <span className="inventory-row-device">
                      <span className={`status-dot status-dot--sm ${status}`} />
                      <span>{deviceLabel(device)}</span>
                    </span>
                    <span>{device.ip_address || '—'}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <DeviceTypeIcon type={device.device_type} size={13} />
                      {device.device_type ? formatDeviceTypeLabel(device.device_type) : iconLabel(device.icon)}
                    </span>
                    <span className={`status-pill ${status}`}>{status === "paused" ? "polling off" : status}</span>
                    <span>{livePingEnabled && liveStatus?.latency_ms != null ? `${liveStatus.latency_ms.toFixed(1)} ms` : '—'}</span>
                    <span>
                      {canWrite ? (
                        <select
                          className="inventory-group-select"
                          value={device.topology_group_id ? String(device.topology_group_id) : ""}
                          disabled={busy}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => { e.stopPropagation(); void updateDeviceGroup(device.id, e.target.value); }}
                        >
                          <option value="">Inferred</option>
                          {groups.map((g) => <option key={`rg-${device.id}-${g.id}`} value={g.id}>{g.display_name || g.name}</option>)}
                        </select>
                      ) : (device.topology_group || "—")}
                    </span>
                    <span>
                      {canWrite ? (
                        <select
                          className="inventory-group-select"
                          value={device.site_id ? String(device.site_id) : ""}
                          disabled={busy}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => { e.stopPropagation(); void updateDeviceSite(device.id, e.target.value); }}
                        >
                          <option value="">No location</option>
                          {sites.map((s) => <option key={`rs-${device.id}-${s.id}`} value={s.id}>{s.display_name ?? s.name}</option>)}
                        </select>
                      ) : ((() => { const s = sites.find((x) => x.id === device.site_id); return s ? (s.display_name ?? s.name) : "—"; })())}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {filteredDevices.length > 0 && (
            <div className="inv-pagination">
              <span className="inv-pagination-info">
                Showing {Math.min((currentPage - 1) * pageSize + 1, filteredDevices.length)}–{Math.min(currentPage * pageSize, filteredDevices.length)} of {filteredDevices.length} device{filteredDevices.length !== 1 ? "s" : ""}
              </span>
              <div className="inv-pagination-controls">
                <span style={{ fontSize: 11, opacity: 0.7 }}>Per page:</span>
                <select
                  className="inv-pagination-select"
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                >
                  {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button
                  type="button"
                  className="inv-pagination-btn"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => p - 1)}
                >
                  ‹ Prev
                </button>
                <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {currentPage} / {Math.max(1, Math.ceil(filteredDevices.length / pageSize))}
                </span>
                <button
                  type="button"
                  className="inv-pagination-btn"
                  disabled={currentPage >= Math.ceil(filteredDevices.length / pageSize)}
                  onClick={() => setCurrentPage((p) => p + 1)}
                >
                  Next ›
                </button>
              </div>
            </div>
          )}
        </div>

        {selectedDevice && (
          <aside className="details-panel">
            <DeviceDetails
              canViewSecurity={canViewSecurity}
              canWrite={canWrite}
              accessToken={accessToken}
              device={selectedDevice}
              disabled={busy}
              groups={groups}
              snmpProfiles={snmpProfiles}
              sites={sites}
              onGraphChange={onGraphChange}
              liveStatus={selectedDeviceLive}
              onSubmit={(payload) => submitDeviceUpdate(selectedDevice.id, payload)}
              securityLoading={deviceSecurityLoading}
              securitySummary={deviceSecuritySummary}
            />
          </aside>
        )}
      </div>

      {showDeviceForm && (
        <DeviceForm busy={busy} device={null} cloneSource={null} groups={groups} snmpProfiles={snmpProfiles} sites={sites}
          onCancel={() => setShowDeviceForm(false)} onSubmit={submitNewDevice} />
      )}
      {showScanModal && (
        <DiscoveryModal accessToken={accessToken} onCancel={() => setShowScanModal(false)}
          onImported={async () => { setShowScanModal(false); await onGraphChange(); }} />
      )}
      {showImportModal && (
        <DeviceImportModal accessToken={accessToken} onClose={() => setShowImportModal(false)}
          onImported={() => { void onGraphChange(); }} />
      )}
    </section>
  );
}

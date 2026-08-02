import { useState, useEffect, useMemo, useContext, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import "./inventory.css";
import { ObservationsAlert } from "../../components/ObservationsAlert";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { Search, Star, ChevronUp, ChevronDown, X } from "lucide-react";
import { IconServer, IconWifi, IconWifiOff, IconTopologyRing } from "@tabler/icons-react";
import {
  api,
  type Device, type DevicePayload, type DeviceStatus, type DeviceLiveStatus,
  type DeviceMonitorSummary,
  type TopologyGraph, type TopologyGroup, type Site, type DeviceIcon,
  type DeviceSecurityEventSummary, type SnmpProfile,
} from "../../api/client";
import { deviceTypeIconMap, iconLabel } from "../../icons";
import type { AppRoute } from "../../routes";
import { compareGroupLabels } from "../../utils/sort";
import { deviceLabel, statusColor, formatDeviceTypeLabel } from "../../utils/format";
import { isDeviceMonitoringPaused } from "../../utils/device";
import { deviceTypeChipFor, groupChipFor, siteChipFor, resolveEntityColor } from "../../utils/entityColor";
import { EntityChip, EntityChipEmpty } from "../../components/EntityChip";
import { SwatchSelect, type SwatchOption } from "../../components/SwatchSelect";
import {
  INV_COL_COUNT, INV_COL_WIDTHS_KEY, INV_MIN_COL_WIDTH,
  invGridTemplate, loadInvColWidths,
} from "../../utils/inventoryColumns";
import { ipSortKey } from "../../utils/ip";
import { compareDevices } from "../../utils/sort";
import { TopbarNoteCtx } from "../../context";
import { DashStat } from "../../components/DashStat";
import { DeviceTypeIcon } from "../../components/DeviceTypeIcon";
import { DeviceDetails } from "../devices/DeviceDetails";
import { DeviceForm } from "../devices/DeviceForm";
import { DiscoveryModal } from "../topology/DiscoveryModal";
import { DeviceImportModal } from "../devices/DeviceImportModal";
import { useDeviceTypes } from "../../hooks/useDeviceTypes";

const INVENTORY_PAGE_SIZE_KEY = "netmap.inventory.pageSize";
const INVENTORY_PAGE_SIZE_MIGRATION_KEY = "netmap.inventory.pageSizeDefault25";
type InventoryStatusFilter = "all" | "online" | "offline" | "warning" | "unknown" | "disabled" | "paused";

const INVENTORY_STATUS_FILTER_OPTIONS: SwatchOption[] = [
  { value: "all", label: "All statuses" },
  { value: "online", label: "Online", color: "#2d9d78" },
  { value: "offline", label: "Offline", color: "#d94b4b" },
  { value: "warning", label: "Warning", color: "#d4912c" },
  { value: "unknown", label: "Unknown", color: "#7a8fa0" },
  { value: "paused", label: "Paused", color: "#7a8fa0" },
  { value: "disabled", label: "Disabled", color: "#5d6b7a" },
];

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
  onNavigate,
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
  onNavigate?: (route: AppRoute) => void;
  onObservationActioned?: () => void;
  onToggleFavourite: (deviceId: number) => void;
  openObservationCount?: number;
}) {
  const confirmAction = useConfirm();
  const toast = useToast();
  const deviceTypesQuery = useDeviceTypes(accessToken);
  const deviceTypeOptions = deviceTypesQuery.options;
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<number>>(new Set());
  const [selectedGroupFilter, setSelectedGroupFilter] = useState('all');
  const [selectedSiteFilter, setSelectedSiteFilter] = useState('all');
  const [selectedTypeFilter, setSelectedTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<InventoryStatusFilter>("all");
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
  const [selectedMonitorSummary, setSelectedMonitorSummary] = useState<DeviceMonitorSummary | null>(null);
  const [monitorSummaryByDeviceId, setMonitorSummaryByDeviceId] = useState<Map<number, DeviceMonitorSummary>>(new Map());
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => {
    const saved = window.localStorage.getItem(INVENTORY_PAGE_SIZE_KEY);
    const migratedDefault = window.localStorage.getItem(INVENTORY_PAGE_SIZE_MIGRATION_KEY);
    if (saved === "10" && migratedDefault !== "true") {
      window.localStorage.setItem(INVENTORY_PAGE_SIZE_MIGRATION_KEY, "true");
      return 25;
    }
    return saved ? Math.max(1, Number(saved)) : 25;
  });

  const [colWidths, setColWidths] = useState<number[] | null>(loadInvColWidths);
  const headerRef = useRef<HTMLDivElement | null>(null);
  // A native <details> only closes via its own summary, so the bulk menu is
  // controlled to let an outside click or Escape dismiss it.
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const bulkMenuRef = useRef<HTMLDetailsElement | null>(null);

  const selectedDevice = graph.devices.find((device) => device.id === selectedDeviceId) ?? null;

  useEffect(() => {
    let cancelled = false;
    setSelectedMonitorSummary(null);
    if (selectedDeviceId === null) return () => { cancelled = true; };
    void api.getMonitoringDevice(accessToken, selectedDeviceId)
      .then((summary) => { if (!cancelled) setSelectedMonitorSummary(summary); })
      .catch(() => { if (!cancelled) setSelectedMonitorSummary(null); });
    return () => { cancelled = true; };
  }, [accessToken, selectedDeviceId]);

  useEffect(() => {
    let cancelled = false;
    async function loadMonitorSummaries() {
      try {
        const rows = await api.listMonitoringDevices(accessToken);
        if (!cancelled) setMonitorSummaryByDeviceId(new Map(rows.map((row) => [row.device_id, row])));
      } catch {
        // Retain the last RTT snapshot if monitoring is temporarily unavailable.
      }
    }
    void loadMonitorSummaries();
    const intervalId = window.setInterval(() => void loadMonitorSummaries(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessToken]);
  const groupOptions = useMemo(
    () => [...new Set(graph.devices.map((device) => device.topology_group))].filter(Boolean).sort(compareGroupLabels),
    [graph.devices],
  );
  useEffect(() => {
    if (!bulkMenuOpen) return;
    // The SwatchSelect popups render inside the <details>, so `contains` keeps
    // the menu open while a picker is being used.
    function onPointerDown(event: MouseEvent) {
      if (!bulkMenuRef.current?.contains(event.target as Node)) setBulkMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // A picker's list only exists while it is open; let Escape dismiss that
      // first rather than closing the whole menu out from under it. This must
      // run on the capture phase — React flushes the picker's state update
      // before a bubble-phase document listener runs, so by then the list has
      // already left the DOM and the guard would never fire.
      if (bulkMenuRef.current?.querySelector(".nm-swatch-list")) return;
      setBulkMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [bulkMenuOpen]);

  // A handle sits at the right edge of column colIdx and resizes that column
  // only. Widths are read from the DOM on the first drag so the flexible `fr`
  // columns freeze at exactly the width they were already rendering at.
  function startColResize(colIdx: number, event: ReactMouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const header = headerRef.current;
    const initialWidths: number[] = header
      ? Array.from(header.children)
          .slice(1, 1 + INV_COL_COUNT)
          .map((cell) => cell.getBoundingClientRect().width)
      : (colWidths ?? []);
    if (initialWidths.length !== INV_COL_COUNT) return;

    function onMove(moveEvent: MouseEvent) {
      const next = Math.max(INV_MIN_COL_WIDTH, initialWidths[colIdx] + (moveEvent.clientX - startX));
      const updated = [...initialWidths];
      updated[colIdx] = next;
      setColWidths(updated);
    }

    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setColWidths((previous) => {
        if (previous) window.localStorage.setItem(INV_COL_WIDTHS_KEY, JSON.stringify(previous));
        return previous;
      });
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Double-clicking any divider drops the saved widths entirely, returning the
  // table to the stylesheet's flexible default layout.
  function resetColWidths() {
    window.localStorage.removeItem(INV_COL_WIDTHS_KEY);
    setColWidths(null);
  }

  // Filter dropdowns carry the same swatch colours as the table chips.
  const groupFilterOptions = useMemo<SwatchOption[]>(
    () => [
      { value: "all", label: "All groups" },
      ...groupOptions.map((name) => {
        const group = groups.find((g) => g.name === name || g.display_name === name);
        return { value: name, label: name, color: resolveEntityColor(group?.color, group?.name ?? name) };
      }),
    ],
    [groupOptions, groups],
  );
  const siteFilterOptions = useMemo<SwatchOption[]>(
    () => [
      { value: "all", label: "All sites" },
      { value: "unassigned", label: "Unassigned" },
      ...sites.map((site) => ({
        value: String(site.id),
        label: site.display_name ?? site.name,
        color: resolveEntityColor(site.color, site.name),
      })),
    ],
    [sites],
  );
  // Bulk-edit menu: same marks as the table so a value is recognisable at a
  // glance. "No change"/"Clear …" stay neutral — they are not entities.
  const bulkGroupOptions = useMemo<SwatchOption[]>(
    () => [
      { value: "", label: "No change" },
      { value: "0", label: "Clear group" },
      ...groups.map((group) => ({
        value: String(group.id),
        label: group.display_name || group.name,
        color: resolveEntityColor(group.color, group.name),
      })),
    ],
    [groups],
  );
  const bulkSiteOptions = useMemo<SwatchOption[]>(
    () => [
      { value: "", label: "No change" },
      { value: "unassign", label: "Clear location" },
      ...sites.map((site) => ({
        value: String(site.id),
        label: site.display_name ?? site.name,
        color: resolveEntityColor(site.color, site.name),
      })),
    ],
    [sites],
  );
  const bulkDeviceTypeOptions = useMemo<SwatchOption[]>(
    () => [
      { value: "", label: "No change" },
      ...deviceTypeOptions.map((type) => ({
        value: type.value,
        label: type.label || formatDeviceTypeLabel(type.value),
        color: resolveEntityColor(type.color, type.value),
        icon: <DeviceTypeIcon type={type.value} size={13} />,
      })),
    ],
    [deviceTypeOptions],
  );
  // Only types actually in use — a filter offering all 17 built-ins when the
  // fleet has three of them is mostly dead options.
  const typeFilterOptions = useMemo<SwatchOption[]>(() => {
    const inUse = new Set(graph.devices.map((device) => device.device_type).filter(Boolean) as string[]);
    const hasUntyped = graph.devices.some((device) => !device.device_type);
    return [
      { value: "all", label: "All types" },
      ...(hasUntyped ? [{ value: "none", label: "No type" }] : []),
      ...deviceTypeOptions
        .filter((type) => inUse.has(type.value))
        .map((type) => ({
          value: type.value,
          label: type.label || formatDeviceTypeLabel(type.value),
          color: resolveEntityColor(type.color, type.value),
          icon: <DeviceTypeIcon type={type.value} size={13} />,
        })),
    ];
  }, [graph.devices, deviceTypeOptions]);
  // Retyping or deleting the last device of a type removes its option; without
  // this the filter would stay set and silently hide every row.
  useEffect(() => {
    if (selectedTypeFilter === "all") return;
    if (!typeFilterOptions.some((option) => option.value === selectedTypeFilter)) {
      setSelectedTypeFilter("all");
    }
  }, [typeFilterOptions, selectedTypeFilter]);

  const liveStatusByDeviceId = useMemo<Map<number, DeviceLiveStatus>>(() => new Map(graph.devices.map((device) => {
    const status = device.status === "disabled"
      ? "disabled"
      : isDeviceMonitoringPaused(device) || !livePingEnabled
      ? "paused"
      : (device.monitor_status ?? device.status);
    return [device.id, {
      device_id: device.id,
      status: status === "paused" ? "unknown" : status,
      latency_ms: null,
      last_checked_at: device.last_monitored_at ?? device.updated_at,
      error: null,
    } satisfies DeviceLiveStatus];
  })), [graph.devices, livePingEnabled]);
  const filteredDevices = useMemo(() => {
    let devs = selectedGroupFilter === 'all' ? graph.devices : graph.devices.filter((d) => d.topology_group === selectedGroupFilter);
    if (selectedSiteFilter === 'unassigned') {
      devs = devs.filter((d) => d.site_id === null);
    } else if (selectedSiteFilter !== 'all') {
      const siteId = Number(selectedSiteFilter);
      devs = devs.filter((d) => d.site_id === siteId);
    }
    if (selectedTypeFilter === 'none') {
      devs = devs.filter((d) => !d.device_type);
    } else if (selectedTypeFilter !== 'all') {
      devs = devs.filter((d) => d.device_type === selectedTypeFilter);
    }
    if (statusFilter !== 'all') {
      devs = devs.filter((d) => {
        const live = liveStatusByDeviceId.get(d.id);
        const s = d.status === "disabled"
          ? "disabled"
          : isDeviceMonitoringPaused(d) || !livePingEnabled
          ? "paused"
          : (live?.status ?? d.monitor_status ?? d.status);
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
  }, [graph.devices, selectedGroupFilter, selectedSiteFilter, selectedTypeFilter, statusFilter, favouriteFilter, favouriteIds, inventorySearch, liveStatusByDeviceId, livePingEnabled]);

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
          const la = monitorSummaryByDeviceId.get(a.id)?.avg_rtt_24h ?? Infinity;
          const lb = monitorSummaryByDeviceId.get(b.id)?.avg_rtt_24h ?? Infinity;
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
  }, [filteredDevices, inventorySortKey, inventorySortDir, liveStatusByDeviceId, monitorSummaryByDeviceId, sites]);

  const paginatedDevices = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedDevices.slice(start, start + pageSize);
  }, [sortedDevices, currentPage, pageSize]);

  useEffect(() => {
    setCurrentPage(1);
  }, [filteredDevices, pageSize]);

  useEffect(() => {
    window.localStorage.setItem(INVENTORY_PAGE_SIZE_KEY, String(pageSize));
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
    if (selectedDeviceId && !graph.devices.some((device) => device.id === selectedDeviceId)) {
      setSelectedDeviceId(null);
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
      patch.icon = (deviceTypeIconMap[bulkDeviceType] || deviceTypeOptions.find((option) => option.value === bulkDeviceType)?.icon || "device") as DeviceIcon;
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
    const count = selectedDeviceIds.size;
    const confirmed = await confirmAction({
      title: `Delete ${count} device${count === 1 ? "" : "s"}`,
      message: `This permanently deletes ${count} selected device${count === 1 ? "" : "s"} and their relationships.`,
      detail: "Monitoring history and topology links for these devices are removed.",
      confirmLabel: count === 1 ? "Delete device" : `Delete ${count} devices`,
      typeToConfirm: count >= 5 ? "delete" : undefined,
    });
    if (!confirmed) {
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

  async function submitDeviceUpdate(deviceId: number, payload: DevicePayload) {
    setBusy(true);
    setInventoryError(null);
    try {
      const updated = await api.updateDevice(accessToken, deviceId, payload);
      onDeviceChange(updated);
      toast.success("Device saved", { detail: deviceLabel(updated) });
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
      toast.success("Device added", { detail: deviceLabel(created) });
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
      <div className="dash-stats inventory-stats nm-summary-band">
        <DashStat
          label="Devices"
          value={graph.devices.length}
          sub="in inventory"
          icon={<IconServer size={20} />}
          accent="teal"
          onClick={() => setStatusFilter("all")}
        />
        <DashStat
          label="Online"
          value={invOnlineCount}
          sub="reachable"
          icon={<IconWifi size={20} />}
          accent="green"
          onClick={() => setStatusFilter((current) => current === "online" ? "all" : "online")}
          active={statusFilter === "online"}
        />
        <DashStat
          label="Offline"
          value={invOfflineCount}
          sub={invOfflineCount > 0 ? "need attention" : "all clear"}
          icon={<IconWifiOff size={20} />}
          accent={invOfflineCount > 0 ? "red" : "green"}
          onClick={() => setStatusFilter((current) => current === "offline" ? "all" : "offline")}
          active={statusFilter === "offline"}
        />
        <DashStat label="Groups" value={groupCount} sub="topology segments" icon={<IconTopologyRing size={20} />} accent="purple" />
      </div>

      <ObservationsAlert
        accessToken={accessToken}
        openObservationCount={openObservationCount}
        onObservationActioned={onObservationActioned}
        onNavigate={onNavigate}
      />

      {inventoryError && <div className="form-error">{inventoryError}</div>}
      {/* ── Purpose-built inventory table ─────────────────────────────── */}
      <div className={selectedDevice ? "topology-content details-open" : "topology-content"}>
        <div className="inventory-surface nm-app-panel">
          <div className="inventory-panel-header nm-app-panel-header">
            <span className="inv-panel-title">
              <span className="inv-panel-title-icon" aria-hidden="true"><IconServer size={17} /></span>
              <span>Devices</span>
              <span className="inv-panel-count">
                {filteredDevices.length !== graph.devices.length
                  ? `${filteredDevices.length} of ${graph.devices.length}`
                  : graph.devices.length}
              </span>
            </span>
            <SwatchSelect
              ariaLabel="Filter by VLAN / group"
              value={selectedGroupFilter}
              options={groupFilterOptions}
              onChange={setSelectedGroupFilter}
            />
            <SwatchSelect
              ariaLabel="Filter by location"
              value={selectedSiteFilter}
              options={siteFilterOptions}
              onChange={setSelectedSiteFilter}
            />
            <SwatchSelect
              ariaLabel="Filter by device type"
              value={selectedTypeFilter}
              options={typeFilterOptions}
              onChange={setSelectedTypeFilter}
            />
            <SwatchSelect
              ariaLabel="Filter by status"
              value={statusFilter}
              options={INVENTORY_STATUS_FILTER_OPTIONS}
              onChange={(value) => setStatusFilter(value as InventoryStatusFilter)}
            />
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
                <details
                  className="inv-bulk-menu"
                  ref={bulkMenuRef}
                  open={bulkMenuOpen}
                  onToggle={(event) => setBulkMenuOpen(event.currentTarget.open)}
                >
                  <summary className="nm-btn">
                    {selectedDeviceIds.size > 0 ? `${selectedDeviceIds.size} selected` : "Bulk"}
                    <ChevronDown size={13} />
                  </summary>
                  <div className="inv-bulk-menu-panel">
                    <div className="inv-bulk-selection">
                      <button
                        type="button"
                        className="nm-btn nm-btn--sm nm-btn--secondary"
                        disabled={filteredDevices.length === 0}
                        onClick={selectAllFiltered}
                      >
                        Select all ({filteredDevices.length})
                      </button>
                      <button
                        type="button"
                        className="nm-btn nm-btn--sm nm-btn--secondary"
                        disabled={selectedDeviceIds.size === 0}
                        onClick={clearSelection}
                      >
                        Clear selection
                      </button>
                    </div>
                    <div className="inv-bulk-menu-grid">
                      {/* Same swatches and icons as the table rows, so a value
                          is recognisable here without reading every label. */}
                      <div className="inv-bulk-menu-field">
                        <span>VLAN / Group</span>
                        <SwatchSelect
                          ariaLabel="Bulk set VLAN / group"
                          value={bulkGroupId}
                          options={bulkGroupOptions}
                          onChange={setBulkGroupId}
                        />
                      </div>
                      <div className="inv-bulk-menu-field">
                        <span>Device type</span>
                        <SwatchSelect
                          ariaLabel="Bulk set device type"
                          value={bulkDeviceType}
                          options={bulkDeviceTypeOptions}
                          onChange={setBulkDeviceType}
                        />
                      </div>
                      <div className="inv-bulk-menu-field">
                        <span>Location</span>
                        <SwatchSelect
                          ariaLabel="Bulk set location"
                          value={bulkSiteId}
                          options={bulkSiteOptions}
                          onChange={setBulkSiteId}
                        />
                      </div>
                    </div>
                    <div className="inv-bulk-menu-actions">
                      <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void applyBulkActions()}>
                        Apply changes
                      </button>
                      <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void updateSelectedStatus("online")}>
                        Enable
                      </button>
                      <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void updateSelectedStatus("disabled")}>
                        Disable
                      </button>
                      <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={busy || selectedDeviceIds.size === 0} onClick={() => void deleteSelected()}>
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
          <div
            className={`inventory-table${colWidths ? " inventory-table--fixed" : ""}`}
            style={colWidths ? ({ "--inv-grid-template": invGridTemplate(colWidths) } as CSSProperties) : undefined}
          >
            <div className="inventory-table-header" ref={headerRef}>
              <span>Select</span>
              {["device", "ip", "type", "status", "latency", "group", "location"].map((key, i) => {
                const labels = ["Device", "IP", "Device Type", "Status", "Latency", "VLAN / Group", "Location"];
                const active = inventorySortKey === key;
                return (
                  <span key={key} className="inventory-th">
                    <button
                      type="button"
                      className={`inventory-sort-btn${active ? " active" : ""}`}
                      onClick={() => toggleSort(key)}
                    >
                      {labels[i]}
                      {active && (inventorySortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                    </button>
                    {i < INV_COL_COUNT - 1 && (
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        className="inventory-col-resize-handle"
                        title="Drag to resize · double-click to reset all columns"
                        onMouseDown={(event) => startColResize(i, event)}
                        onDoubleClick={resetColWidths}
                      />
                    )}
                  </span>
                );
              })}
            </div>
            {filteredDevices.length === 0 ? (
              <div className="inventory-empty">No devices match the current filters.</div>
            ) : (
              paginatedDevices.map((device) => {
                const liveStatus = livePingEnabled ? (liveStatusByDeviceId.get(device.id) ?? null) : null;
                const monitorSummary = monitorSummaryByDeviceId.get(device.id);
                const status = device.status === "disabled"
                  ? "disabled"
                  : isDeviceMonitoringPaused(device) || !livePingEnabled
                  ? "paused"
                  : (liveStatus?.status ?? device.monitor_status ?? device.status);
                const groupChip = groupChipFor(device, groups);
                const siteChip = siteChipFor(device, sites);
                const typeChip = deviceTypeChipFor(device.device_type, deviceTypeOptions);
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
                    <span>
                      <EntityChip
                        label={device.device_type ? formatDeviceTypeLabel(device.device_type) : iconLabel(device.icon)}
                        color={typeChip?.color}
                        colorKey={typeChip?.key ?? device.device_type ?? device.icon}
                        icon={<DeviceTypeIcon type={device.device_type} size={13} />}
                      />
                    </span>
                    <span className={`status-pill ${status}`}>{status === "paused" ? "paused" : status}</span>
                    <span>{monitorSummary?.avg_rtt_24h != null ? `${monitorSummary.avg_rtt_24h.toFixed(1)} ms` : '—'}</span>
                    <span>
                      {groupChip ? (
                        <EntityChip label={groupChip.label} color={groupChip.color} colorKey={groupChip.key} />
                      ) : (
                        <EntityChipEmpty />
                      )}
                    </span>
                    <span>
                      {siteChip ? (
                        <EntityChip label={siteChip.label} color={siteChip.color} colorKey={siteChip.key} />
                      ) : (
                        <EntityChipEmpty />
                      )}
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
          <aside className="details-panel inventory-device-sidebar" aria-label="Device overview">
            <div className="inventory-device-sidebar-header">
              <span className="inventory-device-sidebar-title">
                <span className="inv-panel-title-icon" aria-hidden="true"><IconServer size={17} /></span>
                <span>Device overview</span>
              </span>
              <button
                type="button"
                className="nm-btn nm-btn--icon"
                aria-label="Close device overview"
                onClick={() => setSelectedDeviceId(null)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="inventory-device-sidebar-body">
              <DeviceDetails
                canViewSecurity={canViewSecurity}
                canWrite={canWrite}
                accessToken={accessToken}
                device={selectedDevice}
                deviceTypes={deviceTypeOptions}
                disabled={busy}
                groups={groups}
                snmpProfiles={snmpProfiles}
                sites={sites}
                onGraphChange={onGraphChange}
                liveStatus={selectedDeviceLive}
                monitorSummary={selectedMonitorSummary}
                onSubmit={(payload) => submitDeviceUpdate(selectedDevice.id, payload)}
                securityLoading={deviceSecurityLoading}
                securitySummary={deviceSecuritySummary}
              />
            </div>
          </aside>
        )}
      </div>

      {showDeviceForm && (
        <DeviceForm busy={busy} device={null} cloneSource={null} deviceTypes={deviceTypeOptions} groups={groups} snmpProfiles={snmpProfiles} sites={sites}
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

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Boxes, ChevronDown, ChevronRight, Cloud, Globe2, Pencil, Plus, Search, Server, Trash2 } from "lucide-react";
import {
  api,
  type CloudProviderOption,
  type ExternalIpAssignment,
  type ExternalIpAssignmentPayload,
  type ExternalIpPool,
  type ExternalIpPoolPayload,
} from "../../api/client";
import { CloudProviderIcon } from "../../components/CloudProviderIcon";
import { IconPickerTrigger } from "../../components/IconPicker";
import { DashStat } from "../../components/DashStat";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { WorkspaceSkeleton } from "../../components/Skeleton";
import { UtilizationBar } from "../../components/UtilizationBar";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { useApiQuery } from "../../hooks/useApiQuery";
import { DeviceForm } from "../devices/DeviceForm";
import { createDeviceWithReservationConfirmation } from "../devices/createDevice";
import type { Device, DevicePayload } from "../../api/client";
import { deviceIconUrl } from "../../icons";

const EMPTY_POOL: ExternalIpPoolPayload = { name: "", cidr: "", provider_id: null, service: null, icon: "cloud", account: null, region: null, description: null };
const EMPTY_ASSIGNMENT: ExternalIpAssignmentPayload = {
  pool_id: 0, device_id: null, asset_id: null, ip_address: "", label: "", status: "in_use",
  owner: null, tags: null, notes: null,
};

/** Sentinel key for allocations that have no provider. */
const UNASSIGNED = "__unassigned__";

type ExternalStatusFilter = "all" | ExternalIpAssignment["status"];

const CLOUD_SERVICE_SUGGESTIONS: Record<string, string[]> = {
  aws: ["Amazon EC2", "AWS Lambda", "Amazon ECS", "Amazon EKS", "AWS Elastic Beanstalk", "Amazon RDS", "Amazon S3", "Elastic Load Balancing", "Amazon CloudFront"],
  azure: ["Virtual Machines", "Azure Kubernetes Service (AKS)", "App Service", "Azure Functions", "Virtual Machine Scale Sets", "Storage", "Azure SQL", "Azure Load Balancer"],
  "google-cloud": ["Compute Engine", "Google Kubernetes Engine (GKE)", "Cloud Run", "Cloud Functions", "App Engine", "Cloud Storage", "Cloud SQL", "Cloud CDN"],
  cloudflare: ["DNS", "CDN", "Load Balancing", "Workers", "R2 Storage", "Zero Trust"],
};

function statusLabel(status: ExternalIpAssignment["status"]) {
  return status === "in_use" ? "In use" : status === "reserved" ? "Reserved" : "Available";
}

function nullable(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

function AllocationActionsMenu({ onAddRange, onEdit, onDelete }: { onAddRange: () => void; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = popoverRef.current?.getBoundingClientRect();
    const menuWidth = menuRect?.width ?? 178;
    const menuHeight = menuRect?.height ?? 112;
    const viewportGap = 8;
    const controlGap = 5;
    const belowTop = triggerRect.bottom + controlGap;
    const aboveTop = triggerRect.top - menuHeight - controlGap;
    const openAbove = belowTop + menuHeight > window.innerHeight - viewportGap && aboveTop >= viewportGap;
    setPopoverPosition({
      top: Math.max(viewportGap, Math.min(openAbove ? aboveTop : belowTop, window.innerHeight - menuHeight - viewportGap)),
      left: Math.max(viewportGap, Math.min(triggerRect.right - menuWidth, window.innerWidth - menuWidth - viewportGap)),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePopoverPosition();
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return <span className="external-ip-actions-menu" ref={rootRef} onClick={(event) => event.stopPropagation()}>
    <button ref={triggerRef} type="button" className="nm-btn nm-btn--sm nm-btn--secondary external-ip-actions-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      Actions <ChevronDown size={13} />
    </button>
    {open && createPortal(<span ref={popoverRef} className="external-ip-actions-popover" role="menu" style={{ top: popoverPosition.top, left: popoverPosition.left }} onClick={(event) => event.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => run(onAddRange)}><Plus size={13} /> Add range</button>
      <button type="button" role="menuitem" onClick={() => run(onEdit)}><Pencil size={13} /> Edit allocation</button>
      <span className="external-ip-actions-separator" />
      <button type="button" role="menuitem" className="is-danger" onClick={() => run(onDelete)}><Trash2 size={13} /> Delete allocation</button>
    </span>, document.body)}
  </span>;
}

export function ExternalIpPanel({ accessToken, canWrite, canCreateDevice = false, onDeviceChange, showSummary = true, allowCreatePool = true, headerContent }: { accessToken: string; canWrite: boolean; canCreateDevice?: boolean; onDeviceChange?: (device: Device) => void; showSummary?: boolean; allowCreatePool?: boolean; headerContent?: ReactNode }) {
  const toast = useToast();
  const confirmAction = useConfirm();
  const query = useApiQuery(async () => {
    const [summary, pools, assignments, cloudProviders, graph] = await Promise.all([
      api.getExternalIpSummary(accessToken),
      api.listExternalIpPools(accessToken),
      api.listExternalIpAssignments(accessToken),
      api.listCloudProviders(accessToken),
      api.topologyGraph(accessToken).catch(() => ({ devices: [], relationships: [] })),
    ]);
    return { summary, pools, assignments, cloudProviders, devices: graph.devices };
  }, [accessToken]);

  const pools = useMemo(() => query.data?.pools ?? [], [query.data]);
  const assignments = useMemo(() => query.data?.assignments ?? [], [query.data]);
  const cloudProviders = useMemo(() => query.data?.cloudProviders ?? [], [query.data]);
  const inventoryDevices = useMemo(() => query.data?.devices ?? [], [query.data]);

  /** Provider → cloud service → allocation. Provider IDs remain the stable root key. */
  const providerGroups = useMemo(() => {
    const grouped = new Map<string, {
      key: string;
      name: string;
      provider: CloudProviderOption | null;
      pools: ExternalIpPool[];
    }>();
    const ensure = (provider: CloudProviderOption | null) => {
      const key = provider ? String(provider.id ?? provider.key) : UNASSIGNED;
      let entry = grouped.get(key);
      if (!entry) {
        entry = { key, name: provider?.name ?? "No provider", provider, pools: [] };
        grouped.set(key, entry);
      }
      return entry;
    };
    for (const pool of pools) ensure(pool.provider ?? null).pools.push(pool);

    return [...grouped.values()]
      .map((group) => {
        const services = new Map<string, { key: string; name: string; pools: ExternalIpPool[] }>();
        for (const pool of group.pools) {
          const name = pool.service?.trim() || "Other services";
          const key = `${group.key}:${name.toLocaleLowerCase()}`;
          const service = services.get(key) ?? { key, name, pools: [] };
          service.pools.push(pool);
          services.set(key, service);
        }
        const serviceGroups = [...services.values()].map((service) => {
          const servicePools = [...service.pools].sort((a, b) => a.name.localeCompare(b.name));
          const capacity = servicePools.reduce((sum, pool) => sum + pool.total, 0);
          const inUse = servicePools.reduce((sum, pool) => sum + pool.in_use + pool.reserved, 0);
          return { ...service, pools: servicePools, capacity, inUse, free: servicePools.reduce((sum, pool) => sum + pool.free, 0), utilization: capacity ? inUse / capacity : 0 };
        }).sort((a, b) => (a.name === "Other services" ? 1 : b.name === "Other services" ? -1 : a.name.localeCompare(b.name)));
        const capacity = group.pools.reduce((sum, pool) => sum + pool.total, 0);
        const inUse = group.pools.reduce((sum, pool) => sum + pool.in_use + pool.reserved, 0);
        return {
          ...group,
          services: serviceGroups,
          capacity,
          free: group.pools.reduce((sum, pool) => sum + pool.free, 0),
          addressCount: capacity,
          inUse,
          utilization: capacity ? inUse / capacity : 0,
        };
      })
      .filter((group) => group.services.length > 0 || group.provider !== null)
      .sort((a, b) => (a.key === UNASSIGNED ? 1 : b.key === UNASSIGNED ? -1 : a.name.localeCompare(b.name)));
  }, [pools]);

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<ExternalStatusFilter>("all");
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const assignmentsByPool = useMemo(() => {
    const grouped = new Map<number, ExternalIpAssignment[]>();
    for (const assignment of assignments) grouped.set(assignment.pool_id, [...(grouped.get(assignment.pool_id) ?? []), assignment]);
    return grouped;
  }, [assignments]);
  const filteredProviderGroups = useMemo(() => providerGroups.map((group) => {
    const providerMatch = !normalizedSearch || `${group.name} ${group.provider?.key ?? ""}`.toLocaleLowerCase().includes(normalizedSearch);
    const services = group.services.map((service) => {
      const serviceMatch = providerMatch || service.name.toLocaleLowerCase().includes(normalizedSearch);
      const visiblePools = service.pools.filter((pool) => {
        const statusMatch = statusFilter === "all" || (statusFilter === "available" ? pool.free > 0 : statusFilter === "in_use" ? pool.in_use > 0 : pool.reserved > 0);
        if (!statusMatch) return false;
        if (serviceMatch) return true;
        const tracked = assignmentsByPool.get(pool.id) ?? [];
        return [pool.name, pool.account, pool.region, pool.description, ...(pool.allocations ?? []).map((item) => item.cidr), ...tracked.flatMap((row) => [row.ip_address, row.label, row.owner, row.device?.display_name, row.device?.hostname])]
          .filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedSearch);
      });
      if (visiblePools.length === 0) return null;
      const capacity = visiblePools.reduce((sum, pool) => sum + pool.total, 0);
      const inUse = visiblePools.reduce((sum, pool) => sum + pool.in_use + pool.reserved, 0);
      return { ...service, pools: visiblePools, capacity, inUse, free: visiblePools.reduce((sum, pool) => sum + pool.free, 0), utilization: capacity ? inUse / capacity : 0 };
    }).filter((service): service is NonNullable<typeof service> => service !== null);
    if (services.length === 0) return null;
    const capacity = services.reduce((sum, service) => sum + service.capacity, 0);
    const inUse = services.reduce((sum, service) => sum + service.inUse, 0);
    return { ...group, services, capacity, addressCount: capacity, inUse, free: services.reduce((sum, service) => sum + service.free, 0), utilization: capacity ? inUse / capacity : 0 };
  }).filter((group): group is NonNullable<typeof group> => group !== null), [assignmentsByPool, normalizedSearch, providerGroups, statusFilter]);

  /** Providers and service groups start open. Allocations start collapsed, except a
   * single-address /32 or /128 where another click would only reveal one row. */
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set());
  const [collapsedServices, setCollapsedServices] = useState<Set<string>>(new Set());
  const [poolOverrides, setPoolOverrides] = useState<Record<number, boolean>>({});
  const isPoolOpen = useCallback(
    (pool: ExternalIpPool) => poolOverrides[pool.id] ?? pool.total === 1,
    [poolOverrides],
  );
  const filteredPools = useMemo(() => filteredProviderGroups.flatMap((group) => group.services.flatMap((service) => service.pools)), [filteredProviderGroups]);
  const openPools = useMemo(() => filteredPools.filter(isPoolOpen), [filteredPools, isPoolOpen]);
  const openPoolKey = openPools.map((pool) => pool.id).join(",");

  /** `selectedPoolId` is now only "which allocation is the Range modal acting on". */
  const [selectedPoolId, setSelectedPoolId] = useState<number | null>(null);
  const selectedPool = pools.find((pool) => pool.id === selectedPoolId) ?? null;
  const [pageOffsets, setPageOffsets] = useState<Record<number, number>>({});
  const addressQuery = useApiQuery(
    openPools.length === 0 ? null : async () => {
      const pages = await Promise.all(openPools.map(
        (pool) => api.getExternalPoolAddresses(accessToken, pool.id, pageOffsets[pool.id] ?? 0, 256),
      ));
      return new Map(openPools.map((pool, index) => [pool.id, pages[index]]));
    },
    [accessToken, openPoolKey, JSON.stringify(pageOffsets)],
  );

  const [poolModal, setPoolModal] = useState<ExternalIpPool | "new" | null>(null);
  const [poolForm, setPoolForm] = useState<ExternalIpPoolPayload>(EMPTY_POOL);
  const [poolDetailsOpen, setPoolDetailsOpen] = useState(false);
  const selectedPoolProvider = cloudProviders.find((provider) => provider.id === poolForm.provider_id) ?? null;
  const serviceSuggestions = CLOUD_SERVICE_SUGGESTIONS[selectedPoolProvider?.key ?? ""] ?? [];
  const [assignmentModal, setAssignmentModal] = useState<ExternalIpAssignment | "new" | null>(null);
  const [assignmentForm, setAssignmentForm] = useState<ExternalIpAssignmentPayload>(EMPTY_ASSIGNMENT);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rangeModal, setRangeModal] = useState(false);
  const [rangeValue, setRangeValue] = useState("");
  const [addToInventory, setAddToInventory] = useState(false);
  const [deviceSeed, setDeviceSeed] = useState<Partial<Device> | null>(null);
  const [seededAssignmentId, setSeededAssignmentId] = useState<number | null>(null);
  const deviceMetadataQuery = useApiQuery(
    deviceSeed === null ? null : async () => {
      const [groups, sites, snmpProfiles, deviceTypes] = await Promise.all([
        api.topologyGroups(accessToken).catch(() => []),
        api.sites(accessToken).catch(() => []),
        api.listSnmpProfiles(accessToken).catch(() => []),
        api.listDeviceTypes(accessToken).catch(() => []),
      ]);
      return { groups, sites, snmpProfiles, deviceTypes };
    },
    [accessToken, deviceSeed !== null],
  );

  useEffect(() => {
    if (selectedPoolId !== null && !pools.some((pool) => pool.id === selectedPoolId)) setSelectedPoolId(null);
  }, [pools, selectedPoolId]);

  function toggleProvider(key: string) {
    setCollapsedProviders((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleService(key: string) {
    setCollapsedServices((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function openPool(pool?: ExternalIpPool, providerId: number | null = null) {
    setPoolModal(pool ?? "new");
    setPoolForm(pool ? {
      name: pool.name, provider_id: pool.provider_id,
      service: pool.service, icon: pool.icon, account: pool.account, region: pool.region, description: pool.description,
    } : { ...EMPTY_POOL, provider_id: providerId });
    setPoolDetailsOpen(Boolean(pool && (
      pool.service?.trim()
      || pool.account?.trim()
      || pool.region?.trim()
      || pool.description?.trim()
      || pool.icon !== "cloud"
    )));
    setFormError(null);
  }

  function openAssignment(assignment?: ExternalIpAssignment, ipAddress = "", poolId = 0, deviceId: number | null = null) {
    setAssignmentModal(assignment ?? "new");
    setAssignmentForm(assignment ? {
      pool_id: assignment.pool_id, device_id: assignment.device_id, asset_id: assignment.asset_id, ip_address: assignment.ip_address,
      label: assignment.label, status: assignment.status,
      owner: assignment.owner, tags: assignment.tags, notes: assignment.notes,
    } : { ...EMPTY_ASSIGNMENT, pool_id: poolId, ip_address: ipAddress, device_id: deviceId });
    setFormError(null);
    setAddToInventory(false);
  }

  async function savePool(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setFormError(null);
    const payload = {
      ...poolForm,
      service: nullable(poolForm.service ?? ""),
      account: nullable(poolForm.account ?? ""),
      region: nullable(poolForm.region ?? ""),
      description: nullable(poolForm.description ?? ""),
    };
    try {
      if (poolModal === "new") await api.createExternalIpPool(accessToken, payload);
      else if (poolModal) {
        const { cidr: _cidr, ...rest } = payload;
        await api.updateExternalIpPool(accessToken, poolModal.id, rest);
      }
      setPoolModal(null);
      await query.reload();
      toast.success(poolModal === "new" ? "Allocation added" : "Allocation updated");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to save allocation");
    } finally { setBusy(false); }
  }

  async function saveAssignment(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setFormError(null);
    const payload = {
      ...assignmentForm,
      status: addToInventory ? "in_use" as const : assignmentForm.status,
      owner: nullable(assignmentForm.owner ?? ""),
      tags: nullable(assignmentForm.tags ?? ""), notes: nullable(assignmentForm.notes ?? ""),
    };
    try {
      const saved = assignmentModal === "new"
        ? await api.createExternalIpAssignment(accessToken, payload)
        : assignmentModal ? await api.updateExternalIpAssignment(accessToken, assignmentModal.id, payload) : null;
      setAssignmentModal(null);
      await query.reload();
      if (openPools.length > 0) await addressQuery.reload();
      toast.success(assignmentModal === "new" ? "External IP tracked" : "External IP updated");
      if (saved && addToInventory) setSeededAssignmentId(saved.id);
      if (saved && addToInventory) setDeviceSeed({
        display_name: saved.asset?.name ?? saved.label,
        hostname: null,
        ip_address: saved.ip_address,
        tags: saved.tags ? saved.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
        notes: saved.notes,
        monitoring_paused: false,
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to save external IP");
    } finally { setBusy(false); }
  }

  async function removePool(pool: ExternalIpPool) {
    if (!await confirmAction({ title: "Delete allocation", message: `Delete ${pool.name} and all of its tracked addresses?`, confirmLabel: "Delete allocation" })) return;
    try { await api.deleteExternalIpPool(accessToken, pool.id); await query.reload(); toast.success("Allocation deleted"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Failed to delete allocation"); }
  }

  async function addRange(event: FormEvent) {
    event.preventDefault();
    if (!selectedPool) return;
    setBusy(true); setFormError(null);
    try {
      await api.createExternalIpRange(accessToken, selectedPool.id, rangeValue.trim());
      setRangeModal(false); setRangeValue("");
      await query.reload(); await addressQuery.reload();
      toast.success("Address allocation added");
    } catch (error) { setFormError(error instanceof Error ? error.message : "Failed to add address allocation"); }
    finally { setBusy(false); }
  }

  async function removeRange(rangeId: number, cidr: string) {
    if (!selectedPool || !await confirmAction({ title: "Remove address allocation", message: `Remove ${cidr} from ${selectedPool.name}?`, confirmLabel: "Remove allocation" })) return;
    try {
      await api.deleteExternalIpRange(accessToken, selectedPool.id, rangeId);
      await query.reload(); await addressQuery.reload();
      toast.success("Address allocation removed");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Failed to remove address allocation"); }
  }

  async function removeAssignment(assignment: ExternalIpAssignment) {
    if (!await confirmAction({ title: "Stop tracking external IP", message: `Remove ${assignment.ip_address} from external IP tracking?`, confirmLabel: "Remove" })) return;
    try {
      await api.deleteExternalIpAssignment(accessToken, assignment.id);
      setAssignmentModal(null);
      await query.reload();
      if (openPools.length > 0) await addressQuery.reload();
      toast.success("External IP removed");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Failed to remove external IP"); }
  }

  async function removeAddress(pool: ExternalIpPool, ipAddress: string, assignment: ExternalIpAssignment | null) {
    const removesAllocation = pool.total === 1;
    const details = [
      assignment ? "Its tracking record will also be removed; any linked Inventory device will remain." : null,
      removesAllocation ? "This is the allocation's final address, so the empty allocation will also be removed." : null,
    ].filter(Boolean).join(" ");
    if (!await confirmAction({
      title: "Delete external IP address",
      message: `Delete ${ipAddress} from ${pool.name}?${details ? ` ${details}` : ""}`,
      confirmLabel: "Delete address",
    })) return;
    try {
      await api.deleteExternalPoolAddress(accessToken, pool.id, ipAddress);
      if (removesAllocation) {
        setPoolOverrides((current) => {
          const next = { ...current };
          delete next[pool.id];
          return next;
        });
      }
      await query.reload();
      if (!removesAllocation) await addressQuery.reload();
      toast.success("External IP address deleted");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Failed to delete external IP address"); }
  }

  async function createInventoryDevice(payload: DevicePayload) {
    setBusy(true); setFormError(null);
    try {
      const created = await createDeviceWithReservationConfirmation(accessToken, payload, confirmAction);
      if (!created) return;
      // Link the address to the device it just produced, which is what puts it on the
      // Cloud assets page — the toggle is the only way a device gets there.
      if (seededAssignmentId !== null) {
        await api.updateExternalIpAssignment(accessToken, seededAssignmentId, { device_id: created.id });
        setSeededAssignmentId(null);
        await query.reload();
      }
      onDeviceChange?.(created);
      setDeviceSeed(null);
      toast.success("Device added to Inventory and linked to this address");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create device";
      setFormError(message);
      toast.error(message);
    } finally { setBusy(false); }
  }

  if (query.isLoading) return showSummary ? <WorkspaceSkeleton /> : <section className="nm-app-panel external-ip-panel"><div className="external-ip-empty">Loading external addresses…</div></section>;
  if (query.error) return <section className="nm-app-panel external-ip-panel"><div className="external-ip-empty external-ip-error">{query.error}</div></section>;
  const summary = query.data?.summary;

  return (
    <div className="external-ip-workspace">
      {showSummary && <div className="dash-stats dash-stats--fill ipam-stats nm-summary-band">
        <DashStat label="Allocations" value={pools.length} sub="across all providers" icon={<Boxes size={20} />} accent="teal" />
        <DashStat label="Tracked" value={(summary?.in_use ?? 0) + (summary?.reserved ?? 0)} sub="assigned or reserved" icon={<Cloud size={20} />} accent="blue" />
        <DashStat label="Available" value={summary?.free ?? 0} sub="allocation addresses" icon={<Globe2 size={20} />} accent="green" />
        <DashStat label="Unassigned" value={summary?.unassigned_address_count ?? 0} sub="not yet allocated" icon={<Server size={20} />} accent="purple" />
      </div>}

      <section className="nm-app-panel external-ip-panel">
        <header className="nm-app-panel-header ipam-panel-header external-ip-panel-header">
          {headerContent ?? <span className="ipam-panel-identity">
            <span className="ipam-panel-icon" aria-hidden="true"><Globe2 size={18} /></span>
            <span className="ipam-panel-title-wrap"><span className="ipam-panel-title">External IPs</span><span className="ipam-panel-meta">{pools.length} allocation{pools.length === 1 ? "" : "s"} across {providerGroups.length} provider{providerGroups.length === 1 ? "" : "s"}</span></span>
          </span>}
          <div className="external-ip-panel-actions">
            {providerGroups.length > 0 && <div className="external-ip-header-controls">
              <div className="nm-search nm-search--toolbar external-ip-search">
                <Search size={14} className="nm-search-icon" aria-hidden="true" />
                <input className="nm-input" type="search" aria-label="Search external IPs" placeholder="Search providers, services, allocations, IPs or owners…" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} />
              </div>
              <label className="external-ip-status-filter"><span>Status</span><select className="nm-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ExternalStatusFilter)}><option value="all">All</option><option value="in_use">In use</option><option value="reserved">Reserved</option><option value="available">Available</option></select></label>
              <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={!searchTerm && statusFilter === "all"} onClick={() => { setSearchTerm(""); setStatusFilter("all"); }}>Clear filters</button>
            </div>}
            {canWrite && allowCreatePool && <button className="nm-btn nm-btn--sm nm-btn--primary" type="button" onClick={() => openPool()}><Plus size={14} /> Add allocation</button>}
          </div>
        </header>

        {providerGroups.length === 0 ? <div className="external-ip-empty">Add an allocation for an ISP or cloud provider, then organise it under the service or area that uses its addresses.</div> : <>
          {filteredProviderGroups.length === 0 ? <div className="external-ip-empty">No external IP records match these filters.</div> : <div className="nm-table-wrap external-ip-table-wrap"><table className="nm-table nm-table--selectable external-ip-table">
            <colgroup><col className="external-ip-col-provider" /><col className="external-ip-col-account" /><col className="external-ip-col-status" /><col className="external-ip-col-stat" /><col className="external-ip-col-stat" /><col className="external-ip-col-util" /><col className="external-ip-col-actions" /></colgroup>
            <thead><tr><th>Provider / service / allocation / address</th><th>Account / owner</th><th>Status</th><th className="nm-table-num">Addresses</th><th className="nm-table-num">In use</th><th>Utilisation</th><th className="external-ip-actions">Actions</th></tr></thead>
            <tbody>{filteredProviderGroups.map((group) => {
              const collapsed = collapsedProviders.has(group.key);
              const accounts = [...new Set(group.services.flatMap((service) => service.pools.map((pool) => pool.account?.trim())).filter((value): value is string => Boolean(value)))];
              return <Fragment key={group.key}>
                <tr className="external-ip-provider-row" aria-expanded={!collapsed} onClick={() => toggleProvider(group.key)}>
                  <td><span className="external-ip-tree-cell external-ip-tree-level-0">
                    <button type="button" className="external-ip-tree-toggle" aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.name}`} onClick={(event) => { event.stopPropagation(); toggleProvider(group.key); }}>{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button>
                    <span className={`external-ip-provider-icon external-ip-provider-icon--${group.provider?.icon ?? "cloud"}`} aria-hidden="true"><CloudProviderIcon icon={group.provider?.icon} iconData={group.provider?.icon_data} size={20} /></span>
                    <span className="external-ip-tree-identity"><strong>{group.name}</strong><small>{group.services.length} service{group.services.length === 1 ? "" : "s"} · {group.free} free of {group.capacity}</small></span>
                    <span className="external-ip-count-badge">{group.services.length} service{group.services.length === 1 ? "" : "s"}</span>
                  </span></td>
                  <td><span className="external-ip-provider-accounts">{accounts.length > 0 ? accounts.join(" · ") : "No account references"}</span></td>
                  <td />
                  <td className="nm-table-num external-ip-provider-stat">{group.addressCount}</td>
                  <td className="nm-table-num external-ip-provider-stat">{group.inUse}</td>
                  <td><span className="external-ip-utilization"><UtilizationBar value={group.utilization} size="thin" /><small>{Math.round(group.utilization * 100)}%</small></span></td>
                  <td className="external-ip-actions" />
                </tr>

                {!collapsed && group.services.map((service) => {
                  const serviceCollapsed = collapsedServices.has(service.key);
                  return <Fragment key={service.key}>
                    <tr className="external-ip-service-row" aria-expanded={!serviceCollapsed} onClick={() => toggleService(service.key)}>
                      <td><span className="external-ip-tree-cell external-ip-tree-level-1">
                        <button type="button" className="external-ip-tree-toggle" aria-label={`${serviceCollapsed ? "Expand" : "Collapse"} ${service.name}`} onClick={(event) => { event.stopPropagation(); toggleService(service.key); }}>{serviceCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button>
                        <span className="external-ip-tree-icon" aria-hidden="true"><Boxes size={14} /></span>
                        <span className="external-ip-tree-identity"><strong>{service.name}</strong><small>{service.pools.length} allocation{service.pools.length === 1 ? "" : "s"}</small></span>
                        <span className="external-ip-count-badge">{service.pools.length} allocation{service.pools.length === 1 ? "" : "s"}</span>
                      </span></td>
                      <td><span className="external-ip-provider-accounts">{[...new Set(service.pools.map((pool) => pool.account).filter(Boolean))].join(" · ") || "—"}</span></td>
                      <td />
                      <td className="nm-table-num external-ip-provider-stat">{service.capacity}</td>
                      <td className="nm-table-num external-ip-provider-stat">{service.inUse}</td>
                      <td><span className="external-ip-utilization"><UtilizationBar value={service.utilization} size="thin" /><small>{Math.round(service.utilization * 100)}%</small></span></td>
                      <td className="external-ip-actions" />
                    </tr>

                    {!serviceCollapsed && service.pools.map((pool, poolIndex) => {
                      const poolOpen = isPoolOpen(pool);
                      const poolPage = addressQuery.data?.get(pool.id);
                      const poolOffset = pageOffsets[pool.id] ?? 0;
                      const poolMetaMatches = !normalizedSearch || [group.name, service.name, pool.name, pool.account, pool.region, pool.description, ...(pool.allocations ?? []).map((item) => item.cidr)].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedSearch);
                      const visibleAddresses = (poolPage?.addresses ?? []).filter((entry) => {
                        if (statusFilter !== "all" && entry.status !== statusFilter) return false;
                        if (poolMetaMatches) return true;
                        const assignment = entry.assignment;
                        return [entry.ip_address, assignment?.label, assignment?.owner, assignment?.device?.display_name, assignment?.device?.hostname].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedSearch);
                      });
                      return <Fragment key={`pool-${pool.id}`}>
                        <tr className={`external-ip-pool-row${poolIndex % 2 === 1 ? " is-alt" : ""}`} aria-expanded={poolOpen} onClick={() => setPoolOverrides((current) => ({ ...current, [pool.id]: !poolOpen }))}>
                          <td><span className="external-ip-tree-cell external-ip-tree-level-2">
                            <button type="button" className="external-ip-tree-toggle" aria-label={`${poolOpen ? "Collapse" : "Expand"} ${pool.name}`} onClick={(event) => { event.stopPropagation(); setPoolOverrides((current) => ({ ...current, [pool.id]: !poolOpen })); }}>{poolOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
                            <span className="external-ip-tree-icon" aria-hidden="true"><img src={deviceIconUrl(pool.icon)} width={15} height={15} alt="" /></span>
                            <span className="external-ip-tree-identity"><strong>{pool.name}</strong><small className="nm-table-mono">{(pool.allocations ?? []).map((item) => item.cidr).join(", ") || "No ranges"}</small></span>
                            <span className="external-ip-count-badge">{pool.total} address{pool.total === 1 ? "" : "es"}</span>
                          </span></td>
                          <td><small>{pool.account ?? "—"}{pool.region ? ` · ${pool.region}` : ""}</small></td>
                          <td><span className={`nm-status nm-status--${pool.free === 0 ? "offline" : pool.utilization > 0 ? "online" : "unknown"}`}>{pool.free} free</span></td>
                          <td className="nm-table-num">{pool.total}</td>
                          <td className="nm-table-num">{pool.in_use + pool.reserved}</td>
                          <td><span className="external-ip-utilization"><UtilizationBar value={pool.utilization} size="thin" /><small>{Math.round(pool.utilization * 100)}%</small></span></td>
                          <td className="external-ip-actions">{canWrite && <AllocationActionsMenu
                            onAddRange={() => { setSelectedPoolId(pool.id); setRangeValue(""); setFormError(null); setRangeModal(true); }}
                            onEdit={() => openPool(pool)}
                            onDelete={() => void removePool(pool)}
                          />}</td>
                        </tr>
                        {poolOpen && <>
                          {addressQuery.isLoading && !poolPage && <tr className="external-ip-address-row"><td colSpan={7}><small>Loading addresses…</small></td></tr>}
                          {visibleAddresses.map((entry, addressIndex) => {
                            const assignment = entry.assignment;
                            return <tr key={entry.ip_address} className={`external-ip-address-row external-ip-address-row--${entry.status}${addressIndex % 2 === 1 ? " is-alt" : ""}${assignment ? "" : " external-ip-address-row--unassigned"}`} onClick={() => assignment ? openAssignment(assignment) : canWrite && openAssignment(undefined, entry.ip_address, pool.id)}>
                              <td><span className="external-ip-tree-cell external-ip-tree-level-3"><span className="external-ip-leaf-mark" aria-hidden="true"><i /></span><span className="external-ip-tree-identity"><code className="nm-table-mono">{entry.ip_address}</code><small>{assignment?.device?.display_name ?? assignment?.device?.hostname ?? assignment?.asset?.name ?? assignment?.label ?? "Unassigned"}</small></span></span></td>
                              <td><small>{assignment?.owner ?? assignment?.device?.display_name ?? assignment?.device?.hostname ?? "—"}</small></td>
                              <td><span className={`nm-status nm-status--${entry.status === "in_use" ? "online" : entry.status === "reserved" ? "paused" : "unknown"}`}>{statusLabel(entry.status)}</span></td>
                              <td className="nm-table-num" /><td className="nm-table-num" /><td />
                              <td className="external-ip-actions" onClick={(event) => event.stopPropagation()}>{canWrite && <span className="nm-table-actions">
                                <button className="nm-btn nm-btn--sm nm-btn--secondary" type="button" onClick={() => assignment ? openAssignment(assignment) : openAssignment(undefined, entry.ip_address, pool.id)}>{assignment ? "Edit" : "Assign"}</button>
                                <button className="nm-btn nm-btn--sm nm-btn--danger external-ip-address-delete" type="button" aria-label={`Delete ${entry.ip_address}`} title="Delete address" onClick={() => void removeAddress(pool, entry.ip_address, assignment)}><Trash2 size={13} /></button>
                              </span>}</td>
                            </tr>;
                          })}
                          {(poolPage?.total ?? 0) > 256 && <tr className="external-ip-pager-row"><td colSpan={7}><footer className="external-ip-pager"><span>{poolOffset + 1}–{Math.min(poolOffset + 256, poolPage?.total ?? 0)} of {poolPage?.total}</span><button className="nm-btn nm-btn--sm" disabled={poolOffset === 0} onClick={() => setPageOffsets((current) => ({ ...current, [pool.id]: Math.max(0, poolOffset - 256) }))}>Previous</button><button className="nm-btn nm-btn--sm" disabled={poolOffset + 256 >= (poolPage?.total ?? 0)} onClick={() => setPageOffsets((current) => ({ ...current, [pool.id]: poolOffset + 256 }))}>Next</button></footer></td></tr>}
                        </>}
                      </Fragment>;
                    })}
                  </Fragment>;
                })}
              </Fragment>;
            })}</tbody>
          </table></div>}
        </>}
      </section>

      {poolModal && <Modal title={poolModal === "new" ? "Add allocation" : "Edit allocation"} titleIcon={<span className="ipam-panel-icon" aria-hidden="true"><Globe2 size={18} /></span>} onCancel={() => setPoolModal(null)} footer={<ModalFooterActions onCancel={() => setPoolModal(null)} primaryLabel={busy ? (poolModal === "new" ? "Adding…" : "Saving…") : (poolModal === "new" ? "Add allocation" : "Save changes")} primaryDisabled={busy} formId="external-pool-form" />}>
        <form id="external-pool-form" className="modal-form external-ip-form" onSubmit={(event) => void savePool(event)}>
          <p className="external-ip-form-intro">Add the public address space assigned by your provider. Ownership and cloud details can be added later.</p>
          <div className="nm-form-row external-ip-core-fields">
            <label>Allocation name<input autoFocus required value={poolForm.name} onChange={(e) => setPoolForm({ ...poolForm, name: e.target.value })} placeholder="Primary WAN allocation" /></label>
            {poolModal === "new" && <label>Public IP address or range<input required value={poolForm.cidr ?? ""} onChange={(e) => setPoolForm({ ...poolForm, cidr: e.target.value })} placeholder="1.1.1.8, 1.1.1.8/32, or 1.1.1.8-1.1.1.14" /><small>Enter one address, a CIDR block, or a start–end range.</small></label>}
          </div>
          <label><span>Provider <span className="external-ip-optional-label">(optional)</span></span><select value={poolForm.provider_id ?? ""} onChange={(e) => setPoolForm({ ...poolForm, provider_id: e.target.value ? Number(e.target.value) : null })}><option value="">No provider</option>{cloudProviders.map((provider) => <option key={provider.key} value={provider.id ?? ""}>{provider.name}</option>)}</select><small>Used to group allocations by ISP or cloud provider.</small></label>
          <button type="button" className="external-ip-details-toggle" aria-expanded={poolDetailsOpen} aria-controls="external-ip-allocation-details" onClick={() => setPoolDetailsOpen((open) => !open)}>
            <span><strong>More details</strong><small>Service, account, region, icon and notes</small></span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          {poolDetailsOpen && <div id="external-ip-allocation-details" className="external-ip-details-section">
            <label><span>Service / area <span className="external-ip-optional-label">(optional)</span></span><input list="external-ip-service-options" value={poolForm.service ?? ""} onChange={(e) => setPoolForm({ ...poolForm, service: e.target.value })} placeholder={selectedPoolProvider ? `Service within ${selectedPoolProvider.name}` : "Service or organisational area"} /><datalist id="external-ip-service-options">{serviceSuggestions.map((service) => <option key={service} value={service} />)}</datalist><small>Groups this allocation within the selected provider.</small></label>
            <div className="nm-form-row">
              <label>Account / subscription<input value={poolForm.account ?? ""} onChange={(e) => setPoolForm({ ...poolForm, account: e.target.value })} placeholder="Subscription, project, or circuit" /></label>
              <label>Region<input value={poolForm.region ?? ""} onChange={(e) => setPoolForm({ ...poolForm, region: e.target.value })} placeholder="Cloud region" /></label>
            </div>
            <label className="icon-picker-field"><span className="icon-picker-field-label">Allocation icon</span><IconPickerTrigger value={poolForm.icon} onChange={(icon) => setPoolForm({ ...poolForm, icon })} /></label>
            <label><span>Notes <span className="external-ip-optional-label">(optional)</span></span><textarea rows={3} value={poolForm.description ?? ""} onChange={(e) => setPoolForm({ ...poolForm, description: e.target.value })} placeholder="How this allocation is used" /></label>
          </div>}
          {/* Ranges live here rather than in the table. On the page they were a strip of
              chips between an allocation and its addresses, which broke the run of IP rows
              and made the tree hard to read; they are edit-time detail, not scan-time. */}
          {poolModal !== "new" && (poolModal.allocations ?? []).length > 0 && <div className="external-ip-range-editor">
            <span className="external-ip-range-editor-label">Ranges</span>
            {(poolModal.allocations ?? []).map((item) => <span className="external-ip-allocation-chip" key={item.id}>
              <code>{item.cidr}</code>
              <small>{item.total} address{item.total === 1 ? "" : "es"}</small>
              {canWrite && (poolModal.allocations ?? []).length > 1 && <button type="button" aria-label={`Remove ${item.cidr}`} onClick={() => void removeRange(item.id, item.cidr)}>×</button>}
            </span>)}
          </div>}
          {formError && <p className="modal-error">{formError}</p>}
        </form>
      </Modal>}

      {rangeModal && selectedPool && <Modal title={`Add range to ${selectedPool.name}`} titleIcon={<Plus size={18} />} onCancel={() => { setRangeModal(false); setFormError(null); }} footer={<ModalFooterActions onCancel={() => { setRangeModal(false); setFormError(null); }} primaryLabel={busy ? "Adding…" : "Add range"} primaryDisabled={busy} formId="external-range-form" />}>
        <form id="external-range-form" className="modal-form external-ip-form" onSubmit={(event) => void addRange(event)}>
          <label>Public IP address or range<input autoFocus required value={rangeValue} onChange={(event) => setRangeValue(event.target.value)} placeholder="104.23.54.68, 104.23.54.68/32, or 104.23.54.64/29" /><small>Address, start-end range, or CIDR.</small></label>
          {formError && <p className="modal-error">{formError}</p>}
        </form>
      </Modal>}

      {assignmentModal && <Modal title={assignmentModal === "new" ? "Track external IP" : "Edit external IP"} titleIcon={<span className="ipam-panel-icon" aria-hidden="true"><Globe2 size={18} /></span>} onCancel={() => setAssignmentModal(null)} size="lg" footer={<ModalFooterActions onCancel={() => setAssignmentModal(null)} primaryLabel={busy ? "Saving…" : "Save address"} primaryDisabled={busy} formId="external-assignment-form">{assignmentModal !== "new" && <button type="button" className="nm-btn nm-btn--danger" onClick={() => void removeAssignment(assignmentModal)}>Remove</button>}</ModalFooterActions>}>
        <form id="external-assignment-form" className="modal-form external-ip-form" onSubmit={(event) => void saveAssignment(event)}>
          <div className="nm-form-row">
            <label>Address<input autoFocus required value={assignmentForm.ip_address} onChange={(e) => setAssignmentForm({ ...assignmentForm, ip_address: e.target.value })} placeholder="8.8.8.8" /></label>
            <label>Allocation<select required value={assignmentForm.pool_id} onChange={(e) => setAssignmentForm({ ...assignmentForm, pool_id: Number(e.target.value) })}><option value={0} disabled>Select an allocation</option>{pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}</select></label>
          </div>
          <div className="nm-form-row">
            <label>Device<select value={assignmentForm.device_id ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, device_id: e.target.value ? Number(e.target.value) : null })}><option value="">Not linked</option>{inventoryDevices.map((device) => <option key={device.id} value={device.id}>{device.display_name || device.hostname || device.ip_address}</option>)}</select><small>Groups this address under a device on the Cloud assets page.</small></label>
            <label>Status<select value={assignmentForm.status} onChange={(e) => setAssignmentForm({ ...assignmentForm, status: e.target.value as ExternalIpAssignment["status"] })}><option value="in_use">In use</option><option value="reserved">Reserved</option><option value="available">Available</option></select></label>
          </div>
          <div className="nm-form-row">
            <label>Label<input required value={assignmentForm.label} onChange={(e) => setAssignmentForm({ ...assignmentForm, label: e.target.value })} placeholder="Public web endpoint" /></label>
            <label>Owner<input value={assignmentForm.owner ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, owner: e.target.value })} placeholder="Team or customer" /></label>
          </div>
          <label>Tags<input value={assignmentForm.tags ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, tags: e.target.value })} placeholder="production, wan, customer" /></label>
          <label>Notes<textarea rows={3} value={assignmentForm.notes ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, notes: e.target.value })} /></label>
          {canCreateDevice && <div className="external-ip-device-toggle"><span className="external-ip-device-toggle-copy"><strong>Add to Inventory and Monitoring</strong><small>Also create a monitored device.</small></span><button type="button" role="switch" aria-checked={addToInventory} aria-label="Add to Inventory and Monitoring" className={`external-ip-device-switch${addToInventory ? " is-on" : ""}`} onClick={() => setAddToInventory((enabled) => !enabled)}><span /></button></div>}
          {formError && <p className="modal-error">{formError}</p>}
        </form>
      </Modal>}

      {deviceSeed && deviceMetadataQuery.data && <DeviceForm
        busy={busy}
        device={null}
        cloneSource={null}
        initialValues={deviceSeed}
        deviceTypes={deviceMetadataQuery.data.deviceTypes}
        groups={deviceMetadataQuery.data.groups}
        snmpProfiles={deviceMetadataQuery.data.snmpProfiles}
        sites={deviceMetadataQuery.data.sites}
        onCancel={() => setDeviceSeed(null)}
        onSubmit={createInventoryDevice}
      />}
    </div>
  );
}

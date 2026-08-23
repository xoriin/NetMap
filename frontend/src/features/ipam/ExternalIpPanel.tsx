import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Cloud, Globe2, Link2, Plus, Server, Boxes } from "lucide-react";
import {
  api,
  type CloudAsset,
  type CloudAssetPayload,
  type CloudProviderOption,
  type ExternalIpAssignment,
  type ExternalIpAssignmentPayload,
  type ExternalIpPool,
  type ExternalIpPoolPayload,
} from "../../api/client";
import { CloudProviderIcon } from "../../components/CloudProviderIcon";
import { DashStat } from "../../components/DashStat";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { WorkspaceSkeleton } from "../../components/Skeleton";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { useApiQuery } from "../../hooks/useApiQuery";
import { DeviceForm } from "../devices/DeviceForm";
import { createDeviceWithReservationConfirmation } from "../devices/createDevice";
import type { Device, DevicePayload } from "../../api/client";

const EMPTY_POOL: ExternalIpPoolPayload = { name: "", cidr: "", provider_id: null, account: null, region: null, description: null };
const EMPTY_ASSIGNMENT: ExternalIpAssignmentPayload = {
  pool_id: 0, device_id: null, asset_id: null, ip_address: "", label: "", status: "in_use",
  owner: null, tags: null, notes: null,
};

/** Sentinel key for addresses that belong to no asset. */
const UNASSIGNED = "__unassigned__";

function statusLabel(status: ExternalIpAssignment["status"]) {
  return status === "in_use" ? "In use" : status === "reserved" ? "Reserved" : "Available";
}

function nullable(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

export function ExternalIpPanel({ accessToken, canWrite, canCreateDevice = false, onDeviceChange, showSummary = true, allowCreatePool = true, headerContent }: { accessToken: string; canWrite: boolean; canCreateDevice?: boolean; onDeviceChange?: (device: Device) => void; showSummary?: boolean; allowCreatePool?: boolean; headerContent?: ReactNode }) {
  const toast = useToast();
  const confirmAction = useConfirm();
  const query = useApiQuery(async () => {
    const [summary, pools, assignments, assets, cloudProviders, graph] = await Promise.all([
      api.getExternalIpSummary(accessToken),
      api.listExternalIpPools(accessToken),
      api.listExternalIpAssignments(accessToken),
      api.listCloudAssets(accessToken),
      api.listCloudProviders(accessToken),
      api.topologyGraph(accessToken).catch(() => ({ devices: [], relationships: [] })),
    ]);
    return { summary, pools, assignments, assets, cloudProviders, devices: graph.devices };
  }, [accessToken]);

  const pools = useMemo(() => query.data?.pools ?? [], [query.data]);
  const assignments = useMemo(() => query.data?.assignments ?? [], [query.data]);
  const assets = useMemo(() => query.data?.assets ?? [], [query.data]);
  const cloudProviders = useMemo(() => query.data?.cloudProviders ?? [], [query.data]);
  const inventoryDevices = useMemo(() => query.data?.devices ?? [], [query.data]);

  /**
   * Provider → assets → addresses.
   *
   * Grouping keys off the provider *row id*, not a lowercased name string as it used
   * to — renaming a provider no longer splits its group in two.
   */
  const providerGroups = useMemo(() => {
    const addressesByAsset = new Map<number, ExternalIpAssignment[]>();
    const unassigned: ExternalIpAssignment[] = [];
    for (const row of assignments) {
      if (row.asset_id === null) unassigned.push(row);
      else {
        const current = addressesByAsset.get(row.asset_id);
        if (current) current.push(row);
        else addressesByAsset.set(row.asset_id, [row]);
      }
    }

    const grouped = new Map<string, {
      key: string;
      name: string;
      provider: CloudProviderOption | null;
      assets: Array<{ asset: CloudAsset; addresses: ExternalIpAssignment[] }>;
      unassigned: ExternalIpAssignment[];
      pools: ExternalIpPool[];
    }>();
    const ensure = (provider: CloudProviderOption | null) => {
      const key = provider ? String(provider.id ?? provider.key) : UNASSIGNED;
      let entry = grouped.get(key);
      if (!entry) {
        entry = { key, name: provider?.name ?? "No provider", provider, assets: [], unassigned: [], pools: [] };
        grouped.set(key, entry);
      }
      return entry;
    };

    for (const asset of assets) {
      ensure(asset.provider).assets.push({ asset, addresses: addressesByAsset.get(asset.id) ?? [] });
    }
    // Addresses with no asset hang off the provider of their allocation group.
    for (const row of unassigned) {
      const pool = pools.find((item) => item.id === row.pool_id) ?? null;
      ensure(pool?.provider ?? null).unassigned.push(row);
    }
    // Allocations hang off their provider so spare capacity shows up in the same
    // drill-down as the assets, rather than behind a separate surface.
    for (const pool of pools) ensure(pool.provider ?? null).pools.push(pool);

    return [...grouped.values()]
      .map((group) => {
        const addressCount = group.assets.reduce((sum, entry) => sum + entry.addresses.length, 0) + group.unassigned.length;
        const all = [...group.assets.flatMap((entry) => entry.addresses), ...group.unassigned];
        return {
          ...group,
          assets: [...group.assets].sort((a, b) => a.asset.name.localeCompare(b.asset.name)),
          pools: [...group.pools].sort((a, b) => a.name.localeCompare(b.name)),
          capacity: group.pools.reduce((sum, pool) => sum + pool.total, 0),
          free: group.pools.reduce((sum, pool) => sum + pool.free, 0),
          // The Addresses / In use columns must mean the same thing at every tier. They
          // are the allocation's capacity and consumption, summed up — not a count of
          // tracked assignment rows, which made a provider read 0 above an allocation
          // reading 1 for the same addresses.
          addressCount: group.pools.reduce((sum, pool) => sum + pool.total, 0),
          inUse: group.pools.reduce((sum, pool) => sum + pool.in_use + pool.reserved, 0),
          trackedCount: addressCount,
          reserved: all.filter((row) => row.status === "reserved").length,
        };
      })
      .filter((group) => group.assets.length > 0 || group.unassigned.length > 0 || group.pools.length > 0 || group.provider !== null)
      .sort((a, b) => (a.key === UNASSIGNED ? 1 : b.key === UNASSIGNED ? -1 : a.name.localeCompare(b.name)));
  }, [assets, assignments, pools]);

  /**
   * Allocations small enough to read at a glance are open from the start.
   *
   * The tier exists because an allocation carries spare capacity, and because its
   * addresses are fetched per allocation rather than up front — a /24 is 254 rows. But a
   * /32 allocation holding one address made you click a row to reveal the single address
   * named in that row, which is not a tier, just an obstacle. Anything at or under this
   * many addresses opens itself; bigger ones stay behind a click and paginate.
   */
  const AUTO_OPEN_MAX_ADDRESSES = 32;
  const [poolOverrides, setPoolOverrides] = useState<Record<number, boolean>>({});
  const isPoolOpen = useCallback(
    (pool: ExternalIpPool) => poolOverrides[pool.id] ?? pool.total <= AUTO_OPEN_MAX_ADDRESSES,
    [poolOverrides],
  );
  const openPools = useMemo(() => pools.filter(isPoolOpen), [pools, isPoolOpen]);
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
  const [assignmentModal, setAssignmentModal] = useState<ExternalIpAssignment | "new" | null>(null);
  const [assignmentForm, setAssignmentForm] = useState<ExternalIpAssignmentPayload>(EMPTY_ASSIGNMENT);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rangeModal, setRangeModal] = useState(false);
  const [rangeValue, setRangeValue] = useState("");
  const [addToInventory, setAddToInventory] = useState(false);
  const [deviceSeed, setDeviceSeed] = useState<Partial<Device> | null>(null);
  const [seededAssignmentId, setSeededAssignmentId] = useState<number | null>(null);
  /** Providers start open. Collapsing by default cost a click to see anything at all,
   *  and the page has nothing else on it. Tracked as the collapsed set so groups that
   *  arrive later are open too, without an effect to seed them. */
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set());

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

  function openPool(pool?: ExternalIpPool, providerId: number | null = null) {
    setPoolModal(pool ?? "new");
    setPoolForm(pool ? {
      name: pool.name, provider_id: pool.provider_id,
      account: pool.account, region: pool.region, description: pool.description,
    } : { ...EMPTY_POOL, provider_id: providerId });
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
    const payload = { ...poolForm, account: nullable(poolForm.account ?? ""), description: nullable(poolForm.description ?? "") };
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
          {canWrite && allowCreatePool && <button className="nm-btn nm-btn--sm nm-btn--primary" type="button" onClick={() => openPool()}><Plus size={14} /> Add allocation</button>}
        </header>

        {providerGroups.length === 0 ? <div className="external-ip-empty">Add an allocation for an ISP or cloud account, then create the assets — EC2 instances, VMs, load balancers — that use its addresses.</div> : (
          <div className="nm-table-wrap external-ip-table-wrap"><table className="nm-table nm-table--selectable external-ip-table">
            <colgroup><col className="external-ip-col-provider" /><col className="external-ip-col-account" /><col className="external-ip-col-version" /><col className="external-ip-col-stat" /><col className="external-ip-col-stat" /><col className="external-ip-col-actions" /></colgroup>
            <thead><tr><th>Provider / allocation / address</th><th>Account / owner</th><th>Status</th><th className="nm-table-num">Addresses</th><th className="nm-table-num">In use</th><th className="external-ip-actions">Actions</th></tr></thead>
            <tbody>{providerGroups.map((group) => {
              const collapsed = collapsedProviders.has(group.key);
              const accounts = [...new Set(group.assets.map((entry) => entry.asset.account?.trim()).filter((value): value is string => Boolean(value)))];
              return <Fragment key={group.key}>
                <tr className="external-ip-provider-row" onClick={() => toggleProvider(group.key)}>
                  <td><span className="external-ip-provider-identity">
                    <span className="external-ip-provider-chevron" aria-hidden="true">{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</span>
                    <span className={`external-ip-provider-icon external-ip-provider-icon--${group.provider?.icon ?? "cloud"}`} aria-hidden="true"><CloudProviderIcon icon={group.provider?.icon} iconData={group.provider?.icon_data} size={20} /></span>
                    <span><strong>{group.name}</strong><small>{group.pools.length} allocation{group.pools.length === 1 ? "" : "s"} · {group.trackedCount} tracked · {group.free} free of {group.capacity}</small></span>
                  </span></td>
                  <td><span className="external-ip-provider-accounts">{accounts.length > 0 ? accounts.join(" · ") : "No account references"}</span></td>
                  <td />
                  <td className="nm-table-num external-ip-provider-stat">{group.addressCount}</td>
                  <td className="nm-table-num external-ip-provider-stat">{group.inUse}</td>
                  <td className="external-ip-actions" onClick={(event) => event.stopPropagation()}>{canWrite && group.provider && <button type="button" className="nm-btn nm-btn--sm" onClick={() => openPool(undefined, group.provider?.id ?? null)}><Plus size={13} /> Allocation</button>}</td>
                </tr>

                {!collapsed && <>
                  {group.pools.map((pool, poolIndex) => {
                    const poolOpen = isPoolOpen(pool);
                    const poolPage = addressQuery.data?.get(pool.id);
                    const poolOffset = pageOffsets[pool.id] ?? 0;
                    return <Fragment key={`pool-${pool.id}`}>
                      <tr
                        className={`external-ip-pool-row${poolIndex % 2 === 1 ? " is-alt" : ""}`}
                        onClick={() => setPoolOverrides((current) => ({ ...current, [pool.id]: !poolOpen }))}
                      >
                        <td><span className="external-ip-address-identity">
                          <code className="nm-table-mono">{pool.name}</code>
                          <small>{(pool.allocations ?? []).map((item) => item.cidr).join(", ") || "No ranges"}</small>
                        </span></td>
                        <td><small>{pool.account ?? "—"}{pool.region ? ` · ${pool.region}` : ""}</small></td>
                        <td><span className={`nm-status nm-status--${pool.free === 0 ? "offline" : pool.utilization > 0 ? "online" : "unknown"}`}>{pool.free} free</span></td>
                        <td className="nm-table-num">{pool.total}</td>
                        <td className="nm-table-num">{pool.in_use + pool.reserved}</td>
                        <td className="external-ip-actions" onClick={(event) => event.stopPropagation()}>{canWrite && <span className="nm-table-actions">
                          <button className="nm-btn nm-btn--sm" type="button" onClick={() => { setSelectedPoolId(pool.id); setRangeValue(""); setFormError(null); setRangeModal(true); }}><Plus size={13} /> Range</button>
                          <button className="nm-btn nm-btn--sm" type="button" onClick={() => openPool(pool)}>Edit</button>
                          <button className="nm-btn nm-btn--sm nm-btn--danger" type="button" onClick={() => void removePool(pool)}>Delete</button>
                        </span>}</td>
                      </tr>
                      {/* One address per row, in the same table as everything above it.
                          This used to be a grid of tiles inside a colSpan cell, which read
                          as a separate widget bolted onto the table rather than part of it. */}
                      {poolOpen && <>
                        {addressQuery.isLoading && !poolPage && <tr className="external-ip-address-row"><td colSpan={6}><small>Loading addresses…</small></td></tr>}

                        {(poolPage?.addresses ?? []).map((entry, addressIndex) => {
                          const assignment = entry.assignment;
                          return <tr
                            key={entry.ip_address}
                            className={`external-ip-address-row external-ip-address-row--${entry.status}${addressIndex % 2 === 1 ? " is-alt" : ""}${assignment ? "" : " external-ip-address-row--unassigned"}`}
                            onClick={() => assignment ? openAssignment(assignment) : canWrite && openAssignment(undefined, entry.ip_address, pool.id)}
                          >
                            <td><span className="external-ip-address-identity">
                              <code className="nm-table-mono">{entry.ip_address}</code>
                              <small>{assignment?.asset?.name ?? assignment?.label ?? "Unassigned"}</small>
                            </span></td>
                            <td><small>{assignment?.device?.display_name ?? assignment?.device?.hostname ?? assignment?.owner ?? "—"}</small></td>
                            <td><span className={`nm-status nm-status--${entry.status === "in_use" ? "online" : entry.status === "reserved" ? "paused" : "unknown"}`}>{statusLabel(entry.status)}</span></td>
                            <td className="nm-table-num" />
                            <td className="nm-table-num" />
                            <td className="external-ip-actions" onClick={(event) => event.stopPropagation()}>{canWrite && <span className="nm-table-actions">
                              <button className="nm-btn nm-btn--sm" type="button" onClick={() => assignment ? openAssignment(assignment) : openAssignment(undefined, entry.ip_address, pool.id)}>{assignment ? "Edit" : "Assign"}</button>
                            </span>}</td>
                          </tr>;
                        })}

                        {(poolPage?.total ?? 0) > 256 && <tr className="external-ip-pager-row">
                          <td colSpan={6}>
                            <footer className="external-ip-pager">
                              <span>{poolOffset + 1}–{Math.min(poolOffset + 256, poolPage?.total ?? 0)} of {poolPage?.total}</span>
                              <button className="nm-btn nm-btn--sm" disabled={poolOffset === 0} onClick={() => setPageOffsets((current) => ({ ...current, [pool.id]: Math.max(0, poolOffset - 256) }))}>Previous</button>
                              <button className="nm-btn nm-btn--sm" disabled={poolOffset + 256 >= (poolPage?.total ?? 0)} onClick={() => setPageOffsets((current) => ({ ...current, [pool.id]: poolOffset + 256 }))}>Next</button>
                            </footer>
                          </td>
                        </tr>}
                      </>}
                    </Fragment>;
                  })}
                </>}

              </Fragment>;
            })}</tbody>
          </table></div>
        )}
      </section>

      {poolModal && <Modal title={poolModal === "new" ? "Add allocation" : "Edit allocation"} titleIcon={<span className="ipam-panel-icon" aria-hidden="true"><Globe2 size={18} /></span>} onCancel={() => setPoolModal(null)} footer={<ModalFooterActions onCancel={() => setPoolModal(null)} primaryLabel={busy ? "Saving…" : "Save allocation"} primaryDisabled={busy} formId="external-pool-form" />}>
        <form id="external-pool-form" className="modal-form external-ip-form" onSubmit={(event) => void savePool(event)}>
          <div className="nm-form-row">
            <label>Name<input autoFocus required value={poolForm.name} onChange={(e) => setPoolForm({ ...poolForm, name: e.target.value })} placeholder="Primary WAN allocation" /></label>
            {poolModal === "new" && <label>Public IP allocation<input required value={poolForm.cidr ?? ""} onChange={(e) => setPoolForm({ ...poolForm, cidr: e.target.value })} placeholder="1.1.1.8, 1.1.1.8/32, or 1.1.1.8-1.1.1.14" /></label>}
          </div>
          <div className="nm-form-row">
            <label>Provider<select value={poolForm.provider_id ?? ""} onChange={(e) => setPoolForm({ ...poolForm, provider_id: e.target.value ? Number(e.target.value) : null })}><option value="">No provider</option>{cloudProviders.map((provider) => <option key={provider.key} value={provider.id ?? ""}>{provider.name}</option>)}</select></label>
            <label>Account / subscription<input value={poolForm.account ?? ""} onChange={(e) => setPoolForm({ ...poolForm, account: e.target.value })} placeholder="Subscription, project, or circuit" /></label>
          </div>
          <label>Region<input value={poolForm.region ?? ""} onChange={(e) => setPoolForm({ ...poolForm, region: e.target.value })} placeholder="Cloud region or service area" /></label>
          <label>Description<textarea rows={3} value={poolForm.description ?? ""} onChange={(e) => setPoolForm({ ...poolForm, description: e.target.value })} placeholder="How this allocation is used" /></label>
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

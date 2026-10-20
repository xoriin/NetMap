import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Cloud, Globe, Link2, Search, Server, Star, Unlink } from "lucide-react";
import { api, type Device } from "../../api/client";
import { DashStat } from "../../components/DashStat";
import { EntityChip, EntityChipEmpty } from "../../components/EntityChip";
import { CloudAssetDetails, type CloudAssetRecord, type CloudDeviceFormOptions } from "./CloudAssetDetails";
import { WorkspaceSkeleton } from "../../components/Skeleton";
import { SpaLink } from "../../components/SpaLink";
import { SwatchSelect } from "../../components/SwatchSelect";
import { useApiQuery } from "../../hooks/useApiQuery";
import type { AppRoute } from "../../routes";
import { deviceHealthLabel, type DeviceHealth } from "../../utils/deviceHealth";
import { InventoryColumnHeading, InventoryPagination, InventoryTableFrame } from "./InventoryTableFrame";
import { useInventoryTableColumns } from "./useInventoryTableColumns";

type CloudRow = {
  key: string; name: string; ip: string; kind: string; purpose: string;
  provider: string; location: string; lifecycle: string; device?: Device; deviceId: number | null;
  record: CloudAssetRecord; health: DeviceHealth; monitoring: string; details: [string, string][];
};
const headings = ["Asset", "IP", "Kind", "Purpose", "Monitoring", "Address state", "Provider", "Location / account"];

/** Current addresses and retained resources remain independent records; linking never enables probes. */
export function CloudAssetsPanel({ accessToken, devices, onNavigate, favouriteIds, onToggleFavourite,
  onOpenDevice, selectedDeviceId, deviceDetails, healthFor, livePingEnabled, mutationError, canWriteIpam,
  canCreateDevice, deviceFormOptions, onDeviceCreated }: {
  accessToken: string; devices: Device[]; onNavigate?: (route: AppRoute) => void;
  favouriteIds: Set<number>; onToggleFavourite: (id: number) => void;
  onOpenDevice: (id: number | null) => void; selectedDeviceId: number | null;
  deviceDetails: ReactNode; canWriteIpam: boolean; healthFor: (device: Device) => DeviceHealth; livePingEnabled: boolean; mutationError: string | null;
  canCreateDevice: boolean; deviceFormOptions: CloudDeviceFormOptions; onDeviceCreated: (device: Device) => void;
}) {
  const query = useApiQuery(async () => {
    const [addresses, locations, accounts, providers, assets] = await Promise.all([
      api.listExternalAddresses(accessToken), api.listExternalLocations(accessToken),
      api.listExternalAccounts(accessToken), api.listCloudProviders(accessToken), api.listSavedCloudAssets(accessToken),
    ]);
    return { addresses, locations, accounts, providers, assets };
  }, [accessToken]);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [monitorFilter, setMonitorFilter] = useState("all");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState(0);
  const [ascending, setAscending] = useState(true);
  const { widths, headerRef, startResize, reset } = useInventoryTableColumns({ count: 8, leadingColumns: 1, storageKey: "netmap.cloud_asset_columns_v2" });
  const records = useMemo<CloudRow[]>(() => {
    if (!query.data) return [];
    const { addresses, locations, accounts, providers, assets } = query.data;
    const deviceById = new Map(devices.map(device => [device.id, device]));
    const locationById = new Map(locations.map(location => [location.id, location]));
    const accountById = new Map(accounts.map(account => [account.id, account]));
    const providerById = new Map(providers.map(provider => [provider.id, provider.name]));
    function monitoring(deviceId: number | null, device?: Device) {
      const health = device ? healthFor(device) : "unknown";
      return { device, deviceId, health, monitoring: device
        ? deviceHealthLabel(device, { observed: device.monitor_status ?? device.status, paused: health === "paused" || !livePingEnabled })
        : deviceId !== null ? "Unknown" : "Not monitored" };
    }
    return [
      ...addresses.map(address => {
        const location = locationById.get(address.location_id ?? -1);
        const account = accountById.get(location?.account_id ?? -1);
        const device = deviceById.get(address.device_id ?? -1);
        const identity = device ?? address.device;
        return {
          key: `address-${address.id}`, record: {type: "address" as const,value:address},
          name: identity?.display_name || identity?.hostname || address.label || address.ip_address,
          ip: address.ip_address, kind: "External IP", purpose: address.label || "",
          provider: providerById.get(account?.provider_id ?? -1) || "",
          location: [location?.name, location?.region, account?.name].filter(Boolean).join(" · "),
          lifecycle: address.status === "in_use" ? "In use" : address.status === "reserved" ? "Reserved" : "Available",
          ...monitoring(address.device_id, device),
          details: [["Owner", address.owner || "—"], ["Tags", address.tags || "—"], ["Notes", address.notes || "—"], ["URL", address.url || "—"]] as [string,string][],
        };
      }),
      ...assets.map(asset => {
        const device = deviceById.get(asset.device_id ?? -1);
        return {
          key: `saved-${asset.id}`, record: {type: "resource" as const,value:asset}, name: asset.name, ip: device?.ip_address || "",
          kind: asset.kind?.replace(/_/g, " ") || "Resource", purpose: asset.description || "",
          provider: providerById.get(asset.provider_id ?? -1) || "",
          location: [asset.account, asset.region].filter(Boolean).join(" · "), lifecycle: "",
          ...monitoring(asset.device_id, device), details: [["Description", asset.description || "—"]] as [string,string][],
        };
      }),
    ];
  }, [query.data, devices, healthFor, livePingEnabled]);
  const values = (row: CloudRow) => [row.name, row.ip, row.kind, row.purpose, row.monitoring, row.lifecycle, row.provider, row.location];
  const filtered = records.filter(row =>
    (providerFilter === "all" || row.provider === providerFilter) &&
    (locationFilter === "all" || row.location === locationFilter) &&
    (kindFilter === "all" || row.kind === kindFilter) &&
    (monitorFilter === "all" || (monitorFilter === "unlinked" ? row.deviceId === null : row.deviceId !== null && row.health === monitorFilter)) &&
    (!favouritesOnly || row.device && favouriteIds.has(row.device.id)) &&
    (!search.trim() || [...values(row), ...row.details.map(([,value]) => value)].some(value => value.toLowerCase().includes(search.trim().toLowerCase()))))
    .sort((a,b) => (ascending ? 1 : -1) * values(a)[sort].localeCompare(values(b)[sort], undefined, { numeric: true }) || a.key.localeCompare(b.key));
  useEffect(() => setPage(1), [search, providerFilter, locationFilter, kindFilter, monitorFilter, favouritesOnly, pageSize, sort, ascending]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const detail = records.find(row => row.key === detailKey);
  const linkedCount = new Set(records.flatMap(row => row.deviceId !== null ? [row.deviceId] : [])).size;
  const providerCount = new Set(records.map(row => row.provider).filter(Boolean)).size;
  function options(field: "provider" | "location" | "kind", label: string) {
    return [{value:"all",label}, ...[...new Set(records.map(row => row[field]))].sort().map(value => ({value, label:value || "Unassigned"}))];
  }
  const ipamLink = <SpaLink className="nm-btn nm-btn--secondary" href="/ipam#external" onNavigate={() => {
    onNavigate?.("/ipam"); window.history.replaceState(null, "", "/ipam#external"); window.dispatchEvent(new Event("hashchange"));
  }}>Manage external IPs</SpaLink>;
  function openRow(row: CloudRow) {
    setDetailKey(row.key);
    onOpenDevice(row.device?.id ?? null);
  }
  const activeOverview = detail && query.data ? <CloudAssetDetails key={detail.key}
    record={detail.record} name={detail.name} health={detail.health} monitoring={detail.monitoring} canWrite={canWriteIpam} accessToken={accessToken}
    devices={devices} providers={query.data.providers} locations={query.data.locations} accounts={query.data.accounts}
    canCreateDevice={canCreateDevice} deviceFormOptions={deviceFormOptions} onDeviceCreated={onDeviceCreated}
    deviceDetails={deviceDetails} externalIpAction={ipamLink} onClose={() => {setDetailKey(null);onOpenDevice(null);}} onLinkChange={onOpenDevice}
    onAddressChange={value => query.setData(current => current && ({...current,addresses:current.addresses.map(row=>row.id===value.id ? value : row)}))}
    onResourceChange={value => query.setData(current => current && ({...current,assets:current.assets.map(row=>row.id===value.id ? value : row)}))}
  /> : null;
  if (query.isLoading) return <WorkspaceSkeleton />;
  return <section className="topology-layout inventory-layout inventory-cloud-layout">
    <div className="dash-stats inventory-stats nm-summary-band">
      <DashStat label="Cloud assets" value={query.error ? "—" : records.length} icon={<Cloud size={20} />} accent="teal" />
      <DashStat label="Linked devices" value={query.error ? "—" : linkedCount} icon={<Link2 size={20} />} accent="green" />
      <DashStat label="Not linked" value={query.error ? "—" : records.filter(row => row.deviceId === null).length} icon={<Unlink size={20} />} accent="amber" onClick={() => setMonitorFilter(value => value === "unlinked" ? "all" : "unlinked")} active={monitorFilter === "unlinked"} />
      <DashStat label="Providers" value={query.error ? "—" : providerCount} icon={<Globe size={20} />} accent="purple" />
    </div>
    {mutationError && <div className="form-error" role="alert">{mutationError}</div>}
    <div className={activeOverview ? "topology-content details-open" : "topology-content"}>
      <InventoryTableFrame toolbar={<>
        <span className="inv-panel-title"><span className="inv-panel-title-icon" aria-hidden="true"><Cloud size={17} /></span><span>Cloud assets</span><span className="inv-panel-count">{filtered.length === records.length ? records.length : `${filtered.length} of ${records.length}`}</span></span>
        <SwatchSelect ariaLabel="Filter by provider" value={providerFilter} options={options("provider","All providers")} onChange={setProviderFilter} />
        <SwatchSelect ariaLabel="Filter by cloud location" value={locationFilter} options={options("location","All locations")} onChange={setLocationFilter} />
        <SwatchSelect ariaLabel="Filter by asset kind" value={kindFilter} options={options("kind","All kinds")} onChange={setKindFilter} />
        <SwatchSelect ariaLabel="Filter by monitoring" value={monitorFilter} options={[{value:"all",label:"All monitoring"},{value:"unlinked",label:"Not linked"}, ...["online","offline","warning","unknown","paused","disabled"].map(value => ({value,label:value[0].toUpperCase()+value.slice(1)}))]} onChange={setMonitorFilter} />
        <button type="button" className={`inv-status-tab inv-fav-filter${favouritesOnly ? " active" : ""}`} onClick={() => setFavouritesOnly(value => !value)} title={favouritesOnly ? "Show all assets" : "Show favourites only"}><Star size={13} />Favs</button>
        <span className="inv-sep" />{ipamLink}
        <div className="inv-search-box nm-search"><Search size={14} className="nm-search-icon" /><input className="nm-input" aria-label="Search cloud assets" placeholder="Search assets or addresses…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      </>} header={<><span aria-hidden="true" />{headings.map((label,index) => <InventoryColumnHeading key={label} active={sort === index} ascending={ascending}
        onSort={() => { if (sort === index) setAscending(value => !value); else { setSort(index); setAscending(true); } }}
        onResize={index < headings.length - 1 ? event => startResize(index,event) : undefined} onReset={reset}>{label}</InventoryColumnHeading>)}</>}
        headerRef={headerRef} fixed={widths !== null}
        tableStyle={{ "--inv-grid-template": widths ? `48px ${widths.map(width => `${width}px`).join(" ")}` : "48px minmax(0,1.4fr) minmax(0,1.2fr) minmax(0,.9fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,.9fr) minmax(0,.9fr) minmax(0,1.3fr)" } as CSSProperties}
        footer={filtered.length > 0 && <InventoryPagination total={filtered.length} page={currentPage} pageSize={pageSize} noun="records" onPageChange={setPage} onPageSizeChange={setPageSize} />}>
        {query.error ? <div className="inventory-empty" role="alert">{query.error}<button className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => void query.reload()}>Retry</button></div>
          : !filtered.length ? <div className="inventory-empty">{records.length ? "No cloud assets match the current filters." : "No external IPs tracked yet. Add an external IP in IPAM to get started."}</div>
          : visible.map(row => <div key={row.key} className={`inventory-row${row.key === detailKey && (!row.device || row.device.id === selectedDeviceId) ? " active" : ""}`} data-cloud-record={row.key}
            onClick={() => openRow(row)}>
            <span className="inventory-row-check">{row.device && <button type="button" className={`fav-btn${favouriteIds.has(row.device.id) ? " fav-btn--active" : ""}`} title={favouriteIds.has(row.device.id) ? "Remove from favourites" : "Add to favourites"}
              onClick={event => {event.stopPropagation(); onToggleFavourite(row.device!.id);}}><Star size={13} fill={favouriteIds.has(row.device.id) ? "currentColor" : "none"} /></button>}</span>
            <button type="button" className="inventory-row-device" aria-label={`Open ${row.name} details`} onClick={event => {event.stopPropagation(); openRow(row);}}>
              <span className={`status-dot status-dot--sm ${row.health}`} /><span>{row.name}</span>
            </button>
            <span className="inventory-row-os" title={row.ip}>{row.ip || "—"}</span>
            <span><EntityChip label={row.kind} icon={<Server size={13} />} /></span>
            <span className="inventory-row-os" title={row.purpose}>{row.purpose || "—"}</span>
            <span className={`status-pill ${row.health}`} title={row.monitoring}><span className="status-pill-text">{row.monitoring}</span></span>
            <span>{row.lifecycle ? <span className="nm-status nm-status--unknown">{row.lifecycle}</span> : <EntityChipEmpty />}</span>
            <span>{row.provider ? <EntityChip label={row.provider} /> : <EntityChipEmpty />}</span>
            <span>{row.location ? <EntityChip label={row.location} /> : <EntityChipEmpty />}</span>
          </div>)}
      </InventoryTableFrame>
      {activeOverview}
    </div>

  </section>;
}

import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Cloud, ChevronDown, ChevronRight, Search } from "lucide-react";
import { api, type Device, type ExternalIpAddress } from "../../api/client";
import { WorkspaceSkeleton } from "../../components/Skeleton";
import { SpaLink } from "../../components/SpaLink";
import { useApiQuery } from "../../hooks/useApiQuery";
import type { AppRoute } from "../../routes";
import { InventoryColumnHeading, InventoryPagination, InventoryTableFrame } from "./InventoryTableFrame";
import { useInventoryTableColumns } from "./useInventoryTableColumns";

/** A read-only projection of the current address register; never revives legacy pools. */
export function CloudAssetsPanel({ accessToken, devices, onNavigate }: {
  accessToken: string;
  devices: Device[];
  onNavigate?: (route: AppRoute) => void;
}) {
  const query = useApiQuery(async () => {
    const [addresses, locations, accounts, providers, assets] = await Promise.all([
      api.listExternalAddresses(accessToken), api.listExternalLocations(accessToken),
      api.listExternalAccounts(accessToken), api.listCloudProviders(accessToken), api.listSavedCloudAssets(accessToken),
    ]);
    return { addresses, locations, accounts, providers, assets };
  }, [accessToken]);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    if (!query.data) return [];
    const { addresses, locations, accounts, providers } = query.data;
    const deviceById = new Map(devices.map(device => [device.id, device]));
    const locationById = new Map(locations.map(location => [location.id, location]));
    const accountById = new Map(accounts.map(account => [account.id, account]));
    const providerById = new Map(providers.map(provider => [provider.id, provider]));
    type Row = { address: ExternalIpAddress; name: string; location: string };
    const buckets = new Map<string, { key: string; name: string; rows: Row[] }>();
    for (const address of addresses) {
      const location = locationById.get(address.location_id ?? -1);
      const account = accountById.get(location?.account_id ?? -1);
      const provider = providerById.get(account?.provider_id ?? -1);
      const device = deviceById.get(address.device_id ?? -1) ?? address.device;
      const name = device ? device.display_name || device.hostname || device.ip_address : "Not linked to Inventory";
      const providerName = provider?.name ?? "No provider";
      const locationName = [location?.name, location?.region, account?.name].filter(Boolean).join(" · ");
      const q = search.trim().toLowerCase();
      if (q && ![address.ip_address, address.label, address.owner, address.tags, name, providerName, locationName]
        .some(value => value?.toLowerCase().includes(q))) continue;
      const key = `${provider?.id ?? "none"}:${address.device_id ?? "unlinked"}`;
      const bucket = buckets.get(key) ?? { key, name: `${providerName} · ${name}`, rows: [] };
      bucket.rows.push({ address, name, location: locationName });
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [query.data, devices, search]);
  const savedAssets = (query.data?.assets ?? []).filter(asset => !search.trim() ||
    [asset.name, asset.kind, asset.account, asset.region, asset.description].some(value => value?.toLowerCase().includes(search.trim().toLowerCase())));
  const count = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState(0);
  const [ascending, setAscending] = useState(true);
  const { widths, headerRef, startResize, reset } = useInventoryTableColumns({ count: 5, storageKey: "netmap.cloud_asset_columns" });
  const total = count + savedAssets.length;
  useEffect(() => setPage(1), [search, pageSize, sort, ascending]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
  const savedRows = savedAssets.map(asset => {
    const device = devices.find(row => row.id === asset.device_id);
    const provider = query.data?.providers.find(row => row.id === asset.provider_id);
    return { key: `saved-${asset.id}`, groupKey: "saved", groupName: "Saved cloud resources", values: [
      `${asset.name}${asset.kind ? ` · ${asset.kind.replace(/_/g, " ")}` : ""}`, device?.ip_address || "—", asset.description || "—",
      [provider?.name, asset.account, asset.region].filter(Boolean).join(" · ") || "—", device ? "Device linked" : "Not monitored",
    ], status: "unknown" };
  });
  const records = [...groups.flatMap(group => group.rows.map(({address, name, location}) => ({
    key: `address-${address.id}`, groupKey: group.key, groupName: group.name,
    values: [name, address.ip_address, address.label || "—", location || "—", address.status === "in_use" ? "In use" : address.status === "reserved" ? "Reserved" : "Available"],
    status: address.status === "in_use" ? "online" : address.status === "reserved" ? "paused" : "unknown",
  }))), ...savedRows].sort((a,b) => a.groupName.localeCompare(b.groupName) || (ascending ? 1 : -1) * a.values[sort].localeCompare(b.values[sort], undefined, {numeric:true}));
  const visible = records.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  function toggle(key: string) {
    setCollapsed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  const ipamLink = <SpaLink className="nm-btn nm-btn--secondary" href="/ipam#external" onNavigate={() => {
    onNavigate?.("/ipam"); window.history.replaceState(null, "", "/ipam#external"); window.dispatchEvent(new Event("hashchange"));
  }}>Manage external IPs</SpaLink>;
  if (query.isLoading) return <WorkspaceSkeleton />;
  return <section className="topology-layout inventory-layout"><div className="topology-content">
    <InventoryTableFrame
      toolbar={<>
        <span className="inv-panel-title"><span className="inv-panel-title-icon" aria-hidden="true"><Cloud size={17} /></span><span>Cloud assets</span><span className="inv-panel-count">{total}</span></span>
        {ipamLink}
        <div className="inv-search-box nm-search"><Search size={14} className="nm-search-icon" /><input className="nm-input" aria-label="Search cloud assets" placeholder="Search assets or addresses…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      </>}
      header={<>{["Asset", "IP", "Purpose", "Location / account", "Status"].map((label,index) => <InventoryColumnHeading key={label}
        active={sort === index} ascending={ascending} onSort={() => { if (sort === index) setAscending(value => !value); else { setSort(index); setAscending(true); } }}
        onResize={index < 4 ? event => startResize(index,event) : undefined} onReset={reset}>{label}</InventoryColumnHeading>)}</>}
      headerRef={headerRef} fixed={widths !== null}
      tableStyle={{ "--inv-grid-template": widths ? widths.map(width => `${width}px`).join(" ") : "minmax(0, 1.5fr) minmax(0, 1.2fr) minmax(0, 1.8fr) minmax(0, 1.5fr) minmax(0, 1fr)" } as CSSProperties}
      footer={total > 0 && <InventoryPagination total={total} page={currentPage} pageSize={pageSize} noun="records" onPageChange={setPage} onPageSizeChange={setPageSize} />}
    >
      {query.error ? <div className="inventory-empty" role="alert">{query.error}<button className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => void query.reload()}>Retry</button></div>
      : total === 0 ? <div className="inventory-empty">{(query.data?.addresses.length || query.data?.assets.length) ? "No cloud assets match this search." : "No external IPs tracked yet. Add an external IP in IPAM to get started."}</div>
      : visible.map((row,index) => <Fragment key={row.key}>
        {(index === 0 || visible[index - 1].groupKey !== row.groupKey) && <div className="inventory-row">
          <button className="inventory-row-device" style={{gridColumn:"1 / -1"}} aria-expanded={!collapsed.has(row.groupKey)} onClick={() => toggle(row.groupKey)}>
            {collapsed.has(row.groupKey) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{row.groupName} ({records.filter(record => record.groupKey === row.groupKey).length})</span>
          </button>
        </div>}
        {!collapsed.has(row.groupKey) && <div className="inventory-row" data-cloud-record={row.key}>
          {row.values.map((value,column) => column === 4
            ? <span key={column} className={`status-pill ${row.status}`} title={value}><span className="status-pill-text">{value}</span></span>
            : <span key={column} className="inventory-row-os" title={value}>{value}</span>)}
        </div>}
      </Fragment>)}
    </InventoryTableFrame>
  </div></section>;
}

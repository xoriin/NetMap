import { Fragment, useMemo, useState } from "react";
import { Cloud, ChevronDown, ChevronRight, Search } from "lucide-react";
import { api, type Device, type ExternalIpAddress } from "../../api/client";
import { WorkspaceSkeleton } from "../../components/Skeleton";
import { SpaLink } from "../../components/SpaLink";
import { useApiQuery } from "../../hooks/useApiQuery";
import type { AppRoute } from "../../routes";

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
  function toggle(key: string) {
    setCollapsed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  const ipamLink = <SpaLink className="nm-btn nm-btn--sm nm-btn--secondary" href="/ipam#external" onNavigate={() => {
    onNavigate?.("/ipam"); window.history.replaceState(null, "", "/ipam#external"); window.dispatchEvent(new Event("hashchange"));
  }}>Manage external IPs</SpaLink>;
  if (query.isLoading) return <WorkspaceSkeleton />;
  return <section className="inventory-layout inventory-cloud-workspace">
    <div className="nm-app-panel inventory-cloud-panel">
      <header className="nm-app-panel-header inventory-cloud-header">
        <div className="inv-panel-title"><span className="inv-panel-title-icon"><Cloud size={18} /></span><span>Cloud assets</span><span className="inv-panel-count">{count} addresses{savedAssets.length > 0 ? ` · ${savedAssets.length} resources` : ""}</span></div>
        <div className="inventory-cloud-controls">
          <div className="nm-search"><Search size={14} /><input className="nm-input" aria-label="Search cloud assets" placeholder="Search assets or addresses…" value={search} onChange={event => setSearch(event.target.value)} /></div>
          {ipamLink}
        </div>
      </header>
      {query.error ? <div className="nm-panel-body" role="alert">{query.error} <button className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => void query.reload()}>Retry</button></div>
      : count === 0 && savedAssets.length === 0 ? <div className="nm-panel-body">{(query.data?.addresses.length || query.data?.assets.length) ? "No cloud assets match this search." : "No external IPs tracked yet. Add an external IP in IPAM to get started."}</div>
      : <div className="nm-table-wrap inventory-cloud-table-wrap"><table className="nm-table inventory-cloud-table">
        <thead><tr><th>Asset</th><th>Address</th><th>Purpose</th><th>Location / account</th><th>Status</th></tr></thead>
        <tbody>{groups.map(group => <Fragment key={group.key}>
          <tr className="inventory-cloud-group"><td colSpan={5}><button className="nm-btn nm-btn--sm nm-btn--ghost" aria-expanded={!collapsed.has(group.key)} onClick={() => toggle(group.key)}>{collapsed.has(group.key) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{group.name} ({group.rows.length})</button></td></tr>
          {!collapsed.has(group.key) && group.rows.map(({ address, name, location }) => <tr key={address.id}>
            <td>{name}</td><td className="nm-table-mono">{address.ip_address}</td><td>{address.label || "—"}</td><td>{location || "—"}</td>
            <td><span className={`nm-status nm-status--${address.status === "in_use" ? "online" : address.status === "reserved" ? "paused" : "unknown"}`}>{address.status === "in_use" ? "In use" : address.status === "reserved" ? "Reserved" : "Available"}</span></td>
          </tr>)}
        </Fragment>)}
        {savedAssets.length > 0 && <tr className="inventory-cloud-group"><td colSpan={5}>Saved cloud resources</td></tr>}
        {savedAssets.map(asset => {
          const device = devices.find(row => row.id === asset.device_id);
          const provider = query.data?.providers.find(row => row.id === asset.provider_id);
          return <tr key={`saved-${asset.id}`}>
            <td>{asset.name}{asset.kind ? ` · ${asset.kind.replace(/_/g, " ")}` : ""}</td>
            <td className="nm-table-mono">{device?.ip_address || "—"}</td>
            <td>{asset.description || "—"}</td>
            <td>{[provider?.name, asset.account, asset.region].filter(Boolean).join(" · ") || "—"}</td>
            <td><span className="nm-status nm-status--unknown">{device ? "Device linked" : "Not monitored"}</span></td>
          </tr>;
        })}</tbody>
      </table></div>}
    </div>
  </section>;
}

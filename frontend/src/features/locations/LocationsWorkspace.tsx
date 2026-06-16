import { useState, useEffect, useRef, useMemo, useContext, type FormEvent } from "react";
import { Search } from "lucide-react";
import { IconMapPin, IconServer, IconDeviceDesktop, IconBolt } from "@tabler/icons-react";
import { api, type Site, type TopologyGraph } from "../../api/client";
import { TopbarNoteCtx } from "../../context";
import { blankToNull } from "../../utils/format";
import { DashStat } from "../../components/DashStat";
import { Modal } from "../../components/Modal";

export function LocationsWorkspace({
  accessToken,
  canWrite,
  graph,
  onGraphChange,
}: {
  accessToken: string;
  canWrite: boolean;
  graph: TopologyGraph;
  onGraphChange: () => Promise<void>;
}) {
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', display_name: '', description: '', address: '', color: '' });
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [detailSite, setDetailSite] = useState<Site | null>(null);
  const [geocodeResult, setGeocodeResult] = useState<{ lat: number; lon: number } | null | 'loading'>(null);
  const geocodeCache = useRef<Map<number, { lat: number; lon: number } | null>>(new Map());
  const setTopbarNote = useContext(TopbarNoteCtx);

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  const deviceCountBySite = useMemo(() => {
    const counts = new Map<number, number>();
    for (const device of graph.devices) {
      if (device.site_id !== null) {
        counts.set(device.site_id, (counts.get(device.site_id) ?? 0) + 1);
      }
    }
    return counts;
  }, [graph.devices]);

  const unassignedDeviceCount = useMemo(
    () => graph.devices.filter((d) => d.site_id === null).length,
    [graph.devices],
  );

  const filteredSortedSites = useMemo(() => {
    const q = search.toLowerCase().trim();
    const rows = q
      ? sites.filter((s) =>
          s.name.toLowerCase().includes(q) ||
          (s.display_name ?? '').toLowerCase().includes(q) ||
          (s.address ?? '').toLowerCase().includes(q) ||
          (s.description ?? '').toLowerCase().includes(q)
        )
      : sites;
    return [...rows].sort((a, b) => {
      if (sortKey === 'devices') {
        const diff = (deviceCountBySite.get(a.id) ?? 0) - (deviceCountBySite.get(b.id) ?? 0);
        return sortDir === 'asc' ? diff : -diff;
      }
      const vals: Record<string, [string, string]> = {
        name: [a.name, b.name],
        address: [a.address ?? '', b.address ?? ''],
      };
      const [aVal, bVal] = vals[sortKey] ?? [a.name, b.name];
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [sites, search, sortKey, sortDir, deviceCountBySite]);

  async function loadSites() {
    setSitesLoading(true);
    setError(null);
    try {
      const rows = await api.sites(accessToken);
      setSites(rows);
    } finally {
      setSitesLoading(false);
    }
  }

  useEffect(() => {
    void loadSites().catch((err) => {
      setError(err instanceof Error ? err.message : 'Unable to load locations');
      setSitesLoading(false);
    });
  }, [accessToken]);

  function openCreateForm() {
    setDetailSite(null);
    setEditingId(null);
    setForm({ name: '', display_name: '', description: '', address: '', color: '' });
    setError(null);
    setShowForm(true);
  }

  function openEditForm(site: Site) {
    setDetailSite(null);
    setEditingId(site.id);
    setForm({
      name: site.name,
      display_name: site.display_name ?? '',
      description: site.description ?? '',
      address: site.address ?? '',
      color: site.color ?? '',
    });
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setError(null);
  }

  async function showSiteDetail(site: Site) {
    if (showForm) return;
    setDetailSite(site);
    if (!site.address) {
      setGeocodeResult(null);
      return;
    }
    if (geocodeCache.current.has(site.id)) {
      setGeocodeResult(geocodeCache.current.get(site.id) ?? null);
      return;
    }
    setGeocodeResult('loading');
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(site.address)}`,
        { headers: { 'User-Agent': 'NetMap/1.0' } },
      );
      const data = await resp.json() as Array<{ lat: string; lon: string }>;
      const coords = data.length > 0 ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) } : null;
      geocodeCache.current.set(site.id, coords);
      setGeocodeResult(coords);
    } catch {
      geocodeCache.current.set(site.id, null);
      setGeocodeResult(null);
    }
  }

  async function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    const name = form.name.trim();
    if (!name) { setError('Location name is required'); return; }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name,
        display_name: blankToNull(form.display_name),
        description: blankToNull(form.description),
        address: blankToNull(form.address),
        color: blankToNull(form.color) as string | null,
      };
      if (editingId !== null) {
        await api.updateSite(accessToken, editingId, payload);
      } else {
        await api.createSite(accessToken, payload);
      }
      await loadSites();
      await onGraphChange();
      setShowForm(false);
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : editingId !== null ? 'Unable to update location' : 'Unable to create location');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSite(siteId: number, siteName: string) {
    if (!canWrite) return;
    if (!window.confirm(`Delete location "${siteName}"? Assigned devices will be unlinked.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteSite(accessToken, siteId);
      setSites((current) => current.filter((s) => s.id !== siteId));
      geocodeCache.current.delete(siteId);
      await onGraphChange();
      if (editingId === siteId) setShowForm(false);
      if (detailSite?.id === siteId) setDetailSite(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete location');
    } finally {
      setBusy(false);
    }
  }

  const sortCols: { key: string; label: string; sortable?: boolean }[] = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'address', label: 'Address', sortable: true },
    { key: 'devices', label: 'Devices', sortable: true },
  ];

  const locationFormFields = (
    <div className="vlan-form-grid">
      <label className="ipam-form-label">Name *
        <input className="ipam-form-input" required value={form.name} onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))} />
      </label>
      <label className="ipam-form-label">Display name
        <input className="ipam-form-input" placeholder="e.g. London HQ" value={form.display_name} onChange={(event) => setForm((c) => ({ ...c, display_name: event.target.value }))} />
      </label>
      <label className="ipam-form-label vlan-form-grid__full">Address
        <input className="ipam-form-input" placeholder="e.g. 123 Main St, London, UK" value={form.address} onChange={(event) => setForm((c) => ({ ...c, address: event.target.value }))} />
      </label>
      <label className="ipam-form-label">Description
        <input className="ipam-form-input" value={form.description} onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))} />
      </label>
      <label className="ipam-form-label">Colour
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <input type="color" value={form.color || '#6366f1'} style={{ width: 44, height: 34, padding: 2, cursor: 'pointer', borderRadius: 6, border: '1px solid var(--border)' }} onChange={(event) => setForm((c) => ({ ...c, color: event.target.value }))} />
          <span style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.7 }}>{form.color || '#6366f1'}</span>
          {form.color && <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost" onClick={() => setForm((c) => ({ ...c, color: '' }))}>Clear</button>}
        </div>
      </label>
      {error && <p className="form-error vlan-form-grid__full">{error}</p>}
    </div>
  );

  useEffect(() => {
    return () => setTopbarNote("");
  }, [setTopbarNote]);

  useEffect(() => {
    setTopbarNote(
      <div className="loc-topbar-actions">
        <div className="nm-search nm-search--toolbar loc-topbar-search">
          <Search size={14} className="nm-search-icon" aria-hidden="true" />
          <input
            className="nm-input"
            type="search"
            placeholder="Search locations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {canWrite && (
          <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={busy} onClick={openCreateForm}>
            + New location
          </button>
        )}
      </div>
    );
  }, [busy, canWrite, search, setTopbarNote]);

  return (
    <section className="dash-layout">
      {!sitesLoading && (
        <div className="dash-stats loc-stats">
          <DashStat label="Total sites" value={sites.length} sub="locations configured" icon={<IconMapPin size={20} />} accent="teal" />
          <DashStat label="Assigned devices" value={[...deviceCountBySite.values()].reduce((a, b) => a + b, 0)} sub="with a location" icon={<IconServer size={20} />} accent="green" />
          <DashStat label="Unassigned" value={unassignedDeviceCount} sub={unassignedDeviceCount > 0 ? "no location set" : "all assigned"} icon={<IconDeviceDesktop size={20} />} accent={unassignedDeviceCount > 0 ? "red" : "teal"} />
          <DashStat label="Links" value={graph.relationships.length} sub="topology connections" icon={<IconBolt size={20} />} accent="blue" />
        </div>
      )}

      {error && <div className="form-error" style={{ margin: '0 0 8px' }}>{error}</div>}

      {/* Card grid */}
      {sitesLoading ? (
        <div className="loc-grid">
          {[1,2,3].map((n) => (
            <div key={n} className="loc-card" style={{ cursor: 'default' }}>
              <div className="loc-card-accent" />
              <div className="loc-card-body">
                <div className="skeleton-line" style={{ height: 14, width: '60%' }} />
                <div className="skeleton-line" style={{ height: 11, width: '40%', marginTop: 6 }} />
              </div>
            </div>
          ))}
        </div>
      ) : filteredSortedSites.length === 0 ? (
        <div className="dash-empty-state" style={{ flex: 1 }}>
          <div className="dash-empty-icon"><IconMapPin size={22} /></div>
          <div className="dash-empty-title">
            {search ? 'No locations match your search' : 'No locations yet'}
          </div>
          <div className="dash-empty-desc">
            {search ? 'Try a different search term.' : 'Create a location to start organising your multi-site topology.'}
          </div>
          {!search && canWrite && (
            <button type="button" className="dash-empty-action" onClick={openCreateForm}>Add location</button>
          )}
        </div>
      ) : (
        <div className="loc-grid">
          {filteredSortedSites.map((site) => {
            const deviceCount = deviceCountBySite.get(site.id) ?? 0;
            const isSelected = detailSite?.id === site.id && !showForm;
            return (
              <div
                key={site.id}
                className={`loc-card${isSelected ? ' loc-card--selected' : ''}`}
                onClick={() => void showSiteDetail(site)}
              >
                <div className="loc-card-accent" style={{ background: site.color || undefined }} />
                <div className="loc-card-body">
                  <div className="loc-card-name">{site.display_name ?? site.name}</div>
                  {site.display_name && site.display_name !== site.name && (
                    <div className="loc-card-sub">{site.name}</div>
                  )}
                  {site.description && <div className="loc-card-sub">{site.description}</div>}
                  {site.address && <div className="loc-card-addr"><IconMapPin size={10} style={{ marginRight: 4, verticalAlign: 'middle', flexShrink: 0 }} />{site.address}</div>}
                </div>
                <div className="loc-card-footer">
                  <span className={`loc-item-badge${deviceCount === 0 ? ' loc-item-badge--zero' : ''}`}>
                    {deviceCount} {deviceCount === 1 ? 'device' : 'devices'}
                  </span>
                  {canWrite && (
                    <div className="loc-card-actions" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="nm-btn nm-btn--sm" disabled={busy} onClick={() => openEditForm(site)}>Edit</button>
                      <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={busy} onClick={() => void handleDeleteSite(site.id, site.display_name ?? site.name)}>Delete</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {detailSite && !showForm && (
        <Modal
          title={detailSite.display_name ?? detailSite.name}
          onCancel={() => setDetailSite(null)}
          size="sm"
          headerExtra={detailSite.color ? (
            <span className="loc-detail-swatch" style={{ background: detailSite.color }} aria-hidden />
          ) : undefined}
          footer={canWrite ? (
            <button type="button" className="nm-btn nm-btn--primary" onClick={() => openEditForm(detailSite)}>Edit location</button>
          ) : undefined}
        >
          <div className="loc-detail-body">
            <dl className="loc-detail-meta">
              {detailSite.display_name && <><dt>Name</dt><dd>{detailSite.name}</dd></>}
              {detailSite.description && <><dt>Description</dt><dd>{detailSite.description}</dd></>}
              {detailSite.address && <><dt>Address</dt><dd>{detailSite.address}</dd></>}
              <dt>Devices</dt>
              <dd>{deviceCountBySite.get(detailSite.id) ?? 0} assigned</dd>
            </dl>
            {detailSite.address && (
              geocodeResult === 'loading' ? (
                <div className="dash-panel-meta" style={{ textAlign: 'center', padding: '20px 0' }}>Locating on map…</div>
              ) : geocodeResult ? (
                <div>
                  <iframe
                    className="loc-detail-map"
                    src={`https://www.openstreetmap.org/export/embed.html?bbox=${geocodeResult.lon - 0.012},${geocodeResult.lat - 0.008},${geocodeResult.lon + 0.012},${geocodeResult.lat + 0.008}&layer=mapnik&marker=${geocodeResult.lat},${geocodeResult.lon}`}
                    title="Location map"
                    loading="lazy"
                  />
                  <a href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(detailSite.address)}`} target="_blank" rel="noopener noreferrer" className="dash-panel-link" style={{ fontSize: '0.75em', display: 'block', marginTop: 6 }}>View larger map ↗</a>
                </div>
              ) : (
                <div className="dash-panel-meta" style={{ fontSize: '0.82em' }}>
                  Address not found on map.{' '}
                  <a href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(detailSite.address)}`} target="_blank" rel="noopener noreferrer" className="dash-panel-link">Search manually ↗</a>
                </div>
              )
            )}
          </div>
        </Modal>
      )}

      {/* Create / edit form */}
      {showForm && (
        <Modal
          title={editingId !== null ? 'Edit location' : 'New location'}
          onCancel={closeForm}
          footer={(
            <div className="nm-btn-row" style={{ width: '100%', justifyContent: 'flex-end' }}>
              <button type="button" className="nm-btn" disabled={busy} onClick={closeForm}>Cancel</button>
              <button type="submit" form="location-form" className="nm-btn nm-btn--primary" disabled={busy}>
                {editingId !== null ? 'Save changes' : 'Create location'}
              </button>
            </div>
          )}
        >
          <form id="location-form" className="modal-form" style={{ padding: "18px 20px" }} onSubmit={(e) => void handleFormSubmit(e)}>
            {locationFormFields}
          </form>
        </Modal>
      )}
    </section>
  );
}

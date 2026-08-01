import { useState, useRef, useMemo, type FormEvent, type KeyboardEvent } from "react";
import "./locations.css";
import { useApiQuery, useApiMutation } from "../../hooks/useApiQuery";
import { useSortableData } from "../../hooks/useSortableData";
import { Search } from "lucide-react";
import { IconMapPin, IconServer, IconDeviceDesktop, IconBolt } from "@tabler/icons-react";
import { api, type Site, type TopologyGraph } from "../../api/client";
import { blankToNull } from "../../utils/format";
import { DashStat } from "../../components/DashStat";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { useConfirm } from "../../components/ConfirmDialog";

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
  const confirmAction = useConfirm();
  const sitesQuery = useApiQuery(() => api.sites(accessToken), [accessToken]);
  const sites = useMemo(() => sitesQuery.data ?? [], [sitesQuery.data]);
  const sitesLoading = sitesQuery.isLoading;
  const [formError, setFormError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', display_name: '', description: '', address: '', color: '' });
  const [search, setSearch] = useState('');
  const { sortKey, sortDir, toggleSort } = useSortableData<string>('name');
  const [detailSite, setDetailSite] = useState<Site | null>(null);
  const [geocodeResult, setGeocodeResult] = useState<{ lat: number; lon: number } | null | 'loading'>(null);
  const geocodeCache = useRef<Map<number, { lat: number; lon: number } | null>>(new Map());

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

  const saveSite = useApiMutation(
    async (payload: Parameters<typeof api.createSite>[1], siteId: number | null) => {
      if (siteId !== null) {
        return api.updateSite(accessToken, siteId, payload);
      }
      return api.createSite(accessToken, payload);
    },
    { errorToast: false },
  );

  const removeSite = useApiMutation(
    (siteId: number) => api.deleteSite(accessToken, siteId),
    { successMessage: "Location deleted" },
  );

  const busy = saveSite.isBusy || removeSite.isBusy;

  function openCreateForm() {
    setDetailSite(null);
    setEditingId(null);
    setForm({ name: '', display_name: '', description: '', address: '', color: '' });
    setFormError(null);
    saveSite.clearError();
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
    setFormError(null);
    saveSite.clearError();
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setFormError(null);
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
    if (!name) { setFormError('Location name is required'); return; }
    setFormError(null);
    const saved = await saveSite.run({
      name,
      display_name: blankToNull(form.display_name),
      description: blankToNull(form.description),
      address: blankToNull(form.address),
      color: blankToNull(form.color) as string | null,
    }, editingId);
    if (saved === null) return;
    await sitesQuery.reload();
    await onGraphChange();
    setShowForm(false);
    setEditingId(null);
  }

  async function handleDeleteSite(siteId: number, siteName: string) {
    if (!canWrite) return;
    const confirmed = await confirmAction({
      title: "Delete location",
      message: `Delete location "${siteName}"?`,
      detail: "Assigned devices will be unlinked from this location. The devices themselves are kept.",
      confirmLabel: "Delete location",
    });
    if (!confirmed) return;
    const deleted = await removeSite.run(siteId);
    if (deleted === null) return;
    sitesQuery.setData((current) => (current ?? []).filter((s) => s.id !== siteId));
    geocodeCache.current.delete(siteId);
    await onGraphChange();
    if (editingId === siteId) setShowForm(false);
    if (detailSite?.id === siteId) setDetailSite(null);
  }

  const locationFormFields = (
    <div className="vlan-form-grid">
      <label className="nm-field"><span className="nm-field-label">Name *</span>
        <input className="nm-input" required value={form.name} onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))} />
      </label>
      <label className="nm-field"><span className="nm-field-label">Display name</span>
        <input className="nm-input" placeholder="e.g. London HQ" value={form.display_name} onChange={(event) => setForm((c) => ({ ...c, display_name: event.target.value }))} />
      </label>
      <label className="nm-field vlan-form-grid__full"><span className="nm-field-label">Address</span>
        <input className="nm-input" placeholder="e.g. 123 Main St, London, UK" value={form.address} onChange={(event) => setForm((c) => ({ ...c, address: event.target.value }))} />
      </label>
      <label className="nm-field"><span className="nm-field-label">Description</span>
        <input className="nm-input" value={form.description} onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))} />
      </label>
      <label className="nm-field"><span className="nm-field-label">Colour</span>
        <div className="loc-colour-field">
          <input className="loc-colour-input" type="color" value={form.color || '#6366f1'} aria-label="Location colour" onChange={(event) => setForm((c) => ({ ...c, color: event.target.value }))} />
          <span className="loc-colour-value">{form.color || '#6366f1'}</span>
          {form.color && <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost" onClick={() => setForm((c) => ({ ...c, color: '' }))}>Clear</button>}
        </div>
      </label>
      {(formError ?? saveSite.error) && <p className="form-error vlan-form-grid__full">{formError ?? saveSite.error}</p>}
    </div>
  );

  function inspectFromKeyboard(event: KeyboardEvent<HTMLDivElement>, site: Site) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void showSiteDetail(site);
  }

  return (
    <section className="dash-layout locations-workspace">
      {!sitesLoading && (
        <div className="dash-stats loc-stats nm-summary-band">
          <DashStat label="Total sites" value={sites.length} sub="locations configured" icon={<IconMapPin size={20} />} accent="teal" />
          <DashStat label="Assigned devices" value={[...deviceCountBySite.values()].reduce((a, b) => a + b, 0)} sub="with a location" icon={<IconServer size={20} />} accent="green" />
          <DashStat label="Unassigned" value={unassignedDeviceCount} sub={unassignedDeviceCount > 0 ? "no location set" : "all assigned"} icon={<IconDeviceDesktop size={20} />} accent={unassignedDeviceCount > 0 ? "red" : "teal"} />
          <DashStat label="Links" value={graph.relationships.length} sub="topology connections" icon={<IconBolt size={20} />} accent="blue" />
        </div>
      )}

      {sitesQuery.error && <div className="error-banner">{sitesQuery.error}</div>}

      <div className="nm-app-panel locations-panel">
        <div className="nm-app-panel-header locations-panel-header">
          <span className="locations-panel-title">
            <span className="locations-panel-icon" aria-hidden="true"><IconMapPin size={18} /></span>
            <span className="locations-panel-separator">-</span>
            <span>Locations</span>
            <span className="locations-panel-count">
              {filteredSortedSites.length !== sites.length
                ? `${filteredSortedSites.length} of ${sites.length}`
                : sites.length}
            </span>
          </span>
          <div className="locations-panel-actions">
            <select
              className="nm-select locations-sort-select"
              aria-label="Sort locations"
              value={sortKey}
              onChange={(event) => {
                if (event.target.value !== sortKey) toggleSort(event.target.value);
              }}
            >
              <option value="name">Sort by name</option>
              <option value="address">Sort by address</option>
              <option value="devices">Sort by devices</option>
            </select>
            <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost locations-sort-direction" onClick={() => toggleSort(sortKey)} aria-label={`Sort ${sortDir === 'asc' ? 'descending' : 'ascending'}`}>
              {sortDir === 'asc' ? 'A–Z' : 'Z–A'}
            </button>
            <div className="nm-search nm-search--toolbar locations-search">
              <Search size={14} className="nm-search-icon" aria-hidden="true" />
              <input className="nm-input" type="search" aria-label="Search locations" placeholder="Search locations…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {canWrite && (
              <button type="button" className="nm-btn nm-btn--primary" disabled={busy} onClick={openCreateForm}>+ New location</button>
            )}
          </div>
        </div>
        <div className="locations-panel-body">
          {sitesLoading ? (
            <div className="loc-grid locations-card-grid">
              {[1,2,3].map((n) => (
                <div key={n} className="loc-card loc-card--loading">
                  <div className="loc-card-accent" />
                  <div className="loc-card-body">
                    <div className="skeleton-line loc-skeleton-title" />
                    <div className="skeleton-line loc-skeleton-copy" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredSortedSites.length === 0 ? (
            <div className="dash-empty-state locations-empty-state">
              <div className="dash-empty-icon"><IconMapPin size={22} /></div>
              <div className="dash-empty-title">{search ? 'No locations match your search' : 'No locations yet'}</div>
              <div className="dash-empty-desc">{search ? 'Try a different search term.' : 'Create a location to start organising your multi-site topology.'}</div>
              {!search && canWrite && <button type="button" className="nm-btn nm-btn--primary" onClick={openCreateForm}>Add location</button>}
            </div>
          ) : (
            <div className="loc-grid locations-card-grid">
              {filteredSortedSites.map((site) => {
                const deviceCount = deviceCountBySite.get(site.id) ?? 0;
                const isSelected = detailSite?.id === site.id && !showForm;
                return (
                  <div
                    key={site.id}
                    className={`loc-card${isSelected ? ' loc-card--selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${site.display_name ?? site.name}`}
                    onClick={() => void showSiteDetail(site)}
                    onKeyDown={(event) => inspectFromKeyboard(event, site)}
                  >
                    <div className="loc-card-accent" style={{ background: site.color || undefined }} />
                    <div className="loc-card-body">
                      <div className="loc-card-name">{site.display_name ?? site.name}</div>
                      {site.display_name && site.display_name !== site.name && <div className="loc-card-sub">{site.name}</div>}
                      {site.description && <div className="loc-card-sub">{site.description}</div>}
                      {site.address && <div className="loc-card-addr"><IconMapPin size={11} aria-hidden="true" />{site.address}</div>}
                    </div>
                    <div className="loc-card-footer">
                      <span className={`loc-item-badge${deviceCount === 0 ? ' loc-item-badge--zero' : ''}`}>{deviceCount} {deviceCount === 1 ? 'device' : 'devices'}</span>
                      {canWrite && (
                        <div className="loc-card-actions" onClick={(event) => event.stopPropagation()}>
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
        </div>
        <div className="locations-panel-footer">Showing {filteredSortedSites.length} of {sites.length} locations</div>
      </div>

      {detailSite && !showForm && (
        <Modal
          title={detailSite.display_name ?? detailSite.name}
          titleIcon={<IconMapPin size={18} />}
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
          titleIcon={<IconMapPin size={18} />}
          onCancel={closeForm}
          footer={(
            <ModalFooterActions
              formId="location-form"
              onCancel={closeForm}
              primaryDisabled={busy}
              primaryLabel={editingId !== null ? 'Save changes' : 'Create location'}
            />
          )}
          bodyClassName="location-modal-body"
        >
          <form id="location-form" className="modal-form location-modal-form" onSubmit={(e) => void handleFormSubmit(e)}>
            {locationFormFields}
          </form>
        </Modal>
      )}
    </section>
  );
}

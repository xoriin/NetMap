import { useState, useEffect, useMemo, type FormEvent } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { api, type TopologyGroup, type TopologyGraph } from "../../api/client";
import { blankToNull } from "../../utils/format";
import { cidrUsableHosts, formatUsableHosts } from "../../utils/ip";
import { Modal } from "../../components/Modal";

export function VlanWorkspace({
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
  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', display_name: '', vlan_id: '', ip_range: '', gateway: '', dns_servers: '', description: '' });
  const [vlanSearch, setVlanSearch] = useState('');
  const [vlanSortKey, setVlanSortKey] = useState('name');
  const [vlanSortDir, setVlanSortDir] = useState<'asc' | 'desc'>('asc');

  function toggleVlanSort(key: string) {
    if (vlanSortKey === key) {
      setVlanSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setVlanSortKey(key);
      setVlanSortDir('asc');
    }
  }
  const normalizeGroupName = (value: string) => value.trim().toLowerCase();
  const normalizeLoose = (value: string) => normalizeGroupName(value).replace(/\s+/g, "");
  const tokenizeRange = (value: string) =>
    value
      .split(/[\s,;|]+/)
      .map((token) => normalizeLoose(token))
      .filter(Boolean);
  const groupMatchesLabel = (group: TopologyGroup, label: string) => {
    const normalized = normalizeLoose(label);
    if (!normalized) return false;
    const name = normalizeLoose(group.name);
    const displayName = normalizeLoose(group.display_name ?? "");
    const ipRange = normalizeLoose(group.ip_range ?? "");
    const rangeTokens = tokenizeRange(group.ip_range ?? "");
    return (
      name === normalized ||
      displayName === normalized ||
      ipRange === normalized ||
      rangeTokens.includes(normalized) ||
      normalized.includes(name) ||
      normalized.includes(displayName)
    );
  };

  const deviceCountByGroup = useMemo(() => {
    const counts = new Map<string, number>();
    for (const device of graph.devices) {
      if (device.topology_group) {
        counts.set(device.topology_group, (counts.get(device.topology_group) ?? 0) + 1);
      }
    }
    return counts;
  }, [graph.devices]);

  // Merge entity groups with inferred group labels visible in the topology
  const mergedRows = useMemo(() => {
    const hasMatchingEntity = (label: string) => groups.some((group) => groupMatchesLabel(group, label));
    const inferredNames = [...new Set(
      graph.devices.map((d) => d.topology_group).filter((n): n is string => !!n && n !== 'Ungrouped')
    )].filter((n) => !hasMatchingEntity(n)).sort();
    return [
      ...groups.map((g) => ({ type: 'entity' as const, entity: g, name: g.name })),
      ...inferredNames.map((n) => ({ type: 'inferred' as const, entity: null as TopologyGroup | null, name: n })),
    ];
  }, [groups, graph.devices]);
  const filteredSortedRows = useMemo(() => {
    const q = vlanSearch.toLowerCase().trim();
    const rows = q
      ? mergedRows.filter((row) =>
          row.name.toLowerCase().includes(q) ||
          (row.entity?.display_name ?? '').toLowerCase().includes(q) ||
          (row.entity?.vlan_id ?? '').toLowerCase().includes(q) ||
	          (row.entity?.ip_range ?? '').toLowerCase().includes(q) ||
	          (row.entity?.gateway ?? '').toLowerCase().includes(q) ||
	          (row.entity?.dns_servers ?? '').toLowerCase().includes(q) ||
          (row.entity?.description ?? '').toLowerCase().includes(q)
        )
      : mergedRows;
    return [...rows].sort((a, b) => {
      if (vlanSortKey === 'devices') {
        const diff = (deviceCountByGroup.get(a.name) ?? 0) - (deviceCountByGroup.get(b.name) ?? 0);
        return vlanSortDir === 'asc' ? diff : -diff;
      }
      const vals: Record<string, [string, string]> = {
        name: [a.name, b.name],
        vlan_id: [a.entity?.vlan_id ?? '', b.entity?.vlan_id ?? ''],
        ip_range: [a.entity?.ip_range ?? '', b.entity?.ip_range ?? ''],
      };
      const [aVal, bVal] = vals[vlanSortKey] ?? [a.name, b.name];
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return vlanSortDir === 'asc' ? cmp : -cmp;
    });
  }, [mergedRows, vlanSearch, vlanSortKey, vlanSortDir, deviceCountByGroup]);

  const effectiveEditingGroup =
    editingId !== null ? (groups.find((group) => group.id === editingId) ?? null) : null;

  async function loadGroups() {
    setError(null);
    const rows = await api.topologyGroups(accessToken);
    setGroups(rows);
  }

  useEffect(() => {
    void loadGroups().catch((err) => {
      setError(err instanceof Error ? err.message : 'Unable to load groups');
    });
  }, [accessToken]);

  function openCreateForm(prefillName = '') {
    setEditingId(null);
    setForm({ name: prefillName, display_name: '', vlan_id: '', ip_range: '', gateway: '', dns_servers: '', description: '' });
    setError(null);
    setShowForm(true);
  }

  function openEditForm(group: TopologyGroup) {
    setEditingId(group.id);
    setForm({
      name: group.name,
      display_name: group.display_name ?? '',
      vlan_id: group.vlan_id ?? '',
      ip_range: group.ip_range ?? '',
      gateway: group.gateway ?? '',
      dns_servers: group.dns_servers ?? '',
      description: group.description ?? '',
    });
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setError(null);
  }

  async function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    const name = form.name.trim();
    if (!name) {
      setError('Group name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const existingGroupId = effectiveEditingGroup?.id ?? null;
      const groupPayload = {
        name,
        display_name: blankToNull(form.display_name),
        vlan_id: blankToNull(form.vlan_id),
        ip_range: blankToNull(form.ip_range),
        gateway: blankToNull(form.gateway),
        dns_servers: blankToNull(form.dns_servers),
        description: blankToNull(form.description),
      };
      if (existingGroupId !== null) {
        await api.updateTopologyGroup(accessToken, existingGroupId, groupPayload);
      } else {
        await api.createTopologyGroup(accessToken, groupPayload);
      }
      await loadGroups();
      await onGraphChange();
      setShowForm(false);
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : effectiveEditingGroup ? 'Unable to update group' : 'Unable to create group');
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(groupId: number, groupName: string) {
    if (!canWrite) return;
    if (!window.confirm(`Delete group "${groupName}"? Assigned devices will be unlinked from this group.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteTopologyGroup(accessToken, groupId);
      setGroups((current) => current.filter((g) => g.id !== groupId));
      await onGraphChange();
      if (editingId === groupId) setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete group');
    } finally {
      setBusy(false);
    }
  }

  const vlanSortCols: { key: string; label: string; sortable?: boolean }[] = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'vlan_id', label: 'VLAN', sortable: true },
	    { key: 'ip_range', label: 'Subnet', sortable: true },
	    { key: 'gateway', label: 'Gateway' },
	    { key: 'dns', label: 'DNS' },
    { key: 'devices', label: 'Devices', sortable: true },
  ];

  const vlanFormFields = (
    <div className="vlan-form-grid">
      <label className="ipam-form-label">Name *
        <input className="ipam-form-input" required value={form.name} onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))} />
      </label>
      <label className="ipam-form-label">Display name
        <input className="ipam-form-input" value={form.display_name} onChange={(event) => setForm((c) => ({ ...c, display_name: event.target.value }))} />
      </label>
      <label className="ipam-form-label">VLAN ID
        <input className="ipam-form-input" placeholder="e.g. 10" value={form.vlan_id} onChange={(event) => setForm((c) => ({ ...c, vlan_id: event.target.value }))} />
      </label>
      <label className="ipam-form-label">Subnet (CIDR)
        <input className="ipam-form-input ipam-form-input--mono" placeholder="192.168.1.0/24" value={form.ip_range} onChange={(event) => setForm((c) => ({ ...c, ip_range: event.target.value }))} />
      </label>
      <label className="ipam-form-label">Gateway
        <input className="ipam-form-input ipam-form-input--mono" placeholder="192.168.1.1" value={form.gateway} onChange={(event) => setForm((c) => ({ ...c, gateway: event.target.value }))} />
      </label>
      <label className="ipam-form-label">DNS servers
        <input className="ipam-form-input" placeholder="8.8.8.8, 1.1.1.1" value={form.dns_servers} onChange={(event) => setForm((c) => ({ ...c, dns_servers: event.target.value }))} />
      </label>
      <label className="ipam-form-label vlan-form-grid__full">Description
        <input className="ipam-form-input" value={form.description} onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))} />
      </label>
      {error && <p className="form-error vlan-form-grid__full">{error}</p>}
    </div>
  );

  return (
    <section className="dash-layout">
        {showForm && !effectiveEditingGroup && (
          <Modal title="New group" onCancel={closeForm}>
            <form className="ipam-subnet-form" style={{ padding: "18px 20px" }} onSubmit={(e) => void handleFormSubmit(e)}>
              {vlanFormFields}
              <div className="modal-actions">
                <button type="button" className="nm-btn" disabled={busy} onClick={closeForm}>Cancel</button>
                <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>Create group</button>
              </div>
            </form>
          </Modal>
        )}
        {showForm && effectiveEditingGroup && (
          <Modal title="Edit group" onCancel={closeForm}>
            <form className="ipam-subnet-form" style={{ padding: "18px 20px" }} onSubmit={(e) => void handleFormSubmit(e)}>
              {vlanFormFields}
              <div className="modal-actions">
                <button type="button" className="nm-btn" disabled={busy} onClick={closeForm}>Cancel</button>
                <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>Save changes</button>
              </div>
            </form>
          </Modal>
        )}

        <div className="panel" style={{ flex: '1 1 auto', padding: 0, overflow: 'auto', minWidth: 0, marginTop: 0 }}>
          <div className="vlan-toolbar">
            <input className="vlan-search-input" type="search" placeholder="Search groups…" value={vlanSearch} onChange={(e) => setVlanSearch(e.target.value)} />
            {canWrite && (
              <button type="button" className="nm-btn nm-btn--primary" disabled={busy} onClick={() => openCreateForm()}>+ New group</button>
            )}
          </div>
          {filteredSortedRows.length === 0 ? (
            <p className="inventory-empty">
              {vlanSearch ? 'No groups match your search.' : 'No groups found. Add devices to the topology or create a group manually.'}
            </p>
          ) : (
            <div className={canWrite ? 'vlan-table-writable' : undefined}>
              <div className="vlan-table-header">
                {vlanSortCols.map(({ key, label, sortable }) => (
                  sortable ? (
                    <button
                      key={key}
                      type="button"
                      className={`inventory-sort-btn${vlanSortKey === key ? ' active' : ''}`}
                      onClick={() => toggleVlanSort(key)}
                    >
                      {label}
                      {vlanSortKey === key && (vlanSortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                    </button>
                  ) : (
                    <span key={key} className="vlan-header-cell">{label}</span>
                  )
                ))}
                {canWrite && <span />}
              </div>
              {filteredSortedRows.map((row) => {
                const deviceCount = deviceCountByGroup.get(row.name) ?? 0;
                const usable = row.entity ? cidrUsableHosts(row.entity.ip_range) : null;
                return (
                  <div key={`${row.type}-${row.name}`} className="vlan-row">
                    <span className="vlan-cell-name">
                      <span className="vlan-name-stack">
                        <span className="vlan-name-primary">{row.name}</span>
                        {row.type === 'entity' && row.entity!.display_name && (
                          <span className="vlan-name-sub">{row.entity!.display_name}</span>
                        )}
                      </span>
                      {row.type === 'inferred' && <span className="vlan-inferred-badge">inferred</span>}
                    </span>
                    <span>
                      {row.type === 'entity' && row.entity!.vlan_id
                        ? <span className="vlan-id-badge">{row.entity!.vlan_id}</span>
                        : <span className="vlan-empty-cell">—</span>}
                    </span>
                    <span className="vlan-subnet-cell">
                      {row.type === 'entity' && row.entity!.ip_range ? (
                        <>
                          <span className="vlan-ip-pill">{row.entity!.ip_range}</span>
                          {usable !== null && (
                            <span className="vlan-usable-count">{formatUsableHosts(usable)} usable</span>
                          )}
                        </>
                      ) : <span className="vlan-empty-cell">—</span>}
                    </span>
	                    <span className="vlan-mono-cell">
	                      {row.type === 'entity' && row.entity!.gateway
	                        ? row.entity!.gateway
	                        : <span className="vlan-empty-cell">—</span>}
	                    </span>
	                    <span className="vlan-mono-cell">
	                      {row.type === 'entity' && row.entity!.dns_servers
                        ? row.entity!.dns_servers
                        : <span className="vlan-empty-cell">—</span>}
                    </span>
                    <span>
                      {deviceCount > 0
                        ? <span className="vlan-device-badge">{deviceCount}</span>
                        : <span className="vlan-empty-cell">0</span>}
                    </span>
                    {canWrite && (
                      <span className="vlan-row-actions">
                        <button
                          type="button"
                          className="nm-btn nm-btn--sm"
                          disabled={busy}
                          onClick={() => {
                            const existingGroup =
                              row.type === 'entity'
                                ? row.entity
                                : groups.find((g) => groupMatchesLabel(g, row.name)) ?? null;
                            if (!existingGroup) {
                              openCreateForm(row.name);
                              return;
                            }
                            openEditForm(existingGroup);
                          }}
                        >
                          Edit
                        </button>
                        {row.type === 'entity' && (
                          <button
                            type="button"
                            className="nm-btn nm-btn--sm nm-btn--danger"
                            disabled={busy}
                            onClick={() => void deleteGroup(row.entity!.id, row.entity!.name)}
                          >
                            Delete
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
    </section>
  );
}

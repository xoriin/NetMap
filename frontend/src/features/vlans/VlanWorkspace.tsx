import { useState, useMemo, useRef, type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import "./vlans.css";
import { ChevronUp, ChevronDown, Network, Search } from "lucide-react";
import { api, type TopologyGroup, type TopologyGraph } from "../../api/client";
import { blankToNull } from "../../utils/format";
import { cidrUsableHosts, formatUsableHosts } from "../../utils/ip";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { useConfirm } from "../../components/ConfirmDialog";
import { useApiQuery, useApiMutation } from "../../hooks/useApiQuery";
import { useSortableData } from "../../hooks/useSortableData";
import { TableSkeleton } from "../../components/Skeleton";

const VLAN_COL_WIDTHS_KEY = "netmap.vlan_col_widths_v1";
const VLAN_COL_COUNT = 6;
const VLAN_MIN_COL_WIDTH = 64;

function loadVlanColWidths(): number[] | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(VLAN_COL_WIDTHS_KEY) ?? "null") as unknown;
    if (
      Array.isArray(parsed)
      && parsed.length === VLAN_COL_COUNT
      && parsed.every((value) => typeof value === "number" && value >= VLAN_MIN_COL_WIDTH)
    ) return parsed;
  } catch {
    // Ignore stale or malformed browser preferences.
  }
  return null;
}

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
  const confirmAction = useConfirm();
  const groupsQuery = useApiQuery(() => api.topologyGroups(accessToken), [accessToken]);
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);
  const [formError, setFormError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', display_name: '', vlan_id: '', ip_range: '', gateway: '', dns_servers: '', description: '' });
  const [vlanSearch, setVlanSearch] = useState('');
  const [colWidths, setColWidths] = useState<number[] | null>(loadVlanColWidths);
  const tableHeaderRef = useRef<HTMLDivElement | null>(null);
  const { sortKey: vlanSortKey, sortDir: vlanSortDir, toggleSort: toggleVlanSort, ariaSort: vlanAriaSort } = useSortableData<string>('name');
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

  const saveGroup = useApiMutation(
    async (payload: Parameters<typeof api.createTopologyGroup>[1], existingGroupId: number | null) => {
      if (existingGroupId !== null) {
        return api.updateTopologyGroup(accessToken, existingGroupId, payload);
      }
      return api.createTopologyGroup(accessToken, payload);
    },
    { errorToast: false },
  );

  const removeGroup = useApiMutation(
    (groupId: number) => api.deleteTopologyGroup(accessToken, groupId),
    { successMessage: "Group deleted" },
  );

  const busy = saveGroup.isBusy || removeGroup.isBusy;

  function openCreateForm(prefillName = '') {
    setEditingId(null);
    setForm({ name: prefillName, display_name: '', vlan_id: '', ip_range: '', gateway: '', dns_servers: '', description: '' });
    setFormError(null);
    saveGroup.clearError();
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
    setFormError(null);
    saveGroup.clearError();
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setFormError(null);
  }

  async function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canWrite) return;
    const name = form.name.trim();
    if (!name) {
      setFormError('Group name is required');
      return;
    }
    setFormError(null);
    const existingGroupId = effectiveEditingGroup?.id ?? null;
    const saved = await saveGroup.run({
      name,
      display_name: blankToNull(form.display_name),
      vlan_id: blankToNull(form.vlan_id),
      ip_range: blankToNull(form.ip_range),
      gateway: blankToNull(form.gateway),
      dns_servers: blankToNull(form.dns_servers),
      description: blankToNull(form.description),
    }, existingGroupId);
    if (saved === null) return;
    await groupsQuery.reload();
    await onGraphChange();
    setShowForm(false);
    setEditingId(null);
  }

  async function deleteGroup(groupId: number, groupName: string) {
    if (!canWrite) return;
    const confirmed = await confirmAction({
      title: "Delete group",
      message: `Delete group "${groupName}"?`,
      detail: "Assigned devices will be unlinked from this group. The devices themselves are kept.",
      confirmLabel: "Delete group",
    });
    if (!confirmed) return;
    const deleted = await removeGroup.run(groupId);
    if (deleted === null) return;
    groupsQuery.setData((current) => (current ?? []).filter((g) => g.id !== groupId));
    await onGraphChange();
    if (editingId === groupId) setShowForm(false);
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
      <label className="nm-field"><span className="nm-field-label">Name *</span>
        <input className="nm-input" required value={form.name} onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))} />
      </label>
      <label className="nm-field"><span className="nm-field-label">Display name</span>
        <input className="nm-input" value={form.display_name} onChange={(event) => setForm((c) => ({ ...c, display_name: event.target.value }))} />
      </label>
      <label className="nm-field"><span className="nm-field-label">VLAN ID</span>
        <input className="nm-input" placeholder="e.g. 10" value={form.vlan_id} onChange={(event) => setForm((c) => ({ ...c, vlan_id: event.target.value }))} />
      </label>
      <label className="nm-field"><span className="nm-field-label">Subnet (CIDR)</span>
        <input className="nm-input vlan-input--mono" placeholder="192.168.1.0/24" value={form.ip_range} onChange={(event) => setForm((c) => ({ ...c, ip_range: event.target.value }))} />
      </label>
      <label className="nm-field"><span className="nm-field-label">Gateway</span>
        <input className="nm-input vlan-input--mono" placeholder="192.168.1.1" value={form.gateway} onChange={(event) => setForm((c) => ({ ...c, gateway: event.target.value }))} />
      </label>
      <label className="nm-field"><span className="nm-field-label">DNS servers</span>
        <input className="nm-input" placeholder="8.8.8.8, 1.1.1.1" value={form.dns_servers} onChange={(event) => setForm((c) => ({ ...c, dns_servers: event.target.value }))} />
      </label>
      <label className="nm-field vlan-form-grid__full"><span className="nm-field-label">Description</span>
        <input className="nm-input" value={form.description} onChange={(event) => setForm((c) => ({ ...c, description: event.target.value }))} />
      </label>
      {(formError ?? saveGroup.error) && <p className="form-error vlan-form-grid__full">{formError ?? saveGroup.error}</p>}
    </div>
  );

  function startColResize(colIdx: number, event: ReactMouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const initialWidths = tableHeaderRef.current
      ? Array.from(tableHeaderRef.current.children)
          .slice(0, VLAN_COL_COUNT)
          .map((cell) => cell.getBoundingClientRect().width)
      : (colWidths ?? []);
    if (initialWidths.length !== VLAN_COL_COUNT) return;

    function onMove(moveEvent: MouseEvent) {
      const updated = [...initialWidths];
      updated[colIdx] = Math.max(VLAN_MIN_COL_WIDTH, initialWidths[colIdx] + moveEvent.clientX - startX);
      setColWidths(updated);
    }
    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setColWidths((current) => {
        if (current) window.localStorage.setItem(VLAN_COL_WIDTHS_KEY, JSON.stringify(current));
        return current;
      });
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function resetColWidths() {
    window.localStorage.removeItem(VLAN_COL_WIDTHS_KEY);
    setColWidths(null);
  }

  const vlanGridStyle = colWidths
    ? ({ "--vlan-grid-template": `${colWidths.map((width) => `${width}px`).join(" ")}${canWrite ? " 112px" : ""}` } as CSSProperties)
    : undefined;

  return (
    <section className="dash-layout vlan-workspace">
        {showForm && (
          <Modal
            title={effectiveEditingGroup ? "Edit group" : "New group"}
            titleIcon={<Network size={18} />}
            onCancel={closeForm}
            bodyClassName="vlan-modal-body"
            footer={(
              <ModalFooterActions
                formId="vlan-group-form"
                onCancel={closeForm}
                primaryDisabled={busy}
                primaryLabel={effectiveEditingGroup ? "Save changes" : "Create group"}
              />
            )}
          >
            <form id="vlan-group-form" className="modal-form vlan-modal-form" onSubmit={(e) => void handleFormSubmit(e)}>
              {vlanFormFields}
            </form>
          </Modal>
        )}

        <div className="panel nm-app-panel vlan-table-panel">
          <div className="vlan-toolbar nm-app-panel-header">
            <span className="vlan-panel-title">
              <span className="vlan-panel-icon" aria-hidden="true"><Network size={18} /></span>
              <span className="vlan-panel-separator">-</span>
              <span>Groups &amp; VLANs</span>
              <span className="vlan-panel-count">
                {filteredSortedRows.length !== mergedRows.length
                  ? `${filteredSortedRows.length} of ${mergedRows.length}`
                  : mergedRows.length}
              </span>
            </span>
            <div className="vlan-toolbar-actions">
              <div className="nm-search nm-search--toolbar vlan-search">
                <Search size={14} className="nm-search-icon" aria-hidden="true" />
                <input className="nm-input" type="search" aria-label="Search groups and VLANs" placeholder="Search groups…" value={vlanSearch} onChange={(e) => setVlanSearch(e.target.value)} />
              </div>
            {canWrite && (
              <button type="button" className="nm-btn nm-btn--primary" disabled={busy} onClick={() => openCreateForm()}>+ New group</button>
            )}
            </div>
          </div>
          {groupsQuery.error && <div className="error-banner">{groupsQuery.error}</div>}
          <div className="vlan-table-viewport">
            {groupsQuery.isLoading ? (
              <TableSkeleton rows={7} columns={6} />
            ) : filteredSortedRows.length === 0 ? (
              <p className="inventory-empty vlan-empty-state">
                {vlanSearch ? 'No groups match your search.' : 'No groups found. Add devices to the topology or create a group manually.'}
              </p>
            ) : (
              <div className={`${canWrite ? 'vlan-table-writable ' : ''}${colWidths ? 'vlan-table--fixed' : ''}`} style={vlanGridStyle}>
              <div className="vlan-table-header" ref={tableHeaderRef}>
                {vlanSortCols.map(({ key, label, sortable }) => (
                  <span key={key} className="vlan-header-cell">
                    {sortable ? (
                      <button
                        type="button"
                        className={`inventory-sort-btn${vlanSortKey === key ? ' active' : ''}`}
                        aria-sort={vlanAriaSort(key)}
                        onClick={() => toggleVlanSort(key)}
                      >
                        {label}
                        {vlanSortKey === key && (vlanSortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                      </button>
                    ) : label}
                    {key !== "devices" && (
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        className="vlan-col-resize-handle"
                        title="Drag to resize · double-click to reset all columns"
                        onMouseDown={(event) => startColResize(vlanSortCols.findIndex((column) => column.key === key), event)}
                        onDoubleClick={resetColWidths}
                      />
                    )}
                  </span>
                ))}
                {canWrite && <span className="vlan-header-cell vlan-actions-heading">Actions</span>}
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
          <div className="vlan-table-footer">
            <span>Showing {filteredSortedRows.length} of {mergedRows.length} groups</span>
            {colWidths && <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost" onClick={resetColWidths}>Reset columns</button>}
          </div>
        </div>
    </section>
  );
}

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Modal } from "../../components/Modal";
import { TableSkeleton } from "../../components/Skeleton";
import { sourceKey, type StatusItemSource, type StatusSources } from "./statusPagesEditorApi";

export type SourceKind = "device" | "service" | "monitor";

export type SourceDescription = {
  kind: SourceKind;
  internal: string;
  reference: string;
  address: string | null;
  missing: boolean;
};

const KIND_LABELS: Record<SourceKind, string> = { device: "Device", service: "Service check", monitor: "Endpoint" };

export function describeSource(source: StatusItemSource, sources: StatusSources | null): SourceDescription {
  if (source.monitor !== undefined) {
    const monitor = sources?.monitors.find((m) => m.id === source.monitor);
    return {
      kind: "monitor",
      internal: monitor?.name ?? `Endpoint #${source.monitor}`,
      reference: `Endpoint #${source.monitor}`,
      address: monitor?.url ?? null,
      missing: sources !== null && !monitor,
    };
  }
  const device = sources?.devices.find((d) => d.id === source.device);
  const deviceName = device?.name ?? `Device #${source.device}`;
  if (source.service_check !== undefined) {
    const check = device?.service_checks.find((c) => c.id === source.service_check);
    return {
      kind: "service",
      internal: `${deviceName} · ${check?.label ?? `check #${source.service_check}`}`,
      reference: `Service check #${source.service_check} · device #${source.device}`,
      address: check ? `${check.check_type}/${check.port}` : null,
      missing: sources !== null && (!device || !check),
    };
  }
  return {
    kind: "device",
    internal: deviceName,
    reference: `Device #${source.device}`,
    address: device?.ip_address ?? null,
    missing: sources !== null && !device,
  };
}

type Candidate = SourceDescription & { key: string; source: StatusItemSource };

function candidates(sources: StatusSources): Candidate[] {
  const rows: Candidate[] = [];
  const add = (source: StatusItemSource) => rows.push({ ...describeSource(source, sources), key: sourceKey(source), source });
  sources.devices.forEach((device) => {
    add({ device: device.id });
    device.service_checks.forEach((check) => add({ device: device.id, service_check: check.id }));
  });
  sources.monitors.forEach((monitor) => add({ monitor: monitor.id }));
  return rows;
}

export function StatusSourcePicker({
  groupName,
  sources,
  sourcesError,
  usedKeys,
  onPick,
  onCancel,
}: {
  groupName: string;
  sources: StatusSources | null;
  sourcesError: string | null;
  usedKeys: Set<string>;
  onPick: (sources: StatusItemSource[]) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | SourceKind>("all");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());

  const rows = useMemo(() => {
    if (!sources) return [];
    const needle = query.trim().toLowerCase();
    return candidates(sources).filter((row) =>
      (kind === "all" || row.kind === kind)
      && (!needle || [row.internal, row.reference, row.address ?? ""].some((text) => text.toLowerCase().includes(needle))));
  }, [sources, query, kind]);

  const selectableVisible = useMemo(
    () => rows.filter((row) => !usedKeys.has(row.key)),
    [rows, usedKeys],
  );
  const selectedVisibleCount = selectableVisible.reduce((count, row) => count + (selectedKeys.has(row.key) ? 1 : 0), 0);
  const allVisibleSelected = selectableVisible.length > 0 && selectedVisibleCount === selectableVisible.length;
  const selectedCount = selectedKeys.size;
  const selectedSources = useMemo(() => {
    if (!sources || selectedKeys.size === 0) return [] as StatusItemSource[];
    return candidates(sources)
      .filter((row) => selectedKeys.has(row.key) && !usedKeys.has(row.key))
      .map((row) => row.source);
  }, [sources, selectedKeys, usedKeys]);

  function toggleKey(key: string, checked: boolean) {
    if (usedKeys.has(key)) return;
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleAllVisible(checked: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      selectableVisible.forEach((row) => {
        if (checked) next.add(row.key);
        else next.delete(row.key);
      });
      return next;
    });
  }

  const canAdd = selectedSources.length > 0;
  const addLabel = selectedSources.length <= 1
    ? (groupName ? `Add to ${groupName}` : "Add")
    : `Add ${selectedSources.length} items`;

  return (
    <Modal
      title="Add item"
      size="lg"
      onCancel={onCancel}
      bodyClassName="modal-body status-source-picker"
      footer={(
        <>
          <span className="status-source-selected-count" aria-live="polite">
            {selectedCount === 0 ? "None selected" : `${selectedCount} selected`}
          </span>
          <button type="button" className="nm-btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="nm-btn nm-btn--primary"
            disabled={!canAdd}
            onClick={() => onPick(selectedSources)}
          >
            {addLabel}
          </button>
        </>
      )}
    >
      <div className="nm-alert nm-alert--info">
        Visitors see only the display name you give the item. The names, addresses and IDs below stay inside NetMap.
      </div>
      <div className="status-source-filters">
        <div className="nm-search status-source-search">
          <Search size={14} className="nm-search-icon" aria-hidden="true" />
          <input
            className="nm-input"
            placeholder="Search name, address or ID…"
            aria-label="Search sources"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <select className="nm-select status-source-kind" aria-label="Source type" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="all">All sources</option>
          <option value="device">Devices</option>
          <option value="service">Service checks</option>
          <option value="monitor">Endpoints</option>
        </select>
      </div>
      {sourcesError ? (
        <div className="nm-alert nm-alert--error" role="alert">{sourcesError}</div>
      ) : !sources ? (
        <TableSkeleton rows={5} columns={4} />
      ) : rows.length === 0 ? (
        <p className="dash-empty">No sources match.</p>
      ) : (
        <>
          <label className="status-layout-check status-source-select-all">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              disabled={selectableVisible.length === 0}
              aria-label="Select all visible"
              onChange={(event) => toggleAllVisible(event.target.checked)}
            />
            <span>Select all visible</span>
            <span className="status-editor-sub">
              {selectableVisible.length === 0
                ? "Nothing left to add"
                : `${selectedVisibleCount} of ${selectableVisible.length} visible`}
            </span>
          </label>
          <div className="nm-table-wrap mon-embedded-table status-source-table-wrap nm-phone-cards">
            <table className="nm-table status-source-table">
              <thead>
                <tr>
                  <th className="status-source-col-check" aria-label="Select" />
                  <th>Source</th>
                  <th>Reference</th>
                  <th>Address</th>
                  <th className="status-source-col-status" aria-label="Status" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const used = usedKeys.has(row.key);
                  const checked = selectedKeys.has(row.key);
                  return (
                    <tr key={row.key} className={checked && !used ? "is-selected" : undefined}>
                      <td className="status-source-col-check">
                        <label className="status-source-check">
                          <input
                            type="checkbox"
                            checked={used ? false : checked}
                            disabled={used}
                            aria-label={used ? `${row.internal} is already on this page` : `Select ${row.internal}`}
                            title={used ? "Already on this page" : undefined}
                            onChange={(event) => toggleKey(row.key, event.target.checked)}
                          />
                        </label>
                      </td>
                      <td>
                        <strong>{row.internal}</strong>
                        <small className="status-editor-sub">{KIND_LABELS[row.kind]}</small>
                      </td>
                      <td className="nm-table-mono">{row.reference}</td>
                      <td className="nm-table-mono">{row.address ?? "—"}</td>
                      <td className="status-source-action">
                        {used ? <span className="status-source-on-page">On page</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

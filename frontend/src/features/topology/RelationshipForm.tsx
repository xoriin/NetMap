import { useState, useEffect, useLayoutEffect, useRef, useMemo, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search } from "lucide-react";
import { type Device, type Relationship, type RelationshipPayload } from "../../api/client";
import { deviceLabel, blankToNull } from "../../utils/format";
import { compareGroupLabels, groupRepresentativeDeviceId } from "../../utils/sort";
import { parseRelationshipVisualEndpoints, stripRelationshipMetadata, composeRelationshipNotes } from "../../utils/relationship";
import { Modal } from "../../components/Modal";

// ── EndpointPicker ────────────────────────────────────────────────────────────

type EndpointOption = { value: string; label: string; sub?: string; badge?: string };

function buildEndpointOptions(devices: Device[], groupNames: string[]): {
  groups: EndpointOption[];
  devices: EndpointOption[];
} {
  return {
    groups: groupNames.map((g) => ({ value: `group:${g}`, label: g, badge: "G" })),
    devices: devices.map((d) => ({
      value: `device:${d.id}`,
      label: deviceLabel(d),
      sub: d.ip_address || undefined,
    })),
  };
}

function matchesSearch(opt: EndpointOption, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  return opt.label.toLowerCase().includes(lower) || (opt.sub?.toLowerCase().includes(lower) ?? false);
}

function EndpointPicker({
  value,
  onChange,
  devices,
  groupNames,
  placeholder = "Select…",
}: {
  value: string;
  onChange: (val: string) => void;
  devices: Device[];
  groupNames: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0, listMaxHeight: 220 });

  const allOptions = useMemo(() => buildEndpointOptions(devices, groupNames), [devices, groupNames]);

  const filtered = useMemo(() => ({
    groups: allOptions.groups.filter((o) => matchesSearch(o, search)),
    devices: allOptions.devices.filter((o) => matchesSearch(o, search)),
  }), [allOptions, search]);

  const flatOptions = useMemo(
    () => [...filtered.groups, ...filtered.devices],
    [filtered],
  );

  const selectedLabel = useMemo(() => {
    if (!value) return null;
    return (
      allOptions.groups.find((o) => o.value === value) ??
      allOptions.devices.find((o) => o.value === value) ??
      null
    );
  }, [value, allOptions]);

  // Reset highlight when filtered list changes
  useEffect(() => { setHighlighted(0); }, [search]);

  // Scroll highlighted item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(".ep-option--hl");
    el?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  function updateDropdownPosition() {
    const trigger = containerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 16;
    const spaceAbove = rect.top - 16;
    const openAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
    const dropdownHeight = Math.min(320, Math.max(180, openAbove ? spaceAbove : spaceBelow));
    setDropdownPosition({
      top: openAbove ? Math.max(12, rect.top - dropdownHeight - 3) : rect.bottom + 3,
      left: rect.left,
      width: rect.width,
      listMaxHeight: Math.max(120, dropdownHeight - 49),
    });
  }

  useLayoutEffect(() => {
    if (!open) return;
    updateDropdownPosition();
  }, [open, search, flatOptions.length]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updateDropdownPosition);
    window.addEventListener("scroll", updateDropdownPosition, true);
    return () => {
      window.removeEventListener("resize", updateDropdownPosition);
      window.removeEventListener("scroll", updateDropdownPosition, true);
    };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!containerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function togglePicker() {
    if (open) {
      setOpen(false);
      return;
    }
    const idx = flatOptions.findIndex((o) => o.value === value);
    setHighlighted(idx >= 0 ? idx : 0);
    setSearch("");
    setOpen(true);
    // Focus search input after render
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      // Scroll selected into view
      const el = listRef.current?.querySelector<HTMLElement>(".ep-option--selected");
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  function select(val: string) {
    onChange(val);
    setOpen(false);
    setSearch("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, flatOptions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = flatOptions[highlighted];
      if (opt) select(opt.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  const dropdown = open ? (
    <div
      className="ep-dropdown"
      ref={dropdownRef}
      role="listbox"
      style={{
        top: dropdownPosition.top,
        left: dropdownPosition.left,
        width: dropdownPosition.width,
      }}
    >
      <div className="ep-search-row">
        <Search size={12} className="ep-search-icon" />
        <input
          ref={searchRef}
          className="ep-search"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="IP, hostname, name..."
          autoComplete="off"
        />
      </div>
      <div className="ep-list" ref={listRef} style={{ maxHeight: dropdownPosition.listMaxHeight }}>
        {filtered.groups.length > 0 && (
          <>
            <div className="ep-section">Groups</div>
            {filtered.groups.map((opt) => {
              const idx = flatOptions.indexOf(opt);
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={value === opt.value}
                  className={[
                    "ep-option",
                    value === opt.value ? "ep-option--selected" : "",
                    highlighted === idx ? "ep-option--hl" : "",
                  ].filter(Boolean).join(" ")}
                  onMouseEnter={() => setHighlighted(idx)}
                  onClick={() => select(opt.value)}
                >
                  <span className="ep-badge">G</span>
                  <span className="ep-option-name">{opt.label}</span>
                </button>
              );
            })}
          </>
        )}
        {filtered.devices.length > 0 && (
          <>
            <div className="ep-section">Devices</div>
            {filtered.devices.map((opt) => {
              const idx = flatOptions.indexOf(opt);
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={value === opt.value}
                  className={[
                    "ep-option",
                    value === opt.value ? "ep-option--selected" : "",
                    highlighted === idx ? "ep-option--hl" : "",
                  ].filter(Boolean).join(" ")}
                  onMouseEnter={() => setHighlighted(idx)}
                  onClick={() => select(opt.value)}
                >
                  <span className="ep-option-name">{opt.label}</span>
                  {opt.sub && <span className="ep-option-ip">{opt.sub}</span>}
                </button>
              );
            })}
          </>
        )}
        {flatOptions.length === 0 && (
          <div className="ep-empty">No results for "{search}"</div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="ep-picker" ref={containerRef}>
      <button
        type="button"
        className={`ep-trigger${open ? " ep-trigger--open" : ""}`}
        onClick={togglePicker}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ep-trigger-label">
          {selectedLabel ? (
            <>
              <span className="ep-trigger-name">{selectedLabel.label}</span>
              {selectedLabel.sub && <span className="ep-trigger-sub">{selectedLabel.sub}</span>}
            </>
          ) : (
            <span className="ep-trigger-placeholder">{placeholder}</span>
          )}
        </span>
        <ChevronDown size={13} className={`ep-chevron${open ? " ep-chevron--open" : ""}`} />
      </button>

      {dropdown ? createPortal(dropdown, document.body) : null}
    </div>
  );
}

export const LINK_SPEED_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Unspecified", value: null },
  { label: "10 Mbps", value: 10 },
  { label: "100 Mbps", value: 100 },
  { label: "1 Gbps", value: 1000 },
  { label: "2.5 Gbps", value: 2500 },
  { label: "10 Gbps", value: 10_000 },
  { label: "25 Gbps", value: 25_000 },
  { label: "40 Gbps", value: 40_000 },
  { label: "100 Gbps", value: 100_000 },
];

export function formatLinkSpeed(mbps: number | null): string {
  if (mbps === null) return "";
  if (mbps >= 1000) {
    const gbps = mbps / 1000;
    return `${Number.isInteger(gbps) ? gbps : gbps.toFixed(1)} Gbps`;
  }
  return `${mbps} Mbps`;
}

function LinkSpeedSelect({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }) {
  return (
    <select
      value={value === null ? "" : String(value)}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
    >
      {LINK_SPEED_OPTIONS.map((option) => (
        <option key={option.label} value={option.value === null ? "" : String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// ── RelationshipEditForm ──────────────────────────────────────────────────────

export function RelationshipEditForm({
  busy,
  devices,
  relationship,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  devices: Device[];
  relationship: Relationship;
  onCancel: () => void;
  onSubmit: (payload: {
    source_device_id: number;
    target_device_id: number;
    relationship_type: string;
    allow_outbound: boolean;
    allow_inbound: boolean;
    notes: string | null;
    link_speed_mbps: number | null;
  }) => Promise<void>;
}) {
  const formId = "relationship-edit-form";
  const groupNames = useMemo(
    () =>
      [...new Set(devices.map((device) => device.topology_group))]
        .filter(Boolean)
        .sort(compareGroupLabels),
    [devices],
  );
  const visualEndpoints = parseRelationshipVisualEndpoints(relationship.notes);
  const [sourceEndpoint, setSourceEndpoint] = useState(visualEndpoints?.source ?? `device:${relationship.source_device_id}`);
  const [targetEndpoint, setTargetEndpoint] = useState(visualEndpoints?.target ?? `device:${relationship.target_device_id}`);
  const [relationshipType, setRelationshipType] = useState(relationship.relationship_type);
  const [allowOutbound, setAllowOutbound] = useState(relationship.allow_outbound !== false);
  const [allowInbound, setAllowInbound] = useState(relationship.allow_inbound !== false);
  const [notes, setNotes] = useState(stripRelationshipMetadata(relationship.notes));
  const [linkSpeed, setLinkSpeed] = useState<number | null>(relationship.link_speed_mbps ?? null);
  const [formError, setFormError] = useState<string | null>(null);

  const allEndpointValues = useMemo(() => {
    const opts = buildEndpointOptions(devices, groupNames);
    return new Set([...opts.groups.map((o) => o.value), ...opts.devices.map((o) => o.value)]);
  }, [devices, groupNames]);

  useEffect(() => {
    if (!allEndpointValues.has(sourceEndpoint)) setSourceEndpoint(`device:${relationship.source_device_id}`);
    if (!allEndpointValues.has(targetEndpoint)) setTargetEndpoint(`device:${relationship.target_device_id}`);
  }, [allEndpointValues, relationship.source_device_id, relationship.target_device_id, sourceEndpoint, targetEndpoint]);

  function resolveEndpoint(endpoint: string): { deviceId: number; type: "device" | "group" } | null {
    if (endpoint.startsWith("device:")) {
      const deviceId = Number(endpoint.replace("device:", ""));
      return devices.some((d) => d.id === deviceId) ? { deviceId, type: "device" } : null;
    }
    if (endpoint.startsWith("group:")) {
      const groupName = endpoint.replace("group:", "");
      const representativeDeviceId = groupRepresentativeDeviceId(devices, groupName);
      return representativeDeviceId !== null ? { deviceId: representativeDeviceId, type: "group" } : null;
    }
    return null;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const normalizedType = relationshipType.trim();
    if (!normalizedType) { setFormError("Link name is required"); return; }
    const source = resolveEndpoint(sourceEndpoint);
    const target = resolveEndpoint(targetEndpoint);
    if (!source || !target) { setFormError("Select valid source and target endpoints"); return; }
    if (source.deviceId === target.deviceId) { setFormError("Source and target resolve to the same device"); return; }
    void onSubmit({
      source_device_id: source.deviceId,
      target_device_id: target.deviceId,
      relationship_type: normalizedType,
      allow_outbound: allowOutbound,
      allow_inbound: allowInbound,
      notes: composeRelationshipNotes(sourceEndpoint, targetEndpoint, blankToNull(notes) ?? null),
      link_speed_mbps: linkSpeed,
    });
  }

  return (
    <Modal title="Edit link" onCancel={onCancel}>
      <form id={formId} className="modal-form relationship-form" onSubmit={submit}>
        <label>
          Source
          <EndpointPicker value={sourceEndpoint} onChange={setSourceEndpoint} devices={devices} groupNames={groupNames} />
        </label>
        <label>
          Target
          <EndpointPicker value={targetEndpoint} onChange={setTargetEndpoint} devices={devices} groupNames={groupNames} />
        </label>
        <label>
          Link name
          <input required value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} />
        </label>
        <label>
          Link speed
          <LinkSpeedSelect value={linkSpeed} onChange={setLinkSpeed} />
        </label>
        <label>
          <span className="inline-toggle">
            <input type="checkbox" checked={allowOutbound} onChange={(e) => setAllowOutbound(e.target.checked)} />
            Allow traffic source → target
          </span>
        </label>
        <label>
          <span className="inline-toggle">
            <input type="checkbox" checked={allowInbound} onChange={(e) => setAllowInbound(e.target.checked)} />
            Allow traffic target → source
          </span>
        </label>
        <label>
          Notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        {formError && <div className="form-error">{formError}</div>}
        <div className="modal-actions modal-actions--plain">
          <button type="button" className="nm-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>Save changes</button>
        </div>
      </form>
    </Modal>
  );
}

// ── RelationshipForm ──────────────────────────────────────────────────────────

export function RelationshipForm({
  busy,
  devices,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  devices: Device[];
  onCancel: () => void;
  onSubmit: (payload: RelationshipPayload) => Promise<void>;
}) {
  const groupNames = useMemo(
    () =>
      [...new Set(devices.map((device) => device.topology_group))]
        .filter(Boolean)
        .sort(compareGroupLabels),
    [devices],
  );
  const allOptions = useMemo(() => buildEndpointOptions(devices, groupNames), [devices, groupNames]);
  const [sourceEndpoint, setSourceEndpoint] = useState(allOptions.groups[0]?.value ?? allOptions.devices[0]?.value ?? "");
  const [targetEndpoint, setTargetEndpoint] = useState(
    allOptions.devices[1]?.value ?? allOptions.groups[1]?.value ?? allOptions.devices[0]?.value ?? "",
  );
  const [relationshipType, setRelationshipType] = useState("link");
  const [allowOutbound, setAllowOutbound] = useState(true);
  const [allowInbound, setAllowInbound] = useState(true);
  const [notes, setNotes] = useState("");
  const [linkSpeed, setLinkSpeed] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const allEndpointValues = useMemo(
    () => new Set([...allOptions.groups.map((o) => o.value), ...allOptions.devices.map((o) => o.value)]),
    [allOptions],
  );

  useEffect(() => {
    if (!allEndpointValues.has(sourceEndpoint)) setSourceEndpoint(allOptions.groups[0]?.value ?? allOptions.devices[0]?.value ?? "");
    if (!allEndpointValues.has(targetEndpoint)) setTargetEndpoint(allOptions.devices[1]?.value ?? allOptions.groups[1]?.value ?? allOptions.devices[0]?.value ?? "");
  }, [allEndpointValues, allOptions, sourceEndpoint, targetEndpoint]);

  function resolveEndpoint(endpoint: string): { deviceId: number; description: string; type: "device" | "group" } | null {
    if (endpoint.startsWith("device:")) {
      const deviceId = Number(endpoint.replace("device:", ""));
      const device = devices.find((d) => d.id === deviceId);
      return device ? { deviceId, description: deviceLabel(device), type: "device" } : null;
    }
    if (endpoint.startsWith("group:")) {
      const groupName = endpoint.replace("group:", "");
      const representativeDeviceId = groupRepresentativeDeviceId(devices, groupName);
      return representativeDeviceId !== null ? { deviceId: representativeDeviceId, description: groupName, type: "group" } : null;
    }
    return null;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const source = resolveEndpoint(sourceEndpoint);
    const target = resolveEndpoint(targetEndpoint);
    if (!source || !target) { setFormError("Select valid source and target endpoints"); return; }
    if (source.deviceId === target.deviceId) { setFormError("Source and target resolve to the same device"); return; }
    onSubmit({
      source_device_id: source.deviceId,
      target_device_id: target.deviceId,
      relationship_type: relationshipType,
      allow_outbound: allowOutbound,
      allow_inbound: allowInbound,
      notes: composeRelationshipNotes(sourceEndpoint, targetEndpoint, blankToNull(notes) ?? null),
      link_speed_mbps: linkSpeed,
    });
  }

  return (
    <Modal title="Add link" onCancel={onCancel}>
      <form className="modal-form relationship-form" onSubmit={submit}>
        <label>
          Source
          <EndpointPicker value={sourceEndpoint} onChange={setSourceEndpoint} devices={devices} groupNames={groupNames} />
        </label>
        <label>
          Target
          <EndpointPicker value={targetEndpoint} onChange={setTargetEndpoint} devices={devices} groupNames={groupNames} />
        </label>
        <label>
          Type
          <input required value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} />
        </label>
        <label>
          Link speed
          <LinkSpeedSelect value={linkSpeed} onChange={setLinkSpeed} />
        </label>
        <label>
          <span className="inline-toggle">
            <input type="checkbox" checked={allowOutbound} onChange={(e) => setAllowOutbound(e.target.checked)} />
            Allow traffic source → target
          </span>
        </label>
        <label>
          <span className="inline-toggle">
            <input type="checkbox" checked={allowInbound} onChange={(e) => setAllowInbound(e.target.checked)} />
            Allow traffic target → source
          </span>
        </label>
        <label>
          Notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        {formError && <div className="form-error">{formError}</div>}
        <div className="modal-actions modal-actions--plain">
          <button type="button" className="nm-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="nm-btn nm-btn--primary" disabled={busy || !sourceEndpoint || !targetEndpoint}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

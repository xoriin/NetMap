import { useEffect, useMemo, useState } from "react";
import { Search, Network, EyeOff, Eye, ChevronDown, ChevronUp } from "lucide-react";
import { IconServer, IconTopologyRing } from "@tabler/icons-react";
import type { Device, DeviceLiveStatus, Relationship } from "../../api/client";
import { deviceLabel } from "../../utils/format";
import { isDeviceMonitoringPaused } from "../../utils/device";

type EntitySection = "devices" | "relationships" | "groups";

/**
 * Stats buttons + expandable searchable entity list (devices / links / groups).
 * Pure presentation over the filtered graph: selection, visibility, and canvas
 * hover highlighting are delegated to the orchestrator via callbacks — this
 * component never touches the cytoscape instance.
 */
export function EntityList({
  devices,
  relationships,
  allDevices,
  allGroupNames,
  groupDeviceCounts,
  hiddenGroupNames,
  livePingEnabled,
  liveStatusByDeviceId,
  selectedDeviceId,
  selectedRelationshipId,
  onSelectDevice,
  onSelectRelationship,
  onToggleGroupVisibility,
  onDeviceHover,
  onRelationshipHover,
  onGroupHover,
}: {
  /** Devices in the current filtered view. */
  devices: Device[];
  /** Relationships in the current filtered view. */
  relationships: Relationship[];
  /** All (non-filtered) devices — used to resolve link endpoint names. */
  allDevices: Device[];
  allGroupNames: string[];
  groupDeviceCounts: Map<string, number>;
  hiddenGroupNames: Set<string>;
  livePingEnabled: boolean;
  liveStatusByDeviceId: Map<number, DeviceLiveStatus>;
  selectedDeviceId: number | null;
  selectedRelationshipId: number | null;
  onSelectDevice: (deviceId: number) => void;
  onSelectRelationship: (relationshipId: number) => void;
  onToggleGroupVisibility: (groupName: string) => void;
  onDeviceHover: (deviceId: number, hovered: boolean) => void;
  onRelationshipHover: (relationshipId: number, hovered: boolean) => void;
  onGroupHover: (groupName: string, hovered: boolean) => void;
}) {
  const [expandedEntitySection, setExpandedEntitySection] = useState<EntitySection | null>(null);
  const [entitySearch, setEntitySearch] = useState("");

  useEffect(() => { setEntitySearch(""); }, [expandedEntitySection]);

  const filteredEntityDevices = useMemo(() => {
    const q = entitySearch.toLowerCase();
    if (!q) return devices;
    return devices.filter((d) =>
      deviceLabel(d).toLowerCase().includes(q) || d.ip_address.toLowerCase().includes(q),
    );
  }, [entitySearch, devices]);

  const filteredEntityRelationships = useMemo(() => {
    const q = entitySearch.toLowerCase();
    if (!q) return relationships;
    return relationships.filter((rel) => {
      const src = allDevices.find((d) => d.id === rel.source_device_id);
      const tgt = allDevices.find((d) => d.id === rel.target_device_id);
      return (
        (src && deviceLabel(src).toLowerCase().includes(q)) ||
        (tgt && deviceLabel(tgt).toLowerCase().includes(q)) ||
        (rel.relationship_type ?? "").toLowerCase().includes(q)
      );
    });
  }, [entitySearch, relationships, allDevices]);

  const filteredEntityGroups = useMemo(() => {
    const q = entitySearch.toLowerCase();
    if (!q) return allGroupNames;
    return allGroupNames.filter((g) => g.toLowerCase().includes(q));
  }, [entitySearch, allGroupNames]);

  return (
    <>
      {expandedEntitySection && (
        <div className="topo-entity-backdrop" onClick={() => setExpandedEntitySection(null)} />
      )}
      <div className="topo-entity-panel">
        <div className="topo-entity-actions">
          {(["devices", "relationships", "groups"] as const).map((section) => {
            const isActive = expandedEntitySection === section;
            const count = section === "devices"
              ? devices.length
              : section === "relationships"
              ? relationships.length
              : new Set(devices.map((d) => d.topology_group).filter(Boolean)).size;
            const icon = section === "devices"
              ? <IconServer size={13} />
              : section === "relationships"
              ? <Network size={13} />
              : <IconTopologyRing size={13} />;
            const label = section === "devices" ? "Devices" : section === "relationships" ? "Links" : "Groups";
            return (
              <button
                key={section}
                type="button"
                className={`topo-stat-btn${isActive ? " topo-stat-btn--active" : ""} topo-stat-btn--${section}`}
                onClick={() => setExpandedEntitySection(isActive ? null : section)}
              >
                <span className="topo-stat-icon">{icon}</span>
                <span className="topo-stat-count">{count}</span>
                <span className="topo-stat-label">{label}</span>
                {isActive ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
            );
          })}
        </div>
        {expandedEntitySection && (
          <div className="topo-entity-list">
            <div className="topo-entity-search-wrap">
              <div className="nm-search">
                <Search size={14} className="nm-search-icon" aria-hidden="true" />
                <input
                  className="nm-input"
                  placeholder={`Search ${expandedEntitySection === "relationships" ? "links" : expandedEntitySection}…`}
                  value={entitySearch}
                  onChange={(e) => setEntitySearch(e.target.value)}
                  autoFocus
                />
                {entitySearch && (
                  <button type="button" className="topo-entity-search-clear" onClick={() => setEntitySearch("")} aria-label="Clear search">×</button>
                )}
              </div>
            </div>
            <div className="topo-entity-scroll">
            {expandedEntitySection === "devices" && (
              filteredEntityDevices.length === 0
                ? <p className="topo-entity-empty">{entitySearch ? "No devices match" : "No devices"}</p>
                : filteredEntityDevices.map((device) => {
                    const liveStatus = livePingEnabled ? liveStatusByDeviceId.get(device.id) : null;
                    const dotStatus = device.status === "disabled"
                      ? "disabled"
                      : isDeviceMonitoringPaused(device) || !livePingEnabled
                      ? "paused"
                      : (liveStatus?.status ?? device.monitor_status ?? device.status);
                    return (
                      <button
                        key={device.id}
                        type="button"
                        className={`topo-entity-row${selectedDeviceId === device.id ? " topo-entity-row--active" : ""}`}
                        onClick={() => { onSelectDevice(device.id); setExpandedEntitySection(null); }}
                        onMouseEnter={() => onDeviceHover(device.id, true)}
                        onMouseLeave={() => onDeviceHover(device.id, false)}
                      >
                        <span className={`status-dot status-dot--sm ${dotStatus}`} />
                        <span className="topo-entity-name">{deviceLabel(device)}</span>
                        <span className="topo-entity-meta">{device.ip_address}</span>
                      </button>
                    );
                  })
            )}
            {expandedEntitySection === "relationships" && (
              filteredEntityRelationships.length === 0
                ? <p className="topo-entity-empty">{entitySearch ? "No links match" : "No links"}</p>
                : filteredEntityRelationships.map((rel) => {
                    const src = allDevices.find((d) => d.id === rel.source_device_id);
                    const tgt = allDevices.find((d) => d.id === rel.target_device_id);
                    return (
                      <button
                        key={rel.id}
                        type="button"
                        className={`topo-entity-row topo-entity-row--relationship${selectedRelationshipId === rel.id ? " topo-entity-row--active" : ""}`}
                        onClick={() => { onSelectRelationship(rel.id); setExpandedEntitySection(null); }}
                        onMouseEnter={() => onRelationshipHover(rel.id, true)}
                        onMouseLeave={() => onRelationshipHover(rel.id, false)}
                      >
                        <span className="topo-entity-name">{src ? deviceLabel(src) : `#${rel.source_device_id}`}</span>
                        <span className="topo-entity-arrow">→</span>
                        <span className="topo-entity-name">{tgt ? deviceLabel(tgt) : `#${rel.target_device_id}`}</span>
                        {rel.relationship_type && <span className="topo-entity-tag">{rel.relationship_type}</span>}
                      </button>
                    );
                  })
            )}
            {expandedEntitySection === "groups" && (
              filteredEntityGroups.length === 0
                ? <p className="topo-entity-empty">{entitySearch ? "No groups match" : "No groups"}</p>
                : filteredEntityGroups.map((groupName) => {
                    const isHidden = hiddenGroupNames.has(groupName);
                    const count = groupDeviceCounts.get(groupName) ?? 0;
                    return (
                      <div
                        key={groupName}
                        className={`topo-entity-row topo-entity-row--group${isHidden ? " topo-entity-row--hidden" : ""}`}
                        onMouseEnter={() => onGroupHover(groupName, true)}
                        onMouseLeave={() => onGroupHover(groupName, false)}
                      >
                        <span className="topo-entity-group-dot" />
                        <span className="topo-entity-name">{groupName}</span>
                        <span className="topo-entity-meta">{count} device{count !== 1 ? "s" : ""}</span>
                        <button
                          type="button"
                          className="topo-entity-eye"
                          onClick={() => onToggleGroupVisibility(groupName)}
                          title={isHidden ? "Show group" : "Hide group"}
                        >
                          {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                      </div>
                    );
                  })
            )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

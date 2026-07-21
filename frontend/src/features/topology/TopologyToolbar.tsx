import { useMemo, useState } from "react";
import { ChevronDown, EyeOff, Eye, Search } from "lucide-react";
import { IconWifi, IconWifiOff } from "@tabler/icons-react";
import type { Device, Site } from "../../api/client";
import type { GroupLayoutShape } from "../../utils/topology";
import { deviceLabel } from "../../utils/format";

export type GroupDisplayPref = {
  nodeScalePercent: number;
  spacingScalePercent: number;
  maxDevicesPerRow: number;
  layoutShape?: GroupLayoutShape;
  maxRings?: number;
};

/**
 * Topology ribbon toolbar: site filter, status chips, view/export actions,
 * icon/label toggles, group-visibility dropdown, and the display-settings
 * dropdown. Owns only its dropdown open/close state — every layout-affecting
 * change is delegated to the orchestrator, which owns the cytoscape instance.
 */
function DeviceSearch({ devices, onLocate }: { devices: Device[]; onLocate: (deviceId: number) => void }) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return devices
      .filter((device) =>
        (device.display_name ?? "").toLowerCase().includes(needle)
        || (device.hostname ?? "").toLowerCase().includes(needle)
        || device.ip_address.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [devices, query]);

  function pick(deviceId: number) {
    onLocate(deviceId);
    setQuery("");
  }

  return (
    <div className="topo-search">
      <Search size={13} aria-hidden="true" className="topo-search-icon" />
      <input
        className="topo-search-input"
        type="search"
        placeholder="Find device…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && matches.length > 0) {
            event.preventDefault();
            pick(matches[0].id);
          }
          if (event.key === "Escape") setQuery("");
        }}
      />
      {matches.length > 0 && (
        <div className="topo-search-results">
          {matches.map((device) => (
            <button key={device.id} type="button" className="topo-search-result" onClick={() => pick(device.id)}>
              <span className="topo-search-result-name">{deviceLabel(device).split("\n")[0]}</span>
              <span className="topo-search-result-ip">{device.ip_address}</span>
            </button>
          ))}
        </div>
      )}
      {query.trim() !== "" && matches.length === 0 && (
        <div className="topo-search-results">
          <span className="topo-search-empty">No matching devices</span>
        </div>
      )}
    </div>
  );
}

export function TopologyToolbar({
  devices,
  pathMode,
  onLocateDevice,
  onTogglePathMode,
  sites,
  selectedSiteId,
  statusCounts,
  canWrite,
  totalDeviceCount,
  showNodeIcons,
  showNodeLabels,
  allGroupNames,
  visibleGroupNames,
  groupDeviceCounts,
  hiddenGroupNames,
  selectedGroupForDisplay,
  activeGroupDisplay,
  groupZoneOpacityPercent,
  nodeLabelFontSize,
  edgeLabelFontSize,
  onSiteChange,
  onFit,
  onResetLayout,
  onOpenLayouts,
  onExportPng,
  onExportSvg,
  onExportPdf,
  onShowNodeIconsChange,
  onShowNodeLabelsChange,
  onToggleGroupVisibility,
  onShowAllGroups,
  onHideAllGroups,
  onSelectGroupForDisplay,
  onSetGroupPref,
  onAutoArrange,
  onResetGroup,
  onSpacingChange,
  onMaxPerRowChange,
  onZoneOpacityChange,
  onNodeLabelSizeChange,
  onEdgeLabelSizeChange,
  onAddDevice,
  onScan,
  onAddLink,
}: {
  devices: Device[];
  pathMode: boolean;
  onLocateDevice: (deviceId: number) => void;
  onTogglePathMode: () => void;
  sites: Site[];
  selectedSiteId: number | null;
  statusCounts: { online: number; offline: number };
  canWrite: boolean;
  totalDeviceCount: number;
  showNodeIcons: boolean;
  showNodeLabels: boolean;
  allGroupNames: string[];
  visibleGroupNames: string[];
  groupDeviceCounts: Map<string, number>;
  hiddenGroupNames: Set<string>;
  selectedGroupForDisplay: string;
  activeGroupDisplay: GroupDisplayPref;
  groupZoneOpacityPercent: number;
  nodeLabelFontSize: number;
  edgeLabelFontSize: number;
  onSiteChange: (siteId: number | null) => void;
  onFit: () => void;
  onResetLayout: () => void;
  onOpenLayouts: () => void;
  onExportPng: () => void;
  onExportSvg: () => void;
  onExportPdf: () => void;
  onShowNodeIconsChange: (value: boolean) => void;
  onShowNodeLabelsChange: (value: boolean) => void;
  onToggleGroupVisibility: (groupName: string) => void;
  onShowAllGroups: () => void;
  onHideAllGroups: () => void;
  onSelectGroupForDisplay: (groupName: string) => void;
  onSetGroupPref: (patch: Partial<GroupDisplayPref>) => void;
  onAutoArrange: () => void;
  onResetGroup: () => void;
  onSpacingChange: (spacingScalePercent: number) => void;
  onMaxPerRowChange: (maxDevicesPerRow: number) => void;
  onZoneOpacityChange: (percent: number) => void;
  onNodeLabelSizeChange: (size: number) => void;
  onEdgeLabelSizeChange: (size: number) => void;
  onAddDevice: () => void;
  onScan: () => void;
  onAddLink: () => void;
}) {
  const [showGroupsPanel, setShowGroupsPanel] = useState(false);
  const [showDisplaySettings, setShowDisplaySettings] = useState(false);

  return (
    <div className="topology-toolbar topology-toolbar--ribbon">
      <div className="toolbar-group">
        <div className="toolbar-group-controls">
          <select
            className="toolbar-select"
            value={selectedSiteId ?? 0}
            onChange={(event) => {
              const id = Number(event.target.value);
              onSiteChange(id === 0 ? null : id);
            }}
          >
            <option value={0}>All Sites</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>{site.display_name ?? site.name}</option>
            ))}
          </select>
          <span className="inv-stat-chip inv-stat-chip--green">
            <IconWifi size={13} className="inv-stat-chip-icon" />
            <strong className="inv-stat-chip-count">{statusCounts.online}</strong>
            <span className="inv-stat-chip-label">Online</span>
          </span>
          <span className={`inv-stat-chip ${statusCounts.offline > 0 ? "inv-stat-chip--red" : "inv-stat-chip--muted"}`}>
            <IconWifiOff size={13} className="inv-stat-chip-icon" />
            <strong className="inv-stat-chip-count">{statusCounts.offline}</strong>
            <span className="inv-stat-chip-label">Offline</span>
          </span>
        </div>
      </div>
      <div className="toolbar-divider" />
      <div className="toolbar-group">
        <div className="toolbar-group-controls">
          <DeviceSearch devices={devices} onLocate={onLocateDevice} />
          <button type="button" className="nm-btn nm-btn--sm" onClick={onFit}>Fit</button>
          <button type="button" className="nm-btn nm-btn--sm" onClick={onResetLayout}>Reset view</button>
          <button type="button" className="nm-btn nm-btn--sm" onClick={onOpenLayouts}>Layouts</button>
          <button
            type="button"
            className={`nm-btn nm-btn--sm${pathMode ? " nm-btn--active" : ""}`}
            title="Highlight the link path between two devices"
            onClick={onTogglePathMode}
          >
            Path
          </button>
          {canWrite && (
            <>
              <button type="button" className="nm-btn nm-btn--sm" onClick={onExportPng}>PNG</button>
              <button type="button" className="nm-btn nm-btn--sm" onClick={onExportSvg}>SVG</button>
              <button type="button" className="nm-btn nm-btn--sm" onClick={onExportPdf}>PDF</button>
            </>
          )}
        </div>
      </div>
      <div className="toolbar-divider" />
      <div className="toolbar-group">
        <div className="toolbar-group-controls toolbar-group--toggles">
          <label className="toolbar-toggle">
            <input type="checkbox" checked={showNodeIcons} onChange={(e) => onShowNodeIconsChange(e.target.checked)} />
            Icons
          </label>
          <label className="toolbar-toggle">
            <input type="checkbox" checked={showNodeLabels} onChange={(e) => onShowNodeLabelsChange(e.target.checked)} />
            Text
          </label>
        </div>
      </div>
      <div className="toolbar-divider" />
      <div className="toolbar-group">
        <div className="toolbar-group-controls">
          <div className="toolbar-dropdown-wrapper">
            <button
              type="button"
              className={showGroupsPanel ? "nm-btn nm-btn--sm nm-btn--active" : "nm-btn nm-btn--sm"}
              onClick={() => setShowGroupsPanel((c) => !c)}
            >
              Groups
              {hiddenGroupNames.size > 0 && (
                <span className="toolbar-btn-badge">{hiddenGroupNames.size} hidden</span>
              )}
              <ChevronDown size={11} style={{ transition: "transform 0.18s", transform: showGroupsPanel ? "rotate(180deg)" : undefined }} />
            </button>
            {showGroupsPanel && (
              <div className="toolbar-groups-panel">
                <div className="toolbar-groups-actions">
                  <button type="button" className="nm-btn nm-btn--sm" onClick={onShowAllGroups}>
                    Show all
                  </button>
                  <button type="button" className="nm-btn nm-btn--sm" onClick={onHideAllGroups}>
                    Hide all
                  </button>
                </div>
                <div className="toolbar-groups-list">
                  {allGroupNames.map((groupName) => {
                    const isHidden = hiddenGroupNames.has(groupName);
                    const total = groupDeviceCounts.get(groupName) ?? 0;
                    return (
                      <button
                        key={groupName}
                        type="button"
                        className={`toolbar-group-row${isHidden ? " toolbar-group-row--hidden" : ""}`}
                        onClick={() => onToggleGroupVisibility(groupName)}
                        title={isHidden ? "Click to show" : "Click to hide"}
                      >
                        <span className="toolbar-group-eye">
                          {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                        </span>
                        <span className="toolbar-group-name">{groupName}</span>
                        <span className="toolbar-group-count">{total}</span>
                      </button>
                    );
                  })}
                  {allGroupNames.length === 0 && (
                    <p className="toolbar-groups-empty">No groups yet</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="toolbar-divider" />
      <div className="toolbar-group">
        <div className="toolbar-group-controls">
          <div className="toolbar-dropdown-wrapper">
            <button
              type="button"
              className={showDisplaySettings ? "nm-btn nm-btn--sm nm-btn--active" : "nm-btn nm-btn--sm"}
              onClick={() => setShowDisplaySettings((c) => !c)}
            >
              Display
              <ChevronDown size={11} style={{ transition: "transform 0.18s", transform: showDisplaySettings ? "rotate(180deg)" : undefined }} />
            </button>
            {showDisplaySettings && (
              <div className="toolbar-display-panel">
                <label>
                  Group
                  <select value={selectedGroupForDisplay} onChange={(e) => onSelectGroupForDisplay(e.target.value)}>
                    {visibleGroupNames.map((groupName) => (
                      <option key={`display-${groupName}`} value={groupName}>{groupName}</option>
                    ))}
                  </select>
                </label>
                <div className="toolbar-display-shape">
                  {(["grid", "radial"] as GroupLayoutShape[]).map((shape) => (
                    <button
                      key={shape}
                      type="button"
                      className={`nm-btn nm-btn--sm${(activeGroupDisplay.layoutShape ?? "grid") === shape ? " nm-btn--active" : ""}`}
                      onClick={() => onSetGroupPref({ layoutShape: shape })}
                    >
                      {shape === "grid" ? "Grid" : "Radial"}
                    </button>
                  ))}
                </div>
                <div className="toolbar-display-actions">
                  <button
                    type="button"
                    className="nm-btn nm-btn--sm"
                    disabled={!visibleGroupNames.includes(selectedGroupForDisplay)}
                    onClick={onAutoArrange}
                  >
                    Auto-arrange
                  </button>
                  <button type="button" className="nm-btn nm-btn--sm" onClick={onResetGroup} disabled={!visibleGroupNames.includes(selectedGroupForDisplay)}>
                    Reset group
                  </button>
                </div>
                <label>
                  Node size <span>{activeGroupDisplay.nodeScalePercent}%</span>
                  <input type="range" min={70} max={180} step={5} value={activeGroupDisplay.nodeScalePercent}
                    onChange={(e) => onSetGroupPref({ nodeScalePercent: Number(e.target.value) })} />
                </label>
                <label>
                  Spacing <span>{activeGroupDisplay.spacingScalePercent}%</span>
                  <input type="range" min={80} max={220} step={10} value={activeGroupDisplay.spacingScalePercent}
                    onChange={(e) => onSpacingChange(Number(e.target.value))} />
                </label>
                {(activeGroupDisplay.layoutShape ?? "grid") === "radial" && (
                  <label>
                    Rings <span>{activeGroupDisplay.maxRings ?? 1}</span>
                    <input type="range" min={1} max={5} step={1} value={activeGroupDisplay.maxRings ?? 1}
                      onChange={(e) => onSetGroupPref({ maxRings: Number(e.target.value) })} />
                  </label>
                )}
                {(activeGroupDisplay.layoutShape ?? "grid") !== "radial" && <label>
                  Per row <span>{activeGroupDisplay.maxDevicesPerRow}</span>
                  <input type="range" min={3} max={8} step={1} value={activeGroupDisplay.maxDevicesPerRow}
                    onChange={(e) => onMaxPerRowChange(Number(e.target.value))} />
                </label>}
                <label>
                  Background <span>{groupZoneOpacityPercent}%</span>
                  <input type="range" min={0} max={100} step={5} value={groupZoneOpacityPercent}
                    onChange={(e) => onZoneOpacityChange(Number(e.target.value))} />
                </label>
                <label>
                  Device labels <span>{nodeLabelFontSize}px</span>
                  <input type="range" min={9} max={20} step={1} value={nodeLabelFontSize}
                    onChange={(e) => onNodeLabelSizeChange(Number(e.target.value))} />
                </label>
                <label>
                  Link labels <span>{edgeLabelFontSize}px</span>
                  <input type="range" min={10} max={24} step={1} value={edgeLabelFontSize}
                    onChange={(e) => onEdgeLabelSizeChange(Number(e.target.value))} />
                </label>
              </div>
            )}
          </div>
          {canWrite && (
            <>
              <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" onClick={onAddDevice}>+ Device</button>
              <button type="button" className="nm-btn nm-btn--sm" onClick={onScan}>Scan</button>
              <button type="button" className="nm-btn nm-btn--sm" disabled={totalDeviceCount < 2} onClick={onAddLink}>+ Link</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef, useMemo, useCallback, type CSSProperties } from "react";
import "./topology.css";
import cytoscape, { type Core, type EdgeSingular } from "cytoscape";
import { Network } from "lucide-react";
import {
  api,
  type Device, type Relationship, type RelationshipPayload, type DevicePayload,
  type DeviceLiveStatus, type TopologyGraph, type TopologyGroup, type Site,
  type DeviceSecurityEventSummary, type TopologyLayout, type TopologyDisplayPrefs, type DeviceIcon, type SnmpProfile,
} from "../../api/client";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { useIconPacks } from "../../providers/IconPackProvider";
import {
  groupId, buildDiagramLayout, buildGroupVisualRows, centeredOffset,
  savedTopologyLayoutKey, readTopologyDisplayPrefs, writeTopologyDisplayPrefs,
  readSavedTopologyLayout, clearSavedTopologyLayout,
  writeSavedTopologyLayoutMeta,
  persistCurrentTopologyLayout, sanitizeTopologyLayoutPositions,
  type GroupLayoutShape,
} from "../../utils/topology";
import { compareGroupLabels, devicesByHierarchy } from "../../utils/sort";
import { deviceLabel, statusColor } from "../../utils/format";
import { isDeviceMonitoringPaused } from "../../utils/device";
import { deviceIconUrl, deviceIconPath, resolveDeviceIcon } from "../../icons";
import { relationshipVisualSourceNodeId, relationshipVisualTargetNodeId } from "../../utils/relationship";
import { DeviceForm } from "../devices/DeviceForm";
import { RelationshipEditForm, RelationshipForm, formatLinkSpeed } from "./RelationshipForm";
import { DiscoveryModal } from "./DiscoveryModal";
import { LayoutsModal } from "./LayoutsModal";
import { MiniMap, type MiniMapExtent, type MiniMapNode } from "./MiniMap";
import { buildCytoscapeStylesheet, linkSpeedEdgeWidth } from "./cytoscapeStyles";
import { exportTopologyPng, exportTopologySvg, exportTopologyPdf } from "./topologyExport";
import { EntityList } from "./EntityList";
import {
  DEFAULT_NODE_SCALE_PERCENT,
  MAX_NODE_LABEL_FONT_SIZE,
  MAX_NODE_SCALE_PERCENT,
  MIN_NODE_LABEL_FONT_SIZE,
  MIN_NODE_SCALE_PERCENT,
  TopologyCanvasControls,
  TopologyToolbar,
  type GroupDisplayPref,
} from "./TopologyToolbar";
import { DetailsPanel } from "./DetailsPanel";
import { useDeviceTypes } from "../../hooks/useDeviceTypes";

const DEFAULT_EDGE_LABEL_FONT_SIZE = 15;
const DEFAULT_NODE_LABEL_FONT_SIZE = 13;
const BASE_DEVICE_ICON_SIZE = 38;

export function TopologyWorkspace({
  accessToken,
  canViewSecurity,
  canWrite,
  graph,
  onGraphChange,
  jumpTarget,
  livePingEnabled,
  onSelectedDeviceChange,
  theme,
  userId,
}: {
  accessToken: string | null;
  canViewSecurity: boolean;
  canWrite: boolean;
  graph: TopologyGraph;
  onGraphChange: () => Promise<void>;
  jumpTarget: { deviceId: number; token: number } | null;
  livePingEnabled: boolean;
  onSelectedDeviceChange: (device: Device | null) => void;
  theme: "light" | "dark";
  userId: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();
  const cyRef = useRef<Core | null>(null);
  const layoutPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const fitOnNextRenderRef = useRef(true);
  const skipPersistOnNextRenderRef = useRef(false);
  const knownGroupIdsRef = useRef<Set<string>>(new Set());
  const confirmAction = useConfirm();
  const { activeIconPackId } = useIconPacks();
  const deviceTypesQuery = useDeviceTypes(accessToken);
  const deviceTypeOptions = deviceTypesQuery.options;
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<number | null>(null);
  const [panelHoveredDeviceId, setPanelHoveredDeviceId] = useState<number | null>(null);
  const [canvasHoveredDeviceId, setCanvasHoveredDeviceId] = useState<number | null>(null);
  const [cloningDevice, setCloningDevice] = useState<Device | null>(null);
  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [showRelationshipForm, setShowRelationshipForm] = useState(false);
  const [showRelationshipEditForm, setShowRelationshipEditForm] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const [showLayoutsModal, setShowLayoutsModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [deviceSecuritySummary, setDeviceSecuritySummary] = useState<DeviceSecurityEventSummary | null>(null);
  const [deviceSecurityLoading, setDeviceSecurityLoading] = useState(false);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [savedLayouts, setSavedLayouts] = useState<TopologyLayout[]>([]);
  const [groups, setGroups] = useState<TopologyGroup[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [snmpProfiles, setSnmpProfiles] = useState<SnmpProfile[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [activeSavedLayoutId, setActiveSavedLayoutId] = useState<number | null>(null);
  const [liveStatuses, setLiveStatuses] = useState<DeviceLiveStatus[]>([]);
  const [hiddenGroupNames, setHiddenGroupNames] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(`netmap.topology-hidden-groups.${userId}`);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const [groupZoneOpacityPercent, setGroupZoneOpacityPercent] = useState<number>(() => {
    try { return readTopologyDisplayPrefs(userId).groupZoneOpacityPercent ?? 10; } catch { return 10; }
  });
  const [edgeLabelFontSize, setEdgeLabelFontSize] = useState<number>(() => {
    try { return Number(localStorage.getItem(`netmap.edge-label-size.${userId}`)) || DEFAULT_EDGE_LABEL_FONT_SIZE; } catch { return DEFAULT_EDGE_LABEL_FONT_SIZE; }
  });
  const [nodeLabelFontSize, setNodeLabelFontSize] = useState<number>(() => {
    try {
      const prefs = readTopologyDisplayPrefs(userId);
      return prefs.nodeLabelFontSize ?? (Number(localStorage.getItem(`netmap.node-label-size.${userId}`)) || DEFAULT_NODE_LABEL_FONT_SIZE);
    } catch { return DEFAULT_NODE_LABEL_FONT_SIZE; }
  });
  const [showGroupZoneBorders, setShowGroupZoneBorders] = useState<boolean>(() => {
    try { return readTopologyDisplayPrefs(userId).showGroupZoneBorders ?? true; } catch { return true; }
  });
  const [showNodeIcons, setShowNodeIcons] = useState<boolean>(() => {
    try { return readTopologyDisplayPrefs(userId).showNodeIcons ?? true; } catch { return true; }
  });
  const [showNodeLabels, setShowNodeLabels] = useState<boolean>(() => {
    try { return readTopologyDisplayPrefs(userId).showNodeLabels ?? true; } catch { return true; }
  });
  const [selectedGroupForDisplay, setSelectedGroupForDisplay] = useState("Ungrouped");
  const [groupDisplayPrefs, setGroupDisplayPrefs] = useState<Record<string, GroupDisplayPref>>({});
  const [overlayNodes, setOverlayNodes] = useState<
    Array<{ id: number; x: number; y: number; lines: string[]; color: string; icon: DeviceIcon; size: number; labelFontSize: number; status: string }>
  >([]);
  const [overlayGroups, setOverlayGroups] = useState<
    Array<{ id: string; label: string; x: number; y: number; width: number; online: number }>
  >([]);
  const [overlayLinks, setOverlayLinks] = useState<
    Array<{ id: number; x: number; y: number; label: string; speed: string | null }>
  >([]);
  const [flashDeviceId, setFlashDeviceId] = useState<number | null>(null);
  const [recentlyChangedIds, setRecentlyChangedIds] = useState<Set<number>>(new Set());
  const prevLiveStatusRef = useRef<Map<number, string>>(new Map());
  const [pathMode, setPathMode] = useState(false);
  const [pathStartId, setPathStartId] = useState<number | null>(null);
  const [pathNodeIds, setPathNodeIds] = useState<Set<number> | null>(null);
  const pathElementIdsRef = useRef<string[]>([]);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<number[]>([]);
  const [bulkGroupChoice, setBulkGroupChoice] = useState("");
  const [bulkSiteChoice, setBulkSiteChoice] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [minimapNodes, setMinimapNodes] = useState<MiniMapNode[]>([]);
  const [minimapExtent, setMinimapExtent] = useState<MiniMapExtent | null>(null);
  const deviceTapRef = useRef<(deviceId: number) => void>(() => {});
  const backgroundTapRef = useRef<() => void>(() => {});
  const refreshOverlayNodesRef = useRef<() => void>(() => {});
  const serverSaveLayoutRef = useRef<(positions: Record<string, { x: number; y: number }>, immediate?: boolean) => void>(() => {});
  const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutInitialLoadDoneRef = useRef(false);
  const setGroupForDisplayRef = useRef<(group: string) => void>(() => {});
  const userIdRef = useRef(userId);
  const previousShowDeviceFormRef = useRef(false);
  const pendingDevicePatchesRef = useRef<Record<number, Partial<Device>>>({});
  const pendingRelationshipPatchesRef = useRef<Record<number, Partial<Relationship>>>({});
  const correlationWindowHours = 24;
  const [liveGraph, setLiveGraph] = useState<TopologyGraph>(graph);
  const [cyZoom, setCyZoom] = useState(1);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

// Keep these callbacks fresh with the latest state every render
  setGroupForDisplayRef.current = (group: string) => {
    setSelectedGroupForDisplay(group);
  };

  function clearPathHighlight() {
    cyRef.current?.elements().removeClass("path-highlight path-dim");
    pathElementIdsRef.current = [];
    setPathNodeIds(null);
    setPathStartId(null);
  }

  function handlePathClick(deviceId: number) {
    const cy = cyRef.current;
    if (!cy) return;
    if (pathStartId === null || pathStartId === deviceId) {
      clearPathHighlight();
      setPathStartId(deviceId);
      setPathNodeIds(new Set([deviceId]));
      return;
    }
    cy.elements().removeClass("path-highlight path-dim");
    // Pathfinding walks drawn links AND zone membership: many maps link the
    // VLAN/group zone (not each device) to the switch, so a device's only
    // route is device → its zone → onward links. Cytoscape's dijkstra only
    // follows edges, so we BFS over an adjacency that adds a virtual hop
    // between every device and its parent zone.
    const adjacency = new Map<string, { node: string; edge: string | null }[]>();
    const addHop = (a: string, b: string, edge: string | null) => {
      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);
      adjacency.get(a)!.push({ node: b, edge });
      adjacency.get(b)!.push({ node: a, edge });
    };
    cy.edges().forEach((edge) => addHop(edge.source().id(), edge.target().id(), edge.id()));
    cy.nodes(".device").forEach((node) => {
      const parent = node.parent();
      if (parent.length > 0) addHop(node.id(), parent.first().id(), null);
    });

    const startNodeId = `device-${pathStartId}`;
    const targetNodeId = `device-${deviceId}`;
    const previousHop = new Map<string, { node: string; edge: string | null }>();
    const visited = new Set([startNodeId]);
    const queue = [startNodeId];
    while (queue.length > 0 && !visited.has(targetNodeId)) {
      const current = queue.shift() as string;
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next.node)) continue;
        visited.add(next.node);
        previousHop.set(next.node, { node: current, edge: next.edge });
        queue.push(next.node);
      }
    }
    if (!visited.has(targetNodeId)) {
      toast.error("No linked path between these devices");
      pathElementIdsRef.current = [];
      setPathStartId(null);
      setPathNodeIds(null);
      return;
    }
    const elementIds: string[] = [targetNodeId];
    let cursor = targetNodeId;
    while (cursor !== startNodeId) {
      const hop = previousHop.get(cursor) as { node: string; edge: string | null };
      if (hop.edge !== null) elementIds.push(hop.edge);
      elementIds.push(hop.node);
      cursor = hop.node;
    }
    let pathElements = cy.collection();
    for (const elementId of elementIds) {
      pathElements = pathElements.union(cy.$id(elementId));
    }
    pathElements.addClass("path-highlight");
    cy.elements("node.device, edge").not(pathElements).addClass("path-dim");
    pathElementIdsRef.current = elementIds;
    const ids = new Set<number>();
    for (const elementId of elementIds) {
      const match = elementId.match(/^device-(\d+)$/);
      if (match) ids.add(Number(match[1]));
    }
    setPathNodeIds(ids);
    setPathStartId(null);
  }

  function togglePathMode() {
    if (pathMode) clearPathHighlight();
    setPathMode(!pathMode);
  }

  function locateDevice(deviceId: number) {
    const cy = cyRef.current;
    if (!cy) return;
    const node = cy.$id(`device-${deviceId}`);
    if (node.length === 0) {
      toast.error("That device is hidden by the current filters");
      return;
    }
    cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.4) }, { duration: 350 });
    setFlashDeviceId(deviceId);
    window.setTimeout(() => setFlashDeviceId((current) => (current === deviceId ? null : current)), 2600);
  }

  function centerCanvasOn(modelX: number, modelY: number) {
    const cy = cyRef.current;
    if (!cy) return;
    const zoom = cy.zoom();
    cy.animate(
      { pan: { x: cy.width() / 2 - modelX * zoom, y: cy.height() / 2 - modelY * zoom } },
      { duration: 200 },
    );
  }

  function clearBulkSelection() {
    cyRef.current?.$("node.device:selected").unselect();
    setBulkSelectedIds([]);
    setBulkGroupChoice("");
    setBulkSiteChoice("");
  }

  async function applyBulkAssignment() {
    if (!accessToken || bulkSelectedIds.length < 2) return;
    const payload: { device_ids: number[]; topology_group_id?: number; site_id?: number } = {
      device_ids: bulkSelectedIds,
    };
    if (bulkGroupChoice) payload.topology_group_id = Number(bulkGroupChoice);
    if (bulkSiteChoice) payload.site_id = Number(bulkSiteChoice);
    if (payload.topology_group_id === undefined && payload.site_id === undefined) return;
    setBulkBusy(true);
    try {
      const result = await api.bulkUpdateDeviceGroup(accessToken, payload);
      toast.success(`Updated ${result.updated} device${result.updated !== 1 ? "s" : ""}`);
      clearBulkSelection();
      await onGraphChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk update failed");
    } finally {
      setBulkBusy(false);
    }
  }

  deviceTapRef.current = (deviceId: number) => {
    if (pathMode) {
      handlePathClick(deviceId);
      return;
    }
    setSelectedDeviceId(deviceId);
    setSelectedRelationshipId(null);
  };

  backgroundTapRef.current = () => {
    setSelectedDeviceId(null);
    setSelectedRelationshipId(null);
    if (pathNodeIds !== null || pathStartId !== null) clearPathHighlight();
  };

  const currentDisplayPrefsRef = useRef({
    groupDisplayPrefs,
    edgeLabelFontSize,
    nodeLabelFontSize,
    groupZoneOpacityPercent,
    showGroupZoneBorders,
    hiddenGroupNames,
    showNodeIcons,
    showNodeLabels,
  });
  currentDisplayPrefsRef.current = {
    groupDisplayPrefs,
    edgeLabelFontSize,
    nodeLabelFontSize,
    groupZoneOpacityPercent,
    showGroupZoneBorders,
    hiddenGroupNames,
    showNodeIcons,
    showNodeLabels,
  };

  serverSaveLayoutRef.current = (positions: Record<string, { x: number; y: number }>, immediate = false) => {
    if (!accessToken || !layoutInitialLoadDoneRef.current) return;
    if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
    const token = accessToken;
    const sanitizedPositions = sanitizeTopologyLayoutPositions(positions);
    const dp = currentDisplayPrefsRef.current;
    const save = () => {
      void api.saveTopologyLayout(token, {
        name: "__autosave__",
        positions: sanitizedPositions,
        display_prefs: {
          groupDisplayPrefs: dp.groupDisplayPrefs,
          edgeLabelFontSize: dp.edgeLabelFontSize,
          nodeLabelFontSize: dp.nodeLabelFontSize,
          groupZoneOpacityPercent: dp.groupZoneOpacityPercent,
          showGroupZoneBorders: dp.showGroupZoneBorders,
          hiddenGroupNames: [...dp.hiddenGroupNames],
          showNodeIcons: dp.showNodeIcons,
          showNodeLabels: dp.showNodeLabels,
        },
      });
    };
    if (immediate) {
      save();
      return;
    }
    layoutSaveTimerRef.current = setTimeout(save, 2000);
  };

  useEffect(() => {
    setLiveGraph((current) => ({
      devices: graph.devices.map((incoming) => ({
        ...incoming,
        ...pendingDevicePatchesRef.current[incoming.id],
      })),
      relationships: graph.relationships.map((incoming) => {
        const existing = current.relationships.find((row) => row.id === incoming.id);
        const pending = pendingRelationshipPatchesRef.current[incoming.id];
        return {
          ...incoming,
          ...pending,
          allow_outbound: pending?.allow_outbound ?? incoming.allow_outbound ?? existing?.allow_outbound ?? true,
          allow_inbound: pending?.allow_inbound ?? incoming.allow_inbound ?? existing?.allow_inbound ?? true,
        };
      }),
    }));
  }, [graph]);

  const selectedDevice = liveGraph.devices.find((device) => device.id === selectedDeviceId) ?? null;
  const selectedRelationship = liveGraph.relationships.find((relationship) => relationship.id === selectedRelationshipId) ?? null;
  const showDetailsPanel = selectedDevice !== null || selectedRelationship !== null;

  useEffect(() => {
    onSelectedDeviceChange(selectedDevice);
  }, [onSelectedDeviceChange, selectedDevice]);

  function applyAutosaveLayout(layout: TopologyLayout) {
    const autosavePositions = sanitizeTopologyLayoutPositions(layout.positions);
    const autosaveTs = new Date(layout.updated_at).getTime();
    layoutPositionsRef.current = autosavePositions;
    writeSavedTopologyLayoutMeta(userId, { savedAt: autosaveTs });
    window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(autosavePositions));
    fitOnNextRenderRef.current = true;
    skipPersistOnNextRenderRef.current = true;
    if (layout.display_prefs) {
      const dp = layout.display_prefs;
      if (dp.groupDisplayPrefs !== undefined) setGroupDisplayPrefs(dp.groupDisplayPrefs);
      if (dp.edgeLabelFontSize !== undefined) setEdgeLabelFontSize(dp.edgeLabelFontSize);
      if (dp.nodeLabelFontSize !== undefined) setNodeLabelFontSize(dp.nodeLabelFontSize);
      if (dp.groupZoneOpacityPercent !== undefined) setGroupZoneOpacityPercent(dp.groupZoneOpacityPercent);
      if (dp.showGroupZoneBorders !== undefined) setShowGroupZoneBorders(dp.showGroupZoneBorders);
      if (dp.hiddenGroupNames !== undefined) setHiddenGroupNames(new Set(dp.hiddenGroupNames));
      if (dp.showNodeIcons !== undefined) setShowNodeIcons(dp.showNodeIcons);
      if (dp.showNodeLabels !== undefined) setShowNodeLabels(dp.showNodeLabels);
      try { localStorage.setItem(`netmap.edge-label-size.${userId}`, String(dp.edgeLabelFontSize ?? DEFAULT_EDGE_LABEL_FONT_SIZE)); } catch {}
      try { localStorage.setItem(`netmap.node-label-size.${userId}`, String(dp.nodeLabelFontSize ?? DEFAULT_NODE_LABEL_FONT_SIZE)); } catch {}
      try { localStorage.setItem(`netmap.topology-hidden-groups.${userId}`, JSON.stringify(dp.hiddenGroupNames ?? [])); } catch {}
    }
    setLayoutRevision((c) => c + 1);
  }

  function currentDisplayPrefsSnapshot(): TopologyDisplayPrefs {
    const dp = currentDisplayPrefsRef.current;
    return {
      groupDisplayPrefs: dp.groupDisplayPrefs,
      edgeLabelFontSize: dp.edgeLabelFontSize,
      nodeLabelFontSize: dp.nodeLabelFontSize,
      groupZoneOpacityPercent: dp.groupZoneOpacityPercent,
      showGroupZoneBorders: dp.showGroupZoneBorders,
      hiddenGroupNames: [...dp.hiddenGroupNames],
      showNodeIcons: dp.showNodeIcons,
      showNodeLabels: dp.showNodeLabels,
    };
  }

  async function refreshSavedLayouts() {
    if (!accessToken) return;
    const layouts = await api.topologyLayouts(accessToken);
    setSavedLayouts(layouts.filter((l) => l.name !== "__autosave__"));
  }

  function loadNamedLayout(layout: TopologyLayout) {
    applyAutosaveLayout(layout);
    // Persist the loaded layout as the new autosave canvas state immediately;
    // the display-prefs effect re-saves with the freshly applied prefs after
    // this render if they changed.
    serverSaveLayoutRef.current(sanitizeTopologyLayoutPositions(layout.positions), true);
    setShowLayoutsModal(false);
  }

  useEffect(() => {
    layoutPositionsRef.current = readSavedTopologyLayout(userId);
    const displayPrefs = readTopologyDisplayPrefs(userId);
    setGroupDisplayPrefs(displayPrefs.groups);
    setNodeLabelFontSize(displayPrefs.nodeLabelFontSize ?? (Number(localStorage.getItem(`netmap.node-label-size.${userId}`)) || DEFAULT_NODE_LABEL_FONT_SIZE));
    setEdgeLabelFontSize(Number(localStorage.getItem(`netmap.edge-label-size.${userId}`)) || DEFAULT_EDGE_LABEL_FONT_SIZE);
    fitOnNextRenderRef.current = true;
    setLayoutRevision((current) => current + 1);
  }, [userId]);

  useEffect(() => {
    writeTopologyDisplayPrefs(userId, {
      groups: groupDisplayPrefs,
      groupZoneOpacityPercent,
      showGroupZoneBorders,
      showNodeIcons,
      showNodeLabels,
      nodeLabelFontSize,
    });
  }, [groupDisplayPrefs, groupZoneOpacityPercent, nodeLabelFontSize, showGroupZoneBorders, showNodeIcons, showNodeLabels, userId]);

  useEffect(() => {
    serverSaveLayoutRef.current(layoutPositionsRef.current);
  }, [groupDisplayPrefs, edgeLabelFontSize, groupZoneOpacityPercent, hiddenGroupNames, nodeLabelFontSize, showGroupZoneBorders, showNodeIcons, showNodeLabels]);

  useEffect(() => {
    if (!accessToken) {
      setSavedLayouts([]);
      setGroups([]);
      setSites([]);
      layoutInitialLoadDoneRef.current = false;
      return;
    }
    layoutInitialLoadDoneRef.current = false;
    const token = accessToken;
    let cancelled = false;
    async function loadSavedLayouts() {
      try {
        const layouts = await api.topologyLayouts(token);
        if (!cancelled) {
          setSavedLayouts(layouts.filter((l) => l.name !== "__autosave__"));
          const autosave = layouts.find((l) => l.name === "__autosave__");
          if (autosave) {
            applyAutosaveLayout(autosave);
          }
          layoutInitialLoadDoneRef.current = true;
        }
      } catch (err) {
        if (!cancelled) {
          layoutInitialLoadDoneRef.current = true;
          setTopologyError(err instanceof Error ? err.message : "Unable to load saved layouts");
        }
      }
    }
    async function loadGroups() {
      try {
        const rows = await api.topologyGroups(token);
        if (!cancelled) {
          setGroups(rows);
        }
      } catch {
        // topology remains functional without group metadata
      }
    }
    async function loadSites() {
      try {
        const rows = await api.sites(token);
        if (!cancelled) {
          setSites(rows);
        }
      } catch {
        // topology remains functional without site metadata
      }
    }
    async function loadSnmpProfiles() {
      try {
        const rows = await api.listSnmpProfiles(token);
        if (!cancelled) {
          setSnmpProfiles(rows);
        }
      } catch {
        // SNMP controls remain optional
      }
    }
    loadSavedLayouts();
    void loadGroups();
    void loadSites();
    void loadSnmpProfiles();
    return () => {
      cancelled = true;
    };
  }, [accessToken, userId]);

  const liveStatusByDeviceId = useMemo(
    () => new Map(liveStatuses.map((row) => [row.device_id, row])),
    [liveStatuses],
  );
  const filteredGraph = useMemo(() => {
    const disabledIds = new Set(
      liveGraph.devices.filter((d) => d.status === "disabled").map((d) => d.id),
    );
    let base: TopologyGraph = disabledIds.size > 0 ? {
      devices: liveGraph.devices.filter((d) => d.status !== "disabled"),
      relationships: liveGraph.relationships.filter(
        (r) => !disabledIds.has(r.source_device_id) && !disabledIds.has(r.target_device_id),
      ),
    } : liveGraph;

    if (selectedSiteId !== null) {
      const siteDeviceIds = new Set(
        base.devices.filter((d) => d.site_id === selectedSiteId).map((d) => d.id),
      );
      base = {
        devices: base.devices.filter((d) => siteDeviceIds.has(d.id)),
        relationships: base.relationships.filter(
          (r) => siteDeviceIds.has(r.source_device_id) && siteDeviceIds.has(r.target_device_id),
        ),
      };
    }

    if (hiddenGroupNames.size > 0) {
      const hiddenIds = new Set(
        base.devices
          .filter((d) => hiddenGroupNames.has(d.topology_group ?? "Ungrouped"))
          .map((d) => d.id),
      );
      base = {
        devices: base.devices.filter((d) => !hiddenIds.has(d.id)),
        relationships: base.relationships.filter(
          (r) => !hiddenIds.has(r.source_device_id) && !hiddenIds.has(r.target_device_id),
        ),
      };
    }

    return base;
  }, [hiddenGroupNames, liveGraph, selectedSiteId]);
  const visibleGroupNames = useMemo(
    () => [...new Set(filteredGraph.devices.map((device) => device.topology_group))].sort(compareGroupLabels),
    [filteredGraph.devices],
  );

  // All groups from liveGraph (includes hidden ones — needed for the visibility panel)
  const allGroupNames = useMemo(() => {
    const names = new Set<string>();
    for (const d of liveGraph.devices) {
      if (d.status !== "disabled") names.add(d.topology_group ?? "Ungrouped");
    }
    return [...names].sort(compareGroupLabels);
  }, [liveGraph.devices]);

  // Device count per group (non-disabled), shared by the entity list and the
  // toolbar's group-visibility dropdown.
  const groupDeviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of liveGraph.devices) {
      if (d.status === "disabled") continue;
      const name = d.topology_group ?? "Ungrouped";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [liveGraph.devices]);

  useEffect(() => {
    localStorage.setItem(`netmap.topology-hidden-groups.${userId}`, JSON.stringify([...hiddenGroupNames]));
  }, [hiddenGroupNames, userId]);
  const topoStatusCounts = useMemo(() => {
    let online = 0, offline = 0;
    for (const d of filteredGraph.devices) {
      const s = liveStatusByDeviceId.get(d.id)?.status ?? d.monitor_status ?? d.status;
      if (s === "online") online++;
      else if (s === "offline") offline++;
    }
    return { online, offline };
  }, [filteredGraph.devices, liveStatusByDeviceId]);
  const storedActiveGroupDisplay =
    groupDisplayPrefs[selectedGroupForDisplay] ?? { nodeScalePercent: DEFAULT_NODE_SCALE_PERCENT, spacingScalePercent: 120, maxDevicesPerRow: 4 };
  const activeGroupDisplay = {
    ...storedActiveGroupDisplay,
    nodeScalePercent: Math.max(MIN_NODE_SCALE_PERCENT, Math.min(MAX_NODE_SCALE_PERCENT, storedActiveGroupDisplay.nodeScalePercent)),
    labelFontSize: Math.max(
      MIN_NODE_LABEL_FONT_SIZE,
      Math.min(MAX_NODE_LABEL_FONT_SIZE, storedActiveGroupDisplay.labelFontSize ?? nodeLabelFontSize),
    ),
  };

  const refreshOverlayNodes = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const nextMiniNodes: MiniMapNode[] = [];
    const nextNodes = filteredGraph.devices
      .map((device) => {
        const node = cy.$id(`device-${device.id}`);
        if (node.length === 0) {
          return null;
        }
        const position = node.renderedPosition();
        const label = deviceLabel(device);
        const groupName = device.topology_group ?? "Ungrouped";
        const nodeScale = Math.max(
          MIN_NODE_SCALE_PERCENT / 100,
          Math.min(MAX_NODE_SCALE_PERCENT / 100, Number(node.data("nodeScale") ?? DEFAULT_NODE_SCALE_PERCENT / 100)),
        );
        const labelFontSize = Math.max(
          MIN_NODE_LABEL_FONT_SIZE,
          Math.min(MAX_NODE_LABEL_FONT_SIZE, groupDisplayPrefs[groupName]?.labelFontSize ?? nodeLabelFontSize),
        );
        const liveStatus = isDeviceMonitoringPaused(device) || !livePingEnabled
          ? "paused"
          : (liveStatusByDeviceId.get(device.id)?.status ?? device.monitor_status ?? device.status);
        const colorStatus = liveStatus === "paused" ? "unknown" : liveStatus;
        const color = device.color || statusColor(colorStatus);
        const modelPosition = node.position();
        nextMiniNodes.push({ id: device.id, x: modelPosition.x, y: modelPosition.y, color });
        return {
          id: device.id,
          x: position.x,
          y: position.y,
          lines: label.split("\n"),
          color,
          icon: resolveDeviceIcon(device.icon),
          size: Math.round(BASE_DEVICE_ICON_SIZE * nodeScale),
          labelFontSize,
          status: liveStatus,
        };
      })
      .filter((row): row is { id: number; x: number; y: number; lines: string[]; color: string; icon: DeviceIcon; size: number; labelFontSize: number; status: string } => row !== null);
    setOverlayNodes(nextNodes);
    const nextGroups = cy.$("node.zone").map((zone) => {
      const label = String(zone.data("label") ?? "Ungrouped");
      const bounds = zone.renderedBoundingBox();
      const online = filteredGraph.devices.reduce((count, device) => {
        if ((device.topology_group ?? "Ungrouped") !== label) return count;
        const liveStatus = isDeviceMonitoringPaused(device) || !livePingEnabled
          ? "paused"
          : (liveStatusByDeviceId.get(device.id)?.status ?? device.monitor_status ?? device.status);
        return count + (liveStatus === "online" ? 1 : 0);
      }, 0);
      return {
        id: zone.id(),
        label,
        x: bounds.x1 + 12,
        y: bounds.y1 + 10,
        width: Math.max(80, bounds.w - 24),
        online,
      };
    });
    setOverlayGroups(nextGroups);
    const relationshipById = new Map(filteredGraph.relationships.map((relationship) => [relationship.id, relationship]));
    const nextLinks = cy.$("edge").map((edge) => {
      const id = Number(edge.id().replace("relationship-", ""));
      const relationship = relationshipById.get(id);
      const midpoint = (edge as EdgeSingular).renderedMidpoint();
      return {
        id,
        x: midpoint.x,
        y: midpoint.y,
        label: relationship?.relationship_type ?? String(edge.data("label") ?? "Link"),
        speed: relationship?.link_speed_mbps != null ? formatLinkSpeed(relationship.link_speed_mbps) : null,
      };
    });
    setOverlayLinks(nextLinks);
    setMinimapNodes(nextMiniNodes);
    const extent = cy.extent();
    setMinimapExtent({ x1: extent.x1, y1: extent.y1, x2: extent.x2, y2: extent.y2 });
  }, [activeIconPackId, filteredGraph.devices, groupDisplayPrefs, livePingEnabled, liveStatusByDeviceId, nodeLabelFontSize]);

  useEffect(() => {
    refreshOverlayNodesRef.current = refreshOverlayNodes;
  }, [refreshOverlayNodes]);

  useEffect(() => {
    const justClosed = previousShowDeviceFormRef.current && !showDeviceForm;
    previousShowDeviceFormRef.current = showDeviceForm;
    if (!justClosed) {
      return;
    }
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    window.requestAnimationFrame(() => {
      cy.resize();
      refreshOverlayNodes();
    });
  }, [refreshOverlayNodes, showDeviceForm]);

  useEffect(() => {
    if (visibleGroupNames.length === 0) {
      return;
    }
    if (!visibleGroupNames.includes(selectedGroupForDisplay)) {
      setSelectedGroupForDisplay(visibleGroupNames[0]);
    }
  }, [selectedGroupForDisplay, visibleGroupNames]);

  async function refreshLiveStatuses(silent = false) {
    if (!accessToken || !livePingEnabled) {
      setLiveStatuses([]);
      return;
    }
    try {
      const rows = await api.listMonitoringDevices(accessToken);
      const visibleIds = new Set(liveGraph.devices.map((device) => device.id));
      setLiveStatuses(rows
        .filter((row) => visibleIds.has(row.device_id))
        .map((row) => ({
          device_id: row.device_id,
          status: row.status === "online" || row.status === "offline" || row.status === "warning" || row.status === "unknown" || row.status === "disabled" ? row.status : "unknown",
          latency_ms: row.avg_rtt_24h,
          last_checked_at: row.last_checked ?? new Date().toISOString(),
          error: null,
        })));
    } catch (err) {
      if (!silent) {
        setTopologyError(err instanceof Error ? err.message : "Unable to refresh live status");
      }
    }
  }

  useEffect(() => {
    if (!livePingEnabled || !accessToken || liveGraph.devices.length === 0) {
      setLiveStatuses([]);
      return;
    }
    let cancelled = false;
    let intervalId = 0;
    async function loadStatuses(initialLoad: boolean) {
      if (initialLoad) {
        await refreshLiveStatuses();
        return;
      }
      if (cancelled) {
        return;
      }
      await refreshLiveStatuses(true);
    }
    void loadStatuses(true);
    intervalId = window.setInterval(() => {
      void loadStatuses(false);
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessToken, livePingEnabled, liveGraph.devices]);

  // Devices whose live status changed since the previous poll get a short
  // attention pulse so outages/recoveries draw the eye on a busy map.
  useEffect(() => {
    const previous = prevLiveStatusRef.current;
    const next = new Map<number, string>();
    const changed: number[] = [];
    liveStatusByDeviceId.forEach((row, deviceId) => {
      next.set(deviceId, row.status);
      const before = previous.get(deviceId);
      if (before !== undefined && before !== row.status) changed.push(deviceId);
    });
    prevLiveStatusRef.current = next;
    if (changed.length === 0) return;
    setRecentlyChangedIds((current) => new Set([...current, ...changed]));
    const timer = window.setTimeout(() => {
      setRecentlyChangedIds((current) => {
        const copy = new Set(current);
        for (const id of changed) copy.delete(id);
        return copy;
      });
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [liveStatusByDeviceId]);

  useEffect(() => {
    if (!canViewSecurity || !accessToken || !selectedDevice) {
      setDeviceSecuritySummary(null);
      return;
    }
    const token = accessToken;
    const deviceId = selectedDevice.id;
    let cancelled = false;
    async function loadDeviceSummary() {
      setDeviceSecurityLoading(true);
      try {
        const summary = await api.deviceSecurityEvents(token, deviceId, {
          window_hours: correlationWindowHours,
          limit: 8,
        });
        if (!cancelled) {
          setDeviceSecuritySummary(summary);
        }
      } catch (err) {
        if (!cancelled) {
          setTopologyError(err instanceof Error ? err.message : "Unable to load device security activity");
        }
      } finally {
        if (!cancelled) {
          setDeviceSecurityLoading(false);
        }
      }
    }
    loadDeviceSummary();
    return () => {
      cancelled = true;
    };
  }, [accessToken, canViewSecurity, correlationWindowHours, selectedDevice]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    if (!cyRef.current) {
      cyRef.current = cytoscape({
        container: containerRef.current,
        layout: { name: "preset", fit: true, padding: 36 },
        boxSelectionEnabled: true,
        zoomingEnabled: true,
        userZoomingEnabled: true,
        style: buildCytoscapeStylesheet(edgeLabelFontSize),
      });
      cyRef.current.on("tap", "node.device", (event) => {
        deviceTapRef.current(Number(event.target.id().replace("device-", "")));
      });
      cyRef.current.on("select unselect", "node.device", () => {
        const ids =
          cyRef.current
            ?.$("node.device:selected")
            .map((node) => Number(node.id().replace("device-", ""))) ?? [];
        setBulkSelectedIds(ids);
      });
      cyRef.current.on("tap", "edge", (event) => {
        setSelectedRelationshipId(Number(event.target.id().replace("relationship-", "")));
        setSelectedDeviceId(null);
      });
      cyRef.current.on("mouseover", "node.device", (event) => {
        const node = event.target;
        setCanvasHoveredDeviceId(Number(node.id().replace("device-", "")));
        node.addClass("hovered");
        node.connectedEdges().addClass("hovered");
      });
      cyRef.current.on("mouseout", "node.device", (event) => {
        const node = event.target;
        setCanvasHoveredDeviceId(null);
        node.removeClass("hovered");
        node.connectedEdges().removeClass("hovered");
      });
      cyRef.current.on("tap", (event) => {
        if (event.target === cyRef.current) {
          backgroundTapRef.current();
        }
      });
      cyRef.current.on("tap", "node.zone", (event) => {
        const label = event.target.data("label") as string | undefined;
        if (label) setGroupForDisplayRef.current(label);
      });
      cyRef.current.on("dragfree", "node.device", () => {
        persistCurrentTopologyLayout(cyRef.current, userIdRef.current, layoutPositionsRef);
        serverSaveLayoutRef.current(layoutPositionsRef.current, true);
        refreshOverlayNodesRef.current();
      });
      cyRef.current.on("dragfree", "node.zone", () => {
        persistCurrentTopologyLayout(cyRef.current, userIdRef.current, layoutPositionsRef);
        serverSaveLayoutRef.current(layoutPositionsRef.current, true);
        refreshOverlayNodesRef.current();
      });
      cyRef.current.on("zoom", () => {
        const cy = cyRef.current;
        if (!cy) return;
        setCyZoom(cy.zoom());
        refreshOverlayNodesRef.current();
      });
      cyRef.current.on("pan", () => {
        refreshOverlayNodesRef.current();
      });
      cyRef.current.on("render", () => {
        refreshOverlayNodesRef.current();
      });
      refreshOverlayNodes();
    }
  }, [userId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const textColor = theme === "dark" ? "#ffffff" : "#111111";
    const zoneColor = theme === "dark" ? "#d8e5ef" : "#263b4b";
    const zoneBgColor = theme === "dark" ? "#20364a" : "#b9cedb";
    const zoneBorderColor = theme === "dark" ? "#496780" : "#6f8ba0";
    const edgeLabelBg = theme === "dark" ? "#1d2f40" : "#eef3f7";
    const edgeBorderColor = theme === "dark" ? "rgba(60,100,130,0.5)" : "rgba(160,190,210,0.6)";
    cy.$("node.device").style("color", textColor);
    cy.$("node.zone").forEach((n) => {
      n.data("zoneLabelColor", zoneColor);
      n.data("zoneBgColor", zoneBgColor);
      n.data("zoneBorderColor", zoneBorderColor);
    });
    cy.$("edge").style("color", textColor);
    cy.$("edge").style("text-background-color", edgeLabelBg);
    cy.$("edge").style("text-border-color", edgeBorderColor);
    cy.$("edge").style("font-size", edgeLabelFontSize);
  }, [theme, layoutRevision, filteredGraph, edgeLabelFontSize]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const hadVisibleElements = cy.$("node.device").length > 0;
    if (!skipPersistOnNextRenderRef.current) {
      persistCurrentTopologyLayout(cy, userId, layoutPositionsRef);
    }
    skipPersistOnNextRenderRef.current = false;
    const layout = buildDiagramLayout(filteredGraph, layoutPositionsRef.current, {
      groupOptions: Object.fromEntries(
        Object.entries(groupDisplayPrefs).map(([groupName, prefs]) => [
          groupName,
          {
            spacingScale: prefs.spacingScalePercent / 100,
            maxDevicesPerRow: prefs.maxDevicesPerRow,
          },
        ]),
      ),
    });
    const validNodeIds = new Set<string>([
      ...layout.groups.map((group) => group.id),
      ...filteredGraph.devices.map((device) => `device-${device.id}`),
    ]);
    cy.elements().remove();
    cy.add([
      ...layout.groups.map((group) => ({
        group: "nodes" as const,
        classes: "zone",
        data: {
          id: group.id,
          label: group.label,
          zoneLabelColor: theme === "dark" ? "#d8e5ef" : "#263b4b",
          zoneBgColor: theme === "dark" ? "#20364a" : "#b9cedb",
          zoneBorderColor: theme === "dark" ? "#496780" : "#6f8ba0",
        },
      })),
      ...filteredGraph.devices.map((device) => {
        const liveStatus = isDeviceMonitoringPaused(device) || !livePingEnabled
          ? "paused"
          : (liveStatusByDeviceId.get(device.id)?.status ?? device.monitor_status ?? "unknown");
        const colorStatus = liveStatus === "paused" ? "unknown" : liveStatus;
        const nodeColor = device.color || statusColor(colorStatus);
        const groupName = device.topology_group ?? "Ungrouped";
        const nodeScale = (groupDisplayPrefs[groupName]?.nodeScalePercent ?? DEFAULT_NODE_SCALE_PERCENT) / 100;
        const iconSize = Math.round(BASE_DEVICE_ICON_SIZE * Math.max(MIN_NODE_SCALE_PERCENT / 100, Math.min(MAX_NODE_SCALE_PERCENT / 100, nodeScale)));
        const hitSize = Math.max(36, iconSize + 14);
        return {
          group: "nodes" as const,
          classes: `device status-${liveStatus}`,
          data: {
            id: `device-${device.id}`,
            label: deviceLabel(device),
            labelColor: theme === "dark" ? "#ffffff" : "#111111",
            color: nodeColor,
            iconUrl: deviceIconUrl(device.icon, nodeColor),
            icon: resolveDeviceIcon(device.icon),
            parent: groupId(device.topology_group),
            nodeScale,
            hitSize,
          },
          position: layout.positions[`device-${device.id}`],
        };
      }),
      ...filteredGraph.relationships.map((relationship) => {
        // If a metadata-based group endpoint is unavailable in current view,
        // fall back to the backing device endpoint so render never crashes.
        const preferredSource = relationshipVisualSourceNodeId(relationship);
        const preferredTarget = relationshipVisualTargetNodeId(relationship);
        const source = validNodeIds.has(preferredSource) ? preferredSource : `device-${relationship.source_device_id}`;
        const target = validNodeIds.has(preferredTarget) ? preferredTarget : `device-${relationship.target_device_id}`;
        const speed = relationship.link_speed_mbps ?? null;
        return {
          group: "edges" as const,
          data: {
            id: `relationship-${relationship.id}`,
            source,
            target,
            label: speed !== null
              ? `${relationship.relationship_type} · ${formatLinkSpeed(speed)}`
              : relationship.relationship_type,
            notes: relationship.notes,
            linkWidth: linkSpeedEdgeWidth(speed),
            edgeLabelColor: theme === "dark" ? "#c8dae8" : "#2a4055",
            edgeLabelBg: theme === "dark" ? "#1d2f40" : "#eef3f7",
            edgeBorderColor: theme === "dark" ? "rgba(60,100,130,0.5)" : "rgba(160,190,210,0.6)",
          },
        };
      }),
    ]);
    cy.layout({ name: "preset", fit: false, padding: 36 }).run();
    // Rebuilding elements drops classes — restore an active path highlight so
    // the 30s live-status refresh doesn't silently clear it.
    if (pathElementIdsRef.current.length > 0) {
      let pathElements = cy.collection();
      for (const elementId of pathElementIdsRef.current) {
        pathElements = pathElements.union(cy.$id(elementId));
      }
      if (pathElements.length > 0) {
        pathElements.addClass("path-highlight");
        cy.elements("node.device, edge").not(pathElements).addClass("path-dim");
      }
    }
    refreshOverlayNodes();
    const currentGroupIds = new Set(layout.groups.map((g) => g.id));
    if (knownGroupIdsRef.current.size > 0 && layout.groups.some((g) => !knownGroupIdsRef.current.has(g.id))) {
      fitOnNextRenderRef.current = true;
    }
    knownGroupIdsRef.current = currentGroupIds;
    if (fitOnNextRenderRef.current || !hadVisibleElements) {
      cy.fit(undefined, 36);
      fitOnNextRenderRef.current = false;
    }
  }, [activeIconPackId, filteredGraph, groupDisplayPrefs, layoutRevision, liveStatusByDeviceId, theme, userId]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.$("node.device").unselect();
    if (selectedDeviceId === null) {
      return;
    }
    const node = cy.$id(`device-${selectedDeviceId}`);
    if (node.length > 0) {
      node.select();
      return;
    }
    setSelectedDeviceId(null);
  }, [selectedDeviceId, filteredGraph.devices]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.$("edge").unselect();
    if (selectedRelationshipId === null) {
      return;
    }
    const edge = cy.$id(`relationship-${selectedRelationshipId}`);
    if (edge.length > 0) {
      edge.select();
      return;
    }
    setSelectedRelationshipId(null);
  }, [selectedRelationshipId, filteredGraph.relationships]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    window.requestAnimationFrame(() => { cy.resize(); });
  }, [showDetailsPanel]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.$("node.zone").style({
      "background-opacity": groupZoneOpacityPercent === 0
        ? 0
        : 0.16 + (groupZoneOpacityPercent / 100) * 0.42,
      "border-opacity": showGroupZoneBorders ? 0.72 : 0,
      "border-width": showGroupZoneBorders ? 1 : 0,
    });
  }, [groupZoneOpacityPercent, layoutRevision, showGroupZoneBorders]);

  useEffect(() => {
    if (!jumpTarget) {
      return;
    }
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const node = cy.$id(`device-${jumpTarget.deviceId}`);
    if (node.length === 0) {
      return;
    }
    setSelectedDeviceId(jumpTarget.deviceId);
    node.select();
    cy.animate({
      center: { eles: node },
      duration: 220,
    });
    node.addClass("focus-pulse");
    const timeout = window.setTimeout(() => node.removeClass("focus-pulse"), 1200);
    return () => window.clearTimeout(timeout);
  }, [jumpTarget]);

  async function updateDevice(deviceId: number, payload: DevicePayload) {
    if (!accessToken) return;
    setBusy(true);
    setTopologyError(null);
    pendingDevicePatchesRef.current[deviceId] = {
      display_name: payload.display_name,
      hostname: payload.hostname,
      ip_address: payload.ip_address ?? "",
      mac_address: payload.mac_address,
      vendor: payload.vendor,
      os: payload.os,
      device_type: payload.device_type,
      status: payload.status,
      lifecycle: payload.lifecycle ?? "active",
      monitoring_paused: payload.monitoring_paused ?? false,
      icon: payload.icon,
      color: payload.color,
      vlan_id: payload.vlan_id,
      subnet: payload.subnet,
      topology_group_id: payload.topology_group_id,
      site_id: payload.site_id,
      snmp_profile_id: payload.snmp_profile_id,
      tags: payload.tags,
      notes: payload.notes,
    };
    setLiveGraph((current) => ({
      ...current,
      devices: current.devices.map((device) =>
        device.id === deviceId
          ? {
              ...device,
              display_name: payload.display_name,
              hostname: payload.hostname,
              ip_address: payload.ip_address ?? "",
              mac_address: payload.mac_address,
              vendor: payload.vendor,
              os: payload.os,
              device_type: payload.device_type,
              status: payload.status,
              lifecycle: payload.lifecycle ?? "active",
              monitoring_paused: payload.monitoring_paused ?? false,
              icon: payload.icon,
              color: payload.color,
              vlan_id: payload.vlan_id,
              subnet: payload.subnet,
              topology_group_id: payload.topology_group_id,
              site_id: payload.site_id,
              snmp_profile_id: payload.snmp_profile_id,
              topology_group: current.devices.find((row) => row.id === deviceId)?.topology_group ?? device.topology_group,
              tags: payload.tags,
              notes: payload.notes,
            }
          : device,
      ),
    }));
    try {
      const updated = await api.updateDevice(accessToken, deviceId, payload);
      delete pendingDevicePatchesRef.current[updated.id];
      setLiveGraph((current) => ({
        ...current,
        devices: current.devices.map((device) =>
          device.id === updated.id
            ? updated
            : device,
        ),
      }));
      void onGraphChange();
      toast.success("Device saved", { detail: deviceLabel(updated) });
    } catch (err) {
      delete pendingDevicePatchesRef.current[deviceId];
      setTopologyError(err instanceof Error ? err.message : "Unable to update device");
      void onGraphChange();
    } finally {
      setBusy(false);
    }
  }

  async function submitDevice(payload: DevicePayload) {
    if (!accessToken) return;
    setBusy(true);
    setTopologyError(null);
    try {
      const created = await api.createDevice(accessToken, payload);
      setLiveGraph((current) => ({
        ...current,
        devices: [...current.devices, created],
      }));
      setShowDeviceForm(false);
      setCloningDevice(null);
      toast.success(cloningDevice ? "Device cloned" : "Device added", { detail: deviceLabel(created) });
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to save device");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedDevice() {
    if (!accessToken || !selectedDevice) {
      return;
    }
    setBusy(true);
    setTopologyError(null);
    try {
      await api.deleteDevice(accessToken, selectedDevice.id);
      setLiveGraph((current) => ({
        ...current,
        devices: current.devices.filter((device) => device.id !== selectedDevice.id),
        relationships: current.relationships.filter(
          (relationship) =>
            relationship.source_device_id !== selectedDevice.id && relationship.target_device_id !== selectedDevice.id,
        ),
      }));
      setSelectedDeviceId(null);
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to delete device");
    } finally {
      setBusy(false);
    }
  }

  async function submitRelationship(payload: RelationshipPayload) {
    if (!accessToken) {
      return;
    }
    setBusy(true);
    setTopologyError(null);
    try {
      const created = await api.createRelationship(accessToken, payload);
      setLiveGraph((current) => ({
        ...current,
        relationships: [...current.relationships, created],
      }));
      setShowRelationshipForm(false);
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to save relationship");
    } finally {
      setBusy(false);
    }
  }

  async function updateSelectedRelationship(payload: {
    source_device_id: number;
    target_device_id: number;
    relationship_type: string;
    allow_outbound: boolean;
    allow_inbound: boolean;
    notes: string | null;
    link_speed_mbps: number | null;
  }) {
    if (!accessToken || !selectedRelationship) {
      return;
    }
    setBusy(true);
    setTopologyError(null);
    pendingRelationshipPatchesRef.current[selectedRelationship.id] = {
      source_device_id: payload.source_device_id,
      target_device_id: payload.target_device_id,
      relationship_type: payload.relationship_type,
      allow_outbound: payload.allow_outbound,
      allow_inbound: payload.allow_inbound,
      notes: payload.notes,
      link_speed_mbps: payload.link_speed_mbps,
    };
    setLiveGraph((current) => ({
      ...current,
      relationships: current.relationships.map((relationship) =>
        relationship.id === selectedRelationship.id
          ? {
              ...relationship,
              source_device_id: payload.source_device_id,
              target_device_id: payload.target_device_id,
              relationship_type: payload.relationship_type,
              allow_outbound: payload.allow_outbound,
              allow_inbound: payload.allow_inbound,
              notes: payload.notes,
              link_speed_mbps: payload.link_speed_mbps,
            }
          : relationship,
      ),
    }));
    try {
      const updated = await api.updateRelationship(accessToken, selectedRelationship.id, payload);
      setLiveGraph((current) => ({
        ...current,
        relationships: current.relationships.map((relationship) =>
          relationship.id === updated.id
            ? {
                ...relationship,
                ...updated,
                allow_outbound: updated.allow_outbound ?? payload.allow_outbound,
                allow_inbound: updated.allow_inbound ?? payload.allow_inbound,
              }
            : relationship,
        ),
      }));
      setShowRelationshipEditForm(false);
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to update relationship");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedRelationship() {
    if (!accessToken || !selectedRelationship) {
      return;
    }
    const confirmed = await confirmAction({
      title: "Delete link",
      message: `Delete the "${selectedRelationship.relationship_type}" link between these devices?`,
      detail: "The devices themselves are not affected.",
      confirmLabel: "Delete link",
    });
    if (!confirmed) {
      return;
    }
    setBusy(true);
    setTopologyError(null);
    try {
      await api.deleteRelationship(accessToken, selectedRelationship.id);
      setLiveGraph((current) => ({
        ...current,
        relationships: current.relationships.filter((relationship) => relationship.id !== selectedRelationship.id),
      }));
      setSelectedRelationshipId(null);
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to delete relationship");
    } finally {
      setBusy(false);
    }
  }

  function fitTopology() {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.fit(undefined, 36);
  }

  function resetLayout() {
    clearSavedTopologyLayout(userId);
    layoutPositionsRef.current = {};
    serverSaveLayoutRef.current({}, true);
    fitOnNextRenderRef.current = true;
    skipPersistOnNextRenderRef.current = true;
    setActiveSavedLayoutId(null);
    setLayoutRevision((current) => current + 1);
  }


  function computeRadialPositions(
    groupDevices: typeof filteredGraph.devices,
    cx: number,
    cy_: number,
    spacingScalePercent: number,
    numRings: number,
  ): Array<{ id: string; x: number; y: number }> {
    const spacingScale = Math.max(0.8, Math.min(2.2, spacingScalePercent / 100));
    const nodeSpacing = Math.round(130 * spacingScale);
    const ringGap = Math.round(110 * spacingScale);
    const n = groupDevices.length;
    if (n === 0) return [];
    if (n === 1) return [{ id: `device-${groupDevices[0].id}`, x: Math.round(cx), y: Math.round(cy_) }];

    const rings = Math.max(1, Math.min(numRings, n));

    // Distribute devices across rings proportionally to ring index+1 (approximates circumference)
    const totalWeight = (rings * (rings + 1)) / 2;
    const ringCapacities: number[] = [];
    let assigned = 0;
    for (let r = 0; r < rings; r++) {
      const cap = r === rings - 1
        ? n - assigned
        : Math.max(1, Math.round(n * (r + 1) / totalWeight));
      ringCapacities.push(cap);
      assigned += cap;
    }

    const finalPositions: Array<{ id: string; x: number; y: number }> = [];
    let deviceIdx = 0;
    for (let ringIdx = 0; ringIdx < rings; ringIdx++) {
      const count = ringCapacities[ringIdx];
      // Radius: first ring sized so arc spacing ≈ nodeSpacing; subsequent rings spaced by ringGap
      const firstRingRadius = Math.max(100, Math.round((ringCapacities[0] * nodeSpacing) / (2 * Math.PI)));
      const radius = firstRingRadius + ringIdx * ringGap;
      for (let i = 0; i < count && deviceIdx < n; i++, deviceIdx++) {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
        finalPositions.push({
          id: `device-${groupDevices[deviceIdx].id}`,
          x: Math.round(cx + radius * Math.cos(angle)),
          y: Math.round(cy_ + radius * Math.sin(angle)),
        });
      }
    }
    return finalPositions;
  }

  function autoArrangeRadialSelectedGroup() {
    const cy = cyRef.current;
    if (!cy || !selectedGroupForDisplay) return;

    const groupDevices = filteredGraph.devices.filter(
      (device) => device.topology_group === selectedGroupForDisplay,
    );
    if (groupDevices.length === 0) return;

    const currentPositions = groupDevices.map((d) => {
      const id = `device-${d.id}`;
      const node = cy.$id(id);
      return node.length > 0 ? node.position() : (layoutPositionsRef.current[id] ?? { x: 0, y: 0 });
    });
    const cx = currentPositions.reduce((s, p) => s + p.x, 0) / currentPositions.length;
    const cy_ = currentPositions.reduce((s, p) => s + p.y, 0) / currentPositions.length;

    const finalPositions = computeRadialPositions(
      groupDevices, cx, cy_,
      activeGroupDisplay.spacingScalePercent,
      activeGroupDisplay.maxRings ?? 1,
    );

    const nextPositions = { ...layoutPositionsRef.current };
    for (const { id, x, y } of finalPositions) {
      const node = cy.$id(id);
      if (node.length > 0) node.position({ x, y });
      nextPositions[id] = { x, y };
    }
    const sanitizedPositions = sanitizeTopologyLayoutPositions(nextPositions);
    layoutPositionsRef.current = sanitizedPositions;
    const now = Date.now();
    window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(sanitizedPositions));
    writeSavedTopologyLayoutMeta(userId, { savedAt: now });
    serverSaveLayoutRef.current(sanitizedPositions, true);
    refreshOverlayNodes();
  }

  function autoArrangeSelectedGroup() {
    const cy = cyRef.current;
    if (!cy || !selectedGroupForDisplay) return;

    const groupDevices = filteredGraph.devices.filter(
      (device) => device.topology_group === selectedGroupForDisplay,
    );
    if (groupDevices.length === 0) return;

    const spacingScale = Math.max(0.8, Math.min(2.2, activeGroupDisplay.spacingScalePercent / 100));
    const maxPerRow = Math.max(1, activeGroupDisplay.maxDevicesPerRow);
    const gridX = Math.round(126 * spacingScale);
    const gridY = Math.round(112 * spacingScale);
    const currentPositions = groupDevices.map((device) => {
      const id = `device-${device.id}`;
      const node = cy.$id(id);
      return node.length > 0 ? node.position() : (layoutPositionsRef.current[id] ?? { x: 0, y: 0 });
    });
    const centerX = currentPositions.reduce((sum, position) => sum + position.x, 0) / currentPositions.length;
    const centerY = currentPositions.reduce((sum, position) => sum + position.y, 0) / currentPositions.length;
    const visualRows = buildGroupVisualRows(devicesByHierarchy(groupDevices), maxPerRow);
    const firstRowY = centerY - ((visualRows.length - 1) * gridY) / 2;
    const finalPositions: Array<{ id: string; x: number; y: number }> = [];
    visualRows.forEach((rowDevices, rowIndex) => {
      rowDevices.forEach((device, columnIndex) => {
        finalPositions.push({
          id: `device-${device.id}`,
          x: Math.round(centerX + centeredOffset(columnIndex, rowDevices.length, gridX)),
          y: Math.round(firstRowY + rowIndex * gridY),
        });
      });
    });

    // Apply a true grid around the group's existing centre, then persist it.
    const nextPositions = { ...layoutPositionsRef.current };
    for (const { id, x, y } of finalPositions) {
      const node = cy.$id(id);
      if (node.length > 0) node.position({ x, y });
      nextPositions[id] = { x, y };
    }
    const sanitizedPositions = sanitizeTopologyLayoutPositions(nextPositions);
    layoutPositionsRef.current = sanitizedPositions;
    const now = Date.now();
    window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(sanitizedPositions));
    writeSavedTopologyLayoutMeta(userId, { savedAt: now });
    serverSaveLayoutRef.current(sanitizedPositions, true);
    refreshOverlayNodes();
  }

  function changeLayoutShape(shape: GroupLayoutShape) {
    // Arrange first so the preference-driven Cytoscape rebuild reads the new
    // positions instead of briefly restoring the previous layout geometry.
    if (shape === "radial") autoArrangeRadialSelectedGroup();
    else autoArrangeSelectedGroup();
    setGroupPref({ layoutShape: shape });
  }

  function toggleGroupVisibility(groupName: string) {
    setHiddenGroupNames((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  }

  function resetSelectedGroup() {
    if (!selectedGroupForDisplay) return;
    const cy = cyRef.current;
    const groupDevices = filteredGraph.devices.filter(
      (device) => device.topology_group === selectedGroupForDisplay,
    );
    const nextPositions = { ...layoutPositionsRef.current };
    // Preserve the group box's current canvas position as an anchor so reset
    // only re-flows the icons inside the box, not the box itself.
    if (cy) {
      const gId = groupId(selectedGroupForDisplay);
      const groupNode = cy.$id(gId);
      if (groupNode.length > 0) {
        const bb = groupNode.boundingBox({});
        const devYs = groupDevices
          .map((d) => cy.$id(`device-${d.id}`))
          .filter((n) => n.length > 0)
          .map((n) => n.position().y);
        const topY = devYs.length > 0 ? Math.min(...devYs) : (bb.y1 + bb.y2) / 2;
        nextPositions[gId] = { x: (bb.x1 + bb.x2) / 2, y: topY };
      }
    }
    for (const device of groupDevices) {
      delete nextPositions[`device-${device.id}`];
    }
    const sanitizedPositions = sanitizeTopologyLayoutPositions(nextPositions);
    layoutPositionsRef.current = sanitizedPositions;
    window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(sanitizedPositions));
    writeSavedTopologyLayoutMeta(userId, { savedAt: Date.now() });
    serverSaveLayoutRef.current(sanitizedPositions, true);
    skipPersistOnNextRenderRef.current = true;
    setLayoutRevision((c) => c + 1);
  }

  // --- Callbacks handed to the extracted child components. Children never see
  // --- the cytoscape instance; canvas side effects all happen here.

  function handleDeviceHover(deviceId: number, hovered: boolean) {
    setPanelHoveredDeviceId(hovered ? deviceId : null);
    const edges = cyRef.current?.getElementById(`device-${deviceId}`)?.connectedEdges();
    if (hovered) edges?.addClass("panel-hover");
    else edges?.removeClass("panel-hover");
  }

  function handleRelationshipHover(relationshipId: number, hovered: boolean) {
    const edge = cyRef.current?.getElementById(`relationship-${relationshipId}`);
    if (hovered) {
      edge?.addClass("panel-hover");
      edge?.connectedNodes().addClass("panel-hover");
    } else {
      edge?.removeClass("panel-hover");
      edge?.connectedNodes().removeClass("panel-hover");
    }
  }

  function handleGroupHover(groupName: string, hovered: boolean) {
    const cy = cyRef.current;
    if (!cy) return;
    if (hovered) {
      cy.getElementById(groupId(groupName)).addClass("panel-hover");
      cy.nodes(`[topology_group = "${groupName}"]`).addClass("panel-hover");
    } else {
      cy.getElementById(groupId(groupName)).removeClass("panel-hover");
      cy.nodes(`[topology_group = "${groupName}"]`).removeClass("panel-hover");
    }
  }

  function setGroupPref(patch: Partial<GroupDisplayPref>) {
    setGroupDisplayPrefs((c) => ({ ...c, [selectedGroupForDisplay]: { ...activeGroupDisplay, ...patch } }));
  }

  function applySpacingChange(newSpacingPercent: number) {
    const cy = cyRef.current;
    const nextPositions = { ...layoutPositionsRef.current };
    if ((activeGroupDisplay.layoutShape ?? "grid") === "radial" && cy) {
      const groupDevices = filteredGraph.devices.filter((d) => d.topology_group === selectedGroupForDisplay);
      const curPos = groupDevices.map((d) => {
        const id = `device-${d.id}`;
        const node = cy.$id(id);
        return node.length > 0 ? node.position() : (layoutPositionsRef.current[id] ?? { x: 0, y: 0 });
      });
      const cx = curPos.reduce((s, p) => s + p.x, 0) / curPos.length;
      const cy_ = curPos.reduce((s, p) => s + p.y, 0) / curPos.length;
      const finalPositions = computeRadialPositions(groupDevices, cx, cy_, newSpacingPercent, activeGroupDisplay.maxRings ?? 1);
      for (const { id, x, y } of finalPositions) {
        cy.$id(id).position({ x, y });
        nextPositions[id] = { x, y };
      }
      layoutPositionsRef.current = sanitizeTopologyLayoutPositions(nextPositions);
      window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(layoutPositionsRef.current));
      writeSavedTopologyLayoutMeta(userId, { savedAt: Date.now() });
      serverSaveLayoutRef.current(layoutPositionsRef.current, true);
      refreshOverlayNodes();
    } else {
      const gId = groupId(selectedGroupForDisplay);
      if (cy) {
        const groupNode = cy.$id(gId);
        if (groupNode.length > 0) {
          const bb = groupNode.boundingBox({});
          const devYs = filteredGraph.devices
            .filter((d) => d.topology_group === selectedGroupForDisplay)
            .map((d) => cy.$id(`device-${d.id}`))
            .filter((n) => n.length > 0)
            .map((n) => n.position().y);
          const topY = devYs.length > 0 ? Math.min(...devYs) : (bb.y1 + bb.y2) / 2;
          nextPositions[gId] = { x: (bb.x1 + bb.x2) / 2, y: topY };
        }
      }
      filteredGraph.devices
        .filter((d) => d.topology_group === selectedGroupForDisplay)
        .forEach((d) => { delete nextPositions[`device-${d.id}`]; });
      layoutPositionsRef.current = sanitizeTopologyLayoutPositions(nextPositions);
      skipPersistOnNextRenderRef.current = true;
    }
    setGroupDisplayPrefs((c) => ({ ...c, [selectedGroupForDisplay]: { ...activeGroupDisplay, spacingScalePercent: newSpacingPercent } }));
  }

  function applyMaxPerRowChange(value: number) {
    const cy = cyRef.current;
    const gId = groupId(selectedGroupForDisplay);
    const nextPositions = { ...layoutPositionsRef.current };
    if (cy) {
      const groupNode = cy.$id(gId);
      if (groupNode.length > 0) {
        const bb = groupNode.boundingBox({});
        const devYs = filteredGraph.devices
          .filter((d) => d.topology_group === selectedGroupForDisplay)
          .map((d) => cy.$id(`device-${d.id}`))
          .filter((n) => n.length > 0)
          .map((n) => n.position().y);
        const topY = devYs.length > 0 ? Math.min(...devYs) : (bb.y1 + bb.y2) / 2;
        nextPositions[gId] = { x: (bb.x1 + bb.x2) / 2, y: topY };
      }
    }
    filteredGraph.devices
      .filter((d) => d.topology_group === selectedGroupForDisplay)
      .forEach((d) => { delete nextPositions[`device-${d.id}`]; });
    layoutPositionsRef.current = sanitizeTopologyLayoutPositions(nextPositions);
    skipPersistOnNextRenderRef.current = true;
    setGroupDisplayPrefs((c) => ({ ...c, [selectedGroupForDisplay]: { ...activeGroupDisplay, maxDevicesPerRow: value } }));
  }

  function handleEdgeLabelSizeChange(size: number) {
    setEdgeLabelFontSize(size);
    try { localStorage.setItem(`netmap.edge-label-size.${userId}`, String(size)); } catch {}
    if (cyRef.current) cyRef.current.$("edge").style("font-size", size);
  }

  return (
    <section className="topology-layout" id="topology">
      <div className="topology-workspace-frame nm-app-panel">
      <TopologyToolbar
        sites={sites}
        selectedSiteId={selectedSiteId}
        statusCounts={topoStatusCounts}
        canWrite={canWrite}
        totalDeviceCount={liveGraph.devices.length}
        showNodeIcons={showNodeIcons}
        showNodeLabels={showNodeLabels}
        allGroupNames={allGroupNames}
        visibleGroupNames={visibleGroupNames}
        groupDeviceCounts={groupDeviceCounts}
        hiddenGroupNames={hiddenGroupNames}
        selectedGroupForDisplay={selectedGroupForDisplay}
        activeGroupDisplay={activeGroupDisplay}
        groupZoneOpacityPercent={groupZoneOpacityPercent}
        nodeLabelFontSize={nodeLabelFontSize}
        edgeLabelFontSize={edgeLabelFontSize}
        devices={filteredGraph.devices}
        onSiteChange={setSelectedSiteId}
        onFit={fitTopology}
        onResetLayout={resetLayout}
        onExportPng={() => { if (cyRef.current) exportTopologyPng(cyRef.current, edgeLabelFontSize); }}
        onExportSvg={() => { if (cyRef.current) exportTopologySvg(cyRef.current); }}
        onExportPdf={() => { if (cyRef.current) exportTopologyPdf(cyRef.current, edgeLabelFontSize); }}
        onShowNodeIconsChange={setShowNodeIcons}
        onShowNodeLabelsChange={setShowNodeLabels}
        onToggleGroupVisibility={toggleGroupVisibility}
        onShowAllGroups={() => setHiddenGroupNames(new Set())}
        onHideAllGroups={() => setHiddenGroupNames(new Set(allGroupNames))}
        onSelectGroupForDisplay={setSelectedGroupForDisplay}
        onSetGroupPref={setGroupPref}
        onLayoutShapeChange={changeLayoutShape}
        onAutoArrange={(activeGroupDisplay.layoutShape ?? "grid") === "radial" ? autoArrangeRadialSelectedGroup : autoArrangeSelectedGroup}
        onResetGroup={resetSelectedGroup}
        onSpacingChange={applySpacingChange}
        onMaxPerRowChange={applyMaxPerRowChange}
        onZoneOpacityChange={setGroupZoneOpacityPercent}
        onEdgeLabelSizeChange={handleEdgeLabelSizeChange}
        onAddDevice={() => setShowDeviceForm(true)}
        onScan={() => setShowScanModal(true)}
        onAddLink={() => setShowRelationshipForm(true)}
      />
      {topologyError && <div className="form-error">{topologyError}</div>}
      <div className={showDetailsPanel ? "topology-content details-open" : "topology-content"}>
        <div className="graph-surface">
          <TopologyCanvasControls
            devices={filteredGraph.devices}
            pathMode={pathMode}
            onLocateDevice={locateDevice}
            onTogglePathMode={togglePathMode}
            onOpenLayouts={() => setShowLayoutsModal(true)}
          />
          <EntityList
            devices={filteredGraph.devices}
            relationships={filteredGraph.relationships}
            allDevices={liveGraph.devices}
            allGroupNames={allGroupNames}
            groupDeviceCounts={groupDeviceCounts}
            hiddenGroupNames={hiddenGroupNames}
            livePingEnabled={livePingEnabled}
            liveStatusByDeviceId={liveStatusByDeviceId}
            selectedDeviceId={selectedDeviceId}
            selectedRelationshipId={selectedRelationshipId}
            onSelectDevice={(deviceId) => { setSelectedDeviceId(deviceId); setSelectedRelationshipId(null); }}
            onSelectRelationship={(relationshipId) => { setSelectedRelationshipId(relationshipId); setSelectedDeviceId(null); }}
            onToggleGroupVisibility={toggleGroupVisibility}
            onDeviceHover={handleDeviceHover}
            onRelationshipHover={handleRelationshipHover}
            onGroupHover={handleGroupHover}
          />
          <div className="graph-canvas" ref={containerRef} />
          <div className="topology-overlay-layer">
            {overlayGroups.map((group) => (
              <div
                key={`group-label-${group.id}`}
                className="topology-group-header"
                style={{ left: `${group.x}px`, top: `${group.y}px`, width: `${group.width}px` }}
              >
                <span className="topology-group-header__identity">
                  <Network size={14} aria-hidden="true" />
                  <span>{group.label}</span>
                </span>
                <span className={`topology-group-header__count${group.online === 0 ? " is-empty" : ""}`}>
                  <span aria-hidden="true" />
                  {group.online}
                </span>
              </div>
            ))}
            {overlayLinks.map((link) => (
              <div
                key={`link-label-${link.id}`}
                className="topology-link-label"
                style={{
                  left: `${link.x}px`,
                  top: `${link.y}px`,
                  "--topology-link-zoom": Math.max(0.55, Math.min(2, cyZoom)),
                } as CSSProperties}
              >
                <span>{link.label}</span>
                {link.speed && <strong>{link.speed}</strong>}
              </div>
            ))}
            {overlayNodes.map((node) => (
              <button
                key={`overlay-${node.id}`}
                type="button"
                className={`topology-overlay-node status-${node.status}${selectedDeviceId === node.id ? " selected" : ""}${panelHoveredDeviceId === node.id ? " panel-glow" : ""}${canvasHoveredDeviceId === node.id ? " canvas-hover" : ""}${flashDeviceId === node.id ? " search-flash" : ""}${recentlyChangedIds.has(node.id) ? " status-changed" : ""}${pathNodeIds !== null ? (pathNodeIds.has(node.id) ? " path-glow" : " path-dimmed") : ""}`}
                style={{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  "--topology-device-zoom": Math.max(0.15, Math.min(8, cyZoom)),
                } as CSSProperties}
                onClick={() => {
                  setSelectedDeviceId(node.id);
                  setSelectedRelationshipId(null);
                }}
                title={node.lines[0]}
              >
                {showNodeIcons && (
                  <span
                    className="topology-device-icon-frame"
                    style={{
                      "--topology-device-color": node.color,
                      "--topology-device-frame-size": `${Math.max(40, node.size + 14)}px`,
                    } as CSSProperties}
                  >
                    <svg viewBox="0 0 24 24" width={node.size} height={node.size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <g dangerouslySetInnerHTML={{ __html: deviceIconPath(node.icon) }} />
                    </svg>
                  </span>
                )}
                {showNodeLabels && cyZoom >= 0.35 && (
                  <span className="topology-overlay-label" style={{ fontSize: `${node.labelFontSize}px` }}>
                    {(cyZoom < 0.6 ? node.lines.slice(0, 1) : node.lines).map((line, index) => (
                      <span key={`${node.id}-line-${index}`}>
                        {cyZoom < 0.6 && line.length > 14 ? `${line.slice(0, 14)}…` : line}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </div>
          {filteredGraph.devices.length === 0 && <div className="empty-graph">No devices match the current view</div>}
          <MiniMap nodes={minimapNodes} extent={minimapExtent} onCenter={centerCanvasOn} />
          {pathMode && (
            <div className="topo-pathbar">
              {pathStartId !== null
                ? "Now click the destination device"
                : pathNodeIds !== null && pathNodeIds.size > 1
                  ? "Path highlighted — click another device to start a new path"
                  : "Path mode: click the first device"}
              <button type="button" className="nm-btn nm-btn--sm" onClick={togglePathMode}>Exit</button>
            </div>
          )}
          {bulkSelectedIds.length >= 2 && (
            <div className="topo-bulkbar">
              <strong>{bulkSelectedIds.length} devices selected</strong>
              {canWrite && (
                <>
                  <select value={bulkGroupChoice} onChange={(e) => setBulkGroupChoice(e.target.value)}>
                    <option value="">Assign group…</option>
                    {groups.map((group) => (
                      <option key={group.id} value={String(group.id)}>{group.name}</option>
                    ))}
                  </select>
                  <select value={bulkSiteChoice} onChange={(e) => setBulkSiteChoice(e.target.value)}>
                    <option value="">Assign site…</option>
                    {sites.map((site) => (
                      <option key={site.id} value={String(site.id)}>{site.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="nm-btn nm-btn--sm nm-btn--primary"
                    disabled={bulkBusy || (!bulkGroupChoice && !bulkSiteChoice)}
                    onClick={() => void applyBulkAssignment()}
                  >
                    {bulkBusy ? "Applying…" : "Apply"}
                  </button>
                </>
              )}
              <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={clearBulkSelection}>
                Clear
              </button>
            </div>
          )}
        </div>
        {showDetailsPanel && (
          <DetailsPanel
            accessToken={accessToken}
            canViewSecurity={canViewSecurity}
            canWrite={canWrite}
            selectedDevice={selectedDevice}
            selectedRelationship={selectedRelationship}
            allDevices={liveGraph.devices}
            busy={busy}
            deviceTypes={deviceTypeOptions}
            groups={groups}
            snmpProfiles={snmpProfiles}
            sites={sites}
            liveStatus={selectedDevice && livePingEnabled ? (liveStatusByDeviceId.get(selectedDevice.id) ?? null) : null}
            securityLoading={deviceSecurityLoading}
            securitySummary={deviceSecuritySummary}
            onGraphChange={onGraphChange}
            onDeleteDevice={deleteSelectedDevice}
            onCloneDevice={(device) => {
              setCloningDevice(device);
              setShowDeviceForm(true);
            }}
            onSubmitDevice={(payload) => selectedDevice ? updateDevice(selectedDevice.id, payload) : Promise.resolve()}
            onDeleteRelationship={() => void deleteSelectedRelationship()}
            onEditRelationship={() => setShowRelationshipEditForm(true)}
          />
        )}
      </div>
      </div>
      {showDeviceForm && (
        <DeviceForm
          busy={busy}
          device={null}
          cloneSource={cloningDevice}
          deviceTypes={deviceTypeOptions}
          groups={groups}
          snmpProfiles={snmpProfiles}
          sites={sites}
          onCancel={() => {
            setShowDeviceForm(false);
            setCloningDevice(null);
          }}
          onSubmit={submitDevice}
        />
      )}
      {showRelationshipForm && (
        <RelationshipForm
          busy={busy}
          devices={liveGraph.devices}
          onCancel={() => setShowRelationshipForm(false)}
          onSubmit={submitRelationship}
        />
      )}
      {showRelationshipEditForm && selectedRelationship && (
        <RelationshipEditForm
          busy={busy}
          devices={liveGraph.devices}
          relationship={selectedRelationship}
          onCancel={() => setShowRelationshipEditForm(false)}
          onSubmit={updateSelectedRelationship}
        />
      )}
      {showScanModal && (
        <DiscoveryModal
          accessToken={accessToken}
          onCancel={() => setShowScanModal(false)}
          onImported={async () => {
            setShowScanModal(false);
            await onGraphChange();
          }}
        />
      )}
      {showLayoutsModal && accessToken && (
        <LayoutsModal
          accessToken={accessToken}
          layouts={savedLayouts}
          getCurrentLayout={() => ({
            positions: sanitizeTopologyLayoutPositions(layoutPositionsRef.current),
            display_prefs: currentDisplayPrefsSnapshot(),
          })}
          onClose={() => setShowLayoutsModal(false)}
          onLoad={loadNamedLayout}
          onLayoutsChanged={refreshSavedLayouts}
        />
      )}
    </section>
  );
}

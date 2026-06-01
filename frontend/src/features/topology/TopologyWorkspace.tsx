import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import cytoscape, { type Core } from "cytoscape";
import { Network, EyeOff, Eye, ChevronDown, ChevronUp } from "lucide-react";
import { IconAlertCircle, IconServer, IconWifi, IconWifiOff, IconTopologyRing } from "@tabler/icons-react";
import {
  api,
  type Device, type Relationship, type RelationshipPayload, type DevicePayload,
  type DeviceLiveStatus, type TopologyGraph, type TopologyGroup, type Site,
  type DeviceSecurityEventSummary, type TopologyLayout, type DeviceIcon, type SnmpProfile,
} from "../../api/client";
import { type DiagramLayout, type DiagramLayoutOptions } from "../../types";
import {
  groupId, buildDiagramLayout,
  savedTopologyLayoutKey, readTopologyDisplayPrefs, writeTopologyDisplayPrefs,
  readSavedTopologyLayout, clearSavedTopologyLayout,
  writeSavedTopologyLayoutMeta,
  persistCurrentTopologyLayout, collectCurrentTopologyLayoutPositions, sanitizeTopologyLayoutPositions,
} from "../../utils/topology";
import { compareGroupLabels } from "../../utils/sort";
import { deviceLabel, statusColor } from "../../utils/format";
import { deviceIconUrl, deviceIconPath, resolveDeviceIcon } from "../../icons";
import { downloadDataUrl, downloadTextFile, buildTopologySvg } from "../../utils/download";
import { relationshipVisualSourceNodeId, relationshipVisualTargetNodeId } from "../../utils/relationship";
import { DeviceDetails } from "../devices/DeviceDetails";
import { DeviceForm } from "../devices/DeviceForm";
import { RelationshipDetails } from "./RelationshipDetails";
import { RelationshipEditForm, RelationshipForm } from "./RelationshipForm";
import { DiscoveryModal } from "./DiscoveryModal";

const DEFAULT_EDGE_LABEL_FONT_SIZE = 15;
const DEFAULT_NODE_LABEL_FONT_SIZE = 11;

export function TopologyWorkspace({
  accessToken,
  activeIconPackId,
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
  activeIconPackId: string;
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
  const cyRef = useRef<Core | null>(null);
  const layoutPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const fitOnNextRenderRef = useRef(true);
  const skipPersistOnNextRenderRef = useRef(false);
  const knownGroupIdsRef = useRef<Set<string>>(new Set());
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<number | null>(null);
  const [expandedEntitySection, setExpandedEntitySection] = useState<"devices" | "relationships" | "groups" | null>(null);
  const [cloningDevice, setCloningDevice] = useState<Device | null>(null);
  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [showRelationshipForm, setShowRelationshipForm] = useState(false);
  const [showRelationshipEditForm, setShowRelationshipEditForm] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
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
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [activeSavedLayoutId, setActiveSavedLayoutId] = useState<number | null>(null);
  const [liveStatuses, setLiveStatuses] = useState<DeviceLiveStatus[]>([]);
  const [showDisplaySettings, setShowDisplaySettings] = useState(false);
  const [showGroupsPanel, setShowGroupsPanel] = useState(false);
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
  const [groupDisplayPrefs, setGroupDisplayPrefs] = useState<Record<string, { nodeScalePercent: number; spacingScalePercent: number; maxDevicesPerRow: number }>>({});
  const [overlayNodes, setOverlayNodes] = useState<
    Array<{ id: number; x: number; y: number; lines: string[]; color: string; icon: DeviceIcon; size: number }>
  >([]);
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
  const activeGroupDisplay =
    groupDisplayPrefs[selectedGroupForDisplay] ?? { nodeScalePercent: 140, spacingScalePercent: 120, maxDevicesPerRow: 4 };

  const refreshOverlayNodes = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const nextNodes = filteredGraph.devices
      .map((device) => {
        const node = cy.$id(`device-${device.id}`);
        if (node.length === 0) {
          return null;
        }
        const position = node.renderedPosition();
        const label = deviceLabel(device);
        const nodeScale = Math.max(0.7, Math.min(2.2, Number(node.data("nodeScale") ?? 1)));
        return {
          id: device.id,
          x: position.x,
          y: position.y,
          lines: label.split("\n"),
          color: device.color || statusColor(device.monitor_status ?? device.status),
          icon: resolveDeviceIcon(device.icon),
          size: Math.round(30 * nodeScale),
        };
      })
      .filter((row): row is { id: number; x: number; y: number; lines: string[]; color: string; icon: DeviceIcon; size: number } => row !== null);
    setOverlayNodes(nextNodes);
  }, [activeIconPackId, filteredGraph.devices]);

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
      const deviceIds = liveGraph.devices.slice(0, 64).map((device) => device.id);
      const response = await api.topologyLiveStatuses(accessToken, {
        device_ids: deviceIds,
        timeout_seconds: 2,
      });
      setLiveStatuses(response.statuses);
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
        boxSelectionEnabled: false,
        zoomingEnabled: true,
        userZoomingEnabled: true,
        style: [
          {
            selector: "node.device",
            style: {
              "background-color": "transparent",
              "background-opacity": 0,
              "border-color": "transparent",
              "border-width": 0,
              "bounds-expansion": 12,
              "font-size": 1,
              height: "data(hitSize)",
              label: "",
              "overlay-opacity": 0,
              shape: "rectangle",
              width: "data(hitSize)",
              "z-index": 10,
            },
          },
          {
            selector: "node.device.hovered",
            style: {
              height: 56,
              opacity: 0.92,
              width: 56,
              "z-index": 65,
            },
          },
          {
            selector: "node.device.security-alert",
            style: {
              opacity: 0.88,
              "text-border-color": "#f0b9b9",
              "text-border-width": 2,
              "z-index": 55,
            },
          },
          {
            selector: "node.device.status-online",
            style: {
              "text-background-color": "#effaf5",
            },
          },
          {
            selector: "node.device.status-offline",
            style: {
              "text-background-color": "#f7f7f9",
            },
          },
          {
            selector: "node.device.status-paused",
            style: {
              "text-background-color": "#fdecec",
            },
          },
          {
            selector: "node.device.status-warning",
            style: {
              "text-background-color": "#fff8ea",
            },
          },
          {
            selector: "node.device.status-unknown",
            style: {
              "text-background-color": "#f4f8fa",
            },
          },
          {
            selector: "node.device.focus-pulse",
            style: {
              opacity: 0.75,
              "z-index": 70,
            },
          },
          {
            selector: "node.zone",
            style: {
              "background-color": "data(zoneBgColor)",
              "background-opacity": 0.1,
              "border-color": "data(zoneBorderColor)",
              "border-opacity": 0.1,
              "border-style": "dashed",
              "border-width": 2,
              color: "data(zoneLabelColor)",
              "font-size": 24,
              "font-weight": 700,
              label: "data(label)",
              padding: "34px",
              shape: "round-rectangle",
              "text-halign": "center",
              "text-margin-y": -26,
              "text-valign": "top",
            },
          },
          {
            selector: "edge",
            style: {
              "curve-style": "bezier",
              label: "data(label)",
              "line-color": "#6f8798",
              "line-style": "solid",
              "target-arrow-color": "#6f8798",
              "target-arrow-shape": "triangle",
              color: "data(edgeLabelColor)",
              "font-size": edgeLabelFontSize,
              "font-weight": 600,
              "overlay-opacity": 0,
              "overlay-padding": "12px",
              "text-background-color": "data(edgeLabelBg)",
              "text-background-opacity": 1,
              "text-background-padding": "5px",
              "text-background-shape": "roundrectangle",
              "text-border-opacity": 1,
              "text-border-width": 1,
              "text-border-color": "data(edgeBorderColor)",
              width: 2,
            },
          },
          {
            selector: "edge.hovered",
            style: {
              "line-color": "#1d6472",
              "target-arrow-color": "#1d6472",
              width: 4,
              "z-index": 40,
            },
          },
          {
            selector: "edge:selected",
            style: {
              "line-color": "#1d6472",
              "target-arrow-color": "#1d6472",
              width: 5,
              "z-index": 60,
            },
          },
          {
            selector: "node.device:selected",
            style: {
              height: 58,
              opacity: 0.9,
              width: 58,
            },
          },
        ],
      });
      cyRef.current.on("tap", "node.device", (event) => {
        setSelectedDeviceId(Number(event.target.id().replace("device-", "")));
        setSelectedRelationshipId(null);
      });
      cyRef.current.on("tap", "edge", (event) => {
        setSelectedRelationshipId(Number(event.target.id().replace("relationship-", "")));
        setSelectedDeviceId(null);
      });
      cyRef.current.on("mouseover", "node.device", (event) => {
        const node = event.target;
        node.addClass("hovered");
        node.connectedEdges().addClass("hovered");
      });
      cyRef.current.on("mouseout", "node.device", (event) => {
        const node = event.target;
        node.removeClass("hovered");
        node.connectedEdges().removeClass("hovered");
      });
      cyRef.current.on("tap", (event) => {
        if (event.target === cyRef.current) {
          setSelectedDeviceId(null);
          setSelectedRelationshipId(null);
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
        setCyZoom(cyRef.current?.zoom() ?? 1);
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
    const zoneColor = theme === "dark" ? "#c8d8e8" : "#263b4b";
    const zoneBgColor = theme === "dark" ? "#f4f8fa" : "#1a3a5c";
    const zoneBorderColor = theme === "dark" ? "#aebfcb" : "#3a6080";
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
          zoneLabelColor: theme === "dark" ? "#c8d8e8" : "#263b4b",
          zoneBgColor: theme === "dark" ? "#f4f8fa" : "#1a3a5c",
          zoneBorderColor: theme === "dark" ? "#aebfcb" : "#3a6080",
        },
      })),
      ...filteredGraph.devices.map((device) => {
        const liveStatus = livePingEnabled ? (liveStatusByDeviceId.get(device.id)?.status ?? device.monitor_status ?? "unknown") : "paused";
        const nodeScale = (groupDisplayPrefs[device.topology_group]?.nodeScalePercent ?? 140) / 100;
        const iconSize = Math.round(30 * Math.max(0.7, Math.min(2.2, nodeScale)));
        const hitSize = Math.max(36, iconSize + 14);
        return {
          group: "nodes" as const,
          classes: `device status-${liveStatus}`,
          data: {
            id: `device-${device.id}`,
            label: deviceLabel(device),
            labelColor: theme === "dark" ? "#ffffff" : "#111111",
            color: device.color || statusColor(device.monitor_status ?? device.status),
            iconUrl: deviceIconUrl(device.icon, device.color || statusColor(device.monitor_status ?? device.status)),
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
        return {
          group: "edges" as const,
          data: {
            id: `relationship-${relationship.id}`,
            source,
            target,
            label: relationship.relationship_type,
            notes: relationship.notes,
            edgeLabelColor: theme === "dark" ? "#c8dae8" : "#2a4055",
            edgeLabelBg: theme === "dark" ? "#1d2f40" : "#eef3f7",
            edgeBorderColor: theme === "dark" ? "rgba(60,100,130,0.5)" : "rgba(160,190,210,0.6)",
          },
        };
      }),
    ]);
    cy.layout({ name: "preset", fit: false, padding: 36 }).run();
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
    const timeout = window.setTimeout(() => {
      cy.resize();
      cy.fit(undefined, 36);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [showDetailsPanel]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.$("node.zone").style({
      "background-opacity": Math.max(0, Math.min(1, groupZoneOpacityPercent / 100)),
      "border-opacity": showGroupZoneBorders ? 0.1 : 0,
      "border-width": showGroupZoneBorders ? 2 : 0,
    });
  }, [groupZoneOpacityPercent, layoutRevision, filteredGraph, showGroupZoneBorders]);

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
      device_type: payload.device_type,
      status: payload.status,
      icon: payload.icon,
      color: payload.color,
      vlan_id: payload.vlan_id,
      subnet: payload.subnet,
      topology_group_id: payload.topology_group_id,
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
              device_type: payload.device_type,
              status: payload.status,
              icon: payload.icon,
              color: payload.color,
              vlan_id: payload.vlan_id,
              subnet: payload.subnet,
              topology_group_id: payload.topology_group_id,
              topology_group: current.devices.find((row) => row.id === deviceId)?.topology_group ?? device.topology_group,
              tags: payload.tags,
              notes: payload.notes,
            }
          : device,
      ),
    }));
    try {
      const updated = await api.updateDevice(accessToken, deviceId, payload);
      setLiveGraph((current) => ({
        ...current,
        devices: current.devices.map((device) =>
          device.id === updated.id
            ? { ...updated, ...pendingDevicePatchesRef.current[updated.id] }
            : device,
        ),
      }));
      void onGraphChange();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to update device");
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
    if (!window.confirm(`Delete link "${selectedRelationship.relationship_type}"?`)) {
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


  async function refreshSavedLayouts() {
    if (!accessToken) {
      return;
    }
    const layouts = await api.topologyLayouts(accessToken);
    setSavedLayouts(layouts);
  }

  async function saveNamedLayout(name: string) {
    if (!accessToken) {
      return;
    }
    const normalizedName = name.trim();
    if (!normalizedName) {
      setTopologyError("Layout name is required");
      return;
    }
    const positions = sanitizeTopologyLayoutPositions({
      ...layoutPositionsRef.current,
      ...collectCurrentTopologyLayoutPositions(cyRef.current),
    });
    if (Object.keys(positions).length === 0) {
      setTopologyError("No topology nodes are available to save");
      return;
    }
    setLayoutBusy(true);
    setTopologyError(null);
    try {
      const saved = await api.saveTopologyLayout(accessToken, { name: normalizedName, positions });
      setActiveSavedLayoutId(saved.id);
      await refreshSavedLayouts();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to save layout");
    } finally {
      setLayoutBusy(false);
    }
  }

  function loadSavedLayout(layout: TopologyLayout) {
    const positions = sanitizeTopologyLayoutPositions(layout.positions);
    layoutPositionsRef.current = positions;
    const now = Date.now();
    window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(positions));
    writeSavedTopologyLayoutMeta(userId, { savedAt: now });
    serverSaveLayoutRef.current(positions, true);
    fitOnNextRenderRef.current = true;
    setActiveSavedLayoutId(layout.id);
    setLayoutRevision((current) => current + 1);
  }

  async function deleteSavedLayout(layout: TopologyLayout) {
    if (!accessToken) {
      return;
    }
    setLayoutBusy(true);
    setTopologyError(null);
    try {
      await api.deleteTopologyLayout(accessToken, layout.id);
      if (activeSavedLayoutId === layout.id) {
        setActiveSavedLayoutId(null);
      }
      await refreshSavedLayouts();
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : "Unable to delete layout");
    } finally {
      setLayoutBusy(false);
    }
  }

  async function saveLayoutPrompt() {
    const defaultName =
      savedLayouts.find((layout) => layout.id === activeSavedLayoutId)?.name ?? "";
    const entered = window.prompt("Save layout as", defaultName);
    if (entered === null) {
      return;
    }
    await saveNamedLayout(entered);
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
    // Half-grid snap: allows devices to sit at midpoints between full-grid columns
    const snapX = Math.round(gridX / 2);
    const snapY = Math.round(gridY / 2);
    const rowStride = Math.round(gridY / snapY); // = 2 snap units per visual row

    // Step 1: Capture positions, sort top-left first for deterministic collision handling
    type Cell = { id: string; col: number; row: number };
    const entries = groupDevices
      .map((device) => {
        const id = `device-${device.id}`;
        const node = cy.$id(id);
        const pos = node.length > 0 ? node.position() : (layoutPositionsRef.current[id] ?? { x: 0, y: 0 });
        return { id, pos };
      })
      .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x);

    // Step 2: Snap each device to the nearest free half-grid cell
    const snapped: Cell[] = [];
    const occupied = new Set<string>();
    for (const { id, pos } of entries) {
      const baseCol = Math.round(pos.x / snapX);
      const baseRow = Math.round(pos.y / snapY);
      let placed = false;
      for (let r = 0; r <= 8 && !placed; r++) {
        for (let dc = -r; dc <= r && !placed; dc++) {
          for (let dr = -r; dr <= r && !placed; dr++) {
            if (r > 0 && Math.abs(dc) < r && Math.abs(dr) < r) continue;
            const key = `${baseCol + dc},${baseRow + dr}`;
            if (!occupied.has(key)) {
              occupied.add(key);
              snapped.push({ id, col: baseCol + dc, row: baseRow + dr });
              placed = true;
            }
          }
        }
      }
    }

    // Step 3: Group by visual row (same snap row index), then enforce maxPerRow limit
    snapped.sort((a, b) => a.row - b.row || a.col - b.col);
    const rowGroups = new Map<number, Cell[]>();
    for (const cell of snapped) {
      const group = rowGroups.get(cell.row) ?? [];
      group.push(cell);
      rowGroups.set(cell.row, group);
    }

    // Step 4: Assign final positions — overflow wraps to next available row
    const sortedRowKeys = [...rowGroups.keys()].sort((a, b) => a - b);
    const occupiedRows = new Set(sortedRowKeys);
    const finalPositions: Array<{ id: string; x: number; y: number }> = [];

    for (const rowKey of sortedRowKeys) {
      const group = rowGroups.get(rowKey)!.sort((a, b) => a.col - b.col);
      let nextOverflowRow = rowKey + rowStride;
      for (let i = 0; i < group.length; i += maxPerRow) {
        let rowY: number;
        if (i === 0) {
          rowY = rowKey;
        } else {
          while (occupiedRows.has(nextOverflowRow)) nextOverflowRow++;
          rowY = nextOverflowRow;
          occupiedRows.add(nextOverflowRow);
          nextOverflowRow += rowStride;
        }
        for (const { id, col } of group.slice(i, i + maxPerRow)) {
          finalPositions.push({ id, x: col * snapX, y: rowY * snapY });
        }
      }
    }

    // Step 5: Apply to Cytoscape and persist
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

  function exportTopologyPng() {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    downloadDataUrl(cy.png({ full: true, bg: "#fbfdfe", scale: 2 }), "netmap-topology.png");
  }

  function exportTopologySvg() {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    downloadTextFile(buildTopologySvg(cy), "netmap-topology.svg", "image/svg+xml");
  }

  return (
    <section className="topology-layout" id="topology">
      {expandedEntitySection && (
        <div className="topo-entity-backdrop" onClick={() => setExpandedEntitySection(null)} />
      )}
      <div className="topo-entity-panel">
        {(["devices", "relationships", "groups"] as const).map((section) => {
          const isActive = expandedEntitySection === section;
          const count = section === "devices"
            ? filteredGraph.devices.length
            : section === "relationships"
            ? filteredGraph.relationships.length
            : new Set(filteredGraph.devices.map((d) => d.topology_group).filter(Boolean)).size;
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
        {expandedEntitySection && (
          <div className="topo-entity-list">
            {expandedEntitySection === "devices" && (
              filteredGraph.devices.length === 0
                ? <p className="topo-entity-empty">No devices</p>
                : filteredGraph.devices.map((device) => {
                    const liveStatus = livePingEnabled ? liveStatusByDeviceId.get(device.id) : null;
                    const dotStatus = device.status === "disabled" ? "disabled" : livePingEnabled ? (liveStatus?.status ?? device.monitor_status ?? device.status) : "paused";
                    return (
                      <button
                        key={device.id}
                        type="button"
                        className={`topo-entity-row${selectedDeviceId === device.id ? " topo-entity-row--active" : ""}`}
                        onClick={() => { setSelectedDeviceId(device.id); setSelectedRelationshipId(null); setExpandedEntitySection(null); }}
                      >
                        <span className={`status-dot status-dot--sm ${dotStatus}`} />
                        <span className="topo-entity-name">{deviceLabel(device)}</span>
                        <span className="topo-entity-meta">{device.ip_address}</span>
                      </button>
                    );
                  })
            )}
            {expandedEntitySection === "relationships" && (
              filteredGraph.relationships.length === 0
                ? <p className="topo-entity-empty">No links</p>
                : filteredGraph.relationships.map((rel) => {
                    const src = liveGraph.devices.find((d) => d.id === rel.source_device_id);
                    const tgt = liveGraph.devices.find((d) => d.id === rel.target_device_id);
                    return (
                      <button
                        key={rel.id}
                        type="button"
                        className={`topo-entity-row${selectedRelationshipId === rel.id ? " topo-entity-row--active" : ""}`}
                        onClick={() => { setSelectedRelationshipId(rel.id); setSelectedDeviceId(null); setExpandedEntitySection(null); }}
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
              allGroupNames.length === 0
                ? <p className="topo-entity-empty">No groups</p>
                : allGroupNames.map((groupName) => {
                    const isHidden = hiddenGroupNames.has(groupName);
                    const count = liveGraph.devices.filter(
                      (d) => d.status !== "disabled" && (d.topology_group ?? "Ungrouped") === groupName,
                    ).length;
                    return (
                      <div key={groupName} className={`topo-entity-row topo-entity-row--group${isHidden ? " topo-entity-row--hidden" : ""}`}>
                        <span className="topo-entity-group-dot" />
                        <span className="topo-entity-name">{groupName}</span>
                        <span className="topo-entity-meta">{count} device{count !== 1 ? "s" : ""}</span>
                        <button
                          type="button"
                          className="topo-entity-eye"
                          onClick={() => toggleGroupVisibility(groupName)}
                          title={isHidden ? "Show group" : "Hide group"}
                        >
                          {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                      </div>
                    );
                  })
            )}
          </div>
        )}
      </div>
      <div className="topology-toolbar topology-toolbar--ribbon">
        <div className="toolbar-group">
          <div className="toolbar-group-controls">
            <select
              className="toolbar-select"
              value={selectedSiteId ?? 0}
              onChange={(event) => {
                const id = Number(event.target.value);
                setSelectedSiteId(id === 0 ? null : id);
              }}
            >
              <option value={0}>All Sites</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>{site.display_name ?? site.name}</option>
              ))}
            </select>
            <span className="inv-stat-chip inv-stat-chip--green">
              <IconWifi size={13} className="inv-stat-chip-icon" />
              <strong className="inv-stat-chip-count">{topoStatusCounts.online}</strong>
              <span className="inv-stat-chip-label">Online</span>
            </span>
            <span className={`inv-stat-chip ${topoStatusCounts.offline > 0 ? "inv-stat-chip--red" : "inv-stat-chip--muted"}`}>
              <IconWifiOff size={13} className="inv-stat-chip-icon" />
              <strong className="inv-stat-chip-count">{topoStatusCounts.offline}</strong>
              <span className="inv-stat-chip-label">Offline</span>
            </span>
          </div>
        </div>
        <div className="toolbar-divider" />
        <div className="toolbar-group">
          <div className="toolbar-group-controls">
            <button type="button" className="toolbar-btn" onClick={fitTopology}>Fit</button>
            <button type="button" className="toolbar-btn" onClick={resetLayout}>Reset view</button>
            {canWrite && (
              <>
                <button type="button" className="toolbar-btn" onClick={exportTopologyPng}>PNG</button>
                <button type="button" className="toolbar-btn" onClick={exportTopologySvg}>SVG</button>
              </>
            )}
          </div>
        </div>
        <div className="toolbar-divider" />
        <div className="toolbar-group">
          <div className="toolbar-group-controls toolbar-group--toggles">
            <label className="toolbar-toggle">
              <input type="checkbox" checked={showNodeIcons} onChange={(e) => setShowNodeIcons(e.target.checked)} />
              Icons
            </label>
            <label className="toolbar-toggle">
              <input type="checkbox" checked={showNodeLabels} onChange={(e) => setShowNodeLabels(e.target.checked)} />
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
                className={showGroupsPanel ? "toolbar-btn toolbar-btn--active" : "toolbar-btn"}
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
                    <button type="button" className="toolbar-btn toolbar-btn--xs" onClick={() => setHiddenGroupNames(new Set())}>
                      Show all
                    </button>
                    <button type="button" className="toolbar-btn toolbar-btn--xs" onClick={() => setHiddenGroupNames(new Set(allGroupNames))}>
                      Hide all
                    </button>
                  </div>
                  <div className="toolbar-groups-list">
                    {allGroupNames.map((groupName) => {
                      const isHidden = hiddenGroupNames.has(groupName);
                      const total = liveGraph.devices.filter(
                        (d) => d.status !== "disabled" && (d.topology_group ?? "Ungrouped") === groupName,
                      ).length;
                      return (
                        <button
                          key={groupName}
                          type="button"
                          className={`toolbar-group-row${isHidden ? " toolbar-group-row--hidden" : ""}`}
                          onClick={() => toggleGroupVisibility(groupName)}
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
                className={showDisplaySettings ? "toolbar-btn toolbar-btn--active" : "toolbar-btn"}
                onClick={() => setShowDisplaySettings((c) => !c)}
              >
                Display
                <ChevronDown size={11} style={{ transition: "transform 0.18s", transform: showDisplaySettings ? "rotate(180deg)" : undefined }} />
              </button>
              {showDisplaySettings && (
                <div className="toolbar-display-panel">
                  <label>
                    Group
                    <select value={selectedGroupForDisplay} onChange={(e) => setSelectedGroupForDisplay(e.target.value)}>
                      {visibleGroupNames.map((groupName) => (
                        <option key={`display-${groupName}`} value={groupName}>{groupName}</option>
                      ))}
                    </select>
                  </label>
                  <div className="toolbar-display-actions">
                    <button type="button" className="toolbar-btn" onClick={autoArrangeSelectedGroup} disabled={!visibleGroupNames.includes(selectedGroupForDisplay)}>
                      Snap to grid
                    </button>
                    <button type="button" className="toolbar-btn" onClick={resetSelectedGroup} disabled={!visibleGroupNames.includes(selectedGroupForDisplay)}>
                      Reset group
                    </button>
                  </div>
                  <label>
                    Node size <span>{activeGroupDisplay.nodeScalePercent}%</span>
                    <input type="range" min={70} max={180} step={5} value={activeGroupDisplay.nodeScalePercent}
                      onChange={(e) => setGroupDisplayPrefs((c) => ({ ...c, [selectedGroupForDisplay]: { ...activeGroupDisplay, nodeScalePercent: Number(e.target.value) } }))} />
                  </label>
                  <label>
                    Spacing <span>{activeGroupDisplay.spacingScalePercent}%</span>
                    <input type="range" min={80} max={220} step={10} value={activeGroupDisplay.spacingScalePercent}
                      onChange={(e) => {
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
                        setGroupDisplayPrefs((c) => ({ ...c, [selectedGroupForDisplay]: { ...activeGroupDisplay, spacingScalePercent: Number(e.target.value) } }));
                      }} />
                  </label>
                  <label>
                    Per row <span>{activeGroupDisplay.maxDevicesPerRow}</span>
                    <input type="range" min={3} max={8} step={1} value={activeGroupDisplay.maxDevicesPerRow}
                      onChange={(e) => {
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
                        setGroupDisplayPrefs((c) => ({ ...c, [selectedGroupForDisplay]: { ...activeGroupDisplay, maxDevicesPerRow: Number(e.target.value) } }));
                      }} />
                  </label>
                  <label>
                    Background <span>{groupZoneOpacityPercent}%</span>
                    <input type="range" min={0} max={100} step={5} value={groupZoneOpacityPercent}
                      onChange={(e) => setGroupZoneOpacityPercent(Number(e.target.value))} />
                  </label>
                  <label>
                    Device labels <span>{nodeLabelFontSize}px</span>
                    <input type="range" min={9} max={20} step={1} value={nodeLabelFontSize}
                      onChange={(e) => {
                        const size = Number(e.target.value);
                        setNodeLabelFontSize(size);
                        try { localStorage.setItem(`netmap.node-label-size.${userId}`, String(size)); } catch {}
                      }} />
                  </label>
                  <label>
                    Link labels <span>{edgeLabelFontSize}px</span>
                    <input type="range" min={10} max={24} step={1} value={edgeLabelFontSize}
                      onChange={(e) => {
                        const size = Number(e.target.value);
                        setEdgeLabelFontSize(size);
                        try { localStorage.setItem(`netmap.edge-label-size.${userId}`, String(size)); } catch {}
                        if (cyRef.current) cyRef.current.$("edge").style("font-size", size);
                      }} />
                  </label>
                </div>
              )}
            </div>
            {canWrite && (
              <>
                <button type="button" className="toolbar-btn toolbar-btn--primary" onClick={() => setShowDeviceForm(true)}>+ Device</button>
                <button type="button" className="toolbar-btn" onClick={() => setShowScanModal(true)}>Scan</button>
                <button type="button" className="toolbar-btn" disabled={liveGraph.devices.length < 2} onClick={() => setShowRelationshipForm(true)}>+ Link</button>
              </>
            )}
          </div>
        </div>
      </div>
      {topologyError && <div className="form-error">{topologyError}</div>}
      <div className={showDetailsPanel ? "topology-content details-open" : "topology-content"}>
        <div className="graph-surface">
          {!livePingEnabled && (
            <div className="topology-live-banner" role="status">
              <IconAlertCircle size={15} />
              <span><strong>Live ping polling is disabled.</strong> Markers show polling off.</span>
            </div>
          )}
          <div className="graph-canvas" ref={containerRef} />
          <div className="topology-overlay-layer">
            {overlayNodes.map((node) => (
              <button
                key={`overlay-${node.id}`}
                type="button"
                className={`topology-overlay-node${selectedDeviceId === node.id ? " selected" : ""}`}
                style={{ left: `${node.x}px`, top: `${node.y}px` }}
                onClick={() => {
                  setSelectedDeviceId(node.id);
                  setSelectedRelationshipId(null);
                }}
                title={node.lines[0]}
              >
                {showNodeIcons && (
                  <svg viewBox="0 0 24 24" width={node.size} height={node.size} fill="none" stroke={node.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <g dangerouslySetInnerHTML={{ __html: deviceIconPath(node.icon) }} />
                  </svg>
                )}
                {showNodeLabels && cyZoom >= 0.35 && (
                  <span className="topology-overlay-label" style={{ fontSize: `${nodeLabelFontSize}px` }}>
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
        </div>
        {showDetailsPanel && (
          <aside className="details-panel">
            {selectedDevice ? (
              <DeviceDetails
                canViewSecurity={canViewSecurity}
                canWrite={canWrite}
                accessToken={accessToken || ""}
                device={selectedDevice}
                disabled={busy}
                groups={groups}
                snmpProfiles={snmpProfiles}
                sites={sites}
                onGraphChange={onGraphChange}
                liveStatus={livePingEnabled ? (liveStatusByDeviceId.get(selectedDevice.id) ?? null) : null}
                onDelete={deleteSelectedDevice}
                onClone={() => {
                  setCloningDevice(selectedDevice);
                  setShowDeviceForm(true);
                }}
                onSubmit={(payload) => updateDevice(selectedDevice.id, payload)}
                securityLoading={deviceSecurityLoading}
                securitySummary={deviceSecuritySummary}
              />
            ) : selectedRelationship ? (
              <RelationshipDetails
                canWrite={canWrite}
                devices={liveGraph.devices}
                disabled={busy}
                relationship={selectedRelationship}
                onDelete={() => void deleteSelectedRelationship()}
                onEdit={() => setShowRelationshipEditForm(true)}
              />
            ) : null}
          </aside>
        )}
      </div>
      {showDeviceForm && (
        <DeviceForm
          busy={busy}
          device={null}
          cloneSource={cloningDevice}
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
    </section>
  );
}

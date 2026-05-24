import type { MutableRefObject } from "react";
import type { Core } from "cytoscape";
import type { Device, TopologyGraph } from "../api/client";
import type { DiagramLayout, DiagramLayoutOptions } from "../types";
import { topologyLayoutStoragePrefix, topologyLayoutVersion, topologyDisplayPrefsStoragePrefix } from "../constants";
import { compareGroupLabels, compareDevices, devicesByHierarchy } from "./sort";

export function groupId(group: string) {
  return `group-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default"}`;
}

export function resolveGroupColumns(groupCount: number) {
  if (groupCount <= 1) return 1;
  if (groupCount <= 4) return 2;
  if (groupCount <= 9) return 3;
  return 4;
}

export function detectCurrentMaxPerRow(positions: { x: number; y: number }[]): number {
  if (positions.length <= 1) return positions.length || 1;
  const sorted = [...positions].sort((a, b) => a.y - b.y);
  const rows: number[][] = [[sorted[0].y]];
  for (let i = 1; i < sorted.length; i++) {
    const lastRow = rows[rows.length - 1];
    const rowMeanY = lastRow.reduce((s, y) => s + y, 0) / lastRow.length;
    if (Math.abs(sorted[i].y - rowMeanY) < 60) {
      lastRow.push(sorted[i].y);
    } else {
      rows.push([sorted[i].y]);
    }
  }
  return Math.max(...rows.map((r) => r.length));
}

export function buildGroupVisualRows(lanes: Device[][], maxDevicesPerRow: number) {
  const safeMaxDevicesPerRow = Math.max(1, maxDevicesPerRow);
  const rows: Device[][] = [];
  lanes.forEach((lane) => {
    if (lane.length <= safeMaxDevicesPerRow) {
      rows.push(lane);
      return;
    }
    const rowCount = Math.ceil(lane.length / safeMaxDevicesPerRow);
    const perRow = Math.ceil(lane.length / rowCount);
    for (let index = 0; index < lane.length; index += perRow) {
      rows.push(lane.slice(index, index + perRow));
    }
  });
  return rows;
}

export function estimateGroupHeight(laneCount: number, nodeGapY: number) {
  if (laneCount <= 1) return 260;
  return Math.max(260, 180 + (laneCount - 1) * nodeGapY);
}

export function centeredOffset(index: number, count: number, gap: number) {
  if (count <= 1) return 0;
  return (index - (count - 1) / 2) * gap;
}

export function buildDiagramLayout(
  graph: TopologyGraph,
  savedPositions: Record<string, { x: number; y: number }> = {},
  options: DiagramLayoutOptions = {},
): DiagramLayout {
  const groups = [...new Set(graph.devices.map((device) => device.topology_group))].sort(compareGroupLabels);
  const positions: DiagramLayout["positions"] = {};
  const spacingScale = Math.max(0.8, Math.min(2, options.spacingScale ?? 1));
  const baseZoneWidth = Math.round(360 * spacingScale);
  const baseZoneGapX = Math.round(90 * spacingScale);
  const baseZoneGapY = Math.round(130 * spacingScale);
  const baseNodeGapX = Math.round(126 * spacingScale);
  const baseNodeGapY = Math.round(112 * spacingScale);
  const groupColumns = resolveGroupColumns(groups.length);

  const layoutGroups = groups.map((group) => {
    const groupOption = options.groupOptions?.[group];
    const groupSpacingScale = Math.max(0.8, Math.min(2, groupOption?.spacingScale ?? spacingScale));
    const nodeGapX = Math.round(126 * groupSpacingScale);
    const nodeGapY = Math.round(112 * groupSpacingScale);
    const devices = graph.devices.filter((device) => device.topology_group === group).sort(compareDevices);
    const lanes = devicesByHierarchy(devices);
    const visualRows = buildGroupVisualRows(lanes, groupOption?.maxDevicesPerRow ?? options.maxDevicesPerRow ?? 4);
    return { group, devices, visualRows, nodeGapX, nodeGapY, estimatedHeight: estimateGroupHeight(visualRows.length, nodeGapY) };
  });

  const rowHeights: number[] = [];
  layoutGroups.forEach((layoutGroup, index) => {
    const row = Math.floor(index / groupColumns);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, layoutGroup.estimatedHeight);
  });
  const rowOffsets: number[] = [];
  let cumulativeOffset = 0;
  rowHeights.forEach((height, row) => {
    rowOffsets[row] = cumulativeOffset;
    cumulativeOffset += height + baseZoneGapY;
  });

  layoutGroups.forEach((layoutGroup, groupIndex) => {
    const row = Math.floor(groupIndex / groupColumns);
    const column = groupIndex % groupColumns;
    const columnX = column * (baseZoneWidth + baseZoneGapX) + baseZoneWidth / 2;
    const rowBaseY = (rowOffsets[row] ?? 0) + 100;

    const savedInGroup = layoutGroup.devices
      .map((d) => savedPositions[`device-${d.id}`])
      .filter((p): p is { x: number; y: number } => Boolean(p));
    const savedGroupCenter = savedPositions[groupId(layoutGroup.group)];
    const newAnchorX = savedInGroup.length > 0
      ? savedInGroup.reduce((s, p) => s + p.x, 0) / savedInGroup.length
      : savedGroupCenter?.x ?? columnX;
    const newAnchorBaseY = savedInGroup.length > 0
      ? Math.max(...savedInGroup.map((p) => p.y))
      : savedGroupCenter != null
        ? savedGroupCenter.y - layoutGroup.nodeGapY
        : rowBaseY - layoutGroup.nodeGapY;

    let newOnlyRowIndex = 0;

    layoutGroup.visualRows.forEach((rowDevices) => {
      const rowSaved = rowDevices
        .map((d) => savedPositions[`device-${d.id}`])
        .filter((p): p is { x: number; y: number } => Boolean(p));
      const allNewRow = rowSaved.length === 0;

      rowDevices.forEach((device, index) => {
        const deviceNodeId = `device-${device.id}`;
        const savedPosition = savedPositions[deviceNodeId];
        if (savedPosition) {
          positions[deviceNodeId] = savedPosition;
          return;
        }
        const y = allNewRow
          ? newAnchorBaseY + (newOnlyRowIndex + 1) * layoutGroup.nodeGapY
          : rowSaved.reduce((s, p) => s + p.y, 0) / rowSaved.length;
        positions[deviceNodeId] = {
          x: newAnchorX + centeredOffset(index, rowDevices.length, layoutGroup.nodeGapX),
          y,
        };
      });

      if (allNewRow && rowDevices.some((d) => !savedPositions[`device-${d.id}`])) {
        newOnlyRowIndex++;
      }
    });
  });

  return {
    groups: groups.map((group) => ({ id: groupId(group), label: group })),
    positions,
  };
}

// ── Topology layout persistence ───────────────────────────────────────────────

export function savedTopologyLayoutKey(userId: number) {
  return `${topologyLayoutStoragePrefix}.v${topologyLayoutVersion}.${userId}`;
}

export function topologyDisplayPrefsKey(userId: number) {
  return `${topologyDisplayPrefsStoragePrefix}.${userId}`;
}

export function readTopologyDisplayPrefs(userId: number): {
  groups: Record<string, { nodeScalePercent: number; spacingScalePercent: number; maxDevicesPerRow: number }>;
} {
  const raw = window.localStorage.getItem(topologyDisplayPrefsKey(userId));
  if (!raw) return { groups: {} };
  try {
    const parsed = JSON.parse(raw) as {
      groups?: Record<string, { nodeScalePercent: number; spacingScalePercent: number; maxDevicesPerRow: number }>;
    };
    return { groups: parsed.groups ?? {} };
  } catch {
    window.localStorage.removeItem(topologyDisplayPrefsKey(userId));
    return { groups: {} };
  }
}

export function writeTopologyDisplayPrefs(
  userId: number,
  prefs: { groups: Record<string, { nodeScalePercent: number; spacingScalePercent: number; maxDevicesPerRow: number }> },
) {
  window.localStorage.setItem(topologyDisplayPrefsKey(userId), JSON.stringify(prefs));
}

export function readSavedTopologyLayout(userId: number) {
  const raw = window.localStorage.getItem(savedTopologyLayoutKey(userId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    return parsed ?? {};
  } catch {
    window.localStorage.removeItem(savedTopologyLayoutKey(userId));
    return {};
  }
}

export function clearSavedTopologyLayout(userId: number) {
  window.localStorage.removeItem(savedTopologyLayoutKey(userId));
}

export function collectCurrentTopologyLayoutPositions(cy: Core | null) {
  const visiblePositions: Record<string, { x: number; y: number }> = {};
  if (!cy) return visiblePositions;
  cy.$("node.device").forEach((node) => {
    visiblePositions[node.id()] = { ...node.position() };
  });
  return visiblePositions;
}

export function persistCurrentTopologyLayout(
  cy: Core | null,
  userId: number,
  layoutPositionsRef: MutableRefObject<Record<string, { x: number; y: number }>>,
) {
  if (!cy) return;
  const visiblePositions = collectCurrentTopologyLayoutPositions(cy);
  if (Object.keys(visiblePositions).length === 0) return;
  layoutPositionsRef.current = { ...layoutPositionsRef.current, ...visiblePositions };
  window.localStorage.setItem(savedTopologyLayoutKey(userId), JSON.stringify(layoutPositionsRef.current));
}


import type { Core, EdgeSingular } from "cytoscape";
import type { DownloadResult } from "../api/client";
import { resolveDeviceIcon, deviceIconPath } from "../icons";
import { topologyPalette } from "./topologyPalette";

export function triggerDownload(result: DownloadResult) {
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

export function downloadTextFile(content: string, filename: string, mimeType: string) {
  triggerDownload({
    blob: new Blob([content], { type: mimeType }),
    filename,
  });
}

export function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Returns the edge endpoints clipped to each node's bounding-box boundary so
// straight-line edges don't pierce into the interior of large zone nodes.
export function edgeClippedEndpoints(
  edge: EdgeSingular,
  offsetX: number,
  offsetY: number,
): { sx: number; sy: number; tx: number; ty: number } | null {
  const srcPos = edge.source().position();
  const tgtPos = edge.target().position();
  if (!srcPos || !tgtPos) return null;
  const dx = tgtPos.x - srcPos.x;
  const dy = tgtPos.y - srcPos.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    return { sx: srcPos.x + offsetX, sy: srcPos.y + offsetY, tx: tgtPos.x + offsetX, ty: tgtPos.y + offsetY };
  }
  const srcHW = edge.source().width() / 2;
  const srcHH = edge.source().height() / 2;
  const tgtHW = edge.target().width() / 2;
  const tgtHH = edge.target().height() / 2;
  // t such that (pos + t*dir) lands on the rectangle boundary
  const tSrc = Math.min(dx !== 0 ? srcHW / Math.abs(dx) : Infinity, dy !== 0 ? srcHH / Math.abs(dy) : Infinity);
  const tTgt = Math.min(dx !== 0 ? tgtHW / Math.abs(dx) : Infinity, dy !== 0 ? tgtHH / Math.abs(dy) : Infinity);
  return {
    sx: srcPos.x + tSrc * dx + offsetX,
    sy: srcPos.y + tSrc * dy + offsetY,
    tx: tgtPos.x - tTgt * dx + offsetX,
    ty: tgtPos.y - tTgt * dy + offsetY,
  };
}

export function topologySvgDimensions(cy: Core): { width: number; height: number; offsetX: number; offsetY: number } {
  const bounds = cy.elements().boundingBox();
  return {
    width: Math.max(320, Math.ceil(bounds.w + 120)),
    height: Math.max(240, Math.ceil(bounds.h + 140)),
    offsetX: 60 - bounds.x1,
    offsetY: 80 - bounds.y1,
  };
}

export function buildTopologySvg(cy: Core, isDark = false, skipText = false) {
  const palette = topologyPalette(isDark);
  const { width, height, offsetX, offsetY } = topologySvgDimensions(cy);

  const bg         = palette.background;
  const zoneFill   = palette.zoneFill;
  const zoneBorder = palette.zoneBorder;
  const zoneTxt    = palette.zoneLabel;
  const edgeColor  = palette.edge;

  let zoneMarkup = "";
  cy.nodes(".zone").forEach((zone) => {
    const position = zone.position();
    const zoneWidth = zone.width();
    const zoneHeight = zone.height();
    const top  = position.y - zoneHeight / 2 + offsetY;
    const left = position.x - zoneWidth / 2 + offsetX;
    const labelText = skipText ? "" : `<text x="${left + 14}" y="${top - 6}" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="${zoneTxt}">${escapeXml(String(zone.data("label") ?? ""))}</text>`;
    zoneMarkup += `
        <g>
          <rect x="${left}" y="${top}" width="${zoneWidth}" height="${zoneHeight}" rx="20" ry="20" fill="${zoneFill}" stroke="${zoneBorder}" stroke-width="2" stroke-dasharray="8 6" />
          ${labelText}
        </g>
      `;
  });

  const edgeTxtColor = palette.edgeText;
  const edgeBgColor  = palette.edgeLabelBg;

  let edgeMarkup = "";
  cy.edges().forEach((edge) => {
    const ep = edgeClippedEndpoints(edge, offsetX, offsetY);
    if (!ep) return;
    const { sx, sy, tx, ty } = ep;
    edgeMarkup += `<line x1="${sx}" y1="${sy}" x2="${tx}" y2="${ty}" stroke="${edgeColor}" stroke-width="2" />`;
    if (!skipText) {
      const label = String(edge.data("label") ?? "");
      if (label) {
        const mx = (sx + tx) / 2;
        const my = (sy + ty) / 2;
        const approxW = label.length * 7 + 8;
        edgeMarkup += `<rect x="${mx - approxW / 2}" y="${my - 10}" width="${approxW}" height="18" rx="4" fill="${edgeBgColor}" />`;
        edgeMarkup += `<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="12" fill="${edgeTxtColor}">${escapeXml(label)}</text>`;
      }
    }
  });

  let nodeMarkup = "";
  cy.nodes(".device").forEach((node) => {
    const position = node.position();
    const color = String(node.data("color") ?? "#5b7c91");
    const icon = resolveDeviceIcon(String(node.data("icon") ?? "unknown"));
    const iconSvgPath = deviceIconPath(icon);
    const nodeScale = Math.max(0.7, Math.min(2.2, Number(node.data("nodeScale") ?? 1)));
    const size = Math.max(30, Math.min(130, 44 * nodeScale));
    const scale = size / 24;
    let labelMarkup = "";
    if (!skipText) {
      const label = String(node.data("label") ?? "");
      const labelColor = palette.deviceLabel;
      const labelY = position.y + offsetY + size / 2 + 14;
      labelMarkup = label.split("\n").map((line, index) =>
        `<text x="${position.x + offsetX}" y="${labelY + index * 14}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="600" fill="${labelColor}">${escapeXml(line)}</text>`
      ).join("");
    }
    nodeMarkup += `
        <g>
          <g transform="translate(${position.x + offsetX - 12 * scale} ${position.y + offsetY - 12 * scale}) scale(${scale})" fill="none" stroke="${escapeXml(color)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            ${iconSvgPath}
          </g>
          ${labelMarkup}
        </g>
      `;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${bg}" />
  ${zoneMarkup}
  ${edgeMarkup}
  ${nodeMarkup}
</svg>`;
}

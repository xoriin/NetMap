import type { Core } from "cytoscape";
import {
  downloadDataUrl, downloadTextFile, triggerDownload, buildTopologySvg, topologySvgDimensions, edgeClippedEndpoints,
} from "../../utils/download";

function renderTopologyCanvas(cy: Core, edgeLabelFontSize: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const isDark = document.body.classList.contains("theme-dark");
    const { width, height, offsetX, offsetY } = topologySvgDimensions(cy);
    // skipText=true: SVG carries only shapes/icons; all text is drawn on canvas
    // directly so it always renders regardless of browser SVG-as-image quirks.
    const svgStr = buildTopologySvg(cy, isDark, true);
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to render topology image")); };
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error("Canvas context unavailable")); return; }
      ctx.scale(scale, scale);
      ctx.fillStyle = isDark ? "#0c1118" : "#fbfdfe";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);

      // Zone labels above their boxes
      const zoneLabelColor = isDark ? "#8ab0c8" : "#263b4b";
      ctx.font = "700 13px Arial, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = zoneLabelColor;
      cy.nodes(".zone").forEach((zone) => {
        const pos = zone.position();
        const top  = pos.y - zone.height() / 2 + offsetY;
        const left = pos.x - zone.width()  / 2 + offsetX;
        ctx.fillText(String(zone.data("label") ?? ""), left + 14, top - 6);
      });

      // Device labels below icons
      const deviceLabelColor = isDark ? "#d7e2ea" : "#13212b";
      ctx.font = "600 12px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = deviceLabelColor;
      cy.nodes(".device").forEach((node) => {
        const pos = node.position();
        const nodeScale = Math.max(0.7, Math.min(2.2, Number(node.data("nodeScale") ?? 1)));
        const size = Math.max(30, Math.min(130, 44 * nodeScale));
        const x = pos.x + offsetX;
        const labelY = pos.y + offsetY + size / 2 + 14;
        const label = String(node.data("label") ?? "");
        label.split("\n").forEach((line, index) => {
          ctx.fillText(line, x, labelY + index * 14);
        });
      });

      // Edge (link) labels at midpoint of the clipped edge line
      const edgeTxtColor = isDark ? "#c8dae8" : "#2a4055";
      const edgeBgColor  = isDark ? "#1d2f40" : "#eef3f7";
      ctx.font = `${edgeLabelFontSize}px Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      cy.edges().forEach((edge) => {
        const label = String(edge.data("label") ?? "");
        if (!label) return;
        const ep = edgeClippedEndpoints(edge, offsetX, offsetY);
        if (!ep) return;
        const mx = (ep.sx + ep.tx) / 2;
        const my = (ep.sy + ep.ty) / 2;
        const metrics = ctx.measureText(label);
        const pad = 4;
        const bw = metrics.width + pad * 2;
        const bh = edgeLabelFontSize + pad * 2;
        ctx.fillStyle = edgeBgColor;
        ctx.fillRect(mx - bw / 2, my - bh / 2, bw, bh);
        ctx.fillStyle = edgeTxtColor;
        ctx.fillText(label, mx, my);
      });

      resolve(canvas);
    };
    img.src = url;
  });
}

export function exportTopologyPng(cy: Core, edgeLabelFontSize: number) {
  void renderTopologyCanvas(cy, edgeLabelFontSize).then((canvas) => {
    downloadDataUrl(canvas.toDataURL("image/png"), "netmap-topology.png");
  });
}

export function exportTopologySvg(cy: Core) {
  const isDark = document.body.classList.contains("theme-dark");
  downloadTextFile(buildTopologySvg(cy, isDark), "netmap-topology.svg", "image/svg+xml");
}

export function exportTopologyPdf(cy: Core, edgeLabelFontSize: number) {
  void renderTopologyCanvas(cy, edgeLabelFontSize).then((canvas) => {
    // JPEG (not PNG): no alpha channel to manage, and it embeds directly into
    // a PDF image XObject via /DCTDecode without needing a Flate/zlib encoder.
    const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const pdfBytes = buildSingleImagePdf(jpegDataUrl, canvas.width, canvas.height);
    triggerDownload({
      blob: new Blob([pdfBytes], { type: "application/pdf" }),
      filename: "netmap-topology.pdf",
    });
  });
}

function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Hand-rolled single-page PDF wrapping one JPEG image, scaled to fit a
 * Letter-sized page. Avoids pulling in a PDF library for one export button.
 */
function buildSingleImagePdf(jpegDataUrl: string, pixelWidth: number, pixelHeight: number): Uint8Array<ArrayBuffer> {
  const jpegBytes = dataUrlToBytes(jpegDataUrl);
  const encoder = new TextEncoder();

  const PAGE_MAX_W = 792; // US Letter landscape, points (72/in)
  const PAGE_MAX_H = 612;
  const margin = 24;
  const availW = PAGE_MAX_W - margin * 2;
  const availH = PAGE_MAX_H - margin * 2;
  const imgAspect = pixelWidth / pixelHeight;
  let drawW = availW;
  let drawH = drawW / imgAspect;
  if (drawH > availH) {
    drawH = availH;
    drawW = drawH * imgAspect;
  }
  const drawX = (PAGE_MAX_W - drawW) / 2;
  const drawY = (PAGE_MAX_H - drawH) / 2;

  const contentStream = `q ${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm /Im0 Do Q`;
  const contentBytes = encoder.encode(contentStream);

  const parts: Uint8Array<ArrayBuffer>[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  function push(bytes: Uint8Array<ArrayBuffer>) {
    parts.push(bytes);
    cursor += bytes.length;
  }
  function pushObj(index: number, bytes: Uint8Array<ArrayBuffer>) {
    offsets[index] = cursor;
    push(bytes);
  }

  push(encoder.encode("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));

  pushObj(1, encoder.encode("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"));
  pushObj(2, encoder.encode("2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"));
  pushObj(3, encoder.encode(
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_MAX_W} ${PAGE_MAX_H}] `
    + `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >> endobj\n`,
  ));
  pushObj(4, encoder.encode(
    `4 0 obj << /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} `
    + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >> stream\n`,
  ));
  push(jpegBytes);
  push(encoder.encode("\nendstream endobj\n"));
  pushObj(5, encoder.encode(`5 0 obj << /Length ${contentBytes.length} >> stream\n`));
  push(contentBytes);
  push(encoder.encode("\nendstream endobj\n"));

  const xrefStart = cursor;
  const objectCount = 6; // objects 0 (free) through 5
  const pad10 = (n: number) => String(n).padStart(10, "0");
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let i = 1; i < objectCount; i++) {
    xref += `${pad10(offsets[i])} 00000 n \n`;
  }
  push(encoder.encode(xref));
  push(encoder.encode(
    `trailer << /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
  ));

  const total = new Uint8Array(cursor);
  let pos = 0;
  for (const part of parts) {
    total.set(part, pos);
    pos += part.length;
  }
  return total;
}

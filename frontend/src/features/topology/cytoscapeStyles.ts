import type cytoscape from "cytoscape";

// Cytoscape's Css typings do not include the non-standard shadow-* extension
// properties; funnel them through one typed boundary instead of scattered casts.
export function cyExtendedStyle(style: Record<string, string | number>): cytoscape.Css.Node {
  return style as unknown as cytoscape.Css.Node;
}

/** Edge width in px for a manual link speed; unspecified links keep the
 *  historical default of 2 so existing maps look unchanged. */
export function linkSpeedEdgeWidth(mbps: number | null): number {
  if (mbps === null) return 2;
  if (mbps <= 100) return 1.5;
  if (mbps < 2500) return 2.5;
  if (mbps < 10_000) return 3;
  if (mbps < 40_000) return 4;
  return 5;
}

/** Static stylesheet for the topology canvas. Theme-dependent colours are
 *  applied afterwards via data attributes and cy.style() updates. */
export function buildCytoscapeStylesheet(edgeLabelFontSize: number): cytoscape.StylesheetJson {
  return [
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
        // Keep the transparent Cytoscape hitbox at its data-driven size while
        // hovered. Resizing the pointer target here can make the cursor cross
        // its new boundary repeatedly, causing mouseover/mouseout flicker.
        opacity: 0.92,
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
        "text-background-color": "#eef4f8",
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
        "background-opacity": 0.2,
        "border-color": "data(zoneBorderColor)",
        "border-opacity": 0.72,
        "border-style": "solid",
        "border-width": 1,
        color: "data(zoneLabelColor)",
        "font-size": 12,
        "font-weight": 700,
        label: "",
        // The HTML device overlay is larger than Cytoscape's hit target once
        // icons and labels are included. Keep a dedicated header clearance so
        // the first device row can never intrude on the group title/count.
        padding: "52px",
        shape: "round-rectangle",
        "text-halign": "center",
        "text-margin-x": 0,
        "text-margin-y": 10,
        "text-valign": "top",
      },
    },
    {
      selector: "edge",
      style: {
        "curve-style": "bezier",
        label: "",
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
        width: "data(linkWidth)",
      },
    },
    {
      selector: "edge.path-dim, node.device.path-dim",
      style: {
        opacity: 0.15,
      },
    },
    {
      selector: "edge.path-highlight",
      style: {
        "line-color": "#1d9ab0",
        "target-arrow-color": "#1d9ab0",
        width: 5,
        "z-index": 70,
      },
    },
    {
      selector: "node.device.path-highlight",
      style: {
        "z-index": 70,
      },
    },
    {
      selector: "node.zone.path-highlight",
      style: {
        "border-color": "#1d9ab0",
        "border-width": 3,
        "border-opacity": 1,
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
    {
      selector: "node.device.panel-hover",
      style: cyExtendedStyle({
        "shadow-blur": 22,
        "shadow-color": "#1d9ab0",
        "shadow-opacity": 0.55,
        "shadow-offset-x": 0,
        "shadow-offset-y": 0,
        opacity: 1,
        "z-index": 80,
      }),
    },
    {
      selector: "node.zone.panel-hover",
      style: cyExtendedStyle({
        "shadow-blur": 18,
        "shadow-color": "#8040c0",
        "shadow-opacity": 0.4,
        "shadow-offset-x": 0,
        "shadow-offset-y": 0,
      }),
    },
    {
      selector: "edge.panel-hover",
      style: {
        "line-color": "#1d9ab0",
        "target-arrow-color": "#1d9ab0",
        width: 4,
        opacity: 1,
        "z-index": 50,
      },
    },
  ];
}

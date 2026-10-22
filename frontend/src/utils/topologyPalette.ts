export type TopologyPalette = {
  background: string;
  zoneFill: string;
  zoneBorder: string;
  zoneLabel: string;
  liveZoneFill: string;
  liveZoneBorder: string;
  liveZoneLabel: string;
  edge: string;
  edgeText: string;
  edgeLabelBg: string;
  edgeLabelBorder: string;
  deviceLabel: string;
  canvasText: string;
};

const LIGHT: TopologyPalette = {
  background: "#fbfdfe",
  zoneFill: "#f4f8fa",
  zoneBorder: "#aebfcb",
  zoneLabel: "#263b4b",
  liveZoneFill: "#b9cedb",
  liveZoneBorder: "#6f8ba0",
  liveZoneLabel: "#263b4b",
  edge: "#6f8798",
  edgeText: "#2a4055",
  edgeLabelBg: "#eef3f7",
  edgeLabelBorder: "rgba(160,190,210,0.6)",
  deviceLabel: "#13212b",
  canvasText: "#111111",
};

const DARK_TOKENS: Record<keyof TopologyPalette, [token: string, fallback: string]> = {
  background: ["--nm-bg", "#020617"],
  zoneFill: ["--nm-bg-elevated", "#0b1222"],
  zoneBorder: ["--nm-border-strong", "#334155"],
  zoneLabel: ["--nm-text-muted", "#94a3b8"],
  liveZoneFill: ["--nm-modal-header", "#162033"],
  liveZoneBorder: ["--nm-border-strong", "#334155"],
  liveZoneLabel: ["--nm-text", "#f1f5f9"],
  edge: ["--nm-border-strong", "#334155"],
  edgeText: ["--nm-modal-label", "#e2e8f0"],
  edgeLabelBg: ["--nm-modal-header", "#162033"],
  edgeLabelBorder: ["--nm-border-strong", "#334155"],
  deviceLabel: ["--nm-text", "#f1f5f9"],
  canvasText: ["--nm-on-deep", "#ffffff"],
};

export function topologyPalette(isDark: boolean): TopologyPalette {
  if (!isDark) return LIGHT;
  const css = getComputedStyle(document.body);
  const entries = Object.entries(DARK_TOKENS).map(([key, [token, fallback]]) => [key, css.getPropertyValue(token).trim() || fallback]);
  return Object.fromEntries(entries) as TopologyPalette;
}

export const RENDERER_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

const LIGHT_TOKENS = `
:root {
  color-scheme: light;
  --sp-bg: #f8fafd;
  --sp-surface: #ffffff;
  --sp-surface-soft: #f1f3f4;
  --sp-row-hover: #f0f4f9;
  --sp-border: #dadce0;
  --sp-text: #202124;
  --sp-text-muted: #5f6368;
  --sp-text-faint: #747775;
  --sp-accent: #1a73e8;
  --sp-success: #188038;
  --sp-success-soft: #e6f4ea;
  --sp-warning: #b06000;
  --sp-warning-text: #8c4e00;
  --sp-warning-soft: #fef7e0;
  --sp-danger: #d93025;
  --sp-danger-soft: #fce8e6;
  --sp-maintenance: var(--sp-warning-text);
  --sp-maintenance-soft: var(--sp-warning-soft);
  --sp-info-text: #174ea6;
  --sp-info-soft: #e8f0fe;
  --sp-beat-healthy: #34a853;
  --sp-beat-unhealthy: #ea4335;
  --sp-beat-unknown: #bdc1c6;
  --sp-beat-maintenance: #f9ab00;
  --sp-card-shadow: 0 2px 6px rgba(60, 64, 67, 0.06);
}
`;

const DARK_TOKENS = `
:root {
  color-scheme: dark;
  --sp-bg: #131314;
  --sp-surface: #1e1f20;
  --sp-surface-soft: #282a2c;
  --sp-row-hover: #282a2c;
  --sp-border: #444746;
  --sp-text: #e3e3e3;
  --sp-text-muted: #c4c7c5;
  --sp-text-faint: #a9a9ad;
  --sp-accent: #a8c7fa;
  --sp-success: #81c995;
  --sp-success-soft: #163b23;
  --sp-warning: #fdd663;
  --sp-warning-text: #fdd663;
  --sp-warning-soft: #42371b;
  --sp-danger: #f28b82;
  --sp-danger-soft: #452421;
  --sp-maintenance: var(--sp-warning-text);
  --sp-maintenance-soft: var(--sp-warning-soft);
  --sp-info-text: #a8c7fa;
  --sp-info-soft: #26354b;
  --sp-beat-healthy: #81c995;
  --sp-beat-unhealthy: #f28b82;
  --sp-beat-unknown: #5f6368;
  --sp-beat-maintenance: #fdd663;
  --sp-card-shadow: none;
}
`;

const BASE_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--sp-bg);
  color: var(--sp-text);
  font-family: Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
}
h1, h2, h3, p, ol, ul, dl { margin: 0; }
a { color: var(--sp-page-accent, var(--sp-accent)); text-decoration: none; }
a:hover { text-decoration: underline; }
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary:focus-visible { outline: 3px solid var(--sp-page-accent, var(--sp-accent)); outline-offset: -2px; }

.sp-page { max-width: 1180px; margin: 0 auto; padding: 48px 32px 64px; }

.sp-header { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; min-width: 0; }
.sp-logo { width: 48px; height: 48px; flex: none; border-radius: 14px; object-fit: contain; }
.sp-title { min-width: 0; font-size: 30px; font-weight: 500; letter-spacing: -0.5px; line-height: 1.25; overflow-wrap: anywhere; }

.sp-summary {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
  margin-bottom: 16px; padding: 24px;
  border: 1px solid var(--sp-border); border-radius: 20px; background: var(--sp-surface); box-shadow: var(--sp-card-shadow);
}
.sp-summary[data-state="operational"] { color: var(--sp-success); background: var(--sp-success-soft); border-color: var(--sp-success); }
.sp-summary[data-state="affected"] { color: var(--sp-warning-text); background: var(--sp-warning-soft); border-color: var(--sp-warning-text); }
.sp-summary[data-state="major"] { color: var(--sp-danger); background: var(--sp-danger-soft); border-color: var(--sp-danger); }
.sp-summary[data-state="maintenance"] { color: var(--sp-maintenance); background: var(--sp-maintenance-soft); border-color: var(--sp-maintenance); }
.sp-summary-dot { width: 12px; height: 12px; flex: none; border-radius: 50%; background: var(--sp-text-faint); }
@keyframes sp-operational-breathe {
  0%, 100% { opacity: 0.65; transform: scale(0.9); box-shadow: 0 0 0 0 var(--sp-success-soft); }
  50% { opacity: 1; transform: scale(1.1); box-shadow: 0 0 0 5px var(--sp-success-soft); }
}
.sp-summary[data-state="operational"] .sp-summary-dot {
  background: var(--sp-success);
  animation: sp-operational-breathe 2.8s ease-in-out infinite;
}
.sp-summary[data-state="affected"] .sp-summary-dot { background: var(--sp-warning); }
.sp-summary[data-state="major"] .sp-summary-dot { background: var(--sp-danger); }
.sp-summary[data-state="maintenance"] .sp-summary-dot { background: var(--sp-maintenance); }
.sp-summary-label { font-size: 18px; font-weight: 500; }
.sp-summary-counts { flex-basis: 100%; padding-left: 26px; color: inherit; font-size: 12px; }

.sp-strip {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px;
  margin-bottom: 12px; padding: 14px 20px;
  border: 1px solid var(--sp-border); border-radius: 16px; background: var(--sp-surface-soft);
  font-size: 13px; overflow-wrap: anywhere;
}
.sp-strip-title { font-weight: 600; }
.sp-strip-body, .sp-strip-meta { color: var(--sp-text-muted); }
.sp-strip-meta { font-size: 12px; }
.sp-strip a { margin-left: auto; font-size: 12px; white-space: nowrap; }

.sp-pill {
  display: inline-block; flex: none; padding: 4px 10px;
  border: 1px solid transparent; border-radius: 999px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap;
}
.sp-pill[data-tone="danger"] { color: var(--sp-danger); background: var(--sp-danger-soft); border-color: var(--sp-danger); }
.sp-pill[data-tone="warning"] { color: var(--sp-warning-text); background: var(--sp-warning-soft); border-color: var(--sp-warning); }
.sp-pill[data-tone="info"] { color: var(--sp-info-text); background: var(--sp-info-soft); border-color: var(--sp-info-text); }
.sp-pill[data-tone="maintenance"] { color: var(--sp-maintenance); background: var(--sp-maintenance-soft); border-color: var(--sp-maintenance); }
.sp-pill[data-tone="neutral"] { color: var(--sp-text-muted); background: var(--sp-surface-soft); border-color: var(--sp-border); }

.sp-groups { display: grid; gap: 24px; margin-top: 24px; }
.sp-group { overflow: hidden; border: 1px solid var(--sp-border); border-radius: 20px; background: var(--sp-surface); box-shadow: var(--sp-card-shadow); }
.sp-group-name { display: flex; align-items: center; gap: 10px; padding: 20px 24px; font-size: 15px; font-weight: 600; }
.sp-group-name::before { content: "\\25B8"; width: 12px; flex: none; color: var(--sp-text-muted); font-size: 12px; }
.sp-group[open] > .sp-group-name::before { content: "\\25BE"; }
.sp-group[open] > .sp-group-name { border-bottom: 1px solid var(--sp-border); }
.sp-group-label { min-width: 0; overflow-wrap: anywhere; }
.sp-group-state { margin-left: auto; font-size: 12px; white-space: nowrap; color: var(--sp-text-muted); }
.sp-group[data-state="operational"] .sp-group-state { color: var(--sp-success); }
.sp-group[data-state="affected"] .sp-group-state { color: var(--sp-warning-text); }
.sp-group[data-state="major"] .sp-group-state { color: var(--sp-danger); }
.sp-group[data-state="maintenance"] .sp-group-state { color: var(--sp-maintenance); }
.sp-group-empty { padding: 12px 20px; color: var(--sp-text-muted); }

.sp-row { border-top: 1px solid var(--sp-border); }
.sp-group-name + .sp-row { border-top: 0; }
.sp-row-main, .sp-row-more {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 12px 24px; padding: 18px 24px;
}
.sp-row-main { align-items: center; }
.sp-row-more { align-items: start; padding-top: 0; }
summary.sp-row-main:hover { background: var(--sp-row-hover); }
.sp-ident { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sp-caret { width: 12px; flex: none; color: var(--sp-text-muted); font-size: 12px; }
details.sp-row > summary .sp-caret::before { content: "\\25B8"; }
details.sp-row[open] > summary .sp-caret::before { content: "\\25BE"; }
.sp-uptime {
  flex: none; min-width: 54px; padding: 4px 10px; border-radius: 999px; text-align: center; white-space: nowrap;
  font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
  color: var(--sp-text-muted); background: var(--sp-surface-soft);
}
.sp-uptime[data-tone="good"] { color: var(--sp-success); background: var(--sp-success-soft); }
.sp-uptime[data-tone="warning"] { color: var(--sp-warning-text); background: var(--sp-warning-soft); }
.sp-uptime[data-tone="danger"] { color: var(--sp-danger); background: var(--sp-danger-soft); }
.sp-row-name { min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
.sp-state { margin-left: auto; font-size: 12px; font-weight: 500; white-space: nowrap; color: var(--sp-text-muted); }
.sp-row[data-state="operational"] .sp-state { color: var(--sp-success); }
.sp-row[data-state="degraded"] .sp-state { color: var(--sp-warning-text); }
.sp-row[data-state="down"] .sp-state { color: var(--sp-danger); }
.sp-row[data-state="maintenance"] .sp-state { color: var(--sp-maintenance); }

.sp-graphs { min-width: 0; }
.sp-lane { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sp-lane + .sp-lane { margin-top: 6px; }
.sp-lane-label { width: 64px; flex: none; color: var(--sp-text-muted); font-size: 10px; text-align: right; }
.sp-row:not([open]) .sp-lane-label { visibility: hidden; }
.sp-heartbeats, .sp-response { flex: 1 1 0; min-width: 0; height: 24px; }
.sp-heartbeats { display: flex; height: 26px; gap: 3px; }
.sp-beat { flex: 1 1 0; min-width: 0; border-radius: 4px; background: var(--sp-beat-unknown); }
.sp-beat--healthy { background: var(--sp-beat-healthy); }
.sp-beat--unhealthy { background: var(--sp-beat-unhealthy); }
.sp-beat--unknown { background: var(--sp-beat-unknown); }
.sp-beat--maintenance { background: var(--sp-beat-maintenance); }
.sp-response { display: block; height: 26px; border-radius: 6px; background: var(--sp-surface-soft); }
.sp-response-area { fill: var(--sp-page-accent, var(--sp-accent)); fill-opacity: 0.18; stroke: none; }
.sp-response-line { fill: none; stroke: var(--sp-page-accent, var(--sp-accent)); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.sp-axis { display: flex; justify-content: space-between; margin: 3px 0 0 72px; color: var(--sp-text-faint); font-size: 10px; }
details.sp-row[open] > summary .sp-axis { display: none; }

.sp-stats { display: grid; grid-template-columns: auto auto; gap: 6px 20px; width: max-content; max-width: 100%; margin-left: 22px; font-size: 12px; }
.sp-stats dt { color: var(--sp-text-muted); }
.sp-stats dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }

.sp-log, .sp-past { margin-top: 24px; overflow: hidden; border: 1px solid var(--sp-border); border-radius: 20px; background: var(--sp-surface); box-shadow: var(--sp-card-shadow); }
.sp-section-title { display: flex; align-items: center; gap: 10px; padding: 20px 24px; font-size: 15px; font-weight: 600; }
.sp-section-title::before { content: "\\25B8"; width: 12px; flex: none; color: var(--sp-text-muted); font-size: 12px; }
details[open] > .sp-section-title::before { content: "\\25BE"; }
details[open] > .sp-section-title { border-bottom: 1px solid var(--sp-border); }
.sp-section-heading { font: inherit; }
.sp-section-count { margin-left: auto; color: var(--sp-text-muted); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.sp-incident { padding: 20px 24px; overflow-wrap: anywhere; }
.sp-incident + .sp-incident { border-top: 1px solid var(--sp-border); }
.sp-incident-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 15px; font-weight: 500; }
.sp-incident-meta { margin: 4px 0 8px; color: var(--sp-text-muted); font-size: 12px; }
.sp-updates { padding: 0 0 0 14px; list-style: none; border-left: 3px solid var(--sp-border); }
.sp-update { padding: 0 0 12px 10px; }
.sp-update-time { margin-right: 6px; color: var(--sp-text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.sp-update-author { margin-right: 6px; font-size: 11px; font-weight: 600; color: var(--sp-text-muted); }
.sp-update-internal, .sp-update-status { margin-right: 6px; }
.sp-update-status { font-size: 12px; font-weight: 600; }
.sp-update[data-internal="true"] .sp-update-text { color: var(--sp-text-muted); }

@media (max-width: 640px) {
  .sp-page { padding: 24px 12px 40px; }
  .sp-header { margin-bottom: 24px; }
  .sp-title { font-size: 24px; }
  .sp-summary { padding: 20px 16px; }
  .sp-summary, .sp-strip { padding-left: 16px; padding-right: 16px; }
  .sp-group-name, .sp-row-main, .sp-row-more, .sp-group-empty, .sp-incident, .sp-section-title { padding-left: 16px; padding-right: 16px; }

}

@media (max-width: 800px) {
  .sp-row-main, .sp-row-more { grid-template-columns: minmax(0, 1fr); }
  .sp-row-more .sp-graphs { order: -1; }
  .sp-lane-label { display: none; }
  .sp-axis { margin-left: 0; }
  .sp-heartbeats { gap: 2px; }
  .sp-ident { flex-wrap: wrap; }
  .sp-state { margin-left: 0; }
  .sp-stats { margin-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`;

export const REDUCED_MOTION_OVERRIDE = `@layer sp-reduced-motion {
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after, *::marker { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
}`;

export type StatusColorScheme = "light" | "dark" | null;

export function builtinStyles(scheme: StatusColorScheme): string {
  if (scheme === "light") return LIGHT_TOKENS + BASE_STYLES;
  if (scheme === "dark") return LIGHT_TOKENS + DARK_TOKENS + BASE_STYLES;
  return `${LIGHT_TOKENS}@media (prefers-color-scheme: dark) {\n${DARK_TOKENS}}\n${BASE_STYLES}`;
}

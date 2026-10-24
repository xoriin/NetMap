import type { DarkStyle } from "../../../providers/ThemeProvider";
import { statusThemeCss } from "./statusTheme";

export const RENDERER_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

const STATUS_TOKENS = `
:root {
  --sp-bg: var(--nm-bg);
  --sp-surface: var(--nm-modal-section);
  --sp-surface-soft: var(--nm-bg-elevated);
  --sp-row-hover: var(--nm-row-hover);
  --sp-border: var(--nm-border);
  --sp-text: var(--nm-text);
  --sp-text-muted: var(--nm-text-muted);
  --sp-text-faint: var(--nm-text-faint);
  --sp-accent: var(--nm-accent-strong);
  --sp-success: color-mix(in srgb, var(--nm-success) 65%, var(--nm-text));
  --sp-success-soft: color-mix(in srgb, var(--nm-success) 22%, var(--nm-surface));
  --sp-warning: var(--nm-warning);
  --sp-warning-text: color-mix(in srgb, var(--nm-warning) 45%, var(--nm-text));
  --sp-warning-soft: color-mix(in srgb, var(--nm-warning) 24%, var(--nm-surface));
  --sp-danger: color-mix(in srgb, var(--nm-danger) 65%, var(--nm-text));
  --sp-danger-soft: color-mix(in srgb, var(--nm-danger) 18%, var(--nm-surface));
  --sp-maintenance: var(--sp-warning-text);
  --sp-maintenance-soft: var(--sp-warning-soft);
  --sp-info-text: color-mix(in srgb, var(--nm-tone-blue-deep) 65%, var(--nm-text));
  --sp-info-soft: color-mix(in srgb, var(--nm-tone-blue-deep) 20%, var(--nm-surface));
  --sp-beat-healthy: var(--nm-success);
  --sp-beat-unhealthy: var(--nm-danger);
  --sp-beat-unknown: var(--nm-border-strong);
  --sp-beat-maintenance: var(--nm-warning);
  --sp-card-shadow: var(--nm-shadow-sm);
}
`;

const BASE_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scrollbar-color: var(--nm-border-strong) var(--sp-bg); }
body {
  margin: 0;
  background: var(--sp-bg);
  color: var(--sp-text);
  font-family: inherit;
  font-size: var(--nm-text-md);
  line-height: 1.45;
}
h1, h2, h3, p, ol, ul, dl { margin: 0; }
a { color: var(--sp-page-accent, var(--sp-accent)); text-decoration: none; }
a:hover { text-decoration: underline; }
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary:focus-visible { outline: 2px solid var(--nm-focus-border); outline-offset: -2px; }

.sp-page { max-width: 1180px; margin: 0 auto; padding: 24px 24px 40px; }

.sp-header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; min-width: 0; }
.sp-logo { width: 40px; height: 40px; flex: none; border-radius: var(--nm-radius-md); object-fit: contain; }
.sp-title { min-width: 0; font-size: 28px; font-weight: 600; letter-spacing: -0.5px; line-height: 1.25; overflow-wrap: anywhere; }

.sp-summary {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
  margin-bottom: 16px; padding: 16px 18px;
  border: 1px solid var(--sp-border); border-radius: var(--nm-radius-lg); background: var(--sp-surface); box-shadow: var(--sp-card-shadow);
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
.sp-summary-label { font-size: var(--nm-text-lg); font-weight: 600; }
.sp-summary-counts { flex-basis: 100%; padding-left: 26px; color: inherit; font-size: 12px; }

.sp-strip {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px;
  margin-bottom: 12px; padding: 16px 20px;
  border: 1px solid var(--sp-border); border-left: 4px solid var(--sp-border); border-radius: var(--nm-radius-lg); background: var(--sp-surface);
  font-size: 14px; line-height: 1.6; overflow-wrap: anywhere;
}
.sp-strip[data-tone="info"] { background: var(--sp-info-soft); border-color: var(--sp-info-text); }
.sp-strip[data-tone="warning"], .sp-strip[data-tone="maintenance"] { background: var(--sp-warning-soft); border-color: var(--sp-warning-text); }
.sp-strip[data-tone="danger"] { background: var(--sp-danger-soft); border-color: var(--sp-danger); }
.sp-strip .sp-strip-body, .sp-strip .sp-strip-meta { color: var(--sp-text); }
.sp-strip .sp-strip-meta { font-size: 13px;
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

.sp-groups { display: grid; gap: 16px; margin-top: 16px; }
.sp-group { overflow: hidden; border: 1px solid var(--sp-border); border-radius: var(--nm-radius-lg); background: var(--sp-surface); box-shadow: var(--sp-card-shadow); }
.sp-group-name { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 18px; font-size: var(--nm-text-lg); font-weight: 600; background: var(--nm-panel-head-bg); color: var(--nm-panel-head-text); }
.sp-panel-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 30px; height: 30px; border-radius: var(--nm-radius-sm); background: var(--nm-panel-head-icon-bg); color: var(--nm-panel-head-icon-fg); }
.sp-panel-icon svg { width: 18px; height: 18px; }
.sp-group-name::before { content: "\\25B8"; width: 12px; flex: none; color: var(--nm-panel-head-muted); font-size: 12px; }
.sp-group[open] > .sp-group-name::before { content: "\\25BE"; }
.sp-group[open] > .sp-group-name { border-bottom: 1px solid var(--sp-border); }
.sp-group-label { min-width: 0; overflow-wrap: anywhere; }
.sp-group-state { margin-left: auto; font-size: 12px; white-space: nowrap; color: var(--nm-panel-head-muted); }
.sp-group[data-state="operational"] .sp-group-state { color: color-mix(in srgb, var(--sp-success) 50%, var(--nm-panel-head-text)); }
.sp-group[data-state="affected"] .sp-group-state { color: color-mix(in srgb, var(--sp-warning-text) 50%, var(--nm-panel-head-text)); }
.sp-group[data-state="major"] .sp-group-state { color: color-mix(in srgb, var(--sp-danger) 50%, var(--nm-panel-head-text)); }
.sp-group[data-state="maintenance"] .sp-group-state { color: color-mix(in srgb, var(--sp-maintenance) 50%, var(--nm-panel-head-text)); }
.sp-group-empty { padding: 12px 20px; color: var(--sp-text-muted); }

.sp-row { border-top: 1px solid var(--sp-border); }
.sp-group-name + .sp-row { border-top: 0; }
.sp-row-main, .sp-row-more {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 12px 24px; padding: 16px 18px;
}
.sp-row-main { align-items: center; }
.sp-row-more { align-items: center; padding-top: 8px; }
summary.sp-row-main:hover { background: var(--sp-row-hover); box-shadow: inset 3px 0 0 var(--nm-row-hover-edge); }
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
/* Match Monitoring's heartbeat arrival inside the script-free sandbox. */
@keyframes sp-beat-arrive {
  0% { transform: scale(1, 0); opacity: 0; filter: brightness(1.6); }
  60% { transform: scale(1.2, 1.25); opacity: 1; filter: brightness(1.35); }
  100% { transform: scale(1, 1); filter: none; }
}
.sp-beat--new {
  transform-origin: center bottom;
  animation: sp-beat-arrive 0.7s cubic-bezier(0.2, 0.8, 0.3, 1.2) both;
}
/* Independent scale composes with arrival's transform, even on the newest bar.
   Keep touch strips steady and honour reduced motion for hover as well. */
@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {
  .sp-beat { transition: scale 160ms ease; }
  .sp-beat:hover { scale: 1.3 1.55; }
}
.sp-response { display: block; height: 64px; border-radius: 6px; background: var(--sp-surface-soft); }
.sp-response-area { fill: var(--sp-page-accent, var(--sp-accent)); fill-opacity: 0.12; stroke: none; }
.sp-response-line { fill: none; stroke: var(--sp-page-accent, var(--sp-accent)); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.sp-response-point { fill: var(--sp-page-accent, var(--sp-accent)); }
.sp-response-grid { stroke: var(--sp-border); stroke-width: 0.5; vector-effect: non-scaling-stroke; }
.sp-response-empty { display: grid; place-items: center; color: var(--sp-text-muted); font-size: 12px; }
.sp-axis { display: flex; justify-content: space-between; margin: 3px 0 0 72px; color: var(--sp-text-faint); font-size: 10px; }
details.sp-row[open] > summary .sp-axis { display: none; }

.sp-stats { display: flex; flex-wrap: wrap; gap: 14px 24px; min-width: 0; margin-left: 22px; font-size: 12px; }
.sp-stat { display: grid; align-content: start; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.sp-stats dt { color: var(--sp-text-muted); }
.sp-stats dd { margin: 0; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }

.sp-log, .sp-past { margin-top: 16px; overflow: hidden; border: 1px solid var(--sp-border); border-radius: var(--nm-radius-lg); background: var(--sp-surface); box-shadow: var(--sp-card-shadow); }
.sp-section-title { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 18px; font-size: var(--nm-text-lg); font-weight: 600; background: var(--nm-panel-head-bg); color: var(--nm-panel-head-text); }
.sp-section-title::before { content: "\\25B8"; width: 12px; flex: none; color: var(--nm-panel-head-muted); font-size: 12px; }
details[open] > .sp-section-title::before { content: "\\25BE"; }
details[open] > .sp-section-title { border-bottom: 1px solid var(--sp-border); }
.sp-section-heading { font: inherit; }
.sp-section-count { margin-left: auto; color: var(--nm-panel-head-muted); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.sp-incident { padding: 16px 18px; overflow-wrap: anywhere; }
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

export function builtinStyles(scheme: StatusColorScheme, darkStyle: DarkStyle = "slate"): string {
  return statusThemeCss(scheme, darkStyle) + STATUS_TOKENS + BASE_STYLES;
}

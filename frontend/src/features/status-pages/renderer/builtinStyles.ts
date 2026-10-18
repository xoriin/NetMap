export const RENDERER_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

const LIGHT_TOKENS = `
:root {
  color-scheme: light;
  --sp-bg: #e8eef3;
  --sp-surface: #f9fbfd;
  --sp-surface-soft: #eef4f8;
  --sp-row-hover: #e7edf2;
  --sp-border: rgba(123, 143, 161, 0.34);
  --sp-text: #111827;
  --sp-text-muted: #5d6b7a;
  --sp-text-faint: #8a97a7;
  --sp-accent: #1d9ab0;
  --sp-success: #2d9d78;
  --sp-success-soft: rgba(45, 157, 120, 0.12);
  --sp-warning: #d4912c;
  --sp-warning-text: #7a5000;
  --sp-warning-soft: rgba(212, 145, 44, 0.12);
  --sp-danger: #d94b4b;
  --sp-danger-soft: rgba(217, 75, 75, 0.1);
  --sp-maintenance: #7c5cbf;
  --sp-maintenance-soft: rgba(124, 92, 191, 0.1);
  --sp-info-text: #1d6472;
  --sp-info-soft: rgba(29, 154, 176, 0.12);
  --sp-beat-healthy: #2dba7c;
  --sp-beat-unhealthy: #d94b4b;
  --sp-beat-unknown: #8a97a7;
  --sp-beat-maintenance: #7c5cbf;
}
`;

const DARK_TOKENS = `
:root {
  color-scheme: dark;
  --sp-bg: #0c1118;
  --sp-surface: #131e28;
  --sp-surface-soft: #111a22;
  --sp-row-hover: #111c28;
  --sp-border: #1e2e3c;
  --sp-text: #d7e2ea;
  --sp-text-muted: #8ab0c8;
  --sp-text-faint: #5a7a95;
  --sp-accent: #22c0cf;
  --sp-success-soft: rgba(45, 157, 120, 0.15);
  --sp-warning-text: #e8b040;
  --sp-warning-soft: rgba(212, 145, 44, 0.15);
  --sp-danger-soft: rgba(217, 75, 75, 0.15);
  --sp-maintenance: #a78bfa;
  --sp-maintenance-soft: rgba(124, 92, 191, 0.12);
  --sp-info-text: #55d6e1;
  --sp-info-soft: rgba(34, 192, 207, 0.12);
  --sp-beat-unknown: #4d6a82;
  --sp-beat-maintenance: #a78bfa;
}
`;

const BASE_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--sp-bg);
  color: var(--sp-text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.45;
}
h1, h2, h3, p, ol, ul, dl { margin: 0; }
a { color: var(--sp-page-accent, var(--sp-accent)); }
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary:focus-visible { outline: 2px solid var(--sp-page-accent, var(--sp-accent)); outline-offset: -2px; }

.sp-page { max-width: 1040px; margin: 0 auto; padding: 28px 20px 48px; }

.sp-header { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; min-width: 0; }
.sp-logo { width: 44px; height: 44px; flex: none; border-radius: 10px; object-fit: contain; }
.sp-title { min-width: 0; font-size: 22px; font-weight: 600; line-height: 1.25; overflow-wrap: anywhere; }

.sp-summary {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
  margin-bottom: 8px; padding: 12px 18px;
  border: 1px solid var(--sp-border); border-radius: 10px; background: var(--sp-surface);
}
.sp-summary-dot { width: 12px; height: 12px; flex: none; border-radius: 50%; background: var(--sp-text-faint); }
.sp-summary[data-state="operational"] .sp-summary-dot { background: var(--sp-success); }
.sp-summary[data-state="affected"] .sp-summary-dot { background: var(--sp-warning); }
.sp-summary[data-state="major"] .sp-summary-dot { background: var(--sp-danger); }
.sp-summary[data-state="maintenance"] .sp-summary-dot { background: var(--sp-maintenance); }
.sp-summary-label { font-size: 15px; font-weight: 600; }
.sp-summary-counts { color: var(--sp-text-muted); font-size: 12px; }

.sp-strip {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px;
  margin-bottom: 6px; padding: 8px 18px;
  border: 1px solid var(--sp-border); border-radius: 8px; background: var(--sp-surface-soft);
  font-size: 13px; overflow-wrap: anywhere;
}
.sp-strip-title { font-weight: 600; }
.sp-strip-body, .sp-strip-meta { color: var(--sp-text-muted); }
.sp-strip-meta { font-size: 12px; }
.sp-strip a { margin-left: auto; font-size: 12px; white-space: nowrap; }

.sp-pill {
  display: inline-block; flex: none; padding: 1px 8px;
  border: 1px solid transparent; border-radius: 999px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap;
}
.sp-pill[data-tone="danger"] { color: var(--sp-danger); background: var(--sp-danger-soft); border-color: rgba(217, 75, 75, 0.35); }
.sp-pill[data-tone="warning"] { color: var(--sp-warning-text); background: var(--sp-warning-soft); border-color: rgba(212, 145, 44, 0.35); }
.sp-pill[data-tone="info"] { color: var(--sp-info-text); background: var(--sp-info-soft); border-color: rgba(29, 154, 176, 0.3); }
.sp-pill[data-tone="maintenance"] { color: var(--sp-maintenance); background: var(--sp-maintenance-soft); border-color: rgba(124, 92, 191, 0.35); }
.sp-pill[data-tone="neutral"] { color: var(--sp-text-muted); background: var(--sp-surface-soft); border-color: var(--sp-border); }

.sp-groups { display: grid; gap: 16px; margin-top: 14px; }
.sp-group { overflow: hidden; border: 1px solid var(--sp-border); border-radius: 10px; background: var(--sp-surface); }
.sp-group-name { display: flex; align-items: center; gap: 10px; padding: 12px 20px; font-weight: 600; }
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
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr); gap: 6px 18px; padding: 12px 20px;
}
.sp-row-main { align-items: center; }
.sp-row-more { align-items: start; padding-top: 0; }
summary.sp-row-main:hover { background: var(--sp-row-hover); }
.sp-ident { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sp-caret { width: 12px; flex: none; color: var(--sp-text-muted); font-size: 12px; }
details.sp-row > summary .sp-caret::before { content: "\\25B8"; }
details.sp-row[open] > summary .sp-caret::before { content: "\\25BE"; }
.sp-uptime {
  flex: none; min-width: 54px; padding: 2px 7px; border-radius: 999px; text-align: center; white-space: nowrap;
  font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
  color: var(--sp-text-muted); background: var(--sp-surface-soft);
}
.sp-uptime[data-tone="good"] { color: var(--sp-success); background: var(--sp-success-soft); }
.sp-uptime[data-tone="warning"] { color: var(--sp-warning-text); background: var(--sp-warning-soft); }
.sp-uptime[data-tone="danger"] { color: var(--sp-danger); background: var(--sp-danger-soft); }
.sp-row-name { min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
.sp-state { margin-left: auto; font-size: 12px; font-weight: 600; white-space: nowrap; color: var(--sp-text-muted); }
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
.sp-heartbeats { display: flex; gap: 2px; }
.sp-beat { flex: 1 1 0; min-width: 0; border-radius: 2px; background: var(--sp-beat-unknown); }
.sp-beat--healthy { background: var(--sp-beat-healthy); }
.sp-beat--unhealthy { background: var(--sp-beat-unhealthy); }
.sp-beat--unknown { background: var(--sp-beat-unknown); }
.sp-beat--maintenance { background: var(--sp-beat-maintenance); }
.sp-response { display: block; border-radius: 3px; background: var(--sp-surface-soft); }
.sp-response-area { fill: var(--sp-page-accent, var(--sp-accent)); fill-opacity: 0.18; stroke: none; }
.sp-response-line { fill: none; stroke: var(--sp-page-accent, var(--sp-accent)); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.sp-axis { display: flex; justify-content: space-between; margin: 3px 0 0 72px; color: var(--sp-text-faint); font-size: 10px; }
details.sp-row[open] > summary .sp-axis { display: none; }

.sp-stats { display: grid; grid-template-columns: auto auto; gap: 3px 14px; width: max-content; max-width: 100%; margin-left: 22px; font-size: 12px; }
.sp-stats dt { color: var(--sp-text-muted); }
.sp-stats dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }

.sp-log, .sp-past { margin-top: 16px; overflow: hidden; border: 1px solid var(--sp-border); border-radius: 10px; background: var(--sp-surface); }
.sp-section-title { display: flex; align-items: center; gap: 10px; padding: 12px 20px; font-size: 14px; font-weight: 600; }
.sp-section-title::before { content: "\\25B8"; width: 12px; flex: none; color: var(--sp-text-muted); font-size: 12px; }
details[open] > .sp-section-title::before { content: "\\25BE"; }
details[open] > .sp-section-title { border-bottom: 1px solid var(--sp-border); }
.sp-section-heading { font: inherit; }
.sp-section-count { margin-left: auto; color: var(--sp-text-muted); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.sp-incident { padding: 12px 20px; overflow-wrap: anywhere; }
.sp-incident + .sp-incident { border-top: 1px solid var(--sp-border); }
.sp-incident-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.sp-incident-meta { margin: 4px 0 8px; color: var(--sp-text-muted); font-size: 12px; }
.sp-updates { padding: 0 0 0 14px; list-style: none; border-left: 2px solid var(--sp-border); }
.sp-update { padding: 0 0 8px 10px; }
.sp-update-time { margin-right: 6px; color: var(--sp-text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.sp-update-author { margin-right: 6px; font-size: 11px; font-weight: 600; color: var(--sp-text-muted); }
.sp-update-internal, .sp-update-status { margin-right: 6px; }
.sp-update-status { font-size: 12px; font-weight: 600; }
.sp-update[data-internal="true"] .sp-update-text { color: var(--sp-text-muted); }

@media (max-width: 640px) {
  .sp-page { padding: 16px 12px 32px; }
  .sp-title { font-size: 19px; }
  .sp-summary, .sp-strip { padding-left: 14px; padding-right: 14px; }
  .sp-group-name, .sp-row-main, .sp-row-more, .sp-group-empty, .sp-incident, .sp-section-title { padding-left: 14px; padding-right: 14px; }
  .sp-row-main, .sp-row-more { grid-template-columns: minmax(0, 1fr); }
  .sp-row-more .sp-graphs { order: -1; }
  .sp-lane-label { display: none; }
  .sp-axis { margin-left: 0; }
  .sp-heartbeats { gap: 1px; }
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

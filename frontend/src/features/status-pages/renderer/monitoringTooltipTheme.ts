import type { StatusColorScheme } from "./builtinStyles";

const classes = new Set([
  ".hb-tooltip-card", ".hb-tooltip-header", ".hb-tooltip-date", ".hb-tooltip-time",
  ".hb-tooltip-status-row", ".hb-tooltip-status-text", ".hb-tooltip-rtt", ".hb-tooltip-ports",
]);
const beats = new Map([
  [".heartbeat-bar--lg .heartbeat-beat", ".sp-beat"],
  [".heartbeat-bar--lg.has-active .heartbeat-beat", ".sp-heartbeats.has-active .sp-beat"],
  [".heartbeat-bar--lg .heartbeat-beat.is-active", ".sp-beat.is-active"],
  [".heartbeat-bar--lg .heartbeat-beat.is-pinned", ".sp-beat.is-pinned"],
  [".heartbeat-bar--lg .heartbeat-beat.is-new", ".sp-beat--new"],
]);
let cached: { base: string; dark: string } | undefined;

/** The sandbox cannot inherit app CSS. Adapt only Monitoring's existing tooltip
 * and heartbeat primitives, so appearance and motion have one shared owner. */
export function monitoringTooltipTheme(scheme: StatusColorScheme): string {
  if (!cached) {
    const base: string[] = [], dark: string[] = [];
    const visit = (sheet: CSSStyleSheet) => {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { return; }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSImportRule && rule.styleSheet) visit(rule.styleSheet);
        if (rule instanceof CSSKeyframesRule && rule.name === "hb-arrive") base.push(rule.cssText);
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const selector of rule.selectorText.split(",").map(value => value.trim())) {
          const plain = selector.replace(/^body\.theme-dark /, "");
          const mapped = beats.get(plain) ?? (classes.has(plain) ? plain : null);
          if (!mapped) continue;
          const css = `${mapped}{${rule.style.cssText}}`;
          (selector === plain ? base : dark).push(css);
        }
      }
    };
    Array.from(document.styleSheets).forEach(visit);
    cached = { base: base.join(""), dark: dark.join("") };
  }
  return cached.base + (scheme === "dark" ? cached.dark : scheme === null ? `@media(prefers-color-scheme:dark){${cached.dark}}` : "");
}

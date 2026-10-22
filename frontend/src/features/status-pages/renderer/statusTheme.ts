import type { DarkStyle } from "../../../providers/ThemeProvider";
import inter400 from "@fontsource/inter/files/inter-latin-400-normal.woff2?inline";
import inter500 from "@fontsource/inter/files/inter-latin-500-normal.woff2?inline";
import inter600 from "@fontsource/inter/files/inter-latin-600-normal.woff2?inline";

type Palette = Map<string, string>;
let palettes: { light: Palette; slate: Palette; zinc: Palette } | undefined;

// The sandbox cannot inherit its parent's CSS. Copy only canonical token
// declarations, never application selectors, credentials, or custom page CSS.
function canonicalPalettes() {
  if (palettes) return palettes;
  const light: Palette = new Map();
  const slate: Palette = new Map();
  const zinc: Palette = new Map();
  const visit = (sheet: CSSStyleSheet) => {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { return; } // Cross-origin font sheets.
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule && rule.styleSheet) visit(rule.styleSheet);
      if (!(rule instanceof CSSStyleRule)) continue;
      const selectors = rule.selectorText.split(",").map(value => value.trim());
      const target = selectors.includes(":root") ? light
        : selectors.includes("body.theme-dark.theme-dark-zinc") ? zinc
          : selectors.includes("body.theme-dark") ? slate : null;
      if (!target) continue;
      for (const name of Array.from(rule.style)) {
        if (name.startsWith("--nm-") || name === "font-family") {
          target.set(name, rule.style.getPropertyValue(name));
        }
      }
    }
  };
  Array.from(document.styleSheets).forEach(visit);
  palettes = { light, slate, zinc };
  return palettes;
}

function root(palette: Palette) {
  const css = `:root{${Array.from(palette, ([name, value]) => `${name}:${value};`).join("")}}`;
  if (css.includes("<")) throw new Error("Invalid status theme tokens");
  return css;
}

export function statusThemeCss(scheme: "light" | "dark" | null, darkStyle: DarkStyle): string {
  const { light, slate, zinc } = canonicalPalettes();
  const dark = root(slate) + (darkStyle === "zinc" ? root(zinc) : "") + ":root{color-scheme:dark;}";
  const colours = root(light) + ":root{color-scheme:light;}" + (scheme === "dark" ? dark
    : scheme === null ? `@media(prefers-color-scheme:dark){${dark}}` : "");
  // Data fonts preserve the existing no-network, script-free frame CSP.
  const fonts = [[400, inter400], [500, inter500], [600, inter600]]
    .map(([weight, data]) => `@font-face{font-family:Inter;font-style:normal;font-weight:${weight};font-display:swap;src:url(${data}) format('woff2');}`)
    .join("");
  return fonts + colours;
}

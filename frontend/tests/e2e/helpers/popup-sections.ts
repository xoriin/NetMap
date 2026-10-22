import { expect, type Locator, type Page } from "@playwright/test";

type Theme = "light" | "dark";

/** Computed colours of a `.mon-hero-section` card before its literals moved onto tokens. */
export const POPUP_SECTION_COLOURS = {
  light: {
    sectionBackground: "rgb(254, 254, 254)", sectionBorder: "rgb(216, 220, 225)",
    titleColor: "rgb(58, 84, 104)", titleBackground: "rgb(238, 241, 244)", titleBorder: "rgb(216, 220, 225)",
    rowBorder: "rgba(209, 220, 230, 0.4)",
  },
  dark: {
    sectionBackground: "rgb(22, 32, 51)", sectionBorder: "rgb(51, 65, 85)",
    titleColor: "rgb(148, 163, 184)", titleBackground: "rgb(29, 37, 54)", titleBorder: "rgb(51, 65, 85)",
    rowBorder: "rgba(51, 65, 85, 0.7)",
  },
};

export const POPUP_HEADER_COLOURS = {
  light: { headerBackground: "rgb(47, 68, 91)", headerBorder: "rgb(24, 40, 58)" },
  dark: { headerBackground: "rgb(22, 32, 51)", headerBorder: "rgb(51, 65, 85)" },
};

const SECTION_TOKENS = {
  sectionBackground: "--nm-popup-section-bg",
  sectionBorder: "--nm-popup-section-border",
  titleColor: "--nm-popup-section-title",
  titleBackground: "--nm-popup-section-title-bg",
  titleBorder: "--nm-popup-section-title-border",
  rowBorder: "--nm-popup-divider",
};

const HEADER_TOKENS = {
  light: { headerBackground: "--nm-panel-head-bg", headerBorder: "--nm-panel-head-border" },
  dark: { headerBackground: "--nm-popup-section-bg", headerBorder: "--nm-popup-section-border" },
};

/** The rules that paint popup sections and the popup header; every colour in them must be a token. */
const TOKENISED_SELECTORS = [
  ".mon-hero-header", "body.theme-dark .mon-hero-header", "body:not(.theme-dark) .mon-hero-header",
  ".mon-hero-section", "body.theme-dark .mon-hero-section",
  ".mon-hero-section-title", "body.theme-dark .mon-hero-section-title",
  ".mon-analysis-row:not(:last-child)", "body.theme-dark .mon-analysis-row",
];

function resolveTokens(node: Element, tokens: Record<string, string>) {
  const probe = document.createElement("div");
  node.appendChild(probe);
  const out: Record<string, string | null> = {};
  for (const [key, name] of Object.entries(tokens)) {
    probe.style.color = "";
    probe.style.color = getComputedStyle(node).getPropertyValue(name).trim();
    out[key] = probe.style.color ? getComputedStyle(probe).color : null;
  }
  probe.remove();
  return out;
}

export async function expectPopupSectionColours(section: Locator, theme: Theme) {
  const { values, tokens } = await section.evaluate((node, [tokenMap, resolverSource]) => {
    const resolve = new Function(`return (${resolverSource})`)() as typeof resolveTokens;
    const s = getComputedStyle(node);
    const t = getComputedStyle(node.querySelector(".mon-hero-section-title")!);
    const r = getComputedStyle(node.querySelector(".mon-analysis-row")!);
    return {
      values: {
        sectionBackground: s.backgroundColor, sectionBorder: s.borderTopColor,
        titleColor: t.color, titleBackground: t.backgroundColor, titleBorder: t.borderBottomColor,
        rowBorder: r.borderBottomColor,
      },
      tokens: resolve(node, tokenMap),
    };
  }, [SECTION_TOKENS, resolveTokens.toString()] as const);
  expect(values).toEqual(POPUP_SECTION_COLOURS[theme]);
  expect(tokens).toEqual(values);
}

export async function expectPopupHeaderColours(header: Locator, theme: Theme) {
  const { values, tokens } = await header.evaluate((node, [tokenMap, resolverSource]) => {
    const resolve = new Function(`return (${resolverSource})`)() as typeof resolveTokens;
    const h = getComputedStyle(node);
    return {
      values: { headerBackground: h.backgroundColor, headerBorder: h.borderBottomColor },
      tokens: resolve(node, tokenMap),
    };
  }, [HEADER_TOKENS[theme], resolveTokens.toString()] as const);
  expect(values).toEqual(POPUP_HEADER_COLOURS[theme]);
  expect(tokens).toEqual(values);
}

/** Fails when a raw hex or rgb()/rgba() colour comes back into any popup section rule. */
export async function expectPopupRulesUseTokens(page: Page) {
  const found = await page.evaluate((selectors) => {
    const hits: Record<string, string[]> = {};
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          const parts = rule.selectorText.split(",").map((part) => part.trim());
          for (const selector of selectors) {
            if (parts.includes(selector)) (hits[selector] ??= []).push(rule.style.cssText);
          }
        } else if ("cssRules" in rule) {
          walk((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { walk(sheet.cssRules); } catch { /* cross-origin sheet */ }
    }
    return hits;
  }, TOKENISED_SELECTORS);
  expect(Object.keys(found).sort()).toEqual([...TOKENISED_SELECTORS].sort());
  const literals = Object.entries(found)
    .flatMap(([selector, texts]) => texts.map((text) => ({ selector, text })))
    // `transparent` is serialised as rgba(0, 0, 0, 0); it is not a palette colour.
    .filter(({ text }) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(text.replaceAll("rgba(0, 0, 0, 0)", "")));
  expect(literals).toEqual([]);
}

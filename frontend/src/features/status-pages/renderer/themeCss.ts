import type { StatusColorScheme } from "./builtinStyles";

// A srcdoc frame can keep evaluating media queries against the OS even when the
// visitor explicitly selected another theme. Resolve only that media feature;
// leave viewport, motion and all other conditions to the browser.
export function themeCss(css: string, scheme: StatusColorScheme): string {
  if (!scheme || !/prefers-color-scheme/i.test(css)) return css;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        rule.media.mediaText = rule.media.mediaText.replace(
          /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi,
          (_, value: string) => value.toLowerCase() === scheme ? "(min-width: 0px)" : "(max-width: -1px)",
        );
      }
      if ("cssRules" in rule) visit(rule.cssRules as CSSRuleList);
    }
  };
  visit(sheet.cssRules);
  const result = Array.from(sheet.cssRules, rule => rule.cssText).join("\n");
  // CSSOM serialisation must never introduce an HTML delimiter into srcdoc.
  return result.includes("<") ? css : result;
}

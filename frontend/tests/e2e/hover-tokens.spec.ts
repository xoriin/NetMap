import { expect, test, type Page } from "@playwright/test";
import { setupCoreMocks, setupTopologyMocks } from "./helpers/api-mocks";

const RAW_TEAL = /rgba\(\s*29\s*,\s*154\s*,\s*176|#1d9ab0|#4db8cc/i;

async function hoverRules(page: Page) {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await page.goto("/overview");
  await page.locator(".app-topbar").waitFor();
  return page.evaluate(() => {
    const rules: { selector: string; css: string }[] = [];
    const walk = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if ("cssRules" in rule && !(rule instanceof CSSStyleRule)) walk((rule as CSSGroupingRule).cssRules);
        else if (rule instanceof CSSStyleRule && rule.selectorText.includes(":hover")) rules.push({ selector: rule.selectorText.replace(/\s+/g, " "), css: rule.style.cssText });
      }
    };
    for (const sheet of Array.from(document.styleSheets)) { try { walk(sheet.cssRules); } catch { /* cross-origin */ } }
    return rules;
  });
}

function rawTealIn(rules: { selector: string; css: string }[], classes: string[]) {
  return rules.filter((rule) => classes.some((name) => rule.selector.includes(name)) && RAW_TEAL.test(rule.css)).map((rule) => rule.selector);
}

const AREAS: [string, string[]][] = [
  ["Inventory, VLAN and IPAM buttons", [".inv-action-btn", ".vlan-action-btn", ".ipam-btn", ".inventory-bulk-edit"]],
  ["Monitoring and Topology toolbar buttons", [".toolbar-btn", ".topology-toolbar-right", ".topo-stat-btn"]],
  ["Admin, Tools, sign-in and empty-state buttons", [".notif-test-btn", ".tool-form", ".auth-sso-btn", ".dash-empty-action"]],
  ["rows and list items", [".loc-item", ".notif-method-card", ".inventory-row:hover", ".security-row-group"]],
  ["tabs and navigation", [".inv-filter-tab", ".tools-nav-item", ".admin-tab-btn", ".auth-forgot-link", ".notif-apprise-details", ".dash-nav-btn"]],
  ["sidebar links and controls", [".sidebar-link", ".sidebar-admin-link", ".sidebar-collapse-btn--footer"]],
  ["drag handles, scrollbars and drop zones", [".mon-col-resize-handle", ".inventory-col-resize-handle", ".inventory-table::-webkit-scrollbar-thumb", ".import-dropzone"]],
];

for (const [area, classes] of AREAS) {
  test(`${area} hover with theme tokens, not raw teal`, async ({ page }) => {
    expect(rawTealIn(await hoverRules(page), classes)).toEqual([]);
  });
}

test("no hover rule uses raw teal except the shared tone glows", async ({ page }) => {
  const glows = [".dash-stat--teal", ".overview-nav-card", ".topo-entity-row"];
  const offenders = (await hoverRules(page)).filter((rule) => RAW_TEAL.test(rule.css) && !glows.some((name) => rule.selector.includes(name)));
  expect(offenders.map((rule) => rule.selector)).toEqual([]);
});

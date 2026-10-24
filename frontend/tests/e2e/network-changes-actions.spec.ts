import { expect, test, type Page } from "@playwright/test";
import { setupCoreMocks, setupInventoryMocks, setupMonitoringMocks, setupTopologyMocks } from "./helpers/api-mocks";

async function setup(page: Page, style: "light" | "slate" | "zinc") {
  await setupCoreMocks(page);
  await setupTopologyMocks(page);
  await setupInventoryMocks(page);
  await setupMonitoringMocks(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(style => {
    localStorage.setItem("netmap.theme", style === "light" ? "light" : "dark");
    localStorage.setItem("netmap.dark_style", style === "zinc" ? "zinc" : "slate");
  }, style);
}

for (const style of ["light", "slate", "zinc"] as const) {
  test(`network change actions use shared semantic buttons in ${style}`, async ({ page }) => {
    await setup(page, style);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const observation = { id: 1, status: "open", observation_type: "field_change", ip_address: "192.168.1.3", hostname: "distribution-switch-with-a-long-name", mac_address: null, device_id: null, summary: "A scheduled scan detected a changed device hostname", details: {}, first_seen_at: "2026-10-22T09:00:00Z", last_seen_at: "2026-10-22T09:00:00Z" };
    let fail = true;
    const statuses: string[] = [];
    await page.route("**/api/v1/discovery/observations?*", route => route.fulfill({ json: [observation] }));
    await page.route("**/api/v1/discovery/observations/1", route => {
      if (fail) return route.fulfill({ status: 500, json: { detail: "Could not update this change" } });
      observation.status = route.request().postDataJSON().status;
      statuses.push(observation.status);
      return route.fulfill({ json: observation });
    });
    await page.goto("/overview");
    if (style === "light") await expect(page.locator("body")).not.toHaveClass(/theme-dark/);
    else await expect(page.locator("body")).toHaveClass(style === "zinc" ? /theme-dark-zinc/ : /theme-dark/);
    const canonical = await page.evaluate(() => {
      const result: Record<string, Record<string, string>> = {};
      for (const variant of ["success", "danger"]) {
        const button = document.createElement("button");
        button.className = `nm-btn nm-btn--${variant}`;
        button.textContent = variant;
        document.body.append(button);
        const css = getComputedStyle(button);
        result[variant] = Object.fromEntries(["background-color", "border-top-color", "color", "border-radius", "height"].map(key => [key, css.getPropertyValue(key)]));
        button.disabled = true;
        result[variant].disabledOpacity = getComputedStyle(button).opacity;
        button.remove();
      }
      return result;
    });
    expect(canonical.success.disabledOpacity).toBe("0.45");
    await page.locator(".dash-alert--changes .dash-alert-link").click();
    const dialog = page.getByRole("dialog", { name: "Network changes", exact: true });
    const acknowledge = dialog.getByRole("button", { name: "Acknowledge", exact: true });
    const clear = dialog.getByRole("button", { name: "Clear", exact: true });
    await expect(dialog.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
    for (const [button, variant] of [[acknowledge, "success"], [clear, "danger"]] as const) {
      await expect(button).toHaveClass(new RegExp(`nm-btn--${variant}`));
      for (const [property, value] of Object.entries(canonical[variant]).filter(([property]) => property !== "disabledOpacity")) await expect(button).toHaveCSS(property, value);
      const measure = () => button.evaluate(node => {
        const context = document.createElement("canvas").getContext("2d")!;
        const rgba = (value: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return Array.from(context.getImageData(0, 0, 1, 1).data).map((value, index) => index === 3 ? value / 255 : value); };
        const over = (fg: number[], bg: number[]) => [0, 1, 2].map(index => fg[index] * fg[3] + bg[index] * (1 - fg[3])).concat(1);
        const ancestors: Element[] = [];
        for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.unshift(parent);
        let surface = [255, 255, 255, 1];
        for (const parent of ancestors) surface = over(rgba(getComputedStyle(parent).backgroundColor), surface);
        const css = getComputedStyle(node), bg = over(rgba(css.backgroundColor), surface), fg = over(rgba(css.color), bg);
        const luminance = (values: number[]) => values.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
        const a = luminance(fg), b = luminance(bg);
        return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), fg, bg };
      });
      const contrast = await measure();
      expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
      // Pin the richer fills independently of the shared owner comparison.
      const fills = {
        light: { success: [187, 223, 211], danger: [242, 197, 197] },
        slate: { success: [25, 66, 67], danger: [80, 40, 53] },
        zinc: { success: [31, 67, 57], danger: [86, 40, 42] },
      };
      contrast.bg.slice(0, 3).forEach((channel, index) => expect(Math.abs(channel - fills[style][variant][index])).toBeLessThanOrEqual(1));
      if (variant === "success") { expect(contrast.fg[1]).toBeGreaterThan(contrast.fg[0]); expect(contrast.fg[1]).toBeGreaterThan(contrast.fg[2]); }
      const fill = await button.evaluate(node => getComputedStyle(node).backgroundColor);
      await button.hover();
      await expect.poll(() => button.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(fill);
      expect((await measure()).ratio).toBeGreaterThanOrEqual(4.5);
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await button.focus();
      await expect(button).toBeFocused();
      expect(await button.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe("none");
    }
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const button of [acknowledge, clear]) {
        const box = await button.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: test.info().outputPath(`${style}-${width}.png`) });
    }
    await acknowledge.click();
    await expect(dialog.locator(".error-banner")).toContainText("Could not update this change");
    await expect(acknowledge).toBeVisible();
    fail = false;
    await acknowledge.click();
    await expect(dialog.locator(".obs-row-acked")).toHaveText("Acknowledged");
    await expect(acknowledge).toHaveCount(0);
    await clear.click();
    await expect(dialog).toContainText("All network changes have been cleared.");
    expect(statuses).toEqual(["acknowledged", "resolved"]);
    expect(errors).toEqual([]);
  });
}

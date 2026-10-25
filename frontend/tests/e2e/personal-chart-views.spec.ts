import { expect, test, type Page } from '@playwright/test';
import { mockDevice, setupCoreMocks, setupTopologyMocks, setupMonitoringMocks } from './helpers/api-mocks';

async function boot(page: Page, theme = 'slate') {
  await page.route('**/api/v1/**', route => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, [
    mockDevice({ id: 1, hostname: 'Long Core Router Name', device_type: 'router', site_id: 1, topology_group: 'Servers' }),
    mockDevice({ id: 2, hostname: 'Storage', device_type: 'server' }),
    mockDevice({ id: 3, hostname: 'AP', device_type: 'access_point' }),
  ], []);
  await setupMonitoringMocks(page);
  await page.route("**/api/v1/topology/sites*", route => route.fulfill({ json: [{ id: 1, name: "HQ", display_name: "Headquarters", color: null, description: "", address: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] }));
  await page.route("**/api/v1/topology/groups*", route => route.fulfill({ json: [{ id: 1, name: "Servers", vlan_id: "20", ip_range: "10.0.0.0/24", gateway: null, dns_servers: null, description: "", color: null }] }));
  let views: Record<string, unknown> = {};
  let failSave = false;
  await page.route('**/api/v1/auth/me/chart-views**', async route => {
    const request = route.request(), id = new URL(request.url()).pathname.split('/chart-views/')[1];
    if (request.method() === 'GET') return route.fulfill({ json: views });
    if (failSave) return route.fulfill({ status: 503, json: { detail: 'Unavailable' } });
    if (request.method() === 'DELETE') { if (id) delete views[id]; else views = {}; return route.fulfill({ status: 204 }); }
    views[id] = request.postDataJSON();
    return route.fulfill({ json: views[id] });
  });
  await page.addInitScript(theme => { localStorage.setItem('netmap.theme', theme === 'light' ? 'light' : 'dark'); localStorage.setItem('netmap.dark_style', theme === 'zinc' ? 'zinc' : 'slate'); }, theme);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  return { fail: (value: boolean) => { failSave = value; }, views: () => views };
}

async function place(chart: ReturnType<Page['locator']>, element: string, other: string, position: string) {
  const word = { top: 'above', bottom: 'below', left: 'left of', right: 'right of' }[position];
  await chart.getByRole('button', { name: `Place ${element} ${word} ${other}`, exact: true }).click();
}

for (const theme of ['light', 'slate', 'zinc']) {
  test(`personal chart gallery fills panels and remembers settings in ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await boot(page, theme);
    await page.goto('/inventory');
    const chart = page.locator('[data-chart-id="inventory.device-types"]');
    const trigger = page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true });
    await expect(trigger).toBeEnabled();
    await expect(trigger).toHaveText('');
    await trigger.click();
    const options = chart.getByRole('region', { name: 'Visual options: Devices per device type', exact: true });
    await expect(options.getByRole('group', { name: 'Visual type' }).getByRole('button')).toHaveCount(12);
    for (const visual of ['Ring', 'Pie', 'Bars', 'Columns', 'Stacked bar', 'Line', 'Area', 'Dot plot', 'Treemap', 'Gauge', 'Number', 'Data table']) {
      await options.getByRole('button', { name: visual, exact: true }).click();
      await expect(options.getByRole('button', { name: visual, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(chart.locator('.nm-personal-renderer, .nm-chart-composition').first()).toBeVisible();
    }
    await options.getByRole('button', { name: 'Columns', exact: true }).click();
    await options.getByRole('button', { name: 'Save my view', exact: true }).click();
    await expect(options.getByRole('status')).toHaveText('My view saved');
    await page.reload();
    await expect(chart.locator('.nm-personal-plot')).toBeVisible();
    await trigger.click();
    await expect(options.getByRole('button', { name: 'Columns', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      await expect.poll(async () => chart.locator('.nm-personal-plot').evaluate(el => Math.abs(el.getBoundingClientRect().width - el.closest('[data-chart-element="chart"]')!.getBoundingClientRect().width))).toBeLessThan(1);
      const centers = await chart.locator('.nm-personal-plot').evaluate(svg => {
        const hits = [...svg.querySelectorAll<SVGRectElement>('.nm-chart-hit')];
        const left = Number(hits[0].getAttribute('x'));
        const last = hits.at(-1)!;
        return { left, right: Number(svg.getAttribute('width')) - Number(last.getAttribute('x')) - Number(last.getAttribute('width')) };
      });
      expect(Math.abs(centers.left - centers.right)).toBeLessThan(1);
      const alignment = await chart.locator('.nm-personal-plot').evaluate(svg => [...svg.querySelectorAll('g')].filter(g => g.querySelector('.nm-chart-hit')).map(g => { const hit = g.querySelector('rect')!, value = g.querySelector('text'); return value ? Math.abs(Number(value.getAttribute('x')) - Number(hit.getAttribute('x')) - Number(hit.getAttribute('width')) / 2) : 0; }));
      expect(alignment.every(offset => offset < 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`personal-${theme}-${width}.png`), fullPage: true });
    }
    await options.getByRole('button', { name: 'Reset this chart', exact: true }).click();
    await expect(chart.locator('.nm-donut-chart')).toBeVisible();
    await page.reload();
    await expect(chart.locator('.nm-donut-chart')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('save failures keep drafts; Cancel restores saved settings; Profile resets all charts', async ({ page }) => {
  const state = await boot(page);
  await page.goto('/inventory');
  const chart = page.locator('[data-chart-id="inventory.device-types"]');
  const trigger = page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true });
  await trigger.click();
  await chart.getByRole('button', { name: 'Pie', exact: true }).click();
  state.fail(true);
  await chart.getByRole('button', { name: 'Save my view', exact: true }).click();
  await expect(chart.getByRole('alert')).toContainText('Your changes are still here');
  await expect(chart.getByRole('button', { name: 'Pie', exact: true })).toHaveAttribute('aria-pressed', 'true');
  state.fail(false);
  await chart.getByRole('button', { name: 'Save my view', exact: true }).click();
  await chart.getByRole('button', { name: 'Bars', exact: true }).click();
  await chart.getByRole('button', { name: 'Cancel', exact: true }).click();
  await trigger.click();
  await expect(chart.getByRole('button', { name: 'Pie', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Reset all chart views', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'All charts restored' })).toBeVisible();
  expect(state.views()).toEqual({});
  await page.goto('/inventory');
  await expect(chart.locator('.nm-donut-chart')).toBeVisible();
});

test('shared chart controls are available across workspaces without changing chronological data', async ({ page }) => {
  await boot(page);
  for (const [url, id] of [
    ['/overview', 'overview.device-types'], ['/inventory', 'inventory.device-types'],
    ['/monitoring#devices', 'monitoring.fleet-health'], ['/monitoring#endpoints', 'monitoring.endpoint-response'],
    ['/locations', 'locations.devices'], ['/vlans', 'vlans.devices'], ['/tools', 'tools.recent-checks'],
  ]) {
    await page.goto(url);
    await expect(page.locator(`[data-chart-id="${id}"]`)).toBeVisible();
    const chart = page.locator(`[data-chart-id="${id}"]`);
    const panel = chart.locator('xpath=ancestor::*[contains(@class,"nm-app-panel")][1]');
    await expect(panel.getByRole('button', { name: /^Visual options:/ }).first()).toBeVisible();
  }
});

test('time series keep chronological order and multi-series values when switching visual', async ({ page }) => {
  await boot(page);
  const date = new Date().toISOString();
  await page.route('**/api/v1/alerts/deliveries*', route => route.fulfill({ json: [
    { id: 1, rule_name: 'Core down', target: 'profile:1', device_id: null, status: 'sent', sent_at: date, detail: 'ok' },
    { id: 2, rule_name: 'Core down', target: 'profile:1', device_id: null, status: 'failed', sent_at: date, detail: 'timeout' },
  ] }));
  await page.goto('/admin#alerts');
  const chart = page.locator('[data-chart-id="admin.alerts.deliveries"]');
  await page.getByRole('button', { name: /^Visual options: Alert notifications per day/ }).click();
  await expect(chart.getByRole('button', { name: 'Ring', exact: true })).toBeDisabled();
  await expect(chart.getByLabel('Order', { exact: true })).toBeDisabled();
  await chart.getByRole('button', { name: 'Data table', exact: true }).click();
  await expect(chart.locator('thead')).toContainText('Sent');
  await expect(chart.locator('thead')).toContainText('Failed');
  const values = await chart.locator('tbody tr').last().locator('td').allTextContents();
  expect(values.slice(1)).toEqual(['1', '1']);
  await chart.getByRole('button', { name: 'Area', exact: true }).click();
  await expect(chart.locator('.nm-chart-area')).toHaveCount(2);
  await chart.getByLabel('Show legend', { exact: true }).check();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const position of ['left', 'right', 'top', 'bottom']) {
      await place(chart, 'Legend', (await chart.getByRole('group', { name: 'Visual type', exact: true }).getByRole('button', { pressed: true }).textContent())!, position);
      await expect(chart.locator('.nm-chart-pair')).toHaveAttribute('data-legend-position', position);
      await expect.poll(() => chart.locator('.nm-personal-plot').evaluate(el => Math.abs(el.getBoundingClientRect().width - el.closest('[data-chart-element="chart"]')!.getBoundingClientRect().width))).toBeLessThan(1);
      await expect(chart.locator('.nm-chart-legend-label')).toHaveText(['Sent', 'Failed']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await chart.getByLabel('Show legend', { exact: true }).uncheck();
  await expect(chart.locator('.nm-chart-legend')).toHaveCount(0);
  await expect(chart.getByRole('group', { name: 'Arrangement', exact: true })).toHaveCount(0);
  await expect(chart.locator('.nm-chart-area')).toHaveCount(2);
});

test('failed preference loads offer retry and never overwrite saved choices', async ({ page }) => {
  await boot(page);
  let fail = true;
  await page.route('**/api/v1/auth/me/chart-views', route => fail ? route.fulfill({ status: 503, json: { detail: 'Unavailable' } }) : route.fulfill({ json: {} }));
  await page.goto('/inventory');
  const chart = page.locator('[data-chart-id="inventory.device-types"]');
  await page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true }).click();
  await expect(chart.getByRole('alert')).toContainText('Could not load your chart views');
  await expect(chart.getByRole('button', { name: 'Save my view', exact: true })).toBeDisabled();
  fail = false;
  await chart.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(chart.getByRole('alert')).toHaveCount(0);
  await expect(chart.getByRole('button', { name: 'Save my view', exact: true })).toBeEnabled();
});

test('pending saves keep feedback visible until the write completes', async ({ page }) => {
  await boot(page);
  let release: (() => void) | undefined;
  await page.route('**/api/v1/auth/me/chart-views/*', async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 503, json: { detail: 'Unavailable' } });
  });
  await page.goto('/inventory');
  const chart = page.locator('[data-chart-id="inventory.device-types"]');
  const trigger = page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true });
  await trigger.click();
  await chart.getByRole('button', { name: 'Pie', exact: true }).click();
  await chart.getByRole('button', { name: 'Save my view', exact: true }).click();
  await expect(trigger).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(chart.locator('.nm-chart-settings')).toBeVisible();
  await expect.poll(() => !!release).toBe(true);
  release!();
  await expect(chart.getByRole('alert')).toContainText('Your changes are still here');
  await expect(trigger).toBeEnabled();
});

test('display options persist independently of the chart form and reset to product defaults', async ({ page }) => {
  await boot(page);
  await page.goto('/inventory');
  const chart = page.locator('[data-chart-id="inventory.device-types"]');
  const trigger = page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true });
  await trigger.click();
  await chart.getByRole('button', { name: 'Ring', exact: true }).click();
  await chart.getByLabel('Show bars', { exact: true }).uncheck();
  await chart.getByLabel('Show legend', { exact: true }).check();
  await chart.getByLabel('Values', { exact: true }).selectOption('both');
  await place(chart, 'Legend', 'Ring', 'bottom');
  await chart.getByLabel('Order', { exact: true }).selectOption('name');
  await expect(chart.locator('.nm-chart-legend-label')).toHaveText(['Access_point', 'router', 'server']);
  await expect(chart.locator('.nm-chart-legend-pct')).toHaveText(['33%', '33%', '33%']);
  await chart.getByLabel('Show values', { exact: true }).uncheck();
  await chart.getByRole('button', { name: 'Save my view', exact: true }).click();
  await page.reload();
  await expect(chart.locator('.nm-personal-ring-layout--below')).toBeVisible();
  await expect(chart.locator('.nm-chart-legend strong')).toHaveCount(0);
  await trigger.click();
  await expect(chart.getByLabel('Values', { exact: true })).toHaveValue('both');
  await expect(chart.getByRole('button', { name: 'Place Legend below Ring', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.getByLabel('Show values', { exact: true })).not.toBeChecked();
  await chart.getByRole('button', { name: 'Reset this chart', exact: true }).click();
  await expect(chart.locator('.nm-bar-list strong')).toHaveCount(3);
});

for (const theme of ['light', 'slate', 'zinc']) {
  test(`selected bars retain default geometry in ${theme}`, async ({ page }) => {
    await boot(page, theme);
    await page.goto('/overview');
    const chart = page.locator('[data-chart-id="overview.device-types"]');
    const panel = chart.locator('xpath=ancestor::*[contains(@class,"nm-app-panel")][1]');
    const trigger = panel.getByRole('button', { name: /^Visual options:/ });
    for (const width of [1440, 820, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      const geometry = () => chart.evaluate(el => {
        const host = el.getBoundingClientRect();
        return [...el.querySelectorAll('.nm-bar-list-track')].map(track => {
          const box = track.getBoundingClientRect(), fill = track.firstElementChild!.getBoundingClientRect();
          return [box.x - host.x, box.y - host.y, box.width, box.height, fill.width];
        });
      });
      await expect(chart.locator('.nm-bar-list-track')).toHaveCount(3);
      const before = await geometry();
      await trigger.click();
      await chart.getByRole('button', { name: 'Bars', exact: true }).click();
      await chart.getByRole('button', { name: 'Save my view', exact: true }).click();
      await chart.getByRole('button', { name: 'Close visual options', exact: true }).click();
      const after = await geometry();
      expect(after).toHaveLength(before.length);
      after.forEach((row, i) => row.forEach((value, j) => expect(Math.abs(value - before[i][j])).toBeLessThan(1)));
      await chart.screenshot({ path: test.info().outputPath(`bars-${theme}-${width}.png`) });
      await trigger.click();
      await chart.getByRole('button', { name: 'Reset this chart', exact: true }).click();
      await chart.getByRole('button', { name: 'Close visual options', exact: true }).click();
    }
  });
}

test('canonical chart preview shows the shared personal controls', async ({ page }) => {
  test.skip(process.env.NETMAP_UI_PREVIEW_TESTS !== '1', 'Live Vite preview only');
  await boot(page);
  await page.goto('/theme-preview');
  const chart = page.locator('[data-chart-id="preview.personal-chart"]');
  await expect(chart).toBeVisible();
  await chart.scrollIntoViewIfNeeded();
  await chart.locator('xpath=ancestor::*[contains(@class,"nm-app-panel")][1]').screenshot({ path: test.info().outputPath('chart-preview.png') });
});

for (const theme of ['light', 'slate', 'zinc']) {
  test(`paired visuals support saved four-way legend placement in ${theme}`, async ({ page }) => {
    const state = await boot(page, theme);
    await page.goto('/inventory');
    const chart = page.locator('[data-chart-id="inventory.device-types"]');
    const trigger = page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true });
    await trigger.click();
    await chart.getByLabel('Show bars', { exact: true }).uncheck();
    await chart.getByLabel('Show legend', { exact: true }).check();
    for (const type of ['Ring', 'Pie', 'Stacked bar']) {
      await chart.getByRole('button', { name: type, exact: true }).click();
      for (const width of [1440, 820, 390]) {
        await page.setViewportSize({ width, height: 1050 });
        for (const position of ['top', 'bottom', 'left', 'right']) {
          await place(chart, 'Legend', (await chart.getByRole('group', { name: 'Visual type', exact: true }).getByRole('button', { pressed: true }).textContent())!, position);
          const pair = chart.locator('.nm-chart-pair');
          await expect(pair).toHaveAttribute('data-legend-position', position);
          const boxes = await pair.evaluate(el => {
            const visual = el.querySelector('.nm-chart-pair-visual')!.getBoundingClientRect();
            const legend = el.querySelector('.nm-chart-legend')!.getBoundingClientRect();
            return { vx: visual.x, vy: visual.y, vr: visual.right, vb: visual.bottom, lx: legend.x, ly: legend.y, lr: legend.right, lb: legend.bottom };
          });
          if (position === 'top') expect(boxes.lb).toBeLessThan(boxes.vy);
          if (position === 'bottom') expect(boxes.ly).toBeGreaterThan(boxes.vb);
          if (position === 'left') expect(boxes.lr).toBeLessThan(boxes.vx);
          if (position === 'right') expect(boxes.lx).toBeGreaterThan(boxes.vr);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
      }
    }
    await chart.getByRole('button', { name: 'Save my view', exact: true }).click();
    await expect(chart.getByRole('status')).toHaveText('My view saved');
    await page.reload();
    await expect(chart.locator('.nm-chart-pair')).toHaveAttribute('data-legend-position', 'right');
    await trigger.click();
    await place(chart, 'Legend', 'Stacked bar', 'left');
    await chart.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(chart.locator('.nm-chart-pair')).toHaveAttribute('data-legend-position', 'right');
    await trigger.click();
    await chart.getByRole('button', { name: 'Ring', exact: true }).click();
    await place(chart, 'Legend', 'Ring', 'top');
    await chart.getByLabel('Show values', { exact: true }).uncheck();
    await chart.screenshot({ path: test.info().outputPath(`placement-${theme}.png`) });
    for (const legacy of ['side', 'below']) {
      state.views()['inventory.device-types'] = { type: 'pie', position: legacy };
      await page.reload();
      await expect(chart.locator('.nm-chart-pair')).toHaveAttribute('data-legend-position', legacy === 'side' ? 'right' : 'bottom');
    }
    await trigger.click();
    await chart.getByRole('button', { name: 'Reset this chart', exact: true }).click();
    await expect(chart.locator('.nm-donut-chart')).toBeVisible();
  });
}

for (const theme of ['light', 'slate', 'zinc']) {
  test(`chart bars and legend are independent elements in ${theme}`, async ({ page }) => {
    const state = await boot(page, theme);
    await page.goto('/inventory');
    const chart = page.locator('[data-chart-id="inventory.device-types"]');
    const trigger = page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true });
    await trigger.click();
    await chart.getByLabel('Show bars', { exact: true }).uncheck();
    await chart.getByLabel('Show legend', { exact: true }).check();
    await chart.getByRole('button', { name: 'Stacked bar', exact: true }).click();
    await expect(chart.locator('.nm-stackbar')).toHaveCount(1);
    await expect(chart.locator('.nm-chart-legend-track, .nm-bar-list-track')).toHaveCount(0);
    await chart.getByRole('button', { name: 'Ring', exact: true }).click();
    await expect(chart.getByLabel('Show bars', { exact: true })).not.toBeChecked();
    await expect(chart.locator('.nm-chart-legend-track, .nm-bar-list-track')).toHaveCount(0);
    await chart.getByLabel('Show legend', { exact: true }).uncheck();
    await chart.getByLabel('Show bars', { exact: true }).check();
    await expect(chart.locator('.nm-chart-legend')).toHaveCount(0);
    await expect(chart.locator('.nm-bar-list-track')).toHaveCount(3);
    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 1050 });
      for (const position of ['top', 'bottom', 'left', 'right']) {
        await place(chart, 'Bars', 'Ring', position);
        const pair = chart.locator('.nm-chart-pair[data-chart-pair="bars"]');
        await expect(pair).toHaveAttribute('data-legend-position', position);
        const placement = await pair.evaluate(el => {
          const visual = el.querySelector('.nm-chart-pair-visual')!.getBoundingClientRect();
          const bars = el.querySelector('[data-chart-element="bars"]')!.getBoundingClientRect();
          return { width: el.getBoundingClientRect().width, visual: { left: visual.left, right: visual.right, top: visual.top, bottom: visual.bottom }, bars: { left: bars.left, right: bars.right, top: bars.top, bottom: bars.bottom } };
        });
        if (position === 'top' || position === 'left' && placement.width <= 360) expect(placement.bars.bottom).toBeLessThan(placement.visual.top);
        else if (position === 'bottom' || position === 'right' && placement.width <= 360) expect(placement.bars.top).toBeGreaterThan(placement.visual.bottom);
        else if (position === 'left') expect(placement.bars.right).toBeLessThan(placement.visual.left);
        else expect(placement.bars.left).toBeGreaterThan(placement.visual.right);
        const geometry = await chart.locator('.nm-bar-list').evaluate(el => {
          const row = el.querySelector('li')!, track = el.querySelector('.nm-bar-list-track')!;
          const style = getComputedStyle(row);
          return { height: track.getBoundingClientRect().height, columns: style.gridTemplateColumns.split(' ').map(Number.parseFloat), gap: Number.parseFloat(style.columnGap) };
        });
        expect(geometry.height).toBe(8);
        expect(geometry.columns[0]).toBeGreaterThanOrEqual(90);
        expect(geometry.gap).toBe(12);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    await chart.getByLabel('Show chart', { exact: true }).uncheck();
    await expect(chart.locator('.nm-personal-ring')).toHaveCount(0);
    await expect(chart.locator('.nm-bar-list-track')).toHaveCount(3);
    await expect(chart.getByLabel('Show legend', { exact: true })).toHaveCount(0);
    await chart.getByRole('button', { name: 'Save my view', exact: true }).click();
    await expect(chart.getByRole('status')).toHaveText('My view saved');
    expect(state.views()['inventory.device-types']).toMatchObject({ version: 2, chart: false, bars: true, legend: false, bar_position: 'right' });
    await page.reload();
    await expect(chart.locator('.nm-personal-ring')).toHaveCount(0);
    await expect(chart.locator('.nm-bar-list-track')).toHaveCount(3);
    await trigger.click();
    await chart.getByRole('button', { name: 'Pie', exact: true }).click();
    await chart.getByLabel('Show chart', { exact: true }).check();
    await chart.getByLabel('Show bars', { exact: true }).uncheck();
    await expect(chart.locator('.nm-personal-pie-label')).toHaveCount(3);
    await chart.getByLabel('Show values', { exact: true }).uncheck();
    await expect(chart.locator('.nm-personal-pie-label')).toHaveCount(0);
    await chart.getByLabel('Show values', { exact: true }).check();
    await page.setViewportSize({ width: 1440, height: 1050 });
    await chart.evaluate(el => { for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) ancestor.scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
    await chart.locator('xpath=ancestor::*[contains(@class,"nm-app-panel")][1]').screenshot({ path: test.info().outputPath(`pie-${theme}.png`) });
    await chart.getByLabel('Show bars', { exact: true }).check();
    await place(chart, 'Bars', 'Pie', 'right');
    await chart.evaluate(el => { for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) ancestor.scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
    await chart.locator('xpath=ancestor::*[contains(@class,"nm-app-panel")][1]').screenshot({ path: test.info().outputPath(`composition-${theme}.png`) });
    await chart.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(chart.locator('.nm-personal-pie-label')).toHaveCount(0);
    await trigger.click();
    await chart.getByRole('button', { name: 'Reset this chart', exact: true }).click();
    await expect(chart.locator('.nm-donut-chart')).toBeVisible();
    await expect(chart.locator('.nm-bar-list-track')).toHaveCount(3);
  });
}

test('legacy tracks translate into optional bars and selecting Bars never duplicates them', async ({ page }) => {
  const state = await boot(page);
  state.views()['inventory.device-types'] = { version: 1, type: 'ring', legend: true, tracks: true, position: 'side' };
  await page.goto('/inventory');
  const chart = page.locator('[data-chart-id="inventory.device-types"]');
  await expect(chart.locator('.nm-personal-ring, .nm-donut-ring')).toBeVisible();
  await expect(chart.locator('.nm-bar-list-track')).toHaveCount(3);
  await expect(chart.locator('.nm-chart-legend')).toHaveCount(0);
  await page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true }).click();
  await chart.getByLabel('Show chart', { exact: true }).uncheck();
  await chart.getByRole('button', { name: 'Bars', exact: true }).click();
  await expect(chart.getByLabel('Show chart', { exact: true })).toBeChecked();
  await expect(chart.getByLabel('Show bars', { exact: true })).not.toBeChecked();
  await expect(chart.locator('.nm-bar-list')).toHaveCount(1);
  state.views()['inventory.device-types'] = { version: 1, type: 'stacked', legend: true, tracks: true };
  await page.reload();
  await expect(chart.locator('.nm-stackbar')).toHaveCount(1);
  await expect(chart.locator('.nm-chart-legend-track, .nm-bar-list-track')).toHaveCount(0);
  state.views()['inventory.device-types'] = { version: 2, type: 'ring', chart: false, bars: false, legend: false };
  await page.reload();
  await expect(chart).toContainText('Choose a chart, bars or legend to display.');
  await page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true }).click();
  await chart.getByLabel('Show chart', { exact: true }).check();
  await expect(chart.locator('.nm-personal-ring, .nm-donut-ring')).toBeVisible();
});

test('pie labels handle a single slice, dominant data and small slices without overlap', async ({ page }) => {
  const state = await boot(page);
  const devices = Array.from({ length: 86 }, (_, index) => mockDevice({ id: index + 1, hostname: `Device ${index + 1}`, device_type: index < 78 ? 'router' : index < 81 ? 'server' : 'access_point' }));
  await setupTopologyMocks(page, devices, []);
  state.views()['inventory.device-types'] = { version: 2, type: 'pie', chart: true, bars: false, legend: false, labels: true };
  await page.goto('/inventory');
  const chart = page.locator('[data-chart-id="inventory.device-types"]');
  await expect(chart.locator('.nm-personal-pie-label')).toHaveCount(1);
  await expect(chart.locator('.nm-personal-pie-label')).toContainText('78');
  await chart.locator('.nm-personal-pie path').first().focus();
  await expect(page.getByRole('status').filter({ hasText: 'router' })).toContainText('78');
  await setupTopologyMocks(page, [devices[0]], []);
  await page.reload();
  await expect(chart.locator('.nm-personal-pie-label')).toHaveCount(1);
  await expect(chart.locator('.nm-personal-pie-label')).toContainText('1');
  const box = await chart.locator('.nm-personal-pie-label').boundingBox();
  const pie = await chart.locator('.nm-personal-pie').boundingBox();
  expect(box!.x).toBeGreaterThan(pie!.x);
  expect(box!.x + box!.width).toBeLessThan(pie!.x + pie!.width);
  await setupTopologyMocks(page, [], []);
  await page.reload();
  await expect(chart).toHaveCount(0);
});

for (const theme of ['light', 'slate', 'zinc']) {
  test(`overview keeps both visual choices while saving pair placement in ${theme}`, async ({ page }) => {
    const state = await boot(page, theme);
    await page.goto('/overview');
    const ring = page.locator('[data-chart-id="overview.health-ring"]');
    const breakdown = page.locator('[data-chart-id="overview.health-status"]');
    const pair = page.locator('.overview-health-combo');
    const open = page.getByRole('button', { name: 'Visual options: Devices per health status', exact: true });
    await expect(ring.locator('.nm-donut-ring')).toBeVisible();
    await expect(breakdown.locator('.nm-column-chart')).toBeVisible();
    await open.click();
    await breakdown.getByRole('button', { name: 'Number', exact: true }).click();
    await breakdown.getByRole('button', { name: 'Place Health breakdown below Health ring', exact: true }).click();
    await breakdown.getByRole('button', { name: 'Save my view', exact: true }).click();
    await expect(breakdown.getByRole('status')).toHaveText('My view saved');
    await breakdown.getByRole('button', { name: 'Close visual options', exact: true }).click();
    await expect(ring.locator('.nm-donut-ring')).toBeVisible();
    await expect(breakdown.locator('.nm-personal-number')).toBeVisible();
    await expect(pair).toHaveAttribute('data-first-position', 'top');
    expect(state.views()['overview.health-layout']).toMatchObject({ position: 'top' });
    await page.reload();
    await expect(pair).toHaveAttribute('data-first-position', 'top');
    await expect(breakdown.locator('.nm-personal-number')).toBeVisible();
    await open.click();
    await breakdown.getByRole('button', { name: 'Place Health breakdown left of Health ring', exact: true }).click();
    await breakdown.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(pair).toHaveAttribute('data-first-position', 'top');
    await open.click();
    await breakdown.getByRole('button', { name: 'Reset this chart', exact: true }).click();
    await breakdown.getByRole('button', { name: 'Close visual options', exact: true }).click();
    await expect(breakdown.locator('.nm-column-chart')).toBeVisible();
    await expect(pair).toHaveAttribute('data-first-position', 'left');
    await expect(ring.locator('.nm-donut-ring')).toBeVisible();
    await pair.screenshot({ path: test.info().outputPath(`overview-pair-${theme}.png`) });
  });

  test(`ring metric formatting works without a legend and default bars have scrollbar clearance in ${theme}`, async ({ page }) => {
    await boot(page, theme);
    await setupTopologyMocks(page, Array.from({ length: 12 }, (_, i) => mockDevice({ id: i + 1, device_type: `type-${i}` })), []);
    await page.goto('/inventory');
    const chart = page.locator('[data-chart-id="inventory.device-types"]');
    await expect(chart.locator('.nm-bar-list li')).toHaveCount(12);
    await expect(chart.locator('.nm-chart-legend')).toHaveCount(0);
    const clearance = await chart.locator('[data-chart-element="bars"]').evaluate(el => ({
      padding: parseFloat(getComputedStyle(el).paddingInlineEnd),
      gutter: getComputedStyle(el).scrollbarGutter,
      right: el.getBoundingClientRect().right - el.querySelector('strong')!.getBoundingClientRect().right,
    }));
    expect(clearance.padding).toBe(12);
    expect(clearance.gutter).toBe('stable');
    expect(clearance.right).toBeGreaterThanOrEqual(12);
    await page.getByRole('button', { name: 'Visual options: Devices per device type', exact: true }).click();
    await expect(chart.getByLabel('Show legend', { exact: true })).toHaveCount(0);
    await chart.getByLabel('Show bars', { exact: true }).uncheck();
    await chart.getByLabel('Values', { exact: true }).selectOption('percent');
    await chart.getByLabel('Value to display', { exact: true }).selectOption('Type 0');
    await expect(chart.locator('.nm-personal-ring-centre strong')).toHaveText('8.33%');
    await chart.getByLabel('Values', { exact: true }).selectOption('both');
    await expect(chart.locator('.nm-personal-ring-centre strong')).toHaveText('1');
    await expect(chart.locator('.nm-personal-ring-centre small')).toHaveText('8.33%');
    await chart.getByRole('button', { name: 'Number', exact: true }).click();
    await expect(chart.locator('.nm-personal-number')).toHaveText('18.33%Type 0');
    await chart.getByRole('button', { name: 'Save my view', exact: true }).click();
    await page.reload();
    await expect(chart.locator('.nm-personal-number')).toHaveText('18.33%Type 0');
  });
}

test('IPAM resets to a Used gauge left of Used and Free bars with an inset right edge', async ({ page }) => {
  const state = await boot(page);
  await page.route('**/api/v1/ipam/summary', route => route.fulfill({ json: { total_hosts: 100, used: 25, free: 75, subnet_count: 1, reservation_count: 5, dhcp_lease_count: 10 } }));
  await page.goto('/ipam');
  const chart = page.locator('[data-chart-id="ipam.address-space"]');
  await expect(chart.locator('.nm-personal-gauge text')).toHaveText('25%');
  await expect(chart.locator('.nm-bar-list-label')).toHaveText(['Used', 'Free']);
  const geometry = await chart.evaluate(el => {
    const gauge = el.querySelector('.nm-personal-gauge')!.getBoundingClientRect();
    const bars = el.querySelector('.nm-bar-list')!.getBoundingClientRect();
    return { gaugeRight: gauge.right, barsLeft: bars.left, inset: el.getBoundingClientRect().right - bars.right };
  });
  expect(geometry.gaugeRight).toBeLessThan(geometry.barsLeft);
  expect(geometry.inset).toBeGreaterThanOrEqual(30);
  state.views()['ipam.address-space'] = { version: 2, type: 'number', bars: false, legend: false };
  await page.reload();
  await expect(chart.locator('.nm-personal-number')).toBeVisible();
  await page.getByRole('button', { name: 'Visual options: Address space', exact: true }).click();
  await chart.getByRole('button', { name: 'Reset this chart', exact: true }).click();
  await expect(chart.locator('.nm-personal-gauge text')).toHaveText('25%');
  await expect(chart.locator('.nm-bar-list-label')).toHaveText(['Used', 'Free']);
});

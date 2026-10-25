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
      await expect(chart.locator('.nm-personal-renderer')).toBeVisible();
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
      await expect.poll(async () => chart.locator('.nm-personal-plot').evaluate(el => Math.abs(el.getBoundingClientRect().width - el.parentElement!.getBoundingClientRect().width))).toBeLessThan(1);
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
  await chart.getByLabel('Values', { exact: true }).selectOption('both');
  await chart.getByLabel('Legend position', { exact: true }).selectOption('below');
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
  await expect(chart.getByLabel('Legend position', { exact: true })).toHaveValue('below');
  await expect(chart.getByLabel('Show values', { exact: true })).not.toBeChecked();
  await chart.getByRole('button', { name: 'Reset this chart', exact: true }).click();
  await expect(chart.locator('.nm-donut-chart .nm-chart-legend strong')).toHaveCount(3);
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
  await chart.locator('xpath=ancestor::*[contains(@class,"nm-app-panel")][1]').screenshot({ path: '/tmp/netmap-chart-preview-before.png' });
});

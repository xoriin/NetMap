import { expect, test, type Page } from '@playwright/test';
import { mockDevice, mockMonitoringDevice, setupCoreMocks, setupMonitoringMocks, setupTopologyMocks } from './helpers/api-mocks';

const records = [
  { name: 'Core A', type: 'router', group: 'Core', vlan: '20', health: 'healthy', rtt: 2, uptime: 1 },
  { name: 'Core B', type: 'router', group: 'Core', vlan: '20', health: 'unhealthy', rtt: 7, uptime: 0.9 },
  { name: 'Edge C', type: 'router', group: 'Edge', vlan: '30', health: 'unknown', rtt: 12, uptime: 0.8 },
  { name: 'Storage D', type: 'server', group: 'Core', vlan: '20', health: 'paused', rtt: null, uptime: null },
  { name: 'Storage E', type: 'server', group: 'Edge', vlan: '30', health: 'healthy', rtt: 4, uptime: 1 },
  ...Array.from({ length: 9 }, (_, i) => ({ name: `Edge extra ${i}`, type: 'router', group: 'Edge', vlan: '30', health: 'healthy', rtt: 20 + i, uptime: 0.99 })),
];

async function boot(page: Page, theme: string) {
  await page.route('**/api/v1/**', route => route.fulfill({ json: [] }));
  await setupCoreMocks(page);
  await setupTopologyMocks(page, records.map((record, i) => mockDevice({
    id: i + 1, display_name: record.name, hostname: record.name,
    device_type: record.type, topology_group: record.group,
  })), []);
  await setupMonitoringMocks(page, records.map((record, i) => mockMonitoringDevice({
    device_id: i + 1, display_name: record.name, hostname: record.name,
    device_type: record.type, topology_group: record.group, vlan_id: record.vlan,
    health_status: record.health, monitoring_paused: record.health === 'paused',
    // Expected-offline is healthy; the visual must not equate offline with unhealthy.
    status: i < 2 ? 'offline' : 'online', expected_status: i === 0 ? 'offline' : 'online',
    avg_rtt_24h: record.rtt, uptime_24h: record.uptime,
  })));
  await page.route('**/api/v1/admin/device-types', route => route.fulfill({ json: [
    { value: 'router', label: 'Router', icon: 'router', is_builtin: true, color: null },
    { value: 'server', label: 'Server', icon: 'server', is_builtin: true, color: null },
  ] }));
  const views: Record<string, unknown> = {};
  await page.route('**/api/v1/auth/me/chart-views**', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: views });
    const id = new URL(route.request().url()).pathname.split('/chart-views/')[1];
    views[id] = route.request().postDataJSON();
    return route.fulfill({ json: views[id] });
  });
  await page.addInitScript(theme => {
    localStorage.setItem('netmap.theme', theme === 'light' ? 'light' : 'dark');
    localStorage.setItem('netmap.dark_style', theme === 'zinc' ? 'zinc' : 'slate');
    localStorage.setItem('netmap.inventory.pageSize', '10');
    localStorage.setItem('netmap.inventory.pageSizeDefault25', 'true');
    localStorage.setItem('netmap.mon_devices_page_size', '10');
  }, theme);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1600, height: 1050 });
}

async function choose(page: Page, filter: string, option: string) {
  await page.getByRole('button', { name: filter, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

for (const theme of ['light', 'slate', 'zinc']) {
  test(`Monitoring visuals follow combined device filters before pagination in ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await boot(page, theme);
    await page.goto('/monitoring#devices');
    const health = page.getByRole('region', { name: 'Fleet Health', exact: true });
    const latency = page.getByRole('region', { name: 'Highest Latency', exact: true });
    const vlans = page.getByRole('region', { name: 'Devices by VLAN', exact: true });
    await expect(page.locator('.mon-row')).toHaveCount(10);
    await expect(health.locator('.dash-donut-pct')).toHaveText('14');
    await page.getByRole('button', { name: 'Next ›', exact: true }).click();
    await expect(page.locator('.mon-row')).toHaveCount(4);
    await expect(health.locator('.dash-donut-pct')).toHaveText('14');

    await choose(page, 'Filter by VLAN', 'VLAN 20');
    await expect(health.locator('.dash-donut-pct')).toHaveText('3');
    await expect(health.locator('.nm-bar-list-label')).toHaveText(['Healthy', 'Unexpected', 'Paused']);
    await expect(latency.locator('.nm-bar-list li')).toHaveCount(2);
    await expect(latency.locator('.nm-bar-list li').first()).toHaveAttribute('aria-label', 'Core B: 7 ms');
    await expect(vlans.locator('.nm-bar-list li')).toHaveAttribute('aria-label', 'VLAN 20: 3');
    await choose(page, 'Filter by device type', 'Router');
    await expect(health.locator('.dash-donut-pct')).toHaveText('2');
    await expect(health.locator('.nm-bar-list strong')).toHaveText(['1', '1']);
    await expect(vlans.locator('.nm-bar-list li')).toHaveAttribute('aria-label', 'VLAN 20: 2');
    await choose(page, 'Filter by device type', 'Server');
    await expect(health.locator('.nm-bar-list-label')).toHaveText(['Paused']);
    await expect(latency).toContainText('No latency recorded yet.');
    await expect(vlans.locator('.nm-bar-list li')).toHaveAttribute('aria-label', 'VLAN 20: 1');

    const search = page.getByPlaceholder('Search devices…', { exact: true });
    await search.fill('no matching device');
    await expect(health).toContainText('No devices match the current filters.');
    await expect(health.locator('.dash-donut-svg')).toHaveCount(0);
    await expect(vlans).toContainText('No devices match the current filters.');
    await expect(vlans.getByRole('button', { name: 'Visual options: Devices per VLAN', exact: true })).toBeEnabled();
    await search.fill('');
    await choose(page, 'Filter by device type', 'All types');
    await choose(page, 'Filter by VLAN', 'All VLANs');
    await expect(health.locator('.dash-donut-pct')).toHaveText('14');
    await expect(vlans.locator('.nm-bar-list-label')).toHaveText(['VLAN 30', 'VLAN 20']);
    await expect(vlans.locator('.nm-bar-list strong')).toHaveText(['11', '3']);
    await expect(latency.locator('.nm-bar-list li')).toHaveCount(6);
    await expect(latency.locator('.nm-bar-list li').first()).toHaveAttribute('aria-label', 'Edge extra 8: 28 ms');
    expect(errors).toEqual([]);
  });

  test(`Inventory type visual and alternate view follow table filters in ${theme}`, async ({ page }) => {
    await boot(page, theme);
    await page.goto('/inventory');
    const panel = page.getByRole('region', { name: 'Devices by Type', exact: true });
    await expect(panel.locator('.dash-donut-pct')).toHaveText('14');
    await page.getByRole('button', { name: 'Next ›', exact: true }).click();
    await expect(panel.locator('.dash-donut-pct')).toHaveText('14');
    await choose(page, 'Filter by VLAN / group', 'Core');
    await expect(panel.locator('.dash-donut-pct')).toHaveText('3');
    await expect(panel.locator('.nm-bar-list strong')).toHaveText(['2', '1']);
    await choose(page, 'Filter by device type', 'Router');
    await expect(panel.locator('.dash-donut-pct')).toHaveText('2');
    await expect(panel.locator('.nm-bar-list-label')).toHaveText(['Router']);

    await panel.getByRole('button', { name: 'Visual options: Devices per device type', exact: true }).click();
    await panel.getByRole('button', { name: 'Columns', exact: true }).click();
    await panel.getByRole('button', { name: 'Save my view', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('My view saved');
    await panel.getByRole('button', { name: 'Close visual options', exact: true }).click();
    await expect(panel.locator('.nm-chart-value')).toHaveText(['2']);
    await choose(page, 'Filter by device type', 'All types');
    await expect(panel.locator('.nm-chart-value')).toHaveText(['2', '1']);
    await choose(page, 'Filter by VLAN / group', 'All groups');
    await expect(panel.locator('.nm-chart-value')).toHaveText(['12', '2']);
    const search = page.getByPlaceholder('Search devices…', { exact: true });
    await search.fill('no matching device');
    await expect(panel).toContainText('No devices match the current filters.');
    await search.fill('');
    await expect(panel.locator('.nm-chart-value')).toHaveText(['12', '2']);
  });
}

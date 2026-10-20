import {expect,test} from '@playwright/test';
import {setupExternalIps,mockAddress} from './helpers/external-ip';
import {mockDevice,mockMonitoringDevice} from './helpers/api-mocks';

for(const theme of ['light','dark'] as const) {
 test(`Cloud rows carry linked device latency, health and a round trip to Devices in ${theme}`,async({page})=>{
  await page.setViewportSize({width:1600,height:1000});
  const devices=[
   mockDevice({id:7,hostname:'Public server',ip_address:'8.8.8.8',last_monitored_at:'2026-10-20T08:00:00Z'}),
   mockDevice({id:8,hostname:'Edge proxy',ip_address:'8.8.4.4',status:'offline',monitor_status:'offline'}),
  ];
  await setupExternalIps(page,{theme,devices,addresses:[mockAddress({device_id:7,ip_address:'8.8.8.8'}),mockAddress({id:2,device_id:8,ip_address:'8.8.4.4',label:'Proxy'}),mockAddress({id:3,ip_address:'203.0.113.99',label:'Spare'}),mockAddress({id:4,device_id:8,ip_address:'8.8.4.5',label:'Proxy secondary'})],beforeGoto:async page=>{
   await page.route('**/api/v1/topology/devices/*/security-events?*',route=>route.fulfill({json:{device_id:7,window_hours:24,blocked_count:0,passed_count:0,total_count:0,last_seen_event_time:null,events:[]}}));
   await page.route(/\/api\/v1\/monitoring\/devices\/\d+$/,route=>route.fulfill({json:mockMonitoringDevice({device_id:Number(route.request().url().split('/').pop())})}));
   await page.route('**/api/v1/monitoring/devices',route=>route.fulfill({json:[mockMonitoringDevice({device_id:7,avg_rtt_24h:12.34}),mockMonitoringDevice({device_id:8,status:'offline',health_status:'unhealthy',avg_rtt_24h:null})]}));
  }});
  await page.goto('/inventory#cloud-assets');
  const header=page.locator('.inventory-table-header');
  await expect(header).toContainText('Latency');
  await expect(page.locator('[data-cloud-record="address-1"]')).toContainText('12.3 ms');
  const offline=page.locator('.dash-stat').filter({hasText:'Offline'});
  await expect(offline.locator('strong')).toHaveText('1');
  await offline.click();
  await expect(page.locator('[data-cloud-record]')).toHaveCount(2);
  await expect(page.locator('[data-cloud-record="address-2"]')).toBeVisible();
  await expect(page.locator('[data-cloud-record="address-4"]')).toBeVisible();
  await offline.click();
  await page.getByRole('button',{name:'Open Public server details'}).click();
  const sidebar=page.getByRole('complementary',{name:'Asset overview'});
  await expect(sidebar).toContainText('Last checked');
  const clipped=await sidebar.evaluate(el=>{const edge=el.getBoundingClientRect().right;return [...el.querySelectorAll('.detail-actions .nm-btn')].filter(button=>button.getBoundingClientRect().right>edge+0.5).map(button=>button.textContent);});
  expect(clipped).toEqual([]);
  await expect(sidebar).toContainText('12.3 ms');
  const pill=sidebar.locator('.status-pill').first();
  await expect(pill).toBeVisible();
  const rowPill=page.locator('[data-cloud-record="address-1"] .status-pill');
  expect(await pill.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(await rowPill.evaluate(el=>getComputedStyle(el).backgroundColor));
  const cloudHeader=await page.locator('.inventory-table-header').evaluate(el=>el.getBoundingClientRect().height);
  await sidebar.getByRole('button',{name:'Show in Devices',exact:true}).click();
  await expect(page).toHaveURL(/inventory#devices$/);
  const device=page.getByRole('complementary',{name:'Device overview'});
  await expect(device).toBeVisible();
  await expect(device).toContainText('Public server');
  await expect(page.locator('.inventory-row.active')).toContainText('Public server');
  expect(await page.locator('.inventory-table-header').evaluate(el=>el.getBoundingClientRect().height)).toBe(cloudHeader);
  await page.goBack();
  await expect(page).toHaveURL(/inventory#cloud-assets$/);
  await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('8.8.8.8');
  await expect(page.locator('[data-cloud-record="address-1"].active')).toBeVisible();
 });
}

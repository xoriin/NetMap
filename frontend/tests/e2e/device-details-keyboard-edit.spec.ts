import {expect,test} from '@playwright/test';
import {setupExternalIps} from './helpers/external-ip';
import {mockDevice,mockMonitoringDevice} from './helpers/api-mocks';

async function open(page:import('@playwright/test').Page) {
 await setupExternalIps(page,{devices:[mockDevice({id:7,hostname:'Edge router'})],beforeGoto:async page=>{
  await page.route('**/api/v1/topology/devices/*/security-events?*',route=>route.fulfill({json:{device_id:7,window_hours:24,blocked_count:0,passed_count:0,total_count:0,last_seen_event_time:null,events:[]}}));
  await page.route(/\/api\/v1\/monitoring\/devices\/\d+$/,route=>route.fulfill({json:mockMonitoringDevice({device_id:7})}));
 }});
 await page.goto('/inventory#devices');
 await page.getByRole('button',{name:'Open Edge router details'}).click();
 return page.getByRole('complementary',{name:'Device overview'}).locator('dt:has-text("Hostname") + dd');
}

test('Device sidebar fields start editing with Enter',async({page})=>{
 const hostname=await open(page);
 await hostname.focus();
 await expect(hostname).toBeFocused();
 await page.keyboard.press('Enter');
 await expect(hostname.locator('input')).toBeVisible();
 await expect(page.locator('.details-edit-hint')).toHaveText('Double-click any field to edit');
});

test('double-clicking inside an open Device field editor keeps the draft',async({page})=>{
 const hostname=await open(page);
 await hostname.dblclick();
 const input=hostname.locator('input');
 await input.fill('Draft hostname');
 await input.dblclick();
 await expect(input).toHaveValue('Draft hostname');
 await input.press('Escape');
 await expect(input).toHaveCount(0);
});

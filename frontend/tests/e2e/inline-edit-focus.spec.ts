import {expect,test,type Page} from '@playwright/test';
import {setupExternalIps,mockAddress} from './helpers/external-ip';
import {mockDevice,mockMonitoringDevice} from './helpers/api-mocks';

function field(page:Page,label:string) {
 return page.locator(`.inventory-device-sidebar dt:text-is("${label}") + dd`);
}

async function common(page:Page) {
 await page.route('**/api/v1/admin/device-types',route=>route.fulfill({json:[]}));
 await page.route('**/api/v1/topology/devices/*/security-events?*',route=>route.fulfill({json:{device_id:7,window_hours:24,blocked_count:0,passed_count:0,total_count:0,last_seen_event_time:null,events:[]}}));
 await page.route(/\/api\/v1\/monitoring\/devices\/\d+$/,route=>route.fulfill({json:mockMonitoringDevice({device_id:7})}));
}

async function openCloud(page:Page) {
 const state=await setupExternalIps(page,{devices:[mockDevice({id:7,hostname:'Existing server'})],addresses:[mockAddress({label:'Public service',owner:'Original owner'})],beforeGoto:common});
 await page.goto('/inventory#cloud-assets');
 await page.getByRole('button',{name:'Open Public service details'}).click();
 return state;
}

async function openDevice(page:Page) {
 await setupExternalIps(page,{devices:[mockDevice({id:7,hostname:'Edge router'})],beforeGoto:common});
 await page.goto('/inventory#devices');
 await page.getByRole('button',{name:'Open Edge router details'}).click();
 return page.getByRole('complementary',{name:'Device overview'}).locator('dt:has-text("Hostname") + dd');
}

const selection=(page:Page)=>page.evaluate(()=>window.getSelection()?.toString() ?? '');

test('double-clicking a field to edit clears the text selection in Cloud and Devices',async({page})=>{
 await openCloud(page);
 await field(page,'Inventory device').dblclick();
 await expect(page.getByRole('button',{name:'Inventory device',exact:true})).toBeVisible();
 expect(await selection(page)).toBe('');
 await page.goto('/inventory#devices');
 await page.getByRole('button',{name:'Open Existing server details'}).click();
 await page.getByRole('complementary',{name:'Device overview'}).locator('dt:has-text("Vendor") + dd').dblclick();
 expect(await selection(page)).toBe('');
});

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

test('the Cloud device picker takes focus when opened from the keyboard or Link device',async({page})=>{
 await openCloud(page);
 const trigger=page.getByRole('button',{name:'Inventory device',exact:true});
 await field(page,'Inventory device').focus();
 await page.keyboard.press('Enter');
 await expect(trigger).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(trigger).toHaveCount(0);
 await expect(field(page,'Inventory device')).toBeFocused();
 await page.getByRole('button',{name:'Link device',exact:true}).click();
 await expect(trigger).toBeFocused();
});

test('closing a Cloud field editor returns focus to the field',async({page})=>{
 const state=await openCloud(page);
 await field(page,'Owner').focus();
 await page.keyboard.press('Enter');
 await page.keyboard.press('Escape');
 await expect(field(page,'Owner')).toBeFocused();
 await page.keyboard.press('Enter');
 await page.getByRole('textbox',{name:'Edit Owner'}).fill('Keyboard owner');
 await page.keyboard.press('Enter');
 await expect(page.getByRole('textbox',{name:'Edit Owner'})).toHaveCount(0);
 await expect(field(page,'Owner')).toBeFocused();
 expect(state.addresses[0].owner).toBe('Keyboard owner');
});

test('a dirty Cloud draft is kept and focused by other fields, Link device and Add to Inventory',async({page})=>{
 await openCloud(page);
 await field(page,'Owner').dblclick();
 const owner=page.getByRole('textbox',{name:'Edit Owner'});
 await owner.fill('Draft owner');
 await field(page,'Tags').dblclick();
 await expect(owner).toBeFocused();
 await page.getByRole('button',{name:'Link device',exact:true}).click();
 await expect(owner).toBeFocused();
 await page.getByRole('button',{name:'Add to Inventory',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Add device',exact:true})).toHaveCount(0);
 await expect(owner).toBeFocused();
 await expect(owner).toHaveValue('Draft owner');
});

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

test('closing a Devices field editor with Escape returns focus to the field',async({page})=>{
 const hostname=await openDevice(page);
 await hostname.focus();
 await page.keyboard.press('Enter');
 const input=hostname.locator('input');
 await expect(input).toBeFocused();
 await input.press('Escape');
 await expect(input).toHaveCount(0);
 await expect(hostname).toBeFocused();
});

test('Devices fields ignore Enter on the field while it is editing',async({page})=>{
 const hostname=await openDevice(page);
 await hostname.focus();
 await page.keyboard.press('Enter');
 const input=hostname.locator('input');
 await input.fill('Draft hostname');
 await hostname.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
 await expect(input).toHaveValue('Draft hostname');
});

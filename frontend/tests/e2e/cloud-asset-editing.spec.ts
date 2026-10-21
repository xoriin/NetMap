import {expect,test,type Page} from '@playwright/test';
import {setupExternalIps,mockAddress,AWS} from './helpers/external-ip';
import {mockDevice,mockMonitoringDevice,setupInventoryMocks} from './helpers/api-mocks';

function field(page:Page,label:string) {
 return page.locator(`.inventory-device-sidebar dt:text-is("${label}") + dd`);
}

test.beforeEach(async({page})=>{
 await page.route('**/api/v1/topology/devices/*/security-events?*',route=>route.fulfill({json:{device_id:7,window_hours:24,blocked_count:0,passed_count:0,total_count:0,last_seen_event_time:null,events:[]}}));
 await page.route(/\/api\/v1\/monitoring\/devices\/\d+$/,route=>route.fulfill({json:mockMonitoringDevice({device_id:Number(route.request().url().split('/').pop())})}));
});

async function edit(page:Page,label:string,value:string,select=false) {
 await field(page,label).dblclick();
 const input=page.getByRole(select?'combobox':'textbox',{name:`Edit ${label}`,exact:true});
 if(select) await input.selectOption(value); else await input.fill(value);
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(input).toHaveCount(0);
}

async function pickDevice(page:Page,option:string) {
 await field(page,'Inventory device').dblclick();
 await page.getByRole('button',{name:'Inventory device',exact:true}).click();
 await page.getByRole('option',{name:option}).click();
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByRole('button',{name:'Inventory device',exact:true})).toHaveCount(0);
}

for(const theme of ['light','dark'] as const) {
 test(`current external address fields and device link edit in place in ${theme}`,async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  const devices=[mockDevice({id:7,hostname:'Existing server',ip_address:'8.8.8.8',monitoring_paused:true})];
  const state=await setupExternalIps(page,{theme,devices,providers:[AWS],accounts:[{id:1,name:'Production',provider_id:1}],locations:[{id:1,account_id:1,name:'Sydney',region:'au'}],addresses:[mockAddress({label:'Public service'})]});
  await setupInventoryMocks(page,devices);
  await page.goto('/inventory#cloud-assets');
  await page.getByRole('button',{name:'Open Public service details'}).click();
  await edit(page,'Purpose','Updated purpose');
  await expect(page.locator('[data-cloud-record="address-1"]')).toContainText('Updated purpose');
  await edit(page,'Location','1',true);
  await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('AWS');
  await edit(page,'Owner','Operations');
  await edit(page,'Tags','public, critical');
  await edit(page,'Notes','Persistent notes\nSecond line');
  await edit(page,'URL','https://example.com/console');
  await edit(page,'Address state','reserved',true);
  await edit(page,'IP address','2606:4700:4700::1111');
  await pickDevice(page,'Existing server');
  expect(state.addressPatches.at(-1)).toEqual([1,{device_id:7}]);
  await expect(field(page,'Purpose')).toHaveClass(/editable-dd/);
  await page.getByRole('button',{name:'Open device',exact:true}).click();
  await expect(page.getByRole('complementary',{name:'Device overview'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Back to asset'}).click();
  await pickDevice(page,'Not linked');
  await expect(page.getByRole('button',{name:'Open device',exact:true})).toHaveCount(0);
  expect(state.addresses[0]).toMatchObject({device_id:null,ip_address:'2606:4700:4700::1111',label:'Updated purpose',owner:'Operations',status:'reserved',location_id:1});
  await page.reload();
  await page.getByRole('button',{name:'Open Updated purpose details'}).click();
  await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('Persistent notes');
  await page.setViewportSize({width:780,height:850});
  await field(page,'Owner').dblclick();
  await page.getByRole('textbox',{name:'Edit Owner',exact:true}).fill('Narrow edit');
  await page.getByRole('textbox',{name:'Edit Owner',exact:true}).scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(state.addresses[0].owner).toBe('Operations');
 });

 test(`retained resource fields, link replacement and errors work in ${theme}`,async({page})=>{
  let asset={id:4,name:'Retained VM',kind:'vm',provider_id:null as number|null,account:'Production',region:'Sydney',device_id:null as number|null,description:'Original description'};
  const patches:Record<string,unknown>[]=[]; let fail=false;
  const devices=[mockDevice({id:7,hostname:'Existing server'}),mockDevice({id:8,hostname:'Replacement server'})];
  await setupExternalIps(page,{theme,devices,beforeGoto:async page=>{
   await page.route('**/api/v1/ipam/external/assets',route=>route.fulfill({json:[asset]}));
   await page.route('**/api/v1/ipam/external/assets/4',async route=>{
    const patch=route.request().postDataJSON() as Record<string,unknown>;
    patches.push(patch);
    if(fail) return route.fulfill({status:500,json:{detail:'Resource update failed'}});
    asset={...asset,...patch}; await route.fulfill({json:asset});
   });
  }});
  await page.goto('/inventory#cloud-assets');
  await page.getByRole('button',{name:'Open Retained VM details'}).click();
  await edit(page,'Name','Restored VM');
  await field(page,'Type').dblclick();
  await page.getByRole('complementary',{name:'Asset overview'}).getByRole('button',{name:'Type',exact:true}).click();
  await page.getByRole('option',{name:'Server',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await edit(page,'Provider','1',true);
  await edit(page,'Account','Infrastructure');
  await edit(page,'Region','au-east');
  await field(page,'Description').dblclick();
  await page.getByRole('textbox',{name:'Edit Description'}).fill('Retry this description');
  fail=true; await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Resource update failed');
  await expect(page.getByRole('textbox',{name:'Edit Description'})).toHaveValue('Retry this description');
  fail=false; await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Edit Description'})).toHaveCount(0);
  await pickDevice(page,'Existing server');
  await pickDevice(page,'Replacement server');
  await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('Replacement server');
  expect(patches.at(-1)).toEqual({device_id:8});
  await pickDevice(page,'Not linked');
  expect(asset.device_id).toBeNull();
  await field(page,'Name').dblclick();
  await page.getByRole('textbox',{name:'Edit Name',exact:true}).fill(' ');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('complementary',{name:'Asset overview'}).getByRole('alert')).toContainText('Enter name');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(asset.name).toBe('Restored VM');
  await page.reload(); await page.getByRole('button',{name:'Open Restored VM details'}).click();
  await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('Retry this description');
 });
}

test('read-only Inventory users cannot edit metadata or links',async({page})=>{
 await setupExternalIps(page,{addresses:[mockAddress({label:'Public service'})]});
 await page.route('**/api/v1/auth/me',route=>route.fulfill({json:{id:2,username:'viewer',role:'Viewer',is_active:true,permissions:[]}}));
 await page.goto('/inventory#cloud-assets'); await page.getByRole('button',{name:'Open Public service details'}).click();
 const sidebar=page.getByRole('complementary',{name:'Asset overview'});
 await expect(sidebar.locator('.editable-dd')).toHaveCount(0);
 await expect(sidebar.locator('.details-edit-hint')).toHaveCount(0);
 await expect(sidebar.locator('.detail-actions button')).toHaveCount(0);
 await field(page,'Owner').dblclick();
 await expect(sidebar.locator('input, select, textarea')).toHaveCount(0);
});

test('pending saves disable controls and cancellation preserves the record',async({page})=>{
 const state=await setupExternalIps(page,{addresses:[mockAddress({label:'Public service',owner:'Original owner'})]});
 let finish:()=>void=()=>{}; const waiting=new Promise<void>(resolve=>{finish=resolve;});
 await page.route('**/api/v1/ipam/external/addresses/1',async route=>{await waiting; const patch=route.request().postDataJSON(); state.addresses[0]={...state.addresses[0],...patch}; await route.fulfill({json:state.addresses[0]});});
 await page.goto('/inventory#cloud-assets'); await page.getByRole('button',{name:'Open Public service details'}).click();
 await field(page,'Owner').dblclick();
 await page.getByRole('textbox',{name:'Edit Owner'}).fill('New owner');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByRole('button',{name:'Saving…',exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();
 finish(); await expect(page.getByRole('textbox',{name:'Edit Owner'})).toHaveCount(0);
 await field(page,'Owner').dblclick();
 await page.getByRole('textbox',{name:'Edit Owner'}).fill('Cancelled');
 await page.getByRole('textbox',{name:'Edit Owner'}).press('Escape');
 expect(state.addresses[0].owner).toBe('New owner');
});

test('a dirty draft survives double-clicks inside its editor and on other fields',async({page})=>{
 const state=await setupExternalIps(page,{addresses:[mockAddress({label:'Public service',owner:'Original owner',tags:'web'})]});
 await page.goto('/inventory#cloud-assets'); await page.getByRole('button',{name:'Open Public service details'}).click();
 const sidebar=page.getByRole('complementary',{name:'Asset overview'});
 await field(page,'Owner').dblclick();
 const owner=page.getByRole('textbox',{name:'Edit Owner'});
 await owner.fill('Draft owner');
 await owner.dblclick();
 await expect(owner).toHaveValue('Draft owner');
 await field(page,'Tags').dblclick();
 await expect(owner).toHaveValue('Draft owner');
 await expect(page.getByRole('textbox',{name:'Edit Tags'})).toHaveCount(0);
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(owner).toHaveCount(0);
 expect(state.addresses[0].owner).toBe('Draft owner');
 await field(page,'Tags').dblclick();
 await expect(page.getByRole('textbox',{name:'Edit Tags'})).toHaveValue('web');
});

test('the Cloud sidebar shares the Devices edit hint and has no per-field edit buttons',async({page})=>{
 await setupExternalIps(page,{addresses:[mockAddress({label:'Public service'})]});
 await page.goto('/inventory#cloud-assets'); await page.getByRole('button',{name:'Open Public service details'}).click();
 const sidebar=page.getByRole('complementary',{name:'Asset overview'});
 await expect(sidebar.locator('.details-edit-hint')).toHaveText('Double-click any field to edit');
 await expect(sidebar.locator('dd button')).toHaveCount(0);
 await field(page,'Owner').focus();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('textbox',{name:'Edit Owner'})).toBeFocused();
});

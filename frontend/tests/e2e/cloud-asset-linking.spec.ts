import {expect,test,type Page} from '@playwright/test';
import {setupExternalIps,mockAddress,AWS} from './helpers/external-ip';
import {mockDevice,mockMonitoringDevice} from './helpers/api-mocks';

function field(page:Page,label:string) {
 return page.locator(`.inventory-device-sidebar dt:text-is("${label}") + dd`);
}

async function common(page:Page) {
 await page.route('**/api/v1/admin/device-types',route=>route.fulfill({json:[]}));
 await page.route('**/api/v1/topology/devices/*/security-events?*',route=>route.fulfill({json:{device_id:7,window_hours:24,blocked_count:0,passed_count:0,total_count:0,last_seen_event_time:null,events:[]}}));
 await page.route(/\/api\/v1\/monitoring\/devices\/\d+$/,route=>route.fulfill({json:mockMonitoringDevice({device_id:Number(route.request().url().split('/').pop())})}));
}

async function pickDevice(page:Page,option:string) {
 await field(page,'Inventory device').dblclick();
 await page.getByRole('button',{name:'Inventory device',exact:true}).click();
 await page.getByRole('option',{name:option}).click();
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByRole('button',{name:'Inventory device',exact:true})).toHaveCount(0);
}

for(const theme of ['light','dark'] as const) {
 test(`Cloud assets link through the shared picker and create devices through the device form in ${theme}`,async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  let posts=0;
  const devices=[mockDevice({id:7,hostname:'Existing server',ip_address:'10.0.0.7'})];
  const state=await setupExternalIps(page,{theme,devices,providers:[AWS],addresses:[mockAddress({label:'Public service',ip_address:'203.0.113.10'})],beforeGoto:async page=>{
   await common(page);
   await page.route('**/api/v1/topology/devices',route=>{
    if(route.request().method()!=='POST') return route.fallback();
    posts++; return route.fulfill({json:mockDevice({id:88,...route.request().postDataJSON()})});
   });
  }});
  await page.goto('/inventory#cloud-assets');
  await page.getByRole('button',{name:'Open Public service details'}).click();
  const sidebar=page.getByRole('complementary',{name:'Asset overview'});
  await field(page,'Inventory device').dblclick();
  await expect(sidebar.locator('select')).toHaveCount(0);
  const trigger=sidebar.getByRole('button',{name:'Inventory device',exact:true});
  await expect(trigger).toHaveClass(/nm-pick-trigger/);
  await trigger.click();
  const menu=page.locator('.nm-pick-menu');
  await expect(menu).toBeVisible();
  const token=await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--nm-modal-header').trim());
  expect(token).not.toBe('');
  const menuBg=await menu.evaluate(el=>getComputedStyle(el).backgroundColor);
  const probe=await page.evaluate(token=>{const el=document.createElement('div');el.style.background=token;document.body.appendChild(el);const value=getComputedStyle(el).backgroundColor;el.remove();return value;},token);
  expect(menuBg).toBe(probe);
  await page.getByRole('button',{name:'Create device…'}).click();
  const form=page.getByRole('dialog',{name:'Add device',exact:true});
  await expect(form.getByLabel('IP address',{exact:true})).toHaveValue('203.0.113.10');
  await form.getByRole('button',{name:'Save',exact:true}).click();
  await expect(form).toBeHidden();
  expect(posts).toBe(1);
  expect(state.addressPatches.at(-1)).toEqual([1,{device_id:88}]);
  await expect(sidebar.getByRole('button',{name:'Open linked device'})).toBeVisible();
  await pickDevice(page,'Not linked');
  expect(state.addressPatches.at(-1)).toEqual([1,{device_id:null}]);
  await pickDevice(page,'Existing server');
  expect(state.addressPatches.at(-1)).toEqual([1,{device_id:7}]);
  await sidebar.getByRole('button',{name:'Unlink device',exact:true}).click();
  expect(state.addressPatches.at(-1)).toEqual([1,{device_id:null}]);
  await expect(sidebar.getByRole('button',{name:'Add to Inventory',exact:true})).toBeVisible();
 });
}

test('retained resources open the device form with their name and link the created device',async({page})=>{
 let asset={id:4,name:'Retained VM',kind:'vm',provider_id:null as number|null,account:null,region:null,device_id:null as number|null,description:null};
 const patches:unknown[]=[];
 await setupExternalIps(page,{devices:[],beforeGoto:async page=>{
  await common(page);
  await page.route('**/api/v1/ipam/external/assets',route=>route.fulfill({json:[asset]}));
  await page.route('**/api/v1/ipam/external/assets/4',async route=>{const patch=route.request().postDataJSON();patches.push(patch);asset={...asset,...patch};await route.fulfill({json:asset});});
  await page.route('**/api/v1/topology/devices',route=>route.request().method()==='POST'?route.fulfill({json:mockDevice({id:90,...route.request().postDataJSON()})}):route.fallback());
 }});
 await page.goto('/inventory#cloud-assets');
 await page.getByRole('button',{name:'Open Retained VM details'}).click();
 await page.getByRole('button',{name:'Add to Inventory',exact:true}).click();
 const form=page.getByRole('dialog',{name:'Add device',exact:true});
 await expect(form.getByLabel('Display name',{exact:true})).toHaveValue('Retained VM');
 await form.getByLabel('IP address',{exact:true}).fill('198.51.100.4');
 await form.getByRole('button',{name:'Save',exact:true}).click();
 await expect(form).toBeHidden();
 expect(patches.at(-1)).toEqual({device_id:90});
});

test('a failed link after creating a device retries without creating a second device',async({page})=>{
 let posts=0,fail=true;
 const state=await setupExternalIps(page,{addresses:[mockAddress({label:'Public service'})],beforeGoto:async page=>{
  await common(page);
  await page.route('**/api/v1/topology/devices',route=>{if(route.request().method()!=='POST') return route.fallback(); posts++; return route.fulfill({json:mockDevice({id:91,...route.request().postDataJSON()})});});
  await page.route('**/api/v1/ipam/external/addresses/1',route=>fail?route.fulfill({status:500,json:{detail:'Link failed'}}):route.fallback());
 }});
 await page.goto('/inventory#cloud-assets');
 await page.getByRole('button',{name:'Open Public service details'}).click();
 await page.getByRole('button',{name:'Add to Inventory',exact:true}).click();
 const form=page.getByRole('dialog').filter({has:page.locator('.device-form')});
 await form.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByText(/Link failed/).first()).toBeVisible();
 fail=false;
 await page.getByRole('button',{name:'Retry link',exact:true}).click();
 await expect(form).toBeHidden();
 expect(posts).toBe(1);
 expect(state.addressPatches.at(-1)).toEqual([1,{device_id:91}]);
});

test('address editors without Inventory write can link but cannot create devices',async({page})=>{
 await setupExternalIps(page,{devices:[mockDevice({id:7,hostname:'Existing server'})],addresses:[mockAddress({label:'Public service'})],beforeGoto:common});
 await page.route('**/api/v1/auth/me',route=>route.fulfill({json:{id:3,username:'ipam',email:'ipam@example.com',role:'Operator',is_active:true,permissions:['topology_read','ipam_read','ipam_write']}}));
 await page.goto('/inventory#cloud-assets');
 await page.getByRole('button',{name:'Open Public service details'}).click();
 await expect(page.getByRole('button',{name:'Add to Inventory',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Link device',exact:true})).toBeVisible();
 await expect(field(page,'Owner')).toHaveClass(/editable-dd/);
 await field(page,'Inventory device').dblclick();
 await page.getByRole('button',{name:'Inventory device',exact:true}).click();
 await expect(page.getByRole('option',{name:'Existing server'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Create device…'})).toHaveCount(0);
});

test('Inventory-only writers can inspect linked context but cannot edit or relink cloud assets',async({page})=>{
 await setupExternalIps(page,{devices:[mockDevice({id:7,hostname:'Existing server'})],addresses:[mockAddress({label:'Public service',device_id:7}),mockAddress({id:2,label:'Spare'})],beforeGoto:common});
 await page.route('**/api/v1/auth/me',route=>route.fulfill({json:{id:4,username:'inventory',email:'inventory@example.com',role:'Operator',is_active:true,permissions:['topology_read','topology_write','ipam_read']}}));
 await page.goto('/inventory#cloud-assets');
 const sidebar=page.getByRole('complementary',{name:'Asset overview'});
 await page.getByRole('button',{name:'Open Spare details'}).click();
 await expect(sidebar.locator('.editable-dd')).toHaveCount(0);
 await expect(sidebar.locator('.details-edit-hint')).toHaveCount(0);
 for(const name of ['Add to Inventory','Link device','Unlink device']) await expect(sidebar.getByRole('button',{name,exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Open Existing server details'}).click();
 await expect(sidebar.getByRole('button',{name:'Show in Devices',exact:true})).toBeVisible();
 await expect(sidebar.getByRole('button',{name:'Unlink device',exact:true})).toHaveCount(0);
 await expect(sidebar.locator('.editable-dd')).toHaveCount(0);
});

import {expect,test,type Page} from '@playwright/test';
import {setupExternalIps,mockAddress,AWS} from './helpers/external-ip';
import {mockDevice,mockMonitoringDevice,setupInventoryMocks} from './helpers/api-mocks';

async function open(page:Page,theme:'light'|'dark',width:number) {
 await page.route('**/api/v1/topology/devices/*/security-events?*',route=>route.fulfill({json:{device_id:7,window_hours:24,blocked_count:0,passed_count:0,total_count:0,last_seen_event_time:null,events:[]}}));
 await page.route(/\/api\/v1\/monitoring\/devices\/\d+$/,route=>route.fulfill({json:mockMonitoringDevice({device_id:7})}));
 await page.setViewportSize({width,height:1000});
 const devices=[mockDevice({id:7,hostname:'Public server',ip_address:'8.8.8.8'})];
 await setupExternalIps(page,{theme,devices,providers:[AWS],accounts:[{id:1,name:'Production',provider_id:1}],locations:[{id:1,account_id:1,name:'Sydney',region:'au'}],addresses:[mockAddress({label:'Public service',device_id:7}),mockAddress({id:2,ip_address:'8.8.4.4',label:'Spare'})]});
 await setupInventoryMocks(page,devices);
 await page.goto('/inventory#cloud-assets');
}

async function expectOneRow(page:Page) {
 const boxes=await page.locator('.inventory-device-sidebar .detail-actions--device').last().locator('.nm-btn').evaluateAll(els=>els.map(el=>({top:Math.round(el.getBoundingClientRect().top),clipped:el.scrollWidth>el.clientWidth})));
 expect(boxes.length).toBeGreaterThan(1);
 expect(new Set(boxes.map(box=>box.top)).size).toBe(1);
 expect(boxes.some(box=>box.clipped)).toBe(false);
}

for(const theme of ['light','dark'] as const) {
 test(`editable sidebar fields hover with the shared tab hover tint in ${theme}`,async({page})=>{
  await open(page,theme,1440);
  await page.getByRole('button',{name:'Open Public server details'}).click();
  const field=page.locator('.inventory-device-sidebar dt:text-is("Inventory device") + dd');
  await field.hover();
  await expect.poll(async()=>field.evaluate(el=>{
   const probe=document.createElement('span'); probe.style.background='var(--nm-tab-hover-bg)'; document.body.append(probe);
   const want=getComputedStyle(probe).backgroundColor; probe.remove();
   return getComputedStyle(el).backgroundColor===want;
  })).toBe(true);
 });

 for(const width of [1440,1100]) test(`asset sidebar actions sit on one row at ${width}px in ${theme}`,async({page})=>{
  await open(page,theme,width);
  await page.getByRole('button',{name:'Open Public server details'}).click();
  await expectOneRow(page);
  await page.getByRole('button',{name:'Open Spare details'}).click();
  await expectOneRow(page);
  await expect(page.locator('.inventory-device-sidebar .detail-actions--inline .nm-btn').last()).toHaveText('Add to Inventory');
 });
}

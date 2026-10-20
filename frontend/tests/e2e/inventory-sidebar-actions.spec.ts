import {expect,test,type Locator} from '@playwright/test';
import {setupExternalIps,mockAddress} from './helpers/external-ip';
import {mockDevice,mockMonitoringDevice} from './helpers/api-mocks';

async function look(locator:Locator) {
 return locator.evaluate(el=>{const s=getComputedStyle(el);return {image:s.backgroundImage,background:s.backgroundColor,color:s.color,border:s.borderTopColor,height:el.getBoundingClientRect().height};});
}

for(const theme of ['light','dark'] as const) {
 test(`sidebar action rows use canonical buttons with the Devices spacing in ${theme}`,async({page})=>{
  await page.setViewportSize({width:1600,height:1000});
  await setupExternalIps(page,{theme,devices:[mockDevice({id:7,hostname:'Profiled device',snmp_profile_id:1})],addresses:[mockAddress({label:'Public service'})],beforeGoto:async page=>{
   await page.route('**/api/v1/admin/device-types',route=>route.fulfill({json:[]}));
   await page.route('**/api/v1/tools/snmp/profiles',route=>route.fulfill({json:[{id:1,name:'Core SNMP',version:'v2c',community:null,port:161,timeout_seconds:2,retries:1}]}));
   await page.route('**/api/v1/topology/devices/*/security-events?*',route=>route.fulfill({json:{device_id:7,window_hours:24,blocked_count:0,passed_count:0,total_count:0,last_seen_event_time:null,events:[]}}));
   await page.route(/\/api\/v1\/monitoring\/devices\/\d+$/,route=>route.fulfill({json:mockMonitoringDevice({device_id:7})}));
  }});
  await page.goto('/inventory#devices');
  await page.addStyleTag({content:'*, *::before, *::after { transition: none !important; }'});
  await page.getByRole('button',{name:'Open Profiled device details'}).click();
  const devices=page.getByRole('complementary',{name:'Device overview'});
  const pause=await look(devices.getByRole('button',{name:'Pause',exact:true}));
  const snmp=await look(devices.getByRole('button',{name:'SNMP ARP preview'}));
  expect(snmp.image).toBe('none');
  expect(snmp.height).toBe(pause.height);

  await page.goto('/inventory#cloud-assets');
  await page.addStyleTag({content:'*, *::before, *::after { transition: none !important; }'});
  await page.mouse.move(0,0);
  const toolbarSecondary=await look(page.locator('.inventory-panel-header a.nm-btn--secondary'));
  await page.getByRole('button',{name:'Open Public service details'}).click();
  await page.mouse.move(0,0);
  const sidebar=page.getByRole('complementary',{name:'Asset overview'});
  const secondaries=sidebar.locator('.detail-actions button.nm-btn--secondary');
  expect(await secondaries.count()).toBeGreaterThan(0);
  for(const button of await secondaries.all()) {
   const style=await look(button);
   expect(style.image).toBe('none');
   expect({background:style.background,color:style.color,border:style.border}).toEqual({background:toolbarSecondary.background,color:toolbarSecondary.color,border:toolbarSecondary.border});
   expect(style.height).toBe(pause.height);
  }
  const rows=await sidebar.locator('.detail-actions').evaluateAll(rows=>rows.map(row=>{
   const buttons=[...row.children].map(child=>child.getBoundingClientRect());
   return {gap:parseFloat(getComputedStyle(row).columnGap),spacing:buttons.slice(1).map((rect,index)=>rect.top===buttons[index].top?Math.round(rect.left-buttons[index].right):null).filter(value=>value!==null)};
  }));
  for(const row of rows) for(const spacing of row.spacing) expect(spacing).toBe(row.gap);
 });
}

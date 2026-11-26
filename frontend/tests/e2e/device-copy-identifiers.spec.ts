import {expect,test,type Page} from '@playwright/test';
import {setupExternalIps} from './helpers/external-ip';
import {mockDevice,mockMonitoringDevice} from './helpers/api-mocks';

async function open(page:Page,theme:'light'|'dark'='dark',device=mockDevice({id:7,hostname:'edge-router.lan',ip_address:'10.30.30.1',mac_address:'AA:BB:CC:11:22:33'})) {
 await setupExternalIps(page,{theme,devices:[device],beforeGoto:async page=>{
  await page.route('**/api/v1/topology/devices/*/security-events?*',route=>route.fulfill({json:{device_id:7,window_hours:24,blocked_count:0,passed_count:0,total_count:0,last_seen_event_time:null,events:[]}}));
  await page.route(/\/api\/v1\/monitoring\/devices\/\d+$/,route=>route.fulfill({json:mockMonitoringDevice({device_id:7})}));
 }});
 await page.goto('/inventory#devices');
 await page.locator('button[aria-label^="Open "][aria-label$=" details"]').first().click();
 return page.getByRole('complementary',{name:'Device overview'});
}

test('copies hostname, IP and MAC with the clipboard API and shows a check',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 const panel=await open(page);
 for (const [label,value] of [['hostname','edge-router.lan'],['IP address','10.30.30.1'],['MAC address','AA:BB:CC:11:22:33']]) {
  const button=panel.getByRole('button',{name:`Copy ${label}`});
  await button.click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(value);
  await expect(panel.getByRole('button',{name:`Copied ${label}`})).toBeVisible();
 }
 await expect(panel.getByRole('button',{name:'Copy hostname'})).toBeVisible({timeout:3000});
});

test('falls back to execCommand when navigator.clipboard is unavailable',async({page})=>{
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});
  const copied:string[]=[];
  (window as unknown as {__copied:string[]}).__copied=copied;
  document.execCommand=((command:string)=>{
   if (command!=='copy') return false;
   const active=document.activeElement;
   copied.push(active instanceof HTMLTextAreaElement?active.value.slice(active.selectionStart,active.selectionEnd):'');
   return true;
  }) as typeof document.execCommand;
 });
 const panel=await open(page);
 await panel.getByRole('button',{name:'Copy IP address'}).click();
 await expect(panel.getByRole('button',{name:'Copied IP address'})).toBeVisible();
 expect(await page.evaluate(()=>(window as unknown as {__copied:string[]}).__copied)).toEqual(['10.30.30.1']);
 await expect(page.locator('body > textarea')).toHaveCount(0);
});

test('unset identifiers have no copy button and copying does not start editing',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 const panel=await open(page,'dark',mockDevice({id:7,hostname:'edge-router.lan',ip_address:'10.30.30.1',mac_address:null}));
 await expect(panel.getByRole('button',{name:'Copy MAC address'})).toHaveCount(0);
 const button=panel.getByRole('button',{name:'Copy hostname'});
 await button.dblclick();
 await expect(panel.locator('dt:has-text("Hostname") + dd input')).toHaveCount(0);
});

for (const theme of ['light','dark'] as const) {
 test(`copy buttons are compact icon buttons that keep the row height in ${theme}`,async({page})=>{
  const panel=await open(page,theme);
  await expect(page.locator('body')).toHaveClass(theme==='dark'?/theme-dark/:/^(?!.*theme-dark)/);
  const button=panel.getByRole('button',{name:'Copy hostname'});
  await expect(button).toHaveClass(/nm-btn--icon-sm/);
  const box=await button.boundingBox();
  expect(box?.height).toBe(24);
  expect(box?.width).toBe(24);
  const withCopy=await panel.locator('dt:has-text("Hostname") + dd').boundingBox();
  const without=await panel.locator('dt:has-text("Vendor") + dd').boundingBox();
  expect(withCopy!.height).toBeLessThanOrEqual(without!.height+2);
 });
}

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockDevice, mockMonitoringDevice, mockUser, setupInventoryMocks, setupMonitoringMocks } from './helpers/api-mocks';
import { AWS, mockAddress, setupExternalIps } from './helpers/external-ip';

// Resolve Color 4 and translucent fills against their real ancestor surfaces.
async function colours(locator: Locator) {
 return locator.evaluate(el=>{
  const ctx=document.createElement('canvas').getContext('2d')!;
  function rgba(value:string) { ctx.clearRect(0,0,1,1); ctx.fillStyle=value; ctx.fillRect(0,0,1,1); return Array.from(ctx.getImageData(0,0,1,1).data).map((v,i)=>i===3?v/255:v); }
  function over(fg:number[],bg:number[]) { return [0,1,2].map(i=>fg[i]*fg[3]+bg[i]*(1-fg[3])).concat(1); }
  const ancestors:Element[]=[]; for(let p=el.parentElement;p;p=p.parentElement) ancestors.unshift(p);
  let parent=[255,255,255,1]; for(const p of ancestors) parent=over(rgba(getComputedStyle(p).backgroundColor),parent);
  const cs=getComputedStyle(el),raw=rgba(cs.backgroundColor),bg=over(raw,parent),fg=over(rgba(cs.color),bg);
  function lum(rgb:number[]) { return rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0); }
  const a=lum(fg),b=lum(bg);
  return {alpha:raw[3],contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),depth:Math.hypot(...bg.slice(0,3).map((v,i)=>v-parent[i]))};
 });
}
async function fixture(page:Page,theme:'light'|'dark',enabled=true) {
 const devices=[mockDevice({id:1,hostname:'Core gateway with a longer name',device_type:'router',topology_group:'Core',site_id:1,is_favourite:true}),mockDevice({id:2,hostname:'Offline server',monitor_status:'offline',device_type:'server',topology_group:'Core',site_id:1}),mockDevice({id:3,hostname:'Unassigned device',monitoring_paused:true})];
 await setupExternalIps(page,{theme,devices,providers:[AWS],accounts:[{id:1,provider_id:1,name:'Production'}],locations:[{id:1,account_id:1,name:'Sydney DC',region:'AU-SYD'}],addresses:[mockAddress({location_id:1,label:'Public server',device_id:1}),mockAddress({id:2,label:'Unlinked address'})]});
 await setupInventoryMocks(page,devices);
 await setupMonitoringMocks(page,[mockMonitoringDevice({is_favourite:true}),mockMonitoringDevice({device_id:2,hostname:'Offline server',status:'offline',health_status:'unhealthy',uptime_24h:.8,compliance_24h:.8}),mockMonitoringDevice({device_id:3,status:'warning',health_status:'unknown',uptime_24h:.95,compliance_24h:.95})]);
 await page.route('**/api/v1/topology/devices/favourites',r=>r.fulfill({json:[1]}));
 await page.route('**/api/v1/auth/me',r=>r.fulfill({json:{...mockUser,entity_colors_enabled:enabled}}));
 await page.route('**/api/v1/admin/settings/*',r=>r.fulfill({json:{app_name:'NetMap',announcement:'NetMap Development Image'}}));
 await page.route('**/api/v1/topology/groups*',r=>r.fulfill({json:[{id:1,name:'Core',color:'#06b6d4'}]}));
 for(const path of ['topology/sites','sites']) await page.route(`**/api/v1/${path}*`,r=>r.fulfill({json:[{id:1,name:'Home Network',color:'#ef4444'}]}));
 await page.route('**/api/v1/admin/device-types',r=>r.fulfill({json:[{id:null,value:'router',label:'Router',icon:'router',is_builtin:true,color:'#8b5cf6'},{id:null,value:'server',label:'Server',icon:'server',is_builtin:true,color:'#22c55e'}]}));
 await page.route('**/api/v1/discovery/observations*',r=>r.fulfill({json:[{id:1,status:'open',observation_type:'new_device',ip_address:'192.168.1.3'}]}));
}
for(const theme of ['light','dark'] as const) {
 for(const width of [1500,700]) test(`shared colours remain readable in ${theme} at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:1000}); await fixture(page,theme);
  const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/overview');
  for(const selector of ['.dash-alert--announcement','.dash-alert--changes','.dash-alert--overview-bar:not(.dash-alert--changes)','.mon-uptime-good']) {
   const item=page.locator(selector).first(); await expect(item).toBeVisible(); const c=await colours(item);
   if(theme==='light') { expect(c.depth,selector).toBeGreaterThan(30); expect(c.contrast,selector).toBeGreaterThanOrEqual(4.5); }
  }
  if(theme==='dark') await expect(page.locator('.mon-uptime-good').first()).toHaveCSS('background-color','rgba(45, 186, 124, 0.15)');
  await page.screenshot({path:info.outputPath(`overview-${theme}-${width}.png`),fullPage:true});
  const review=page.locator('.dash-alert--changes .dash-alert-link'); await review.focus(); await expect(review).toBeFocused();
  await page.locator('.dash-alert--changes .dash-alert-dismiss').hover(); await page.locator('.dash-alert--changes .dash-alert-dismiss').click(); await expect(page.locator('.dash-alert--changes')).toHaveCount(0);
  await page.goto('/inventory#devices'); const online=page.locator('.status-pill.online').first(); await expect(online).toBeVisible();
  if(theme==='light') { expect((await colours(online)).depth).toBeGreaterThan(40); expect((await colours(online)).contrast).toBeGreaterThanOrEqual(4.5); }
  const chips=page.locator('.inventory-row .nm-chip:not(.nm-chip--empty)'); await expect(chips.first()).toBeVisible();
  for(const chip of await chips.all()) { const c=await colours(chip); expect(c.contrast).toBeGreaterThanOrEqual(4.5); expect(c.alpha).toBeCloseTo(theme==='light'?.12:.06,2); }
  await expect(page.locator('.nm-chip--empty').first()).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await page.screenshot({path:info.outputPath(`devices-${theme}-${width}.png`),fullPage:true});
  await page.goto('/inventory#cloud-assets'); await expect(page.locator('[data-cloud-record]')).toHaveCount(2);
  for(const chip of await page.locator('[data-cloud-record] .nm-chip:not(.nm-chip--empty)').all()) expect((await colours(chip)).alpha).toBeCloseTo(theme==='light'?.12:.06,2);
  await page.screenshot({path:info.outputPath(`cloud-${theme}-${width}.png`),fullPage:true});
  await page.goto('/monitoring#devices'); await expect(page.locator('.mon-uptime-good').first()).toBeVisible();
  if(theme==='light') for(const tone of ['good','warn','bad']) {const c=await colours(page.locator(`.mon-uptime-${tone}`).first());expect(c.depth).toBeGreaterThan(30);expect(c.contrast).toBeGreaterThanOrEqual(4.5);}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 });
 test(`entity colour opt-out stays neutral in ${theme}`,async({page})=>{
  await fixture(page,theme,false);await page.goto('/inventory#devices');await expect(page.locator('.nm-chip--nocolor').first()).toBeVisible();
  for(const chip of await page.locator('.nm-chip--nocolor').all()) {await expect(chip).toHaveCSS('background-color','rgba(0, 0, 0, 0)');expect(await chip.getAttribute('style')).toBeNull();}
  await page.goto('/inventory#cloud-assets');await expect(page.locator('.nm-chip--nocolor').first()).toBeVisible();await expect(page.locator('.nm-chip--nocolor').first()).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
 });
}

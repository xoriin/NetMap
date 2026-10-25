import { expect, test } from '@playwright/test';
import { mockAddress, setupExternalIps, AWS } from './helpers/external-ip';
import { mockDevice } from './helpers/api-mocks';

for (const theme of ['light', 'dark'] as const) {
 test(`Cloud assets restores linked and unlinked addresses in ${theme}`, async ({page}) => {
  await setupExternalIps(page, {theme, providers:[AWS], accounts:[{id:1,provider_id:1,name:'Production'}], locations:[{id:1,account_id:1,name:'Sydney',region:'au'}],
   devices:[mockDevice({id:7,hostname:'Public server',ip_address:'8.8.8.8'})], addresses:[
    mockAddress({id:1,device_id:7,ip_address:'8.8.8.8',location_id:1,label:'Primary'}),
    mockAddress({id:2,device_id:7,ip_address:'8.8.4.4',location_id:1,label:'Secondary'}),
    mockAddress({id:3,ip_address:'2606:4700:4700::1111',status:'reserved'}),
   ]});
  await page.route('**/api/v1/admin/device-types', route=>route.fulfill({json:[]}));
  await page.goto('/inventory#cloud-assets');
  const table=page.locator('.inventory-table');
  await expect(table).toBeVisible();
  await expect(table).toContainText('8.8.8.8'); await expect(table).toContainText('8.8.4.4');
  await expect(table).toContainText('2606:4700:4700::1111');
  await expect(table.locator('.inventory-row')).toHaveCount(3);
  await expect(table).toContainText('Not monitored');
  const firstHeader=table.locator('.inventory-table-header');
  expect(await firstHeader.evaluate(el=>getComputedStyle(el).fontSize)).toBe('11px');
  const bg=await table.evaluate(el=>getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  const cell=table.locator('[data-cloud-record]').first();
  await cell.hover();
  expect(await cell.evaluate(el=>getComputedStyle(el).boxShadow)).toContain('inset');
  await page.getByRole('textbox',{name:'Search cloud assets'}).fill('Secondary');
  await expect(table.getByText('8.8.4.4',{exact:true})).toBeVisible();
  await expect(table.getByText('8.8.8.8',{exact:true})).toBeHidden();
  await page.getByRole('textbox',{name:'Search cloud assets'}).fill('');
  await page.getByRole('link',{name:'Devices',exact:true}).click();
  await expect(page.locator('.inventory-table')).toBeVisible();
  await page.goBack(); await expect(table).toBeVisible();
  await page.reload(); await expect(table).toBeVisible();
  await page.setViewportSize({width:780,height:850});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
 });
}

test('Cloud assets has empty, failed and retry states', async ({page})=>{
 await setupExternalIps(page);
 await page.route('**/api/v1/admin/device-types', route=>route.fulfill({json:[]}));
  await page.goto('/inventory#cloud-assets');
 await expect(page.getByText('No cloud assets yet.',{exact:false})).toBeVisible();
 let fail=true;
 await page.route('**/api/v1/ipam/external/addresses', route=>route.fulfill(fail?{status:500,json:{detail:'Register unavailable'}}:{json:[]}));
 await page.reload(); await expect(page.getByRole('alert')).toContainText('Register unavailable');
 fail=false; await page.getByRole('button',{name:'Retry',exact:true}).click();
 await expect(page.getByText('No cloud assets yet.',{exact:false})).toBeVisible();
 await page.getByRole('link',{name:'Manage external IPs'}).click();
 await expect(page).toHaveURL(/ipam#external$/);
 await expect(page.getByRole('button',{name:'Add external IP'}).first()).toBeVisible();
});

for (const theme of ['light','dark'] as const) {
 test(`saved resources without addresses are visible in ${theme}`,async ({page})=>{
  await setupExternalIps(page,{theme,beforeGoto:async page=>{
   await page.route('**/api/v1/ipam/external/assets',route=>route.fulfill({json:[{
    id:4,name:'Retained gateway',kind:'nat_gateway',provider_id:null,account:'Production',region:'Sydney',device_id:null,description:'Original description',
   }]}));
  }});
  await page.goto('/inventory#cloud-assets');
  await expect(page.getByText('Retained gateway',{exact:true})).toBeVisible();
  await expect(page.getByText('Not monitored',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Retained gateway details'}).click();
  await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('Original description');
 });
}

test('dense cloud register keeps long metadata inside its scroll viewport',async ({page})=>{
 await setupExternalIps(page,{addresses:Array.from({length:100},(_,i)=>mockAddress({id:i+1,ip_address:`8.8.8.${i+1}`,label:'A long public endpoint name '.repeat(8),notes:'Retained notes'}))});
 await page.goto('/inventory#cloud-assets');
 await expect(page.locator('[data-cloud-record]')).toHaveCount(25);
 await expect(page.locator('.inv-pagination-info')).toContainText('of 100 records');
 await page.getByRole('button',{name:'Next ›',exact:true}).click();
 await expect(page.locator('[data-cloud-record]')).toHaveCount(25);
 await page.setViewportSize({width:780,height:850});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

for (const theme of ['light','dark'] as const) {
 test(`Cloud assets shares the Devices table design in ${theme}`,async ({page})=>{
  await setupExternalIps(page,{theme,devices:[mockDevice({id:7,hostname:'Public server',ip_address:'8.8.8.8'})],addresses:[mockAddress({device_id:7,ip_address:'8.8.8.8'})],beforeGoto:async page=>{
   await page.route('**/api/v1/admin/device-types',route=>route.fulfill({json:[]}));
  }});
  async function styles(selector:string, properties:string[]) {
   return page.locator(selector).first().evaluate((el,properties)=>Object.fromEntries(properties.map(key=>[key,getComputedStyle(el).getPropertyValue(key)])),properties);
  }
  async function design(row:string) {
   return {
    panel:await styles('.inventory-surface',['background-color','border-color','border-radius','box-shadow']),
    toolbar:await styles('.inventory-panel-header',['background-color','padding','gap','min-height']),
    header:await styles('.inventory-table-header',['background-color','color','font-size','font-weight','padding','letter-spacing','border-bottom-color','height']),
    row:await styles(row,['background-color','color','font-size','line-height','height','padding','border-bottom-color','border-left-width']),
    search:await styles('.inv-search-box',['background-color','border-color','border-radius','height']),
    footer:await styles('.inv-pagination',['background-color','color','padding','border-top-color']),
   };
  }
  await page.goto('/inventory#devices');
  await expect(page.locator('.inventory-row')).toBeVisible();
  await page.addStyleTag({content:'*, *::before, *::after { transition: none !important; animation: none !important; }'});
  await page.mouse.move(0,0);
  const devices=await design('.inventory-row');
  await page.locator('.inventory-row').first().hover();
  const deviceHover=await styles('.inventory-row',['background-color','box-shadow','border-left-color']);
  await page.getByRole('link',{name:'Cloud assets',exact:true}).click();
  await expect(page.locator('[data-cloud-record]')).toBeVisible();
  await page.mouse.move(0,0);
  expect(await design('[data-cloud-record]')).toEqual(devices);
  await page.locator('[data-cloud-record]').first().hover();
  expect(await styles('[data-cloud-record]',['background-color','box-shadow','border-left-color'])).toEqual(deviceHover);
  const handle=page.locator('.inventory-col-resize-handle').first();
  const box=await handle.boundingBox();
  const before=await page.locator('.inventory-th').first().evaluate(el=>el.getBoundingClientRect().width);
  await page.mouse.move(box!.x+3,box!.y+10); await page.mouse.down(); await page.mouse.move(box!.x+70,box!.y+10); await page.mouse.up();
  expect(await page.locator('.inventory-th').first().evaluate(el=>el.getBoundingClientRect().width)).toBeGreaterThan(before+40);
  await page.reload(); await expect(page.locator('.inventory-table--fixed')).toBeVisible();
  await page.locator('.inventory-col-resize-handle').first().dblclick();
  await expect(page.locator('.inventory-table--fixed')).toHaveCount(0);
  await page.setViewportSize({width:780,height:850});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  const layout = await page.locator('.inventory-stats').evaluate(el => ({width:el.clientWidth,scroll:el.scrollWidth,columns:getComputedStyle(el).gridTemplateColumns.split(' ').length}));
  expect(layout.scroll).toBeLessThanOrEqual(layout.width); expect(layout.columns).toBe(2);
  expect(await page.locator('.inventory-table-header').evaluate(el=>el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(1200);
 });
}

for (const theme of ['light','dark'] as const) {
 test(`whole Cloud workspace follows Devices composition with real lifecycle states in ${theme}`,async({page})=>{
  await page.setViewportSize({width:2315,height:1289});
  await setupExternalIps(page,{theme,addresses:[mockAddress({ip_address:'110.50.33.120',label:'Virtual Machine'}),mockAddress({id:2,ip_address:'203.11.55.200',status:'available'})],beforeGoto:async page=>{
   await page.route('**/api/v1/admin/settings/*',route=>route.fulfill({json:{app_name:'NetMap',idle_timeout_minutes:15,announcement:'NetMap Development Image'}}));
   await page.route('**/api/v1/ipam/external/assets',route=>route.fulfill({json:[{id:1,name:'VM',kind:null,provider_id:null,account:null,region:null,device_id:null,description:null},{id:2,name:'web-test-01',kind:'ec2',provider_id:1,account:null,region:'ap-east',device_id:null,description:null}]}));
  }});
  await page.goto('/inventory#cloud-assets');
  await expect(page.locator('.inventory-stats .dash-stat')).toHaveCount(4);
  for(const name of ['Filter by provider','Filter by cloud location','Filter by asset type','Filter by monitoring']) await expect(page.getByRole('button',{name})).toBeVisible();
  await expect(page.locator('.inventory-row')).toHaveCount(4);
  await expect(page.locator('[data-cloud-record="address-1"]')).not.toContainText('online');
  const neutral=page.locator('[data-cloud-record="address-2"] .nm-status--unknown').first();
  await expect(neutral).toBeVisible();
  if(theme==='dark') {
   expect(await neutral.evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgb(237, 243, 247)');
   expect(await page.locator('.status-pill.unknown').first().evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgb(237, 243, 247)');
  }
 });
}

for (const theme of ['light','dark'] as const) {
 test(`Cloud filters, favourites and shared details work in ${theme}`,async({page})=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await setupExternalIps(page,{theme,providers:[AWS],accounts:[{id:1,provider_id:1,name:'Production'}],locations:[{id:1,account_id:1,name:'Sydney',region:'au'}],devices:[mockDevice({id:7,hostname:'Public server',ip_address:'8.8.8.8',expected_status:'offline',monitor_status:'offline',is_favourite:true})],addresses:[mockAddress({device_id:7,ip_address:'8.8.8.8',location_id:1}),mockAddress({id:2,ip_address:'2606:4700:4700::1111',status:'reserved',notes:'Retained notes'})]});
  await page.route('**/api/v1/topology/devices/favourites',route=>route.fulfill({json:[7]}));
  await page.goto('/inventory#devices');
  const stats=await page.locator('.inventory-stats').boundingBox();
  const panel=await page.locator('.inventory-surface').boundingBox();
  await page.getByRole('link',{name:'Cloud assets',exact:true}).click();
  await expect(page.locator('[data-cloud-record]')).toHaveCount(2);
  const cloudStats=await page.locator('.inventory-stats').boundingBox();
  const cloudPanel=await page.locator('.inventory-surface').boundingBox();
  expect(cloudStats).toEqual(stats);
  // Both tables share the same workspace anchor and width; natural row height follows their data.
  expect(cloudPanel!.x).toBe(panel!.x);
  expect(cloudPanel!.y).toBe(panel!.y);
  expect(cloudPanel!.width).toBe(panel!.width);
  await expect(page.locator('[data-cloud-record="address-1"] .status-pill')).toHaveText('expected offline');
  await page.getByRole('button',{name:'Filter by provider'}).click();
  await page.getByRole('option',{name:'AWS',exact:true}).click();
  await expect(page.locator('[data-cloud-record]')).toHaveCount(1);
  await page.getByRole('button',{name:'Open Public server details'}).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Open device',exact:true}).click();
 await expect(page.getByRole('complementary',{name:'Device overview'})).toBeVisible();
  await page.getByRole('button',{name:'Close device overview'}).click();
  await page.getByRole('button',{name:'Filter by provider'}).click();
  await page.getByRole('option',{name:'All providers',exact:true}).click();
  await page.getByTitle('Show favourites only').click();
  await expect(page.locator('[data-cloud-record]')).toHaveCount(1);
  await page.getByTitle('Show all assets').click();
  await page.getByRole('button',{name:'Open 2606:4700:4700::1111 details'}).click();
  await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('Retained notes');
  await page.getByRole('button',{name:'Close asset overview'}).click();
  await expect(page.getByRole('complementary',{name:'Asset overview'})).toHaveCount(0);
  await page.getByRole('button',{name:'Filter by monitoring'}).click();
  await page.getByRole('option',{name:'Not linked',exact:true}).click();
  await expect(page.locator('[data-cloud-record]')).toHaveCount(1);
  expect(errors).toEqual([]);
 });
}

test('a retained device link without a graph observation stays unknown',async({page})=>{
 await setupExternalIps(page,{addresses:[mockAddress({device_id:99,status:'in_use',device:{id:99,hostname:'Retained device',display_name:null,ip_address:'203.0.113.10',device_type:null,site_id:null}})]});
 await page.goto('/inventory#cloud-assets');
 await expect(page.locator('[data-cloud-record] .status-pill')).toHaveText('Unknown');
 await expect(page.locator('.dash-stat').filter({hasText:'Linked devices'}).locator('strong')).toHaveText('1');
 await expect(page.locator('.dash-stat').filter({hasText:'Not linked'}).locator('strong')).toHaveText('0');
});

test('Cloud loading uses a skeleton and read-only users can inspect retained metadata',async({page})=>{
 await setupExternalIps(page,{addresses:[mockAddress({notes:'Retained notes'})]});
 await page.route('**/api/v1/auth/me',route=>route.fulfill({json:{id:2,username:'viewer',email:'viewer@example.com',role:'Viewer',is_active:true,permissions:['topology_read','ipam_read']}}));
 let finish:()=>void=()=>{};
 const waiting=new Promise<void>(resolve=>{finish=resolve;});
 await page.route('**/api/v1/ipam/external/addresses',async route=>{await waiting; await route.fulfill({json:[mockAddress({notes:'Retained notes'})]});});
 await page.goto('/inventory#cloud-assets');
 await expect(page.getByRole('status',{name:'Loading'}).first()).toBeVisible();
 finish();
 await page.getByRole('button',{name:'Open 203.0.113.10 details'}).click();
 await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('Retained notes');
 await expect(page.getByRole('button',{name:'Save',exact:true})).toHaveCount(0);
});

for (const theme of ['light','dark'] as const) {
 test(`unlinked Cloud items use the Devices sidebar treatment in ${theme}`,async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await setupExternalIps(page,{theme,devices:[mockDevice({id:7,hostname:'Reference device'})],addresses:[mockAddress({label:'Public service',notes:'Retained notes'})]});
  await page.goto('/inventory#devices');
  await page.getByRole('button',{name:'Open Reference device details'}).click();
  const reference=await page.locator('.inventory-device-sidebar').evaluate(el=>({width:el.getBoundingClientRect().width,background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderColor}));
  await page.goto('/inventory#cloud-assets');
  await page.getByRole('button',{name:'Open Public service details'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const sidebar=page.getByRole('complementary',{name:'Asset overview'});
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toContainText('Retained notes');
  expect(await sidebar.evaluate(el=>({width:el.getBoundingClientRect().width,background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderColor}))).toEqual(reference);
  await expect(sidebar.locator('.inventory-device-sidebar-header')).toHaveCSS('min-height','44px');
  const toolbar=await page.locator('.inventory-panel-header').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
  expect(toolbar.scroll).toBeLessThanOrEqual(toolbar.width);
  await page.setViewportSize({width:780,height:850});
  await expect(sidebar).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await sidebar.scrollIntoViewIfNeeded();
  await sidebar.getByRole('link',{name:'External IPs',exact:true}).scrollIntoViewIfNeeded();
  await expect(sidebar.getByRole('link',{name:'External IPs',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close asset overview'}).click();
  await expect(sidebar).toHaveCount(0);
 });
}

test('linked addresses, unlinked addresses and retained resources replace one detail sidebar',async({page})=>{
 await setupExternalIps(page,{devices:[mockDevice({id:7,hostname:'Public server'})],addresses:[mockAddress({device_id:7}),mockAddress({id:2,label:'Unlinked address'})],beforeGoto:async page=>{
  await page.route('**/api/v1/ipam/external/assets',route=>route.fulfill({json:[{id:4,name:'Retained gateway',kind:'nat_gateway',provider_id:null,account:null,region:null,device_id:null,description:'Original metadata'}]}));
 }});
 await page.goto('/inventory#cloud-assets');
 await page.getByRole('button',{name:'Open Public server details'}).click();
 await page.getByRole('button',{name:'Open device',exact:true}).click();
 await expect(page.getByRole('complementary',{name:'Device overview'})).toBeVisible();
 await page.getByRole('button',{name:'Open Unlinked address details'}).click();
 await expect(page.getByRole('complementary',{name:'Device overview'})).toHaveCount(0);
 await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('Unlinked address');
 await page.getByRole('button',{name:'Open Retained gateway details'}).click();
 await expect(page.locator('.inventory-device-sidebar')).toHaveCount(1);
 await expect(page.getByRole('complementary',{name:'Asset overview'})).toContainText('Original metadata');
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Close asset overview'}).click();
 await expect(page.locator('.topology-content.details-open')).toHaveCount(0);
});

for (const theme of ['light','dark'] as const) {
 test(`Cloud assets and Devices share the same neutral hover treatment in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:1600,height:900});
  await setupExternalIps(page,{theme,devices:Array.from({length:30},(_,i)=>mockDevice({id:i+1,hostname:`host-${i+1}`,ip_address:`10.0.0.${i+1}`})),
   addresses:Array.from({length:30},(_,i)=>mockAddress({id:i+1,ip_address:`8.8.8.${i+1}`,label:`Endpoint ${i+1}`}))});
  await page.route('**/api/v1/admin/device-types', route=>route.fulfill({json:[]}));
  const token = (name:string) => page.evaluate(variable=>{ const probe=document.createElement('i'); probe.style.color=`var(${variable})`; document.body.append(probe); const value=getComputedStyle(probe).color; probe.remove(); return value; }, name);
  const hovered = async (selector:string) => {
   const el=page.locator(selector).first();
   await el.hover();
   await page.waitForTimeout(250);
   const style=await el.evaluate(node=>{ const s=getComputedStyle(node); return {background:s.backgroundColor,color:s.color,border:s.borderTopColor}; });
   await page.mouse.move(0,0);
   return style;
  };
  const read = async () => {
   const next=await hovered('.inv-pagination-btn:not(:disabled)');
   await page.locator('.inventory-row:not(.inventory-table-header)').first().click();
   const field=await hovered('.editable-dd');
   const add=await page.locator('.inventory-panel-header .nm-btn--primary:visible').first().evaluate(node=>({height:getComputedStyle(node).height,radius:getComputedStyle(node).borderRadius}));
   return {next,field,add};
  };
  await page.goto('/inventory#devices');
  await page.locator('.inventory-row:not(.inventory-table-header)').first().waitFor();
  const devices=await read();
  await page.goto('/inventory#cloud-assets');
  await page.locator('[data-cloud-record]').first().waitFor();
  const cloud=await read();
  expect(cloud).toEqual(devices);
  const tabHoverBg=await token('--nm-tab-hover-bg');
  expect([cloud.next.background, cloud.field.background]).not.toContain(tabHoverBg);
  expect(cloud.next).toEqual({background:await token('--nm-btn-hover-bg'),color:await token('--nm-btn-hover-text'),border:await token('--nm-btn-hover-border')});
  expect(cloud.field.background).toBe(await token('--nm-row-hover'));
 });
}

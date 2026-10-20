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
  await expect(table).toContainText('AWS · Public server (2)');
  await expect(table).toContainText('Not linked to Inventory');
  const firstHeader=table.locator('.inventory-table-header');
  expect(await firstHeader.evaluate(el=>getComputedStyle(el).fontSize)).toBe('11px');
  const bg=await table.evaluate(el=>getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  const cell=table.locator('[data-cloud-record]').first();
  await cell.hover();
  expect(await cell.evaluate(el=>getComputedStyle(el).boxShadow)).toContain('inset');
  await page.getByRole('button',{name:'AWS · Public server (2)'}).click();
  await expect(table.getByText('8.8.8.8',{exact:true})).toBeHidden();
  await page.getByRole('button',{name:'AWS · Public server (2)'}).click();
  await page.getByRole('textbox',{name:'Search cloud assets'}).fill('Secondary');
  await expect(table.getByText('8.8.4.4',{exact:true})).toBeVisible();
  await expect(table.getByText('8.8.8.8',{exact:true})).toBeHidden();
  await page.getByRole('textbox',{name:'Search cloud assets'}).fill('');
  await page.screenshot({path:`/tmp/netmap-cloud-${theme}.png`});
  await page.getByRole('link',{name:'Devices',exact:true}).click();
  await expect(page.locator('.inventory-table')).toBeVisible();
  await page.goBack(); await expect(table).toBeVisible();
  await page.reload(); await expect(table).toBeVisible();
  await page.setViewportSize({width:780,height:850});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/netmap-cloud-${theme}-narrow.png`});
 });
}

test('Cloud assets has empty, failed and retry states', async ({page})=>{
 await setupExternalIps(page);
 await page.route('**/api/v1/admin/device-types', route=>route.fulfill({json:[]}));
  await page.goto('/inventory#cloud-assets');
 await expect(page.getByText('No external IPs tracked yet.',{exact:false})).toBeVisible();
 let fail=true;
 await page.route('**/api/v1/ipam/external/addresses', route=>route.fulfill(fail?{status:500,json:{detail:'Register unavailable'}}:{json:[]}));
 await page.reload(); await expect(page.getByRole('alert')).toContainText('Register unavailable');
 fail=false; await page.getByRole('button',{name:'Retry',exact:true}).click();
 await expect(page.getByText('No external IPs tracked yet.',{exact:false})).toBeVisible();
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
  await expect(page.getByText('Retained gateway · nat gateway',{exact:true})).toBeVisible();
  await expect(page.getByText('Original description',{exact:true})).toBeVisible();
  await expect(page.getByText('Not monitored',{exact:true})).toBeVisible();
  await page.screenshot({path:`/tmp/netmap-saved-assets-${theme}.png`});
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
    header:await styles('.inventory-table-header',['background-color','color','font-size','font-weight','padding','letter-spacing','border-bottom-color']),
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
  await page.screenshot({path:`/tmp/netmap-canonical-devices-${theme}.png`});
  await page.getByRole('link',{name:'Cloud assets',exact:true}).click();
  await expect(page.locator('[data-cloud-record]')).toBeVisible();
  await page.mouse.move(0,0);
  expect(await design('[data-cloud-record]')).toEqual(devices);
  await page.locator('[data-cloud-record]').first().hover();
  expect(await styles('[data-cloud-record]',['background-color','box-shadow','border-left-color'])).toEqual(deviceHover);
  await page.screenshot({path:`/tmp/netmap-canonical-cloud-${theme}.png`});
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
  await page.screenshot({path:`/tmp/netmap-canonical-cloud-${theme}-narrow.png`});
 });
}

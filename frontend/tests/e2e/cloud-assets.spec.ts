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
  const table=page.locator('.inventory-cloud-table');
  await expect(table).toBeVisible();
  await expect(table).toContainText('8.8.8.8'); await expect(table).toContainText('8.8.4.4');
  await expect(table).toContainText('2606:4700:4700::1111');
  await expect(table).toContainText('AWS · Public server (2)');
  await expect(table).toContainText('Not linked to Inventory');
  const firstHeader=table.locator('th').first();
  expect(await firstHeader.evaluate(el=>getComputedStyle(el).fontSize)).toBe('11px');
  const bg=await table.locator('tbody tr').nth(1).locator('td').first().evaluate(el=>getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
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

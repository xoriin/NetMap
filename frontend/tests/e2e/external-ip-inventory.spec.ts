import { expect, test, type Page } from '@playwright/test';
import { mockAddress, setupExternalIps } from './helpers/external-ip';
import { mockDevice, mockUser } from './helpers/api-mocks';

async function metadata(page: Page) {
 await page.route('**/api/v1/admin/device-types', route=>route.fulfill({json:[]}));
}

test('new single address offers Inventory creation in the form and links the created device', async ({page})=>{
 let posts=0;
 const state=await setupExternalIps(page,{beforeGoto:async page=>{
  await metadata(page);
  await page.route('**/api/v1/topology/devices',route=>{posts++;return route.fulfill({json:mockDevice({id:77,...route.request().postDataJSON()})});});
 }});
 await page.getByRole('button',{name:'Add external IP'}).first().click();
 const add=page.getByRole('dialog',{name:'Add external IP',exact:true});
 await add.getByLabel('Address or range').fill('8.8.8.8');
 const toggle=add.getByRole('switch',{name:'Also add to Inventory and Monitoring'});
 await expect(toggle).toBeVisible();
 await expect(add.locator('form').getByRole('switch')).toHaveCount(1);
 await toggle.click(); await add.getByRole('button',{name:'Add address',exact:true}).click();
 const device=page.getByRole('dialog',{name:'Add device',exact:true});
 await expect(device.getByLabel('IP address',{exact:true})).toHaveValue('8.8.8.8');
 await device.getByRole('button',{name:'Save',exact:true}).click();
 await expect(device).toBeHidden(); expect(posts).toBe(1);
 expect(state.addressPatches[0][1]).toEqual({device_id:77});
});

test('saved IPv6 address can be added and a failed link retry never creates a second device', async ({page})=>{
 let posts=0,fail=true;
 const state=await setupExternalIps(page,{addresses:[mockAddress({id:9,ip_address:'2606:4700:4700::1111'})],beforeGoto:async page=>{
  await metadata(page);
  await page.route('**/api/v1/topology/devices',route=>{posts++;return route.fulfill({json:mockDevice({id:78,...route.request().postDataJSON()})});});
  await page.route('**/api/v1/ipam/external/addresses/9',route=>fail?route.fulfill({status:500,json:{detail:'Link failed'}}):route.fallback());
 }});
 await page.getByRole('button',{name:'Add to Inventory',exact:true}).click();
 const device=page.getByRole('dialog').filter({has:page.locator('.device-form')});
 await expect(device.getByLabel('IP address',{exact:true})).toHaveValue('2606:4700:4700::1111');
 await device.getByRole('button',{name:'Save',exact:true}).click();
 await expect(page.getByText(/Link failed/)).toBeVisible();
 expect(posts).toBe(1); fail=false;
 await page.getByRole('button',{name:'Retry link',exact:true}).click();
 await expect(device).toBeHidden(); expect(posts).toBe(1);
 expect(state.addressPatches[0][1]).toEqual({device_id:78});
 await expect(page.getByRole('button',{name:'Add to Inventory',exact:true})).toHaveCount(0);
});

test('matching Inventory device is offered for linking instead of duplication', async ({page})=>{
 const state=await setupExternalIps(page,{addresses:[mockAddress({ip_address:'8.8.8.8'})],devices:[mockDevice({id:79,ip_address:'8.8.8.8'})],beforeGoto:metadata});
 await page.getByRole('button',{name:'Add to Inventory',exact:true}).click();
 await page.getByRole('dialog',{name:'Add device',exact:true}).getByRole('button',{name:'Save',exact:true}).click();
 await page.getByRole('button',{name:'Link device',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Add device',exact:true})).toBeHidden();
 expect(state.addressPatches[0][1]).toEqual({device_id:79});
});

test('cancelling saved address creation preserves the register', async ({page})=>{
 const state=await setupExternalIps(page,{addresses:[mockAddress()],beforeGoto:metadata});
 await page.getByRole('button',{name:'Add to Inventory',exact:true}).click();
 await page.getByRole('dialog',{name:'Add device',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
 expect(state.addressPatches).toHaveLength(0); expect(state.addressPosts).toHaveLength(0);
});

test('address-only permissions do not expose device creation', async ({page})=>{
 await setupExternalIps(page,{addresses:[mockAddress()],beforeGoto:async page=>{
  await page.route('**/api/v1/auth/me',route=>route.fulfill({json:{...mockUser,role:'Operator',permissions:['ipam_write']}}));
 }});
 await expect(page.getByRole('button',{name:'Add to Inventory',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Add external IP'}).first().click();
 await expect(page.getByRole('switch',{name:'Also add to Inventory and Monitoring'})).toHaveCount(0);
});

for (const theme of ['light','dark'] as const) {
 test(`Inventory option is visible and keyboard operable in ${theme}`,async ({page})=>{
  await setupExternalIps(page,{theme,addresses:[mockAddress()]});
  await page.getByRole('button',{name:'Add external IP'}).first().click();
  const dialog=page.getByRole('dialog',{name:'Add external IP',exact:true});
  const toggle=dialog.getByRole('switch');
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked','true');
  await page.screenshot({path:`/tmp/netmap-inventory-option-${theme}.png`});
  await page.setViewportSize({width:780,height:850});
  await expect(toggle).toBeInViewport();
  await page.screenshot({path:`/tmp/netmap-inventory-option-${theme}-narrow.png`});
  await dialog.getByLabel('Address or range').fill('8.8.8.0/29');
  await expect(toggle).toHaveCount(0);
 });
}

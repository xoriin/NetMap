import {expect,test} from '@playwright/test';
import {setupExternalIps,mockAddress,AWS} from './helpers/external-ip';

for(const theme of ['light','dark'] as const) {
 test(`cloud address and resource sidebars copy their identifiers in ${theme}`,async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.setViewportSize({width:1440,height:1000});
  await setupExternalIps(page,{theme,providers:[AWS],accounts:[{id:1,name:'Production',provider_id:1}],locations:[{id:1,account_id:1,name:'Sydney',region:'au'}],addresses:[mockAddress({ip_address:'203.0.113.10',label:'Public service'})],beforeGoto:async page=>{
   await page.route('**/api/v1/ipam/external/assets',route=>route.fulfill({json:[{id:4,name:'Retained VM',kind:'vm',provider_id:null,account:'Production',region:'Sydney',device_id:null,description:null}]}));
  }});
  await page.goto('/inventory#cloud-assets');
  const panel=page.getByRole('complementary',{name:'Asset overview'});

  await page.getByRole('button',{name:'Open Public service details'}).click();
  const ip=panel.getByRole('button',{name:'Copy IP address'});
  await expect(ip).toHaveClass(/nm-btn--icon-sm/);
  expect((await ip.boundingBox())?.height).toBe(24);
  await ip.click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('203.0.113.10');
  await expect(panel.getByRole('button',{name:'Copied IP address'})).toBeVisible();
  await ip.dblclick();
  await expect(panel.getByRole('textbox',{name:'Edit IP address'})).toHaveCount(0);

  await page.getByRole('button',{name:'Open Retained VM details'}).click();
  await panel.getByRole('button',{name:'Copy name'}).click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('Retained VM');
  await expect(panel.getByRole('button',{name:'Copy region'})).toHaveCount(0);
 });
}
